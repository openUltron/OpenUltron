#!/bin/bash

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# 加载 nvm 并切换到项目指定的 Node 版本
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if [ -f "$PROJECT_DIR/.nvmrc" ]; then
    echo "🔄 切换 Node 版本..."
    nvm use || nvm install
    echo ""
fi

echo "🔍 检查已运行的进程..."

# 杀掉 Electron 进程
ELECTRON_PIDS=$(ps aux | grep -i "[E]lectron" | grep -v grep | awk '{print $2}')
if [ -n "$ELECTRON_PIDS" ]; then
    echo "⚠️  发现已运行的 Electron 进程，准备终止..."
    echo "$ELECTRON_PIDS" | while read pid; do
        if [ -n "$pid" ]; then
            echo "🔪 终止 Electron 进程 PID: $pid"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
fi

# 杀掉占用 28789(正式UI)、28790(正式Gateway)、28791(开发Vite)、28792(开发Gateway) 的进程
for port in 28789 28790 28791 28792; do
    PID=$(lsof -ti:$port 2>/dev/null)
    if [ -n "$PID" ]; then
        echo "⚠️  发现占用 $port 端口的进程，准备终止..."
        kill -9 $PID 2>/dev/null || true
    fi
done

# 等待进程完全退出
sleep 2
echo "✅ 已清理所有相关进程"

# 切换到项目目录
cd "$PROJECT_DIR"

# 检查依赖是否完整（检查关键模块）
if [ ! -d "node_modules/electron/dist" ] || [ ! -d "node_modules/vite" ] || [ ! -d "node_modules/concurrently" ] || [ ! -d "node_modules/node-edge-tts" ]; then
    echo "📦 依赖不完整，正在安装..."
    npm install
    echo "✅ 依赖安装完成"
fi

bash scripts/ensure-electron-runtime.sh

# 启动开发服务器（先等 5 秒让 Vite 起来，再启动 Electron，不依赖 wait-on）
echo "🚀 启动开发服务器..."
npx concurrently "npm run dev" "sleep 5 && NODE_ENV=development npx electron ." --names "VITE,ELECTRON" --prefix-colors "cyan,green"



