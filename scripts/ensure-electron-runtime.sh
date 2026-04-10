#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

cd "$PROJECT_DIR"

electron_runtime_ok() {
  node <<'EOF' >/dev/null 2>&1
const fs = require('fs');
const path = require('path');

const base = path.join(process.cwd(), 'node_modules', 'electron');
const pathFile = path.join(base, 'path.txt');
if (!fs.existsSync(pathFile)) process.exit(1);

const relativeExecutable = fs.readFileSync(pathFile, 'utf8').trim();
if (!relativeExecutable) process.exit(1);

const executablePath = path.join(base, 'dist', relativeExecutable);
if (!fs.existsSync(executablePath)) process.exit(1);

process.exit(0);
EOF
}

if electron_runtime_ok; then
  exit 0
fi

echo "📦 Electron runtime 缺失，正在修复..."
node scripts/run-electron-install.js

if ! electron_runtime_ok; then
  echo "❌ Electron runtime 修复失败"
  exit 1
fi

echo "✅ Electron runtime 已修复"
