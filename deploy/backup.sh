#!/usr/bin/env bash
# Fennec Share 备份脚本：备份 catalog + 全部项目文件，并清理过期备份。
# 适合放进 crontab 每天跑，不重启服务、不锁死站点（内部用发布写锁，只在备份期间阻塞发布）。
#
#   bash deploy/backup.sh [--keep-days 14] [--out DIR]
#
# 退出码：0 成功，非 0 失败（cron 会因此发告警）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${DATA_DIR:-/home/ubuntu/fennec-share-data}"
OUT_DIR="${OUT_DIR:-/home/ubuntu/backups/fennec-share}"
KEEP_DAYS="${KEEP_DAYS:-14}"

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-days) KEEP_DAYS="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"
echo "[$(date -Is)] 备份开始：DATA_DIR=$DATA_DIR OUT_DIR=$OUT_DIR"

cd "$APP_DIR"
RESULT="$(DATA_DIR="$DATA_DIR" node dist/tools/publish.js backup --out "$OUT_DIR" --json)"
echo "$RESULT"

# 清理过期备份目录（只删本脚本命名规则下的目录，不碰别的）
DELETED=0
while IFS= read -r -d '' dir; do
  echo "[$(date -Is)] 清理过期备份：$dir"
  rm -rf "$dir"
  DELETED=$((DELETED + 1))
done < <(find "$OUT_DIR" -maxdepth 1 -type d -name 'fennec-share-backup-*' -mtime "+$KEEP_DAYS" -print0)

echo "[$(date -Is)] 备份完成，清理了 $DELETED 个过期目录"
