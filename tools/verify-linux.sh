#!/usr/bin/env bash
# 在 Linux（本机用 WSL Ubuntu 24.04）验证：干净安装依赖 → 类型检查 → 构建 → 发布示例 → 启动 → HTTP 冒烟。
# 不会碰仓库里的 node_modules / dist / data：全部在临时目录里做。
#
#   bash tools/verify-linux.sh
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-/tmp/fennec-share-linux}"
PORT="${PORT:-8795}"
DATA_DIR="$WORK_DIR/data"

echo "== 环境 =="
. /etc/os-release
echo "发行版: $PRETTY_NAME"
echo "内核/架构: $(uname -r) $(uname -m)"
echo "node: $(command -v node) $(node -v)"
echo "npm: $(npm -v)"
echo "源码目录: $SRC_DIR"
echo "临时目录: $WORK_DIR"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/app"

echo
echo "== 拷贝源码（排除 node_modules/dist/data/artifacts）=="
tar -C "$SRC_DIR" \
  --exclude=node_modules --exclude=dist --exclude=data --exclude=artifacts \
  --exclude=.git --exclude=ops --exclude='*.tgz' \
  -cf - . | tar -C "$WORK_DIR/app" -xf -
du -sh "$WORK_DIR/app"

cd "$WORK_DIR/app"

echo
echo "== npm ci（使用 lockfile，全新安装）=="
npm ci --no-audit --no-fund 2>&1 | tail -n 5

echo
echo "== 类型检查 + 构建 =="
npm run build 2>&1 | tail -n 12

echo
echo "== 发布示例项目 =="
DATA_DIR="$DATA_DIR" PUBLIC_BASE_URL="http://127.0.0.1:$PORT" node dist/tools/publish.js seed --demo-dir demo 2>&1 | tail -n 8

echo
echo "== 启动服务 =="
DATA_DIR="$DATA_DIR" HOST=127.0.0.1 PORT="$PORT" PUBLIC_BASE_URL="http://127.0.0.1:$PORT" \
  node dist/server/index.js > "$WORK_DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1; then break; fi
  sleep 0.25
done

echo
echo "== HTTP 冒烟 =="
fail=0
probe() {
  local path="$1" expect="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path")"
  if [ "$code" = "$expect" ]; then
    echo "  ✔ $path -> $code"
  else
    echo "  ✘ $path -> $code（期望 $expect）"
    fail=1
  fi
}

curl -fsS "http://127.0.0.1:$PORT/healthz"; echo
probe "/" 200
probe "/api/projects" 200
probe "/play/paper-notes" 308
probe "/play/paper-notes/" 302
probe "/play/pixel-garden/about/" 302
probe "/download/paper-notes/paper-notes-web-1.0.0.zip" 200
probe "/download/paper-notes" 302
probe "/play/not-exist/" 404
probe "/catalog.json" 404

echo
echo "== 下载头与 Range =="
curl -sI "http://127.0.0.1:$PORT/download/paper-notes/paper-notes-web-1.0.0.zip" | tr -d '\r' | grep -Ei '^(HTTP|content-type|content-length|content-disposition|accept-ranges|x-content-type-options)' || true
curl -s -H 'Range: bytes=0-15' -o /dev/null -w '  range bytes=0-15 -> %{http_code} (%{size_download} bytes)\n' "http://127.0.0.1:$PORT/download/paper-notes/paper-notes-web-1.0.0.zip"

echo
echo "== 计算下载文件 SHA-256 并与 catalog 对比 =="
python3 - "$DATA_DIR" "$PORT" <<'PY'
import hashlib, json, sys, urllib.request
data_dir, port = sys.argv[1], sys.argv[2]
with open(f"{data_dir}/catalog.json", "r", encoding="utf-8") as fh:
    catalog = json.load(fh)
project = next(p for p in catalog["projects"] if p["slug"] == "paper-notes")
download = project["downloads"][0]
with urllib.request.urlopen(f"http://127.0.0.1:{port}{download['publicUrl']}") as response:
    body = response.read()
digest = hashlib.sha256(body).hexdigest()
ok = digest == download["sha256"]
print(f"  {'✔' if ok else '✘'} {download['fileName']} {len(body)} 字节 sha256={digest[:16]}… 与 catalog 一致={ok}")
sys.exit(0 if ok else 1)
PY

echo
echo "== 自测套件（发布事务 + HTTP 断言）=="
DATA_DIR="$DATA_DIR" node dist/tools/selftest.js 2>&1 | tail -n 6

echo
echo "== 服务日志尾部 =="
tail -n 6 "$WORK_DIR/server.log"

if [ "$fail" -ne 0 ]; then
  echo
  echo "有冒烟检查失败"
  exit 1
fi
echo
echo "Linux 验证完成"
