# 主进程 `main.js` 模块化拆分蓝图

`electron/main.js` 体量极大（约 1 万行），集中了 **IPC、`registerChannel`、渠道编排、AI 编排、浏览器/扩展、文件与终端** 等逻辑。本文说明 **如何按域拆分**、**依赖方向**、**迁移顺序与风险**，与 `OPTIMIZATION-ROADMAP.md` P2 对齐。

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
    ipc/                     # 按域拆分的「只负责 registerChannel」模块
      window-logs-notifications.js # 已存在：log/logs-*、window-*、refresh、系统通知、get-api-base-url
      store-config-snapshot.js     # 已存在：delete-saved-config、get/set-current-config
      fs-dialog-basic.js           # 已存在：show-open/save-dialog、read-file、save-file、read-image-as-base64
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
