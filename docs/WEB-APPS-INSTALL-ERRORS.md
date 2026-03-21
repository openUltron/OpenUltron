# Web 应用安装与依赖：错误码与排查（D2 子集）

对齐 `WEB-APPS-SANDBOX-DESIGN.md` §4、§8；实现见 `electron/web-apps/registry.js`、`npm-install.js`。

## 导入 ZIP / 安装流程

| 阶段 | 失败表现 | 原因 | 处理 |
|------|----------|------|------|
| `OU-WA-ZIP-001` | 提示「ZIP 根目录缺少 manifest.json」 | 压缩包顶层无 manifest | 按 §7 打包，根目录含 `manifest.json` |
| `OU-WA-ZIP-002` | 「manifest.json 解析失败」 | JSON 损坏或编码异常 | 校验 UTF-8 JSON |
| `OU-WA-ZIP-003` | 「manifest 校验失败」 | 不满足 MVP 必填（`id`/`name`/`version`/`host`/`entry`/`runtime` 规则） | 对照 `validateMvpManifest` 与 `manifest-web-app-mvp.schema.json` |
| `OU-WA-HOST-001` | 「当前 OpenUltron … 不满足应用要求的宿主版本」 | `host.openUltron` 为 semver 范围，当前宿主 `package.json` 的 `version` 不在该范围内 | 升级 OpenUltron 或使用与当前版本兼容的 `host.openUltron`（如 `>=1.0.0`） |
| `OU-WA-ZIP-004` | 「无法覆盖已存在目录」 | 目标 `web-apps/<id>/<version>/` 被占用且删除失败 | 关闭占用进程或手动删目录后重试 |
| `OU-WA-NPM-001` | 导入失败，错误含 `npm` | `package.json` 存在但 `npm ci`/`npm install` 失败 | 检查 lockfile 与 registry；查看返回中的 `npm.stdout`/`stderr` |
| `OU-WA-NPM-002` | （未作为失败）「无 package.json，跳过 npm」 | 纯静态应用 | 正常 |

## 运行时 / 网络（B2）

| 码 | 说明 |
|----|------|
| `OU-WA-NET-001` | 默认 **禁止** 出站 `http/https`；控制台可见 `[web-apps] Blocked network (net:none default)` |
| `OU-WA-NET-002` | 若 manifest 含 `permissions` 含 `net:allowlist` 且配置 `netAllowlist`（或 `network.allowlist`），仅允许列表中 **主机名** 的请求 |

## AI 工具（§6）

| 码 | 说明 |
|----|------|
| `OU-WA-AI-001` | `webapp__*` 工具仅在 **当前会话 `projectPath` 为该应用目录** 时可执行 |
| `OU-WA-AI-002` | `handler: browser` 尚未接入，返回明确提示 |
| `OU-WA-AI-003` | **设置 → Web 应用** 可关闭工具合并或限定应用；配置键 **`aiWebAppToolsEnabled`**、**`aiWebAppToolsScope`**（`all` / `allowlist`）、**`aiWebAppToolsAllowlist`**（IPC：`web-apps-get-ai-settings` / `set`） |

## 配置键（electron-store）

| 键 | 默认 | 说明 |
|----|------|------|
| `aiWebAppToolsEnabled` | `true` | 为 `false` 时，不向模型合并 `manifest.aiTools` 定义 |
| `aiWebAppToolsScope` | （旧安装无键时按 allowlist 推断） | **`all`**：全部应用；**`allowlist`**：仅 **`aiWebAppToolsAllowlist`** 中的 id（列表可为空 = 不合并任何 webapp__ 工具） |
| `aiWebAppToolsAllowlist` | `[]` | 与 **`scope=allowlist`** 联用时为 id 列表；**`scope=all`** 时忽略 |
