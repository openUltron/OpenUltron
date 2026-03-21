# OpenUltron

[中文](./README.md) | English

OpenUltron is an AI desktop assistant built for real execution, not just chat.

Think of it as a local AI workspace that can understand tasks, run tools, produce deliverables, and send results back to your channels.

## Why OpenUltron

- Execution-first experience, not a plain chatbot
- One workspace for request -> execution -> output -> delivery
- Local-first and configurable, suitable for daily long-term use

## What You Can Do

- Generate webpages, docs, scripts, and reports
- Handle screenshots, files, and links as task artifacts
- Send results directly to Feishu / Telegram / DingTalk; Feishu **user space docs** supported (authorize User Access Token to create docs in your space, token auto-refresh)
- Extend capabilities with Skills and MCP tools
- **Web sandbox apps**: use the sidebar **Apps** entry to install or create mini front-ends under `~/.openultron/web-apps/`; **Studio** pairs a live preview with AI-assisted edits to `index.html` / `manifest`. See `docs/WEB-APPS-SANDBOX-DESIGN.md` and `docs/WEB-APPS-IPC-REFERENCE.md`
- Keep multi-session context and progress history

## Key Features

- Multi-model support with flexible provider config
- Sub-agent execution for complex tasks
- Built-in + MCP tool calling system
- Persistent conversation memory
- Cron-based scheduled tasks (including Feishu User Token refresh, can be disabled)
- Backup and restore for local data

## Typical Use Cases

- Operations: campaign copy, daily summaries, channel delivery
- Development: quick page generation, code tasks, packaged outputs
- Team collaboration: AI outputs synced to chat and docs
- Personal productivity: automate repetitive workflows

## Quick Start

```bash
npm install
npm run electron:dev
```

After launch, configure your model and notification channels in-app, then start dispatching tasks.

## Common Commands

```bash
# Frontend dev
npm run dev

# Build frontend
npm run build

# Start Electron
npm run electron

# Integrated dev mode (recommended)
npm run electron:dev

# Build desktop apps
npm run electron:build
npm run electron:build:mac
npm run electron:build:win
npm run electron:build:linux

# Release scripts
npm run release
npm run release:x64
npm run release:all
```

## Data & Paths

- App data: `~/.openultron/`
- Conversations: `conversations/`
- Local skills: `skills/`
- Logs: `logs/app.log`

## Stack (Brief)

- Electron + Vue 3 + Vite
- Node.js main-process capabilities
- MCP-based tool extensibility

---

If you want AI that delivers outcomes instead of just responses, OpenUltron is built for that.
