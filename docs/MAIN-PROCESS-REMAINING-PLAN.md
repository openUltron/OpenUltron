# 主进程拆分：剩余工作与收尾计划

本文与 [`MAIN-PROCESS-MODULARIZATION.md`](./MAIN-PROCESS-MODULARIZATION.md) 配套：**已拆模块**见该文 §10；此处列出 **尚未迁出内容** 与 **建议执行顺序**，目标是把 `electron/main.js` 收敛为「生命周期 + 聚合注册 + 少量无法外移的胶水」。

> 统计口径：`main.js` 内仍约有 **~90+ 条** `registerChannel(...)`（随分支略有浮动；阶段 1 完成后减少 7 条，以 `rg "^registerChannel\\(" electron/main.js` 为准）。

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

---

## 二、剩余工作总览（按域）

| 域 | 大致 channel 范围 | 体量 | 依赖特点 |
|----|-------------------|------|----------|
| **A. 浏览器扩展** | `get-extensions` … `remove-extension` | 中 | `session`、`path`、`fs`、`dialog`、`store` |
| **B. 扣子 Coze** | `get/save-coze-config`、`coze-generate-commit-message`、`coze-check-auth`、`coze-logout` | 中大 | `store`、HTTPS、`COZE_API_URL`；`coze-generate-*` 内含大块辅助逻辑，**宜先抽纯函数到 `electron/coze/`** |
| **C. AI 核心** | `ai-*`、`get-gateway-ws-url`、会话/聊天/历史/模型/工具/MCP/备份等 | **极大** | `Orchestrator`、`aiConfigFile`、`memoryStore`、`conversationFile`、全局 `aiGateway`、大量闭包 |
| **D. 渠道与集成** | `feishu-*`、`telegram-*`、`dingtalk-*`、`webhook-trigger`、`doctor-run`、`dingtalk-inbound` | 大 | 与 C 强耦合；**宜在 AI 子模块稳定后再动** |
| **E. Web 应用设置** | `web-apps-get/set-ai-settings` | 小 | `store` 或独立配置 |
| **F. 技能 / MCP / 备份** | `ai-get-skills` … `ai-import-skills-pack`、`ai-get-mcp-*` … | 大 | `skillPack`、`mcpConfigFile`、`fs`、`dialog`、`getAppRootPath` |
| **G. 记忆 Markdown** | `ai-get-*-md-path`、`ai-open-*-md`、`ai-get-agent-display-name` | 小 | `memoryStore`、`ensureAndOpenMd`、常量路径 |
| **H. Cron** | `cron-*` | 中 | `cronScheduler`、`feishuNotify`、`appLogger` |
| **I. Workspace** | `workspace-*` | 小 | `store`、`dialog`、`getWorkspace*`、`ensureWorkspaceDirs` |

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

### 阶段 2 — Coze（中风险）

- **产出**：`main-process/ipc/coze-ipc.js` + 可选 `electron/coze/commit-message.js`（纯函数）
- **动作**：配置类 channel 先行；`coze-generate-commit-message` 内联的 diff 解析等迁到 `electron/coze/` 再 IPC 薄封装
- **验收**：配置保存、生成 commit message、logout

### 阶段 3 — Workspace + Web 应用 AI 设置 + 记忆 Markdown（低风险、快赢）

- **产出**：`workspace-ipc.js`、`web-apps-ai-settings-ipc.js`、`agent-memory-md-ipc.js`
- **动作**：依赖面窄，可并行两个 PR
- **验收**：工作区增删路径、Web 应用设置、打开 SOUL/USER/BOOT/IDENTITY

### 阶段 4 — Cron（中风险）

- **产出**：`cron-ipc.js`
- **动作**：注入 `cronScheduler`、`feishuNotify`、`appLogger`；注意与飞书配置读取顺序
- **验收**：列表、增删改、立即运行、飞书 refresh 任务确保

### 阶段 5 — 技能 / MCP / 备份包（中大）

- **产出**：`skills-ipc.js`、`mcp-settings-ipc.js`、`backup-ipc.js`（或按文件行数再拆）
- **动作**：每个文件 `register*(deps)`；大段 JSON 读写保持与现逻辑一致
- **验收**：技能 CRUD、MCP 配置与重连、备份导出/导入/预览

### 阶段 6 — AI 巨型块（分段拆，避免单次 PR 过大）

建议 **自下而上**：

1. **配置与模型**：`ai-save-config`、`ai-fetch-models`、`ai-get-models`、`ai-verify-model`、`proxy-*`、`ai-get-config*`、`onboarding`、usage/billing（能用的继续用 `ai-config-normalize`）
2. **工具与附件**：`ai-get-tools`、`ai-model-supports-vision`、`ai-upload-attachments`
3. **Orchestrator 会话**：`ai-chat-start/stop`、session register/list/pause/…、`ai-editor-open-files-response`（依赖 `Orchestrator` 单例或工厂注入）
4. **历史与持久化**：`ai-save/load-chat-history`、conversations、sessions、evolve 等（`conversationFile`、`memoryStore`）
5. **Gateway / 当前会话**：`get-gateway-ws-url`、`ai-report-current-session`、`ai-get-current-session`
6. **子 Agent 列表**：`ai-list-external-subagents`（若体积大可单独文件）

**依赖策略**：引入 `main-process/deps/ai-context.js` 或构造函数参数对象，**禁止**子模块 `require('../main.js')`。

### 阶段 7 — 渠道与 IM（最后）

- **产出**：`feishu-ipc.js`、`telegram-ipc.js`、`dingtalk-ipc.js`、`webhook-doctor-ipc.js` 等
- **原因**：与 AI 会话、artifact、`handleChatMessageReceived` 类大闭包交织，最后拆成本最低
- **动作**：可先把「仅读写 config + 启停连接」与「消息处理」分层到不同文件

### 阶段 8 — `main.js` 瘦身为入口（收尾）

- **目标**：`main.js` 主要保留：`registerChannel` 定义（或迁入 `register-channel.js`）、`app` 生命周期、`createWindow`、按序 `require(...).register*(deps)`  
- **可选**：`electron/main-process/bootstrap/` 下 `protocol.js`、`api-server.js`、`window.js`

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
