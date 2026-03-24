# OpenUltron

中文 | [English](./README.en.md)

OpenUltron 是一个 **Execution-First AI Desktop Agent Platform**。  
它把“聊天”升级为“执行与交付”：在一个本地桌面工作台内，完成任务理解、工具调用、结果产出与渠道回传。

> **Request -> Execute -> Deliver**

## Hero

### 让 AI 真的帮你把事做完

- 不只是回答问题，而是执行命令、写文件、调用工具、生成产物
- 不只是一次对话，而是可持续会话、记忆、日志与恢复
- 不只是单模型，而是多模型、多供应商、可治理的调度系统

### 产品定位

OpenUltron 面向“高频任务执行”场景：开发、运营、自动化和跨渠道协作。  
你提需求，AI 在可控边界内执行，并把可验证结果返回给你。

## Feature Highlights

### Execution Engine

- 内置工具链：`execute_command`、`file_operation`、`apply_patch`、Web 工具等
- MCP 扩展：可接入自定义工具与外部能力
- 子任务分发：`sessions_spawn` 多 Agent 协作

### Model Orchestration

- 多供应商配置（OpenAI 兼容）
- 模型池 + 模型绑定 + fallback 路由
- 不可用模型会话/全局缓存，避免重复失败重试

### Workspace & Delivery

- Web 沙箱应用工作室：`/web-app-studio`（左预览 + 右 AI）
- 渠道协作：飞书 / Telegram / 钉钉
- 定时任务：周期执行自动化流程

### Reliability & Governance

- 本地优先：数据默认存储在 `~/.openultron/`
- 边界控制：路径与沙箱约束（特别是 Web Apps）
- 可观测性：runId、trace、日志、错误归因

## Capability Matrix

| 能力域 | OpenUltron |
|---|---|
| 任务理解 | 对话 + 上下文记忆 |
| 任务执行 | 命令 / 文件 / 工具 / MCP |
| 编排调度 | 会话状态机 + fallback + retry |
| 结果交付 | 本地产物 + IM 渠道回传 |
| 过程治理 | 沙箱、权限约束、日志审计 |
| 持续自动化 | 子 Agent、Gateway、定时任务 |

## Typical Scenarios

- **开发提效**：生成原型、修复脚本、批量改动、输出交付文件
- **运营执行**：内容生成、整理总结、自动回传渠道
- **团队协作**：在桌面执行，在 IM 会话同步结果
- **个人自动化**：把重复任务交给调度与定时任务

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

1. 在“设置 -> 配置”填写 Provider Key / Base URL  
2. 选择主模型（或在对话中用 `/model`）  
3. 接入需要的渠道（飞书 / Telegram / 钉钉）  
4. 发起任务并观察执行链路与产出结果

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

默认目录：`~/.openultron/`

- `openultron.json`：模型/供应商配置
- `conversations/`：会话历史
- `skills/`：本地技能
- `web-apps/`：沙箱应用（`id/version`）
- `logs/app.log`：运行日志

## Docs

文档总索引：[`docs/README.md`](./docs/README.md)

- [优化路线图](./docs/OPTIMIZATION-ROADMAP.md)
- [认知层计划](./docs/plans/agent-cognitive-architecture-plan.md)
- [消息契约](./docs/MESSAGE-CONTRACT.md)
- [Gateway WebSocket](./docs/GATEWAY-WEBSOCKET.md)
- [Web 沙箱设计](./docs/WEB-APPS-SANDBOX-DESIGN.md)
- [Web 沙箱 IPC](./docs/WEB-APPS-IPC-REFERENCE.md)
- [技能包兼容](./docs/SKILLS-PACK-COMPAT.md)
- [Codex 与 Chat Completions 说明](./docs/OPENAI-CODEX-AND-CHAT-COMPLETIONS.md)

## Roadmap (High Level)

- 更细粒度策略控制（工具/路径/网络域名）
- 更完整的可观测面板（执行链路可视化）
- 更强的多 Agent 协作编排与恢复机制

---

如果你想要的是“能执行、能交付、能持续协作”的 AI 桌面平台，OpenUltron 就是为此而生。
