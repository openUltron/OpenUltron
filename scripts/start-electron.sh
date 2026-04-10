#!/bin/bash

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

echo "🔍 检查已运行的 Electron 进程..."

# 查找所有运行的 Electron 进程（排除 grep 自身）
ELECTRON_PIDS=$(ps aux | grep -i "[E]lectron" | grep -v grep | awk '{print $2}')

if [ -n "$ELECTRON_PIDS" ]; then
    echo "⚠️  发现已运行的 Electron 进程，准备终止..."
    echo "$ELECTRON_PIDS" | while read pid; do
        if [ -n "$pid" ]; then
            echo "🔪 终止进程 PID: $pid"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
    # 等待进程完全退出
    sleep 1
    echo "✅ 已终止所有 Electron 进程"
else
    echo "✅ 未发现运行的 Electron 进程"
fi

echo "🚀 启动 Electron 应用..."
cd "$PROJECT_DIR"
echo "📍 当前目录: $(pwd)"

# 检查 dist 目录是否存在（生产模式需要）
if [ ! -d "dist" ] && [ "$1" != "dev" ]; then
    echo "⚠️  dist 目录不存在，需要先构建。正在构建..."
    npm run build
fi

# 根据是否在生产模式决定启动方式
bash scripts/ensure-electron-runtime.sh

if [ "$1" = "dev" ]; then
    echo "📦 开发模式"
    echo "🔧 启动命令: NODE_ENV=development npx electron ."
    NODE_ENV=development npx electron .
else
    echo "📦 生产模式"
    echo "🔧 启动命令: npx electron ."
    npx electron .
fi
