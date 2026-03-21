# Web 应用（沙箱）IPC / HTTP 参考

与 `electron/web-apps/registry.js`、`electron/main.js` 中的 `registerChannel` 对齐；**HTTP** `POST /api/invoke` 使用相同 `channel` 名（与 IPC 一致），参数为 **数组** `{ "channel": "web-apps-get", "args": [{ "id": "...", "version": "..." }] }`。

| channel | 说明 | 参数（IPC 为 `invoke(channel, arg)` 的第二个参数对象） |
|---------|------|--------------------------------------------------------|
| `web-apps-list` | 列出已安装应用 | 无 |
| `web-apps-get` | 读取某版本应用路径与 manifest | `{ id, version }` |
| `web-apps-preview-url` | 仅返回预览 URL | `{ id, version }` |
| `web-apps-install-sample` | 安装 Hello 示例 | 无 |
| `web-apps-create` | 新建空白应用（0.1.0） | `{ name?: string }` |
| `web-apps-import-zip` | 从 ZIP 导入 | `{ filePath?: string }`（可选，无则弹对话框） |
| `web-apps-export-zip` | 导出为 ZIP | `{ id, version }` |
| `web-apps-update-name` | **更新展示名**（写 `manifest.json` 的 `name`） | `{ id, version, name }` |
| `web-apps-get-ai-settings` | 读取 Web 应用 AI 工具相关设置 | 无；返回含 **`aiWebAppToolsScope`**: `'all'` \| `'allowlist'`（旧数据无该键时：若 `allowlist` 非空则视为 `'allowlist'`，否则 `'all'`） |
| `web-apps-set-ai-settings` | 写入设置 | `{ aiWebAppToolsEnabled?: boolean, aiWebAppToolsScope?: 'all' \| 'allowlist', aiWebAppToolsAllowlist?: string[] }`；**`scope=all`** 时合并全部应用；**`scope=allowlist`** 时仅 **`allowlist` 内 id**（可为空，表示不合并任何 webapp__ 工具） |

## `web-apps-update-name`

- **主进程**：`electron/main.js` 中显式 `registerChannel('web-apps-update-name', …)`，实现为 `updateWebAppDisplayName`（`registry.js` 导出）。
- **渲染进程**：`electronAPI.ai.updateWebAppName`（`preload.js`）。
- **成功返回**：`{ success: true, path, manifest, previewUrl }`。
- **失败**：`{ success: false, error: string }`。

## 与 AI 工作室

- 会话 `projectPath` 为 `~/.openultron/web-apps/<id>/<version>/` 时，编排器会识别为 **应用工作室沙箱**，memory 注入与主会话 OpenUltron 身份区分，避免误改 `IDENTITY.md`。
- **`getToolDefinitions({ projectPath })`**（Gateway 内部）会合并 **`manifest.aiTools`**，工具名形如 **`webapp__<appId>__<name>`**；`electron-store` 键 **`aiWebAppToolsEnabled`**（默认 `true`）为 `false` 时不合并；**`aiWebAppToolsScope`** 为 **`allowlist`** 时仅 **`aiWebAppToolsAllowlist`** 内的 **`manifest.id`** 合并（UI：**设置 → Web 应用**）。
- 详见 `WEB-APPS-SANDBOX-DESIGN.md` §20.9。

## 预览 WebView 与网络（Phase B）

- **分区**：`<webview partition="persist:ou-webapps">`（`WebAppStudioView` / `AppOpenView`），与主窗口 `persist:main` 隔离。
- **`local-resource://`**：`protocol.handle` 按 **Session** 生效，主进程在 **`defaultSession`** 与 **`session.fromPartition('persist:ou-webapps')`** 上注册**同一**处理器；否则预览分区无法加载 `local-resource:///web-apps/...`，左侧会空白。
- **实现**：`electron/web-apps/guest-session.js` → `setupWebAppGuestSession()`，在 **`app.whenReady`** 中注册；默认 **拦截出站 `http/https`**；若 manifest 声明 **`permissions` 含 `net:allowlist`** 且配置 **`netAllowlist`**，则仅放行对应主机。
- **CSP**：`local-resource` 对 `web-apps/**/*.html` 附加 **`Content-Security-Policy`**（`main.js` 协议处理）。

## npm（Phase B3）

- ZIP 导入成功后：`electron/web-apps/npm-install.js` → **`runNpmInstallIfNeeded`**（`npm ci` / `npm install`，`--omit=dev`，默认 `--ignore-scripts`）。
- 失败时 **`web-apps-import-zip`** 返回 `success: false` 与错误信息，见 **`WEB-APPS-INSTALL-ERRORS.md`**。

## 相关文件

- `manifest` MVP 校验：`electron/web-apps/registry.js` → `validateMvpManifest(manifest, { checkHostVersion })`（安装/导入 ZIP 时 `checkHostVersion: true` 以比对 `host.openUltron` 与当前宿主）
- JSON Schema（草案）：`docs/manifest-web-app-mvp.schema.json`
- 错误码：`docs/WEB-APPS-INSTALL-ERRORS.md`
