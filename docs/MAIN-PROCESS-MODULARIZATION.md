# 主进程 `main.js` 模块化拆分蓝图

`electron/main.js` 体量极大（约 1 万行），集中了 **IPC、`registerChannel`、渠道编排、AI 编排、浏览器/扩展、文件与终端** 等逻辑。本文说明 **如何按域拆分**、**依赖方向**、**迁移顺序与风险**，与 `OPTIMIZATION-ROADMAP.md` P2 对齐。

**剩余 channel 与分阶段收尾清单**：见 [`MAIN-PROCESS-REMAINING-PLAN.md`](./MAIN-PROCESS-REMAINING-PLAN.md)（`main.js` 内 **直接** `registerChannel('...')` 已基本迁出；仍以 `rg "registerChannel\\(" electron/main.js` 为准，多为注入到子模块的变量名）。

---

## 1. 为什么要拆

| 问题 | 说明 |
|------|------|
| **认知成本** | 单文件难以建立心智模型，新人难以下手。 |
| **合并冲突** | 多人改同一 `main.js` 易冲突。 |
| **可测性** | 大段逻辑与闭包变量耦合，难以对单域做单测。 |
| **循环依赖** | 随意 `require` 子模块再被 `main` 引用，易出现隐式环。 |

拆分目标不是「文件变多就好」，而是 **边界清晰 + 依赖单向 + 每步可回归**。

---

## 2. 推荐目录与职责

在 `electron/` 下增加 **`main-process/`**（或 `ipc/`，二选一即可，避免两套并存）：

```
electron/
  main.js                    # 入口：app 生命周期、全局单例、聚合注册
  main-process/
    register-channel.js      # 可选：封装 ipcMain.handle + invokeRegistry（与现 registerChannel 一致）
    deps.js                  # 可选：集中导出 app/store/mainWindow 等（慎用，防成上帝对象）
    inbound-model-command.js # 已存在：渠道 /model 解析与全局默认模型
    skills-runtime.js        # 已存在：~/.openultron/skills 读写、内置技能初始化、chokidar 热刷新与缓存
    mcp-http-bridge.js       # 已存在：本地 HTTP `/mcp` 桥（open_file / open_diff / refresh）
    mcp-json-config.js       # 已存在：解析 mcp.json、合并内置 chrome-devtools MCP
    main-window.js           # 已存在：主窗口、生产 dist 静态服务、应用菜单
    proxy-and-ai-config-helpers.js # 已存在：系统代理写入 env、contextCompression/toolDefinitions 合并
    local-resource-protocol.js # 已存在：local-resource:// 双分区注册 + web-apps guest session
    ai-resolved-config.js    # 已存在：getResolvedAIConfig / getResolvedAIConfigForProvider
    verify-provider-model.js # 已存在：verifyProviderModel（Anthropic / OpenAI responses / chat/completions）
    ai-chat-artifacts.js     # 已存在：registerImageBase64ForChat、registerScreenshotFilePathForChat
    ai-configured-providers.js # 已存在：getConfiguredProvidersWithKey、orderProvidersForModel（模型验证 IPC）
    external-subagent-cli.js # 已存在：EXTERNAL_SUBAGENT_SPECS、runCliCommand、scanExternalSubAgents、代理 env 变体
    subagent-dispatch.js     # 已存在：sessions_spawn 派发（internal / 外部 CLI、超时、commandLogs）
    ipc/                     # 按域拆分的「只负责 registerChannel」模块
      window-logs-notifications.js # 已存在：log/logs-*、window-*、refresh、系统通知、get-api-base-url
      store-config-snapshot.js     # 已存在：delete-saved-config、get/set-current-config
      fs-dialog-basic.js           # 已存在：show-open/save-dialog、read-file、save-file、read-image-as-base64
      shell-spawn-command.js       # 已存在：execute-command、execute-command-realtime、kill-command-process、Git index.lock
      external-open.js             # 已存在：open-cursor、open-terminal、get-available-terminals、open-in-finder、open-external
      browser-favorites-passwords.js # 已存在：浏览器收藏 CRUD/导入导出、密码相关 IPC
      browser-extensions.js          # 已存在：Chrome 扩展加载/列表/开关/卸载（persist:main）
      window-shell.js        # （可选后续）与上并列时再细分
      fs-dialog.js           # （命名占位）更多文件类 IPC 可并入或拆出
      terminal-process.js    # execute-command、PTY、kill
      browser-favorites.js   # 收藏夹 CRUD
      browser-passwords.js   # 密码管理
      extensions.js          # 扩展加载
      coze.js                # 扣子相关 IPC
      ai-config.js           # ai-get/save-config、模型列表缓存、proxy
      ai-chat-sessions.js      # ai-chat-start/stop、session 注册/列表
      ai-history.js          # 会话持久化、summary、evolve
      channels-feishu.js       # feishu-*、与其它 IM 并列时可再拆
      ...
```

**原则**：

- **`main.js` 只做**：`app.on('ready')` / `window-all-closed` / `protocol`、创建 `BrowserWindow`、按顺序 `require('./main-process/ipc/xxx')(deps)`。
- **每个 `ipc/*.js` 导出** 形如 `function registerXxxIpc(deps) { ... registerChannel(...) }`，**不**在模块顶层读尚未初始化的变量。

---

## 3. 按 `registerChannel` 划域（当前主文件中的大致分组）

下列分组便于排期；具体 channel 名以代码为准，可用 `rg "^registerChannel\\(" electron/main.js` 刷新列表。

| 域 | 典型 channel / 职责 | 依赖 |
|----|---------------------|------|
| **日志** | `log-to-frontend`, `logs-*` | logger、路径 |
| **窗口/UI** | `window-*`, `toggle-maximize`, `send-refresh-on-focus`, `show-system-notification` | `BrowserWindow`、主窗口引用 |
| **配置快照** | `get/set-current-config`, `delete-saved-config` | store、路径 |
| **文件/对话框** | `show-open-dialog`, `read-file`, `save-file`, `read-image-as-base64` | `dialog`, `fs` |
| **命令/终端** | `execute-command*`, `kill-command-process`, `open-terminal`, `open-cursor`, `open-in-finder`, `open-external` | `child_process`, `pty`, 路径 |
| **内置浏览器** | `get-browser-favorites`, 密码相关、导入导出 | store / 加密存储 |
| **扩展** | `get-extensions`, `load-extension-*`, `toggle/remove-extension` | session、路径 |
| **Coze** | `get/save-coze-config`, `coze-generate-commit-message` | HTTP、配置 |
| **AI 核心** | `ai-verify-model`, `ai-fetch-models`, `ai-get-models`, `ai-save-config`, `ai-chat-*`, session 系列, Gateway URL, MCP 相关 | `Orchestrator`、配置文件、`store`、多窗口广播 |
| **渠道/IM** | `feishu-*`, `telegram-*`, 钉钉等 | 与 AI、会话文件、artifact 强耦合，**宜后置**或子模块内再分层 |
| **其它** | Web Apps、本地协议、HTTP API 注册 | 与 `protocol`、`web-apps` 包协作 |

**AI 域** 仍过大时，可再拆三层：

1. **纯函数 / 无 Electron**：请求体构建、错误分类 → 已有 `electron/ai/*` 继续承接。  
2. **读配置 + 写盘**：`ai-config-file`、`ai-config-normalize`（已抽）。  
3. **IPC 粘合**：仅 `registerChannel` + 调用 1、2。

---

## 4. 依赖方向（禁止循环引用）

建议自上而下：

```
main.js
  → main-process/ipc/*.js（注册 IPC）
  → electron/ai/*、electron/api/*、electron/web-apps/*（业务实现）
  → Node 内置 / electron API
```

**规则**：

- `electron/ai/*` **不要** `require('../main.js')` 或 `require('../main-process/ipc/ai-chat')`。  
- 需要回调主进程能力时，通过 **注入** `deps`（例如 `broadcastAiConfigUpdated`、`getMainWindow`）传入，而不是反向 require。

---

## 5. 迁移顺序（建议）

按 **风险从低到高**、**耦合从弱到强**：

1. **已完成 / 可做**  
   - 配置规范化：`ai-config-normalize.js`。  
   - 渠道 `/model`：`main-process/inbound-model-command.js`（依赖注入 `app/store/BrowserWindow/aiConfigFile`）。

2. **第一批 IPC 迁出（闭包少、少共享状态）**  
   - 日志、窗口最小化/关闭、系统通知。  
   - 文件对话框、单次读写（注意与现有 `registerChannel` + `invokeRegistry` 双注册保持一致）。

3. **第二批**  
   - 浏览器收藏夹/密码、扩展加载（依赖 `session`、路径工具）。

4. **第三批**  
   - Coze、Proxy、AI 配置类 IPC（与 `aiConfigFile`、`store` 强相关，但边界仍清晰）。

5. **最后**  
   - `ai-chat-start`、Orchestrator 全链路、Feishu/Telegram 大函数体（通常与 `conversationFile`、`artifactRegistry`、会话 ID 交织）。  
   - 策略：**先**把内部大块逻辑迁到 `electron/ai/channels/*.js` 或 `electron/feishu/*.js`，**再**让 `main` 里只剩几行 `registerChannel`。

每一步：**行为不变**（channel 名、入参、返回值、向渲染进程 `webContents.send` 的事件名不变）。

---

## 6. 单步 PR 检查清单

- [ ] 新增模块仅通过 `deps` 使用 `app` / `store` / `BrowserWindow` / 配置模块。  
- [ ] `registerChannel` 与 `invokeRegistry` 仍同时注册（若项目依赖 HTTP `/api/invoke`）。  
- [ ] `node --check electron/main.js` 通过。  
- [ ] 手工或自动化：覆盖本域至少一条关键路径（如保存 AI 配置、发一条渠道消息）。  
- [ ] 文档：在 `OPTIMIZATION-ROADMAP.md` 或本文档「进度」打勾。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 初始化顺序 | IPC 注册函数在 `app.whenReady` 内、且在所有 `deps` 可用之后调用。 |
| 隐式全局 | 减少 `main.js` 顶层 `let x` 被深层闭包依赖；迁出时改为显式传入 `deps`。 |
| 行为漂移 | 拆分时禁止顺手改业务逻辑；逻辑变更单独 PR。 |
| 测试缺口 | 优先给迁出的纯函数写 Vitest（如 `parseInboundModelCommand`）。 |

---

## 8. 与入口 `main.js` 的最终关系（目标态）

```text
// main.js（示意）
const { app, BrowserWindow } = require('electron')
const store = ...
require('./main-process/ipc/window-shell').register({ app, registerChannel, ... })
require('./main-process/ipc/ai-config').register({ app, store, registerChannel, aiConfigFile, ... })
// ...
```

`registerChannel` 可保留在 `main.js`，或抽到 `main-process/register-channel.js` 再传入各模块，避免循环依赖。

---

## 9. 文档维护

大域拆分落地后，在本文件末尾追加 **「进度」** 小节（日期、PR、已迁出文件列表），并同步 `OPTIMIZATION-ROADMAP.md` P2。

---

## 10. 进度（已迁出）

| 日期 | 文件 | 说明 |
|------|------|------|
| — | `main-process/inbound-model-command.js` | 渠道 `/model`、`applyGlobalDefaultModel` |
| 2026-03-19 | `main-process/ipc/window-logs-notifications.js` | `log-to-frontend`、`logs-*`、`window-*`、`toggle-maximize`、刷新相关、`show-system-notification`、`get-api-base-url`（`getMainWindow` / `getApiServerPort` 由 main 注入） |
| 2026-03-19 | `main-process/ipc/store-config-snapshot.js` | `delete-saved-config`、`get-current-config`、`set-current-config` |
| 2026-03-19 | `main-process/ipc/fs-dialog-basic.js` | `show-open-dialog`、`show-save-dialog`、`read-file`、`save-file`、`read-image-as-base64` |
| 2026-03-19 | `main-process/ipc/shell-spawn-command.js` | `execute-command`、`execute-command-realtime`、`kill-command-process`；进程 Map 与 `checkAndRemoveGitLock` 内聚于模块（另导出 `isGitWriteCommand` / `checkAndRemoveGitLock` 供测试复用） |
| 2026-03-19 | `main-process/ipc/external-open.js` | Cursor / 终端 / 已装终端列表 / 访达 / `openExternal`；注入 `shell`、`getAppRoot` |
| 2026-03-19 | `main-process/ipc/browser-favorites-passwords.js` | 内置浏览器收藏与密码 IPC；注入 `store`、`dialog`、`getMainWindow`、`safeLog`/`safeError` |
| 2026-03-19 | `main-process/ipc/browser-extensions.js` | `get-extensions`、`load-extension-*`、`toggle-extension`、`remove-extension`；`loadedExtensions` Map 内聚于模块 |
| 2026-03-19 | `main-process/register-channel.js` | `createRegisterChannel(ipcMain, invokeRegistry)`，与原先 `registerChannel` 行为一致 |
| 2026-03-19 | `main-process/ipc/coze-ipc.js`、`electron/coze/commit-message.js` | 扣子配置、commit message、check-auth、logout |
| 2026-03-19 | `main-process/ipc/workspace-ipc.js` | `workspace-*` |
| 2026-03-19 | `main-process/ipc/web-apps-settings-ipc.js` | Web 应用 AI 设置、`web-apps-update-name` |
| 2026-03-19 | `main-process/ipc/agent-md-ipc.js` | Agent / SOUL / USER / BOOT / IDENTITY 等 MD 路径与打开 |
| 2026-03-19 | `main-process/ipc/cron-ipc.js` | `cron-*` |
| 2026-03-19 | `main-process/ipc/skills-ipc.js` | `ai-get/save/delete-skill` |
| 2026-03-19 | `main-process/ipc/mcp-admin-ipc.js` | MCP 配置读写、导入 Claude、状态、重连、禁用、启停单服务 |
| 2026-03-19 | `main-process/ipc/backup-ipc.js` | 备份 JSON/ZIP、恢复、技能包导入导出 |
| 2026-03-19 | `main-process/ipc/ai/gateway-session-ipc.js` | `get-gateway-ws-url`、`ai-report/get-current-session` |
| 2026-03-19 | `main-process/ipc/channels-im-ipc.js` | 飞书/Telegram/钉钉 状态与配置、`doctor-run`、`webhook-trigger`、飞书通知与 OAuth、发消息等薄 IPC |
| 2026-03-19 | `main-process/ipc/ai/session-constants.js` | `MAIN_CHAT_PROJECT`、各渠道 project 常量、`SESSION_SOURCES` |
| 2026-03-19 | `main-process/ipc/ai/chat-history-helpers.js` | `createChatHistoryHelpers`：`persistToolArtifactsToRegistry`、`stripToolExecutionFromMessages`、`mergeCompactedConversationMessages`；导出 `stripRawToolCallXml` |
| 2026-03-19 | `main-process/ipc/ai/ai-history-ipc.js` | `ai-save/load/clear-chat-history`、session summary、conversations、sessions、`ai-evolve-from-session` 等；返回 `triggerAutoEvolveFromSession` 供飞书入站调用 |
| 2026-03-19 | `main-process/ipc/ai/ai-verify-model-ipc.js` | `ai-verify-model` |
| 2026-03-19 | `main-process/ipc/ai/ai-config-proxy-ipc.js` | `ai-generate-commit-message`、`ai-get/save-config`、Codex key、proxy、onboarding、备份恢复、用量/账单 |
| 2026-03-19 | `main-process/ipc/ai/ai-models-ipc.js` | `ai-fetch-models`、`ai-get-models` |
| 2026-03-19 | `main-process/ipc/ai/ai-tools-attachments-ipc.js` | `ai-get-tools`、`ai-model-supports-vision`、`ai-upload-attachments` |
| 2026-03-19 | `main-process/ipc/ai/ai-chat-session-ipc.js` | `ai-chat-start/stop`、session 视图/元数据/注入、`ai-editor-open-files-response` |
| 2026-03-19 | `main-process/ipc/ai/ai-external-subagents-ipc.js` | `ai-list-external-subagents` |
| 2026-03-19 | `electron/ai/inbound-message-text.js` | `createInboundMessageTextHelpers`：入站回复文本清洗、截图路径/base64 解析、`getAssistantText` / `extractLatestVisibleText` 等（main 注入 path/fs/appRoot/stripRawToolCallXml） |
| 2026-03-19 | `main-process/ipc/ai/gateway-side-effects.js` | `createGatewaySideEffectHandlers`：`onToolResult`、`onChatCompleteAny`（应用内飞书）、`forwardToMainWindow`、`onRemoteUserMessage`、`onChatComplete`（`eventBus` 由 main 提前创建后注入） |
| 2026-03-19 | `main-process/channel-run-state.js` | `createChannelRunState`：IM 同会话多 run 的 Map/Set 与 `stopPreviousRunsForChannel` / `waitForPreviousRuns`（注入 `aiOrchestrator`） |
| 2026-03-19 | `main-process/ipc/channels-session-completed-send.js` | `registerChannelsSessionCompletedSend`：`chat.session.completed` 出站产物登记、`rememberSessionArtifacts`、`chatChannelRegistry.send`、飞书失败兜底 |
| 2026-03-19 | `main-process/im-tool-call-format.js` | `parseToolCallArgs`、`formatCommandFromToolCall`（主进程直跑重试与飞书流式命令行展示共用） |
| 2026-03-19 | `main-process/im-channel-message-pipeline.js` | `registerImChannelMessagePipeline`：`chat.message.received` → `processMessageReplace` / `handleChatMessageReceived`（飞书/TG/钉钉协调 Agent 全链路） |
| 2026-03-19 | `main-process/im-channel-artifacts.js` | `createImChannelArtifactHandlers`：会话产物缓存、`registerArtifactsFromItems`、飞书引用解析与 `registerReferenceArtifactsFromMessages` |
| 2026-03-19 | `main-process/im-channel-session-page-target.js` | `createSessionPageTargetHelpers`：`findRecentPageTarget` / `findRecentHtmlArtifact`（子 Agent 委派时注入主会话网页上下文） |
| 2026-03-19 | `main-process/ai-chat-tools-access.js` | `createAiChatToolsAccess`：`getToolsForChat` / `getToolsForChatWithWait` / `getToolsForSubChat` / `getToolsForCoordinatorChat`、`getCoordinatorSystemPrompt`（须在 `createGateway` 之前初始化） |
| 2026-03-19 | `main-process/im-channel-master-agent-fallbacks.js` | `createImChannelMasterAgentFallbacks`：`rescueReplyByMasterAgent`、`runMainAgentDirectRetry`（及未接线出口的 `refineReplyByMasterAgent`）；依赖 `im-tool-call-format` |
| 2026-03-19 | `main-process/mcp-start-saved.js` | `createStartSavedMcpServers`：`app.whenReady` 后按 mcp.json 启动 MCP；chrome-devtools 失败提示 |
| 2026-03-19 | `main-process/heartbeat-runner.js` | `createHeartbeatRunner`：`HEARTBEAT.md` 巡检、`startHeartbeat` / `runHeartbeat`（供 `cronScheduler`） |
| 2026-03-19 | `main-process/vision-model-support.js` | `createVisionModelSupport`：`modelSupportsVision`（供 `ai-tools-attachments-ipc`） |
| 2026-03-19 | `main-process/im-channels-bootstrap.js` | `setupImChannels`：适配器注册、`registerImChannelMessagePipeline`、`registerChannelsSessionCompletedSend`、`registerChannelsImIpc`；`channel-run-state` 由 main 在 `aiOrchestrator` 后立即创建并注入（保证 `stop_previous_task` / `wait_for_previous_run` 工具注册可用） |
| 2026-03-19 | `main-process/main-window-tab-forwarding.js` | `registerMainWindowTabForwarding`：`request-open-url-in-new-tab` IPC + `web-contents-created` 拦截新窗口 → 主窗口新标签 |
| 2026-03-19 | `main-process/app-ready-bootstrap.js` | `registerAppWhenReady`：`app.whenReady` 内协议、webview session、窗口、MCP HTTP bridge、invoke API、`aiGateway`、MCP 子进程、Heartbeat、cron、飞书、skills 重绑；**须在 main 末尾调用**（闭包依赖已初始化的 `aiGateway` 等） |
| 2026-03-19 | `main-process/app-quit-activate.js` | `registerAppQuitActivate`：`app.isQuiting`、`before-quit`（skills watcher、web-apps、MCP bridge、API、Gateway、UI server、session flush）、`window-all-closed`、`activate` |
| 2026-03-19 | `main-process/invoke-config-ipc.js` | `registerInvokeConfigForwardingIpc`：`get-config` / `set-config` / `get-all-configs` / `save-config` / `save-saved-configs` / `get-saved-configs` → `invokeRegistry` |
| 2026-03-19 | `main-process/safe-console.js` | `createSafeConsoleLoggers`：`safeLog` / `safeError`（防 EPIPE） |
| 2026-03-19 | `main-process/ai-core-stack-bootstrap.js` | `bootstrapAiCoreStack(deps)`：Skills IPC、AI 配置/MCP 管理、Orchestrator、子 Agent 派发、Gateway 与各 AI IPC、工具批量注册、Heartbeat 运行器；`skillPack` / `filterSessionsList` / `FEISHU_PROJECT` 内聚于模块；扩展 executor/hardware 在模块加载时注册 |
