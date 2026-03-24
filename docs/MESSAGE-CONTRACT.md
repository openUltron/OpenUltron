# 内部消息契约（AI 对话管线）

供主进程编排、渲染端历史、Gateway、IM 渠道共用概念模型。新功能**优先**把扩展字段放进 `meta`，避免在消息根上继续堆积 `_*` 字段。

---

## 1. 标准字段（与 OpenAI Chat 对齐部分）

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `'system' \| 'user' \| 'assistant' \| 'tool'` | 必填 |
| `content` | `string` 或多模态片段数组 | 依供应商而定 |
| `tool_calls` / `toolCalls` | 数组 | assistant 轮次上的工具调用 |
| `tool_call_id` | string | tool 角色消息必填（部分网关会补全） |

---

## 2. 推荐扩展：`meta`（可选）

新增 UI 或渠道专用信息时，使用：

```js
{
  role: 'user',
  content: '...',
  meta: {
    channel: 'feishu',
    displayContent: '...',
    summaryKind: 'session_handoff'
  }
}
```

| `meta` 键 | 用途 |
|-----------|------|
| `channel` | `main` / `feishu` / `telegram` / `gateway` 等 |
| `runId` | 与 `createChatRunId` 一致，贯穿 token/complete 日志 |
| `displayContent` | 用户可见文本与送模型文本不一致时使用 |
| `summaryKind` | `compress` / `session_handoff` / `conversation_list`（便于日志与排查） |

**遗留字段（存量代码，新代码勿仿效）**

- `_hideInUI`：不在列表中展示该条（如系统注入的循环提示）。
- `_uiKey`：前端列表稳定 key。

迁移策略（M8）：新注入同时设置 **`meta.hideInUI`** 与 `_hideInUI`；`ChatPanel` 列表过滤已识别二者。后续可逐步去掉 `_hideInUI`。新代码优先 `meta.uiKey`（待统一）。

---

## 3. 工具结果与 Envelope

工具返回体若为 JSON 字符串，可含：

- `envelope`：`execution-envelope.js` 产出的统一成功/失败/产物结构（子 Agent、`sessions_spawn` 等）。

解析与展示应优先读 `envelope.success` / `envelope.error.code`，避免被乐观 `result` 文本误导（与 `inbound-message-text.js` 策略一致）。

---

## 4. EventBus 与异步

核心事件见 `electron/core/events.js`。

- **`emit`**：同步调用 handlers；若某 handler 返回 Promise，`emit` **不会**等待其结束（见该文件注释）。
- **需要多订阅者且须 await**：使用 **`emitAsync`**，或引入显式 pipeline / 中间件。

**已用 `emitAsync` 并 `await` 的路径**（M7）：`chat.session.completed`（IM `im-channel-message-pipeline`、Gateway 飞书回发）、`chat.message.received`（Feishu / Telegram / DingTalk adapters）。

新增「上下文 hook」类能力前，先选定上述之一并在本文档与 `events.js` 中保持一致。

---

## 6. 压缩摘要 vs 会话延续摘要（易混概念）

| 机制 | 作用 | 典型落点 |
|------|------|----------|
| **上下文压缩** | 长对话超过 token 阈值时，将早期消息压成一条 system 摘要，**同一会话内**继续聊 | `context-compressor.js` → 消息内 `[对话摘要（早期消息已压缩）]` |
| **会话延续** | **新开一条会话**时，把上一会话的归档摘要塞进首条 system，继承意图 | 主窗口 `carrySummaryForNextSession`（如 `ChatPanel.vue`） |

二者目的不同：前者省 token；后者跨 session 继承。日志中可用 `meta.summaryKind`: `compress` / `session_handoff` 区分（逐步落地）。

---

## 7. 关联文档

- `docs/plans/agent-cognitive-architecture-plan.md` — 认知层当前状态与下一阶段行动项  
- `docs/plans/README.md` — `plans/` 下其它专项索引  
