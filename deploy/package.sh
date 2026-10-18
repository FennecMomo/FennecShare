#!/usr/bin/env bash
# 打部署包：源码 + 文档 + 示例，排除 node_modules / dist / data / .git / ops / .env。
# Linux、WSL、macOS 都可以直接跑；Windows 上用 `wsl bash deploy/package.sh` 或 deploy/package.ps1。
#
#   bash deploy/package.sh [输出目录] [时间戳]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$REPO_DIR/artifacts}"
STAMP="${2:-$(date -u +%Y%m%d-%H%M%S)}"
VERSION="$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || \
  grep -m1 '"version"' "$REPO_DIR/package.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
NAME="fennec-share-$VERSION-$STAMP"

mkdir -p "$OUT_DIR"
TARGET="$OUT_DIR/$NAME.tgz"

cd "$REPO_DIR"
tar -czf "$TARGET" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./data' \
  --exclude='./data-*' \
  --exclude='./.git' \
  --exclude='./ops' \
  --exclude='./.env' \
  --exclude='*.tgz' \
  --exclude='*.sha256' \
  --transform "s,^\.,$NAME," \
  .

SHA="$(sha256sum "$TARGET" | awk '{print $1}')"
printf '%s  %s\n' "$SHA" "$(basename "$TARGET")" > "$TARGET.sha256"

SIZE="$(stat -c %s "$TARGET" 2>/dev/null || wc -c < "$TARGET")"
# 一次读出清单再匹配：grep -q 会提前退出，配合 pipefail 会把 tar 的 SIGPIPE 误判成失败
LIST="$(tar -tzf "$TARGET")"
FILES="$(printf '%s\n' "$LIST" | grep -cv '/$' || true)"

echo "部署包：$TARGET"
echo "大小：$SIZE 字节（$(( SIZE / 1024 )) KiB）"
echo "文件数：$FILES"
echo "SHA-256：$SHA"
echo "顶层目录：$NAME"
echo
echo "包含的关键路径："
for key in package.json package-lock.json server/index.ts src/App.tsx tools/publish.ts \
           deploy/deploy.sh deploy/fennec-share.service deploy/backup.sh \
           demo/packages/paper-notes-web-1.0.0.zip docs/DEPLOYMENT.md README.md; do
  if [ "$(printf '%s\n' "$LIST" | grep -c "/$key\$" || true)" -gt 0 ]; then
    echo "  OK   $key"
  else
    echo "  MISS $key"
  fi
done
