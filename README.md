# OpenUltron

中文 | [English](./README.en.md)

OpenUltron 是一个基于 **Electron + Vue 3 + Vite** 的 AI 桌面应用，定位为可本地运行、可扩展工具链的智能工作台。

项目融合了会话式 AI、Skills、MCP、定时任务、通知通道与本地持久化，核心目标是让 AI 可以在桌面端稳定地执行工程化任务。

## 核心能力

- 多模型/多供应商 AI 接入（OpenAI 兼容接口 + Anthropic）
- 会话管理（聊天、会话列表、历史加载、流式输出）
- 工具调用体系（内置工具 + MCP 工具）
- Skills 管理（本地技能、远程技能源、安装与校验）
- 定时任务（Cron）
- 通知与消息通道（飞书、Telegram、钉钉、Webhook）
- 飞书语音消息（内置 TTS，支持音色列表、别名、默认音色记忆）
- 本地数据备份与恢复（配置、会话、技能、记忆）
- 内置日志与诊断页面

## 技术栈

- 前端：Vue 3、Vue Router、Vite
- 桌面：Electron
- 后端能力（主进程）：Node.js、Express、IPC、自定义协议
- 终端能力：node-pty

## 项目结构

```text
.
├── src/                    # 渲染进程（Vue UI）
│   ├── components/ai/      # AI 聊天、配置、技能、MCP 等核心组件
│   ├── views/              # 页面：Chat / Sessions / Skills / Settings / Cron
│   ├── router/             # 路由定义
│   └── composables/        # 组合式逻辑（主题、会话、健康检查等）
├── electron/               # 主进程
│   ├── ai/                 # 编排器、工具注册、会话与记忆系统
│   ├── ai/tools/           # 内置工具实现
│   ├── api/                # IPC / HTTP invoke 桥接
│   ├── extensions/         # 扩展与执行器
│   └── main.js             # Electron 入口
├── mcp-server/             # 内置 MCP Server（stdio JSON-RPC）
├── scripts/                # 开发/打包/清理脚本
├── public/                 # 静态资源
└── icons/                  # 应用图标资源
```

## 本地数据目录

应用运行时数据存放于：`~/.openultron/`

典型内容：

- `openultron.json`：统一配置（AI + 通知等）
- `logs/app.log`：应用日志
- `conversations/`：会话历史
- `skills/`：本地技能
- `memory/` 与 `MEMORY.md`：记忆数据
- `IDENTITY.md` / `SOUL.md` / `USER.md` / `BOOT.md`：身份与行为配置

## 开发环境要求

- Node.js 20+
- npm 10+
- macOS/Linux（Windows 可开发，但当前脚本对 Unix 环境更友好）

## 快速开始

```bash
npm install
npm run electron:dev
```

`electron:dev` 会同时启动 Vite 与 Electron 开发环境。

## 常用命令

```bash
# 仅前端开发（Vite）
npm run dev

# 构建前端
npm run build

# 以 Electron 启动（若 dist 不存在会先构建）
npm run electron

# 开发联调（推荐）
npm run electron:dev

# 构建桌面应用
npm run electron:build
npm run electron:build:mac
npm run electron:build:win
npm run electron:build:linux

# 发布脚本（项目内封装）
npm run release
npm run release:x64
npm run release:all

# 清理 Electron / builder 缓存
npm run electron:clean-cache
```

## 打包说明

- Electron 打包输出目录：`dist-electron/`
- 前端构建输出目录：`dist/`
- 项目提供了 `scripts/build-release*.sh` 脚本用于 macOS 下的构建与签名流程

## 备注

- 若遇到打包缓存损坏，可先执行：`npm run electron:clean-cache` 再重试。
