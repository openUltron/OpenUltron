# Gateway WebSocket 协议（摘要）

默认监听 **`127.0.0.1:28790`**（与 UI 端口分离）。仅 JSON 文本帧。

## 客户端 → 服务端

| `type` | 说明 |
|--------|------|
| `chat` | 字段：`sessionId?`、`projectPath?`、`messages`、`model?`、`tools?`、`fromAppWindow?`；可选 `id` 作为 `requestId` 回传 |
| `ping` | 服务端回 `{ event: 'pong' }` |
| `config` / `cron` / `presence` | 查询类，见 `electron/ai/gateway.js` |

## 服务端 → 客户端（`chat` 会话期间）

与主窗口 IPC 事件对齐，并统一带 **`runId`**（单次 `startChat` 标识）：

| `event` | 主要字段 |
|---------|-----------|
| `token` | `token`、`runId?`、`requestId?` |
| `tool_call` | `toolCall`（含 `id`/`name`/`arguments`）、`runId?` |
| `tool_result` | **`toolCallId`、`name`、`result`**（字符串）、`runId?` |
| `usage` | `iteration`、`usage`（token 分解）、`runId?` |
| `complete` | `messages`（完整会话数组）、`runId?` |
| `error` | `error` 文案、`runId?` |

**兼容说明**：旧版曾错误使用嵌套 `toolResult`；当前以 **扁平 `toolCallId` + `result`** 为准（与 `ai-chat-tool-result` IPC 一致）。

实现参考：`electron/ai/gateway-ws-events.js`（映射函数）、`electron/ai/gateway.js`。
