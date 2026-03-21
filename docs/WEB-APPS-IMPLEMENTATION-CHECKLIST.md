# Web 应用（沙箱）实现清单

对齐产品文档：`WEB-APPS-SANDBOX-DESIGN.md`。  
**规则**：实现一步 → 勾选 → Review（不偏离：先 MVP 竖切，再 `aiTools` / 会话拦截等）。

---

## Phase A — 基础设施（当前 Sprint）

- [x] **A1** 数据目录：`~/.openultron/web-apps/<id>/<version>/` 与 `ensure`（对齐 §3.1）
- [x] **A2** `manifest.json` MVP 校验：`id`、`name`、`version`、`host.openUltron`、`host.protocol`、`entry.html`（对齐 §3.2 子集）；**`runtime`** 缺省规范为 `{ browser: true, node: false }`；**安装/导入 ZIP** 时校验 **`host.openUltron` 与当前宿主 semver**（`host-openultron.js`）；草案 Schema：`docs/manifest-web-app-mvp.schema.json`
- [x] **A3** 主进程 IPC：`web-apps-list` / `web-apps-get` / `web-apps-preview-url` / `web-apps-import-zip` / `web-apps-export-zip` / `web-apps-install-sample` / `web-apps-create`
- [x] **A3b** **`web-apps-update-name`**：更新 `manifest.json` 的 `name`（展示名）；实现 **`updateWebAppDisplayName`**（`registry.js`），**`main.js` 显式 `registerChannel`**（与 `registerWebAppsIpc` 并列），保证 IPC/HTTP invoke 有 handler；详见 `docs/WEB-APPS-IPC-REFERENCE.md`
- [x] **A4** 预加载与 `browserPolyfill` 暴露 `ai.listWebApps` 等（含 **`updateWebAppName`**）
- [x] **A5** 示例应用 `hello-webapp`（模板安装到用户目录）
- [x] **A6** UI：侧栏 **应用** → **`/web-apps`** 应用库：列表、**打开** `/app-open`（仅预览）、**工作室**、导入/导出 zip、安装示例
- [x] **A6b** **工作室** `/web-app-studio`：左侧 **webview**、右侧 **ChatPanel**（`projectPath` = 应用目录）；**打开** `/app-open` 为全屏预览模式
- [x] **A6c** **新建**：IPC `web-apps-create`（空白 `manifest` + `index.html`，版本 `0.1.0`）→ 创建后跳转工作室；应用库页主按钮 **新建应用**
- [x] **A7** **Review**：对照 §2.1 — 预览使用已有 **`local-resource://web-apps/...`**（与 `~/.openultron` 根对齐）；**未**单独实现 `openwebapp://`（MVP 可接受，见设计文档 §2.1 进阶项）
- [x] **A8** **工作室展示名称**：顶部输入框保存 → `web-apps-update-name`；AI 改写 `manifest.json` 后 **自动同步** 展示名到 UI
- [x] **A9** **AI 沙箱会话**：`ChatPanel` **`studioSandboxMode`**；**`orchestrator`** 对 `web-apps` 路径注入专用 memory，避免误改 `IDENTITY.md` / 主程序身份（见设计 §20.9）

---

## Phase B — 安全加固（下一 Sprint）

- [x] **B1** WebView：对 `local-resource` 下 **`web-apps/**.html`** 响应附加 **CSP**（`main.js` 协议处理）；脚本/样式允许 `local-resource` + `unsafe-inline`（与 AI 生成页兼容，见 §2.1）
- [x] **B2** 预览 **`<webview partition="persist:ou-webapps">`**；`guest-session.js` 对 `http/https` **默认拦截**；`manifest.permissions` 含 **`net:allowlist`** 且配置 **`netAllowlist`**（或 `network.allowlist`）时按主机名放行
- [x] **B3** ZIP 导入成功后若存在 **`package.json`**：执行 **`npm ci`**（有 lock）或 **`npm install`**（无 lock）+ **`--omit=dev`** + 默认 **`--ignore-scripts`**；`manifest.npm.allowScripts === true` 时去掉 `--ignore-scripts`

---

## Phase C — AI 工具（§6）

- [x] **C1** `getToolDefinitions(params)` 传入 **`projectPath`** 时合并 **`buildWebAppToolDefinitions(projectPath)`**（`webapp__<appId>__<name>`）；**子 Agent** 仍用无 `projectPath` 的 `getToolsForSubChat`，不注入 Web 应用工具
- [x] **C2** **`orchestrator._executeTool`** 对 **`webapp__`** 前缀路由至 **`executeWebAppTool`**：`handler: node` 加载应用目录内 `entry` 模块；`handler: browser` 返回「未接入」说明
- [x] **C3** **`aiWebAppToolsEnabled`** + **`aiWebAppToolsScope`** + **`aiWebAppToolsAllowlist`**（`electron-store`）；**设置 → Web 应用** 勾选范围（全部 / 仅所选应用），无需手输 id

---

## Phase D — 备份与运维

- [x] **D1** **备份 ZIP**（`ai-backup-export` 全量 `~/.openultron`）已包含 **`web-apps/`** 子树；分享/导出单应用仍用 **`web-apps-export-zip`**
- [x] **D2（部分）** 安装/依赖错误码与排查：**`WEB-APPS-INSTALL-ERRORS.md`**；完整 JSON Schema（全字段）仍待扩展

---

**最后更新**：随仓库提交勾选；偏离产品时先改 `WEB-APPS-SANDBOX-DESIGN.md` 再改代码。

**相关文档**：`WEB-APPS-IPC-REFERENCE.md`（IPC/HTTP）、`WEB-APPS-INSTALL-ERRORS.md`（错误码）、`WEB-APPS-REVIEW-NOTES.md`（Review 纪要）、`manifest-web-app-mvp.schema.json`（MVP Schema）
