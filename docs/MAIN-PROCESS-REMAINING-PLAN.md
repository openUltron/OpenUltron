# 主进程拆分：剩余工作与收尾计划

本文与 [`MAIN-PROCESS-MODULARIZATION.md`](./MAIN-PROCESS-MODULARIZATION.md) 配套：**已拆模块**见该文 §10；此处列出 **尚未迁出内容** 与 **建议执行顺序**，目标是把 `electron/main.js` 收敛为「生命周期 + 聚合注册 + 少量无法外移的胶水」。

> 统计口径：AI 域大量 channel 已迁入 `main-process/ipc/ai/*`，`main.js` 内 **字面量** `registerChannel('...')` 应极少；仍以 `rg "registerChannel\\(" electron/main.js` 对照（多为子模块形参名）。

---

## 一、已完成（便于对照）

| 模块路径 | 覆盖范围 |
|----------|----------|
| `main-process/inbound-model-command.js` | 渠道 `/model`、全局默认模型 |
| `main-process/ipc/window-logs-notifications.js` | 日志、窗口、刷新、通知、`get-api-base-url` |
| `main-process/ipc/store-config-snapshot.js` | `savedConfigs` / `current-config-*` |
| `main-process/ipc/fs-dialog-basic.js` | 基础打开保存对话框、小文件读写 |
| `main-process/ipc/shell-spawn-command.js` | `execute-command*`、`kill-command-process`、Git lock |
| `main-process/ipc/external-open.js` | Cursor、终端、访达、`openExternal` |
| `main-process/ipc/browser-favorites-passwords.js` | 内置浏览器收藏与密码 |
| `main-process/ipc/browser-extensions.js` | Chrome 扩展加载/列表/开关（`persist:main`） |
| `main-process/register-channel.js` | `createRegisterChannel`（IPC + invokeRegistry） |
| `main-process/ipc/coze-ipc.js` + `electron/coze/commit-message.js` | 扣子配置、commit、auth |
| `main-process/ipc/workspace-ipc.js` | `workspace-*` |
| `main-process/ipc/web-apps-settings-ipc.js` | Web 应用 AI 设置、`web-apps-update-name` |
| `main-process/ipc/agent-md-ipc.js` | Agent / 记忆 MD 路径与打开 |
| `main-process/ipc/cron-ipc.js` | `cron-*` |
| `main-process/ipc/skills-ipc.js` | 技能 CRUD |
| `main-process/ipc/mcp-admin-ipc.js` | MCP 管理 IPC |
| `main-process/ipc/backup-ipc.js` | 备份 / 技能包 ZIP |
| `main-process/ipc/ai/gateway-session-ipc.js` | Gateway URL、当前会话上报 |
| `main-process/ipc/channels-im-ipc.js` | 飞书/TG/钉钉 状态与配置、Doctor、Webhook、飞书通知/OAuth/发消息等 |
| `main-process/ipc/ai/session-constants.js` | 会话 project 常量、`SESSION_SOURCES` |
| `main-process/ipc/ai/chat-history-helpers.js` | 落库前产物/剥离/压缩合并 + `stripRawToolCallXml` |
| `main-process/ipc/ai/ai-history-ipc.js` | 聊天历史落库、摘要、会话列表、evolve；导出 `triggerAutoEvolveFromSession` |
| `main-process/ipc/ai/ai-verify-model-ipc.js` | `ai-verify-model` |
| `main-process/ipc/ai/ai-config-proxy-ipc.js` | 配置 / 代理 / onboarding / 备份 / 用量 / `ai-generate-commit-message` |
| `main-process/ipc/ai/ai-models-ipc.js` | `ai-fetch-models`、`ai-get-models` |
| `main-process/ipc/ai/ai-tools-attachments-ipc.js` | 工具列表、视觉能力、附件上传 |
| `main-process/ipc/ai/ai-chat-session-ipc.js` | 对话启停、会话注册与 `ai-editor-open-files-response` |
| `main-process/ipc/ai/ai-external-subagents-ipc.js` | `ai-list-external-subagents` |
| `electron/ai/inbound-message-text.js` | 飞书/TG/钉钉 入站侧文本与截图解析（`createInboundMessageTextHelpers`） |
| `main-process/ipc/ai/gateway-side-effects.js` | Gateway 截图缓冲、会话落库、飞书应用内完成回发、`eventBus.emit` |
| `main-process/channel-run-state.js` | IM 渠道 run 队列状态、`stop_previous_task` / `wait_for_previous_run` 依赖 |
| `main-process/ipc/channels-session-completed-send.js` | `chat.session.completed` → 渠道发送与飞书失败提示 |
| `main-process/im-tool-call-format.js` | 工具调用参数解析与命令行摘要（与 `runMainAgentDirectRetry` 等共用） |
| `main-process/im-channel-message-pipeline.js` | IM 入站 `chat.message.received` → 协调 run + `aiGateway.runChat` + 回发 |
| `main-process/im-channel-artifacts.js` | IM 渠道 artifact 登记、飞书链接引用、会话内产物记忆 |
| `main-process/im-channel-session-page-target.js` | 主会话最近 HTML 文件 / URL 推断（`sessions_spawn` 上下文） |
| `main-process/ai-chat-tools-access.js` | Gateway/子 Agent/附件 IPC 共用的工具列表与协调 Agent 系统提示 |
| `main-process/im-channel-master-agent-fallbacks.js` | Gateway 侧兜底文案、`runMainAgentDirectRetry`（协调空结果直跑） |

---

## 二、剩余工作总览（按域）

| 域 | 大致 channel 范围 | 体量 | 依赖特点 |
|----|-------------------|------|----------|
| **C. AI 核心（仍多在 main）** | 多数 `ai-*` IPC 已迁 `ipc/ai/*`；**仍在 main**：`aiGateway` 创建与编排闭包、子 Agent 派发、`getToolsForChat` 等与飞书入站交织的逻辑 | **中** | `Orchestrator`、`aiToolRegistry`、`createGateway`、渠道消息处理 |
| **D. 飞书接收大段（非薄 IPC）** | `main.js` 内 **飞书长连接 → `handleChatMessageReceived` 等** 仍与 AI 编排交织；薄 IPC 已迁 `channels-im-ipc.js` | 大 | 可先下沉 `inbound-coordinator` 再削 main |
| **J. Bootstrap / lifecycle** | `app.whenReady` 内 protocol、API Server、Gateway 冷启动等（可选 `main-process/bootstrap/`） | 中 | 与窗口、协议注册顺序相关 |

另：**非 `registerChannel` 但仍占行数**的内容需单独规划（不必与 IPC 同文件）：

- `app.whenReady` 内 `protocol`、`webviewSession`、API Server、Gateway、MCP、Feishu 冷启动等  
- `web-contents-created` / 菜单 / `createWindow`  
→ 可后续单独立项「**bootstrap / lifecycle**」文件，与 IPC 拆分正交。

---

## 三、分阶段执行计划（建议顺序）

原则：**每阶段一个可合并 PR**；迁出后 **channel 名、入参、返回值、事件名不变**；优先 **低耦合 → 高耦合**。

### 阶段 1 — 扩展（低风险）✅ 已落地

- **产出**：`main-process/ipc/browser-extensions.js`
- **动作**：`get-extensions` … `remove-extension` + 启动后清空 `loadedExtensions` 的 `setTimeout` 与原逻辑一致
- **验收**：加载/开关/卸载扩展与现网一致

### 阶段 2 — Coze（中风险）✅ 已落地

- **产出**：`main-process/ipc/coze-ipc.js` + 可选 `electron/coze/commit-message.js`（纯函数）
- **动作**：配置类 channel 先行；`coze-generate-commit-message` 内联的 diff 解析等迁到 `electron/coze/` 再 IPC 薄封装
- **验收**：配置保存、生成 commit message、logout

### 阶段 3 — Workspace + Web 应用 AI 设置 + 记忆 Markdown（低风险、快赢）✅ 已落地

- **产出**：`workspace-ipc.js`、`web-apps-settings-ipc.js`、`agent-md-ipc.js`
- **动作**：依赖面窄，可并行两个 PR
- **验收**：工作区增删路径、Web 应用设置、打开 SOUL/USER/BOOT/IDENTITY

### 阶段 4 — Cron（中风险）✅ 已落地

- **产出**：`cron-ipc.js`
- **动作**：注入 `cronScheduler`、`feishuNotify`、`appLogger`；注意与飞书配置读取顺序
- **验收**：列表、增删改、立即运行、飞书 refresh 任务确保

### 阶段 5 — 技能 / MCP / 备份包（中大）✅ 已落地

- **产出**：`skills-ipc.js`、`mcp-admin-ipc.js`、`backup-ipc.js`
- **动作**：每个文件 `register*(deps)`；大段 JSON 读写保持与现逻辑一致
- **验收**：技能 CRUD、MCP 配置与重连、备份导出/导入/预览

### 阶段 6 — AI 巨型块（分段拆，避免单次 PR 过大）🔄 收尾

- **已迁**：`gateway-session-ipc.js`；`chat-history-helpers.js` + `ai-history-ipc.js`；`ai-verify-model-ipc.js`；`ai-config-proxy-ipc.js`；`ai-models-ipc.js`；`ai-tools-attachments-ipc.js`；`ai-chat-session-ipc.js`；`ai-external-subagents-ipc.js`（均由 `main.js` 注入 `registerChannel` 与依赖后注册）。
- **仍在 main**：`createGateway` 的端口/Orchestrator/工具列表等装配、子 Agent 派发、`getToolsForChat` / `modelSupportsVision`、飞书 `handleChatMessageReceived` 大段；Gateway 副作用回调已迁 `gateway-side-effects.js`。

建议 **自下而上**（余量）：

1. ~~**配置与模型**~~：✅ 见 `ai-config-proxy-ipc.js`、`ai-models-ipc.js`、`ai-verify-model-ipc.js`
2. ~~**工具与附件**~~：✅ `ai-tools-attachments-ipc.js`
3. ~~**Orchestrator 会话**~~：✅ `ai-chat-session-ipc.js`
4. ~~**历史与持久化**~~：✅ `ai-history-ipc.js`
5. **Gateway / 当前会话**：URL 上报已在 `gateway-session-ipc.js`；`createGateway` 本体仍在 main
6. ~~**子 Agent 列表**~~：✅ `ai-external-subagents-ipc.js`

**依赖策略**：引入 `main-process/deps/ai-context.js` 或构造函数参数对象，**禁止**子模块 `require('../main.js')`。

### 阶段 7 — 渠道与 IM（最后）🔄 薄 IPC 已迁

- **已迁**：`main-process/ipc/channels-im-ipc.js`（状态、Doctor、Webhook、飞书配置/OAuth/发消息、TG/钉钉配置等）。
- **仍在 main**：飞书 **接收与消息处理大段**（长连接、`handleChatMessageReceived` 等）。
- **可选再拆**：`feishu-inbound-*.js` 等，与 AI 编排解耦后再迁。
- **原因**：与 AI 会话、artifact、`handleChatMessageReceived` 类大闭包交织，最后拆成本最低
- **动作**：可先把「仅读写 config + 启停连接」与「消息处理」分层到不同文件

### 阶段 8 — `main.js` 瘦身为入口（收尾）🔄 部分

- **已做**：`registerChannel` 迁入 **`main-process/register-channel.js`**（`createRegisterChannel`）。
- **待做**：`app.whenReady` / protocol / window 等迁入 **`main-process/bootstrap/`**（可选）。

---

## 四、质量与协作约定

- 每 PR：`node --check electron/main.js` + 手工烟测本域关键路径  
- 逻辑变更与「搬家」分开提交（必要时两个 commit）  
- 更新 [`MAIN-PROCESS-MODULARIZATION.md`](./MAIN-PROCESS-MODULARIZATION.md) §10 进度表  
- 自动化：对迁出的纯函数（如 Coze diff 解析、`isGitWriteCommand` 同类）补 **Vitest**（与路线图 P0 一致）

---

## 五、里程碑对照（建议）

| 里程碑 | 标志 |
|--------|------|
| M1 | 扩展 + Coze + Workspace + Cron + 记忆 MD 全部外移 |
| M2 | 技能/MCP/备份 IPC 外移 |
| M3 | AI 配置/模型/工具层外移 |
| M4 | AI 聊天与会话层外移 |
| M5 | 渠道 Feishu/Telegram/Dingtalk 外移 |
| M6 | `main.js` &lt; ~1500 行且职责仅为 bootstrap + 注册 |

---

## 六、文档维护

完成某阶段后：在本文件对应阶段标题下勾选 **「已完成 + 合并提交 SHA」**，并同步 `OPTIMIZATION-ROADMAP.md` P2 描述。
