# OpenUltron

[中文](./README.md) | English

OpenUltron is an AI desktop assistant built for real execution, not just chat.

Think of it as a local AI workspace that can understand tasks, run tools, produce deliverables, and send results back to your channels.

## Problems It Solves

| Pain point | How OpenUltron helps |
|------------|----------------------|
| Chatbots that only talk | Built-in tools + MCP: files, shell, browser, screenshots, Feishu send, etc.—outputs land on disk or channels |
| Juggling multiple models/providers | **Global model pool** + **per-model provider bindings**; the active model routes to the right `baseUrl` / key; in-app **`/model`** updates the same global **default model** as Settings |
| Copy-pasting between desktop and IM | Feishu / Telegram / DingTalk integration; first-line **`/model`** + model id in Feishu (model must be in pool) switches the **global** default, same as the app |
| Spinning up a tiny page/tool without a full repo | **Web sandbox apps**: sidebar **Apps** → install/create; **Studio** = preview + AI edits; CSP, network allowlist, optional `npm install`—see design docs |
| Losing context or config after reinstall | Local conversations, memory, `~/.openultron/` data; backup ZIP export/import |

## Why OpenUltron

- Execution-first, not a plain chatbot  
- One flow: **request → execute → deliver → push to channels**  
- Local-first with configurable models/proxy for daily and sensitive work  

## What You Can Do

- Generate webpages, docs, scripts, and reports; write files to disk via tools  
- Handle screenshots, files, and links as task artifacts  
- Send results to Feishu / Telegram / DingTalk; Feishu **user space docs** (User Access Token, auto-refresh)  
- Extend with **Skills** and **MCP**  
- **Global model selection**: **`/model`** in chat persists to config (same as Settings); AI can also use **`ai_config_control`** (e.g. `switch_model`)  
- **Web sandbox apps**: **`/web-apps`** (library), **`/web-app-studio`** (preview + chat); see `docs/WEB-APPS-SANDBOX-DESIGN.md` and `docs/WEB-APPS-IPC-REFERENCE.md`  
- Multi-session history and progress  

## Key Features

- **Multi-model & multi-provider**: providers, model pool, bindings; OpenAI-compatible APIs; see `docs/OPENAI-CODEX-AND-CHAT-COMPLETIONS.md` for Codex vs chat/completions  
- **Sub-agents**: `sessions_spawn` for delegated work  
- **Tools**: built-in + MCP; optional **`webapp__*`** tools in Web App Studio (see checklist)  
- **Memory & persistence**: conversation and project memory on disk  
- **Gateway**: local WebSocket entry for scripts/automation (default port in docs)  
- **Cron**: scheduled jobs (Feishu token refresh optional)  
- **Backup & restore**: ZIP backup of `~/.openultron/`  

## Typical Use Cases

- **Ops**: copy, summaries, channel delivery  
- **Dev**: prototypes, code tasks, packaged outputs; **Web Studio** for sandbox mini-apps  
- **Teams**: sync AI output to chat/docs  
- **Personal**: cron + tools for repetitive work  

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

- App data: `~/.openultron/` (includes `openultron.json` AI config: **default model, pool, providers, bindings**)
- Conversations: `conversations/`
- Local skills: `skills/`
- Web sandbox apps: `web-apps/` (per app id / version)
- Logs: `logs/app.log`

## Stack (Brief)

- Electron + Vue 3 + Vite
- Node.js main-process capabilities
- MCP-based tool extensibility

## Documentation

- [Optimization & agent roadmap](./docs/OPTIMIZATION-ROADMAP.md)
- [Main process (main.js) modularization plan](./docs/MAIN-PROCESS-MODULARIZATION.md)
- [OpenAI Codex vs Chat Completions](./docs/OPENAI-CODEX-AND-CHAT-COMPLETIONS.md)
- [Skills & ClawHub compatibility](./docs/SKILLS-PACK-COMPAT.md)
- [Web sandbox apps](./docs/WEB-APPS-SANDBOX-DESIGN.md)
- [Web apps IPC / HTTP](./docs/WEB-APPS-IPC-REFERENCE.md)
- [Web apps implementation checklist](./docs/WEB-APPS-IMPLEMENTATION-CHECKLIST.md)

---

If you want AI that delivers outcomes instead of just responses, OpenUltron is built for that.
