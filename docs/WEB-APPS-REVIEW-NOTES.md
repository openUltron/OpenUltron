# Web 应用实现 Review 纪要

## 已确认行为

| 项 | 说明 |
|----|------|
| **B2 首屏子资源** | `guest-session` 在 `webContents.getURL()` 尚未就绪时，增加 **`details.referrer`**（及可选 **Referer** 头）解析 `web-apps/...`，减少误拦 |
| **B2 缓存** | ZIP 导入成功后 **`invalidateManifestNetCache(id, version)`**，避免沿用旧 manifest 的 allowlist |
| **C3 范围** | `electron-store`：**`aiWebAppToolsEnabled`**、**`aiWebAppToolsScope`**（`all` / `allowlist`）、**`aiWebAppToolsAllowlist`**；**设置 → Web 应用** 勾选应用列表（`scope=allowlist` 且列表为空则不合并任何 webapp__ 工具） |
| **UI** | **设置 → Web 应用**（`WebAppToolsSettingsPage`）开关 + 范围（全部 / 勾选已安装应用），IPC：`web-apps-get-ai-settings` / `web-apps-set-ai-settings` |

## 已知限制 / 后续

- **`onBeforeRequest`** 的 **`requestHeaders`** 在部分 Electron 版本可能不可用；以 **`referrer`** 为主。
- **`handler: browser`** 的 aiTools 仍依赖 WebContents 消息路由（未实现）。
- **完整 manifest JSON Schema（全字段）** 仍可在 `manifest-web-app-mvp.schema.json` 上继续扩展。
