# OpenUltron

[中文](./README.md) | English

OpenUltron is an **execution-first AI desktop agent platform**.  
It turns “chat” into “delivery”: understand tasks, run tools, generate outputs, and send results back to your channels in one local workspace.

> **Request -> Execute -> Deliver**

## Hero

### AI That Actually Gets Work Done

- Not just answers: runs commands, edits files, calls tools, produces artifacts
- Not just one-off chat: persistent sessions, memory, logs, and recovery
- Not just one model: multi-model, multi-provider, governed orchestration

### Positioning

OpenUltron is designed for high-frequency execution workflows: development, operations, automation, and channel collaboration.

## Feature Highlights

### Execution Engine

- Built-in tools: `execute_command`, `file_operation`, `apply_patch`, web tools, and more
- MCP extensibility for custom integrations
- Sub-task delegation with `sessions_spawn`

### Model Orchestration

- Multi-provider configuration (OpenAI-compatible)
- Model pool + model bindings + fallback routes
- Session/global unavailable-model cache to avoid repeated failed attempts

### Workspace & Delivery

- Web sandbox studio: `/web-app-studio` (preview + AI editing)
- Channel integrations: Feishu / Telegram / DingTalk
- Scheduled automation with cron tasks

### Reliability & Governance

- Local-first data in `~/.openultron/`
- Sandbox and path constraints (especially for web apps)
- Observability via runId, traces, logs, and error classification

## Capability Matrix

| Capability | OpenUltron |
|---|---|
| Task understanding | Conversational context + memory |
| Task execution | Shell / file / tools / MCP |
| Orchestration | Session state machine + retries + fallback |
| Delivery | Local artifacts + channel sync |
| Governance | Sandbox boundaries + logging |
| Automation | Sub-agents + Gateway + cron |

## Typical Scenarios

- **Development**: rapid prototypes, code fixes, artifact outputs
- **Operations**: content generation, reports, channel delivery
- **Team collaboration**: execute locally, sync outcomes to chat/docs
- **Personal automation**: recurring tasks powered by tools + schedule

## Architecture (Simplified)

```text
App UI (Electron + Vue)
  -> IPC Layer
  -> Orchestrator (prompt/context/state/retry/fallback)
  -> Tool Runtime (built-in tools + MCP tools)
  -> Local Services (web-app sandbox / gateway / logs / storage)
```

## Quick Start

### Requirements

- Node.js 18+ (LTS recommended)
- npm 9+
- macOS / Windows / Linux

### Launch

```bash
npm install
npm run electron:dev
```

or

```bash
make install
make run
```

### First-Time Setup

1. Configure provider key/base URL in Settings  
2. Select your default model (or use `/model` in chat)  
3. Connect channels as needed (Feishu / Telegram / DingTalk)  
4. Start tasks and verify outputs via execution logs and artifacts

## Commands

```bash
# dev
npm run dev
npm run electron:dev

# build
npm run build
npm run electron:build
npm run electron:build:mac
npm run electron:build:win
npm run electron:build:linux

# release
npm run release
npm run release:x64
npm run release:all
```

## Data Layout

Default directory: `~/.openultron/`

- `openultron.json`: model/provider configuration
- `conversations/`: session history
- `skills/`: local skills
- `web-apps/`: sandbox apps (`id/version`)
- `logs/app.log`: runtime logs

## Documentation

See **[docs/README.md](./docs/README.md)** for the full docs hub.

Quick links:

- [Optimization Roadmap](./docs/OPTIMIZATION-ROADMAP.md)
- [Cognitive Plan](./docs/plans/agent-cognitive-architecture-plan.md)
- [Capability Routing Plan](./docs/plans/agent-capability-routing.md)
- [Message Contract](./docs/MESSAGE-CONTRACT.md)
- [Gateway WebSocket](./docs/GATEWAY-WEBSOCKET.md)
- [Web Sandbox Design](./docs/WEB-APPS-SANDBOX-DESIGN.md)
- [Skills / ClawHub Compatibility](./docs/SKILLS-PACK-COMPAT.md)

Sidebar **Apps**:

- Library: `/web-apps`
- Fullscreen preview: `/app-open`
- Studio: `/web-app-studio`

---

If you need AI that executes and delivers, not just responds, OpenUltron is built for that.
