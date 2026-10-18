#!/usr/bin/env bash
# Fennec Share 部署 / 更新脚本（在 Linux 服务器上以 ubuntu 用户执行）
#
#   bash deploy/deploy.sh --source /home/ubuntu/fennec-share-staging/app
#
# 做的事：校验 Node 版本 → 同步代码 → 安装锁定依赖 → 构建 → 生成 env → 安装/重载 systemd 单元
#        → 健康检查。数据目录不会被删除或覆盖。
#
# 可选参数（也支持同名环境变量）：
#   --source DIR       源码目录（默认：本脚本所在仓库根目录）
#   --app-dir DIR      代码目录（默认 /home/ubuntu/dev-projects/fennec-share）
#   --data-dir DIR     数据目录（默认 /home/ubuntu/fennec-share-data，权限 0700）
#   --port PORT        监听端口（默认 8770）
#   --public-base-url  对外地址（默认 https://share.fennecmomo.top）
#   --node PATH        Node 可执行文件（默认自动挑选 >= 22.12 的最高版本）
#   --skip-build       只同步文件，不安装依赖/构建
#   --skip-systemd     不动 systemd（只构建 + 准备 env）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR:-/home/ubuntu/dev-projects/fennec-share}"
DATA_DIR="${DATA_DIR:-/home/ubuntu/fennec-share-data}"
PORT="${PORT:-8770}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://share.fennecmomo.top}"
NODE_BIN="${NODE_BIN:-}"
SERVICE_NAME="fennec-share"
SKIP_BUILD=0
SKIP_SYSTEMD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --public-base-url) PUBLIC_BASE_URL="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-systemd) SKIP_SYSTEMD=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

log() { printf '\n== %s ==\n' "$1"; }

log "参数"
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
echo "源码目录   : $SOURCE_DIR"
echo "代码目录   : $APP_DIR"
echo "数据目录   : $DATA_DIR"
echo "监听端口   : $PORT"
echo "对外地址   : $PUBLIC_BASE_URL"

log "检查 Node 版本"
if [ -z "$NODE_BIN" ]; then
  # 优先用 nvm 里最高版本的 Node（>= 22.12），否则退回系统 node
  if [ -d "$HOME/.nvm/versions/node" ]; then
    NODE_BIN="$(find "$HOME/.nvm/versions/node" -maxdepth 3 -type f -name node -perm -u+x 2>/dev/null | sort -V | tail -n 1)"
  fi
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node || true)"
  fi
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "找不到可用的 node，可用 --node 指定绝对路径" >&2; exit 1; }
NODE_VERSION="$("$NODE_BIN" -v)"
echo "node      : $NODE_BIN ($NODE_VERSION)"
"$NODE_BIN" -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Node ${process.versions.node} 太旧：Vite 7 需要 ^20.19 或 >=22.12，本项目 engines 要求 >=22.12`);
  process.exit(1);
}
'
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm)"
echo "npm       : $NPM_BIN ($("$NPM_BIN" -v))"

log "准备目录"
mkdir -p "$APP_DIR" "$DATA_DIR" "$DATA_DIR/projects" "$DATA_DIR/staging" "$DATA_DIR/backups"
chmod 700 "$DATA_DIR"
echo "已确保目录存在，数据目录权限 0700"

log "同步代码到 $APP_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'dist' --exclude 'data' --exclude 'data-*' \
    --exclude '.git' --exclude 'artifacts' --exclude 'ops' --exclude '*.tgz' \
    "$SOURCE_DIR"/ "$APP_DIR"/
else
  ( cd "$SOURCE_DIR" && tar --exclude=node_modules --exclude=dist --exclude=data \
      --exclude=.git --exclude=artifacts --exclude=ops -cf - . ) | ( cd "$APP_DIR" && tar -xf - )
fi
echo "代码已同步（未触碰数据目录与 node_modules）"

ENV_FILE="$DATA_DIR/$SERVICE_NAME.env"
if [ ! -f "$ENV_FILE" ]; then
  log "生成 env 文件 $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# 由 deploy.sh 生成；修改后 sudo systemctl restart $SERVICE_NAME
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
WEB_DIST_DIR=$APP_DIR/dist/web
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
else
  log "env 文件已存在，保持不变：$ENV_FILE"
  grep -E '^(HOST|PORT|DATA_DIR|WEB_DIST_DIR|PUBLIC_BASE_URL)=' "$ENV_FILE" || true
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "安装依赖（npm ci，使用 lockfile）"
  ( cd "$APP_DIR" && "$NPM_BIN" ci --no-audit --no-fund )
  log "构建（类型检查 + 前端 + 服务端）"
  ( cd "$APP_DIR" && "$NPM_BIN" run build )
else
  echo "跳过依赖安装与构建"
fi

if [ "$SKIP_SYSTEMD" -eq 0 ]; then
  log "安装 systemd 单元 $SERVICE_NAME.service"
  UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"
  RENDERED="$(mktemp)"
  sed -e "s#__APP_DIR__#$APP_DIR#g" \
      -e "s#__ENV_FILE__#$ENV_FILE#g" \
      -e "s#__NODE_BIN__#$NODE_BIN#g" \
      "$APP_DIR/deploy/fennec-share.service" > "$RENDERED"

  if sudo -n true 2>/dev/null; then
    sudo install -m 0644 "$RENDERED" "$UNIT_PATH"
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      sudo systemctl restart "$SERVICE_NAME"
    else
      sudo systemctl start "$SERVICE_NAME"
    fi
    rm -f "$RENDERED"
    sleep 1
    systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
  else
    echo "没有免密 sudo，单元文件已渲染到：$RENDERED"
    echo "请手工执行："
    echo "  sudo install -m 0644 $RENDERED $UNIT_PATH"
    echo "  sudo systemctl daemon-reload && sudo systemctl enable --now $SERVICE_NAME"
  fi
else
  echo "跳过 systemd 安装（--skip-systemd）"
fi

log "健康检查"
OK=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" > /tmp/fennec-health.json 2>/dev/null; then
    OK=1
    break
  fi
  sleep 0.5
done
if [ "$OK" -eq 1 ]; then
  echo "healthz OK：$(cat /tmp/fennec-health.json)"
  curl -s -o /dev/null -w "首页 / -> %{http_code}\n" "http://127.0.0.1:$PORT/"
  curl -s -o /dev/null -w "接口 /api/projects -> %{http_code}\n" "http://127.0.0.1:$PORT/api/projects"
elif [ "$SKIP_SYSTEMD" -eq 1 ]; then
  # --skip-systemd 只是"装代码不装服务"，这时候服务本来就没起来，不算失败
  echo "已跳过 systemd，未做健康检查（需要时手工启动：$NODE_BIN dist/server/index.js）"
else
  echo "健康检查失败，查看日志：journalctl -u $SERVICE_NAME -n 80 --no-pager" >&2
  exit 1
fi

log "完成"
echo "代码目录 : $APP_DIR"
echo "数据目录 : $DATA_DIR"
echo "env 文件 : $ENV_FILE"
echo "服务名   : $SERVICE_NAME.service（journalctl -u $SERVICE_NAME -f）"
echo "本机地址 : http://127.0.0.1:$PORT/"
echo "发布命令 : cd $APP_DIR && DATA_DIR=$DATA_DIR node dist/tools/publish.js publish --manifest <绝对路径>/manifest.json"
