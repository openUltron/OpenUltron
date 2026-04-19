#!/usr/bin/env bash
# electron-builder / release 前：结束本机 OpenUltron 调试相关进程，避免端口占用或 dist-electron 下 EBUSY。
# 与 kill-dev-ports.sh 不同：会释放 28789/28790（正式包 UI/Gateway），因打包前通常希望独占。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🧹 release 前清理：端口 28789–28792、本仓库 Electron 调试、占用 dist-electron 的产物…"

for port in 28789 28790 28791 28792; do
  for PID in $(lsof -ti:"$port" 2>/dev/null || true); do
    [ -z "${PID:-}" ] && continue
    echo "⚠️  释放端口 $port (PID $PID)"
    kill -9 "$PID" 2>/dev/null || true
  done
done

# 典型：`npx electron .` / `NODE_ENV=development npx electron .`，命令行含本仓库 electron 路径
while IFS= read -r pid; do
  pid="${pid// /}"
  [ -z "$pid" ] && continue
  if [ "$pid" = "$$" ]; then continue; fi
  echo "🔪 结束本仓库 Electron 调试进程 PID=$pid"
  kill -9 "$pid" 2>/dev/null || true
done < <(ps ax -o pid=,args= 2>/dev/null | awk -v d="$PROJECT_DIR/node_modules/electron" 'index($0, d) {print $1+0}')

# 若曾从 dist-electron 直接打开过 .app，打包替换时可能 EBUSY
if [ -d "$PROJECT_DIR/dist-electron" ]; then
  shopt -s nullglob 2>/dev/null || true
  for app in "$PROJECT_DIR"/dist-electron/mac*/"${PROJECT_DIR##*/}".app "$PROJECT_DIR"/dist-electron/mac*/*.app; do
    [ -e "$app" ] || continue
    for PID in $(lsof -t "$app" 2>/dev/null || true); do
      [ -z "${PID:-}" ] && continue
      echo "🔪 结束占用 $app 的进程 PID=$PID"
      kill -9 "$PID" 2>/dev/null || true
    done
  done
  shopt -u nullglob 2>/dev/null || true
fi

sleep 1
echo "✅ release 前清理完成"
