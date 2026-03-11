# OpenUltron

[中文](./README.md) | English

OpenUltron is an AI-first desktop app built with **Electron + Vue 3 + Vite**. It is designed as a local, extensible workstation for engineering-focused AI workflows.

The project combines conversational AI, Skills, MCP, cron tasks, notification channels, and local persistence, aiming to make desktop AI execution stable and practical.

## Key Capabilities

- Multi-model / multi-provider AI access (OpenAI-compatible APIs + Anthropic)
- Session management (chat, session list, history loading, streaming output)
- Tooling system (built-in tools + MCP tools)
- Skills management (local skills, remote sources, install and validation)
- Cron task scheduling
- Notification channels (Feishu, Telegram, DingTalk, Webhook)
- Local backup and restore (config, sessions, skills, memories)
- Built-in logs and diagnostics pages

## Tech Stack

- Frontend: Vue 3, Vue Router, Vite, Monaco Editor
- Desktop: Electron
- Backend capability (main process): Node.js, Express, IPC, custom protocols
- Terminal capability: node-pty

## Project Structure

```text
.
├── src/                    # Renderer process (Vue UI)
│   ├── components/ai/      # Core AI components: chat/config/skills/MCP
│   ├── views/              # Pages: Chat / Sessions / Skills / Settings / Cron
│   ├── router/             # Route definitions
│   └── composables/        # Reusable logic (theme/session/health checks)
├── electron/               # Main process
│   ├── ai/                 # Orchestrator, tools, sessions, memory system
│   ├── ai/tools/           # Built-in tool implementations
│   ├── api/                # IPC / HTTP invoke bridge
│   ├── extensions/         # Extensions and executors
│   └── main.js             # Electron entrypoint
├── mcp-server/             # Built-in MCP server (stdio JSON-RPC)
├── scripts/                # Dev/build/cleanup scripts
├── public/                 # Static assets
└── icons/                  # App icon assets
```

## Local Data Directory

Runtime data is stored under: `~/.openultron/`

Typical content:

- `openultron.json`: unified config (AI + notifications, etc.)
- `logs/app.log`: app logs
- `conversations/`: chat history
- `skills/`: local skills
- `memory/` and `MEMORY.md`: memory data
- `IDENTITY.md` / `SOUL.md` / `USER.md` / `BOOT.md`: identity and behavior configs

## Development Requirements

- Node.js 20+
- npm 10+
- macOS/Linux (Windows development is possible, but current scripts are Unix-oriented)

## Quick Start

```bash
npm install
npm run electron:dev
```

`electron:dev` starts both Vite and Electron for integrated development.

## Common Commands

```bash
# Frontend only (Vite)
npm run dev

# Build frontend
npm run build

# Start with Electron (builds dist first if missing)
npm run electron

# Integrated dev mode (recommended)
npm run electron:dev

# Build desktop app
npm run electron:build
npm run electron:build:mac
npm run electron:build:win
npm run electron:build:linux

# Release scripts (project wrappers)
npm run release
npm run release:x64
npm run release:all

# Clear Electron / builder caches
npm run electron:clean-cache
```

## Packaging Notes

- Electron output directory: `dist-electron/`
- Frontend output directory: `dist/`
- `scripts/build-release*.sh` are provided for macOS build/sign flows

## Notes

- Some legacy names such as `GitManager` may still appear in code/scripts.
- If packaging cache is corrupted, run `npm run electron:clean-cache` and retry.
