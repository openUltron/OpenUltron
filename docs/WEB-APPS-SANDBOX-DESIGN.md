# Web 沙箱应用：设计说明（可打包、可安装、依赖可审计）

本文档汇总 **Web 迷你应用** 的产品目标、架构边界、清单格式、打包/安装流程，以及易遗漏项与后续演进建议。与对话中讨论的「沙箱预览 + 可选 Node + skills/经验协作」一致，并扩展 **分享安装** 与 **依赖显式记录**。

**一句话定位**：可视为 **「带 UI、可独立使用的 Skills」**——用户可打开界面操作；AI 也可像使用 Skills 所承载的能力一样调用其 **`aiTools`**（运行时工具），二者共享同一套应用与依赖，无需在宿主重复实现（详见 §6、§11）。

---

## 1. 目标与非目标

### 1.1 目标

- AI 与用户可在受控环境中 **构建、保存、管理** Web 类应用（不仅静态展示）。
- 应用可 **打包** 给他人，他人可 **安装** 使用。
- **依赖与权限** 对使用者 **可读、可比对、可拒绝**（manifest + 锁文件 + 宿主版本）。
- 与现有能力衔接：**对话/工具改文件**、`get_skill` 拉规范、memory/lessons 提供摘要（不替代沙箱执行）。
- **已安装的 Web 应用** 可在 manifest 中 **声明 AI 可调用的工具**（OpenAI/MCP 式参数描述），宿主合并进会话工具列表；**主应用无需重复实现** 同类能力，由应用在自己的沙箱/Node 侧实现 **一次** 即可。

### 1.2 非目标（第一版可不承诺）

- 等同「用户整机的任意代码执行环境」或通用 Docker 编排。
- 替代 VS Code / 完整在线 IDE。
- 保证任意第三方包 **供应链绝对安全**（需签名、审计、沙箱硬化等后续能力）。

---

## 2. 设计原则

| 原则 | 说明 |
|------|------|
| **两层运行时** | **页面** = 浏览器沙箱；**Node/系统能力** = 主进程或子进程在白名单目录与 API 内执行，页面不直接 `require('fs')` 全盘读写。 |
| **显式优于隐式** | 权限、网络、Node 是否启用，均写在 **manifest**，未声明则 **最严默认**。 |
| **依赖可复现** | 若使用 npm：**package.json + lockfile**（`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` 择一），打包分享 **强烈建议包含 lockfile**。 |
| **宿主契约** | manifest 声明 **OpenUltron 最低版本** 与 **协议版本**，安装时校验，避免静默不兼容。 |

### 2.1 取优补短：整合业界优点与已定案短板

以下将 **§17 同类产品的长处** 与 **§16 曾列实现缺口** 收敛为 **可执行定案**；实现与评审以本节为准，避免只「像谁」却未落地。

#### 取优（明确采纳）

| 来源 | 采纳什么 | 在本项目中的落点 |
|------|----------|------------------|
| **VS Code**（Extension Host + Webview） | 逻辑与 UI 分离；Webview **仅消息** 与后端通信；协议版本化 | §2 两层运行时；bridge **异步 + 带 `protocol` 版本**；禁止页面直接 `require` |
| **Chrome MV3** | `permissions` 与 **网络类权限**分层；**可选**运行时授权 | manifest 拆 **`permissions`（安装时必显）** 与 **`optionalPermissions`（首次调用时再授权）**；`net:allowlist` 可与 optional 组合 |
| **Obsidian** | 根 `manifest.json`、**`minAppVersion`**、ZIP 解压安装 | `host.openUltron` = minAppVersion；安装流与技能包 ZIP 对齐 |
| **Electron 安全模型** | Renderer **Sandbox**、**Context Isolation**、不可信内容 **关 nodeIntegration** | 用户 HTML 走 **独立 WebContents + preload 白名单**；能力只经 `contextBridge` |
| **PWA**（可选） | `name` / `icons` / `display` 等展示元数据 | manifest **可选字段** `presentation`：`icons[]`、`themeColor`；**不**替代 `dependencies` / Node |
| **MCP / OpenAI Tools** | 工具 **声明式 schema**（name、description、parameters）+ **宿主路由调用** | manifest **`aiTools[]`** 与全局工具名 **`webapp__<appId>__<name>`**；与内置工具、MCP **同一套编排**，仅 **invoke 目标** 不同（见 §6） |

#### 补短（原缺口 → 定案）

| 原风险/缺口 | 定案（MVP 起即遵守） |
|--------------|----------------------|
| 仅 manifest 写 `net:none` 仍可能外泄 | **WebView 所用 session** 上实现 **`webRequest`/`onBeforeRequest` 级拦截**（或等价 API），与 manifest 一致；默认 **拒绝未声明出站** |
| `file://`/相对路径混乱 | **优先自定义协议**（如 `openwebapp://<appId>/...`）映射到磁盘目录，统一 **origin**；实现细节见实现文档，不单依赖裸 `file://` |
| CSP 与 AI 生成内联脚本 | **默认**：禁止内联脚本 + 允许外链脚本同源；**开发模式**（仅本地未签名包）可放宽并显著标注 |
| 第三方 zip 安装 npm 时 `postinstall` 风险 | **不可信来源**（任意 zip）：默认 **`npm ci --omit=dev --ignore-scripts`**（或等效）；需脚本时 manifest 显式声明 **`npm.allowScripts: true`** 且安装 UI **二次确认** |
| `id` 与本地已装冲突 | **默认策略**：**并存目录** `web-apps/<id>/<version>/`，列表里选「默认打开版本」；若用户选择「替换安装」，先备份上一版 manifest 再覆盖 |
| Node 版本漂移 | `runtime` 含 node 时 **`engines.node` 必填**（可来自 `package.json`）；安装器 **不满足则拒绝并提示**，不静默降级 |
| 宿主壳无快捷键 | **最小集**：刷新、返回应用列表、（可选）开发者工具——**不依赖**沙箱内页面实现 |

#### 刻意不采纳（避免范围膨胀）

| 来源 | 为何不照搬 |
|------|------------|
| **云端容器 IDE**（CodeSandbox 等） | 成本与架构不同；本机 **不承诺** 任意 npm 与云端一致 |
| **浏览器扩展商店审发流程** | MVP **不做**强制审核；仅 **签名/策展市场** 作后续扩展（§12.6） |

---

## 3. 应用模型

### 3.1 目录布局（示例）

```
web-apps/<appId>/
  manifest.json       # 机器可读：元数据、运行时、依赖、权限
  index.html          # 默认入口（可由 manifest 覆盖）
  assets/             # 静态资源
  package.json        # 可选：Node 依赖
  package-lock.json   # 可选：强烈建议存在以保证可复现安装
  server/             # 可选：Node 入口脚本等
    main.js
```

### 3.2 `manifest.json` 建议字段（初版）

以下为 **建议 schema**，实现时可收紧必填项。

| 字段 | 说明 |
|------|------|
| `id` | 稳定唯一 id（如反向域名 `com.example.app`）。 |
| `name` | 展示名。 |
| `version` | SemVer 字符串。 |
| `author` / `license` | 可选，分享时建议填写。 |
| `entry` | 如 `{ "html": "index.html", "node": "server/main.js" }`。 |
| `runtime` | 如 `{ "browser": true, "node": false }` 或枚举 `browser` / `browser+node`。 |
| `host` | 如 `{ "openUltron": ">=1.0.26", "protocol": 1 }`。 |
| `dependencies` | 见 §4；若含 Node，可内嵌 **`npm`**：`packageFile`、`lockfile`、**`allowScripts`**（默认 false，与 §2.1 一致）。 |
| `permissions` | 见 §5；**安装时**即展示并生效的必选能力。 |
| `optionalPermissions` | 可选：见 §5；**首次使用**相关能力时再授权（对齐 Chrome optional）。 |
| `optionalSkills` | 可选：技能 id 与版本范围；缺失时降级提示，不自动静默安装。 |
| `presentation` | 可选：`icons`、`themeColor` 等（对齐 PWA 子集，便于列表与启动展示）。 |
| `aiTools` | 可选：见 **§6**；声明供 **主会话 AI** 调用的工具（无需在宿主重复实现）。 |
| `createdAt` / `updatedAt` | ISO8601，可选。 |

**协议字段 `host.protocol`（或单独 `schemaVersion`）**：manifest 结构变更时递增，安装器按版本解析。

---

## 4. 依赖如何「明确记录」

### 4.1 分层

| 层级 | 记录方式 | 用途 |
|------|----------|------|
| **宿主** | `host.openUltron`、`host.protocol` | 防止装上了跑不起来。 |
| **Node 引擎** | `engines.node`（可与 `package.json` 对齐） | 安装前检查本机 Node 或内置 Node。 |
| **npm** | `package.json` + **lockfile** | 可复现的依赖树；manifest 可引用 `dependencies.npm.packageFile` / `lockfile`。 |
| **浏览器侧** | 无包管理器时可为空；若用 CDN，建议在文档或 `dependencies.assets` 中声明 URL 与完整性（SRI）— **进阶**。 |

### 4.2 安装策略（建议）

- 生产依赖：`npm ci`（有 lockfile）或 `npm install --omit=dev`（策略可配置）。
- **不可信包**（他人分享的 zip）：默认 **`npm ci --omit=dev --ignore-scripts`**，除非 manifest 声明 **`npm.allowScripts: true`** 且用户确认（见 §2.1）。
- **失败回滚**：安装 npm 失败时删除未完成目录或恢复备份，避免半安装状态。

### 4.3 与「只展示」应用

- 纯静态：可无 `package.json`，`runtime.browser` 即可，`dependencies` 可为空或仅 `host`。

---

## 5. 权限模型（沙箱）

建议 **白名单枚举**，未列出的能力默认 **关闭**。

**分层（取优 Chrome MV3）**：

- **`permissions`**：安装时必须展示并 **同意** 后才能完成安装；装后即生效。
- **`optionalPermissions`**：仅在用户 **首次触发** 对应能力时弹窗授权（可拒绝则功能降级）。

示例（实现时定最终枚举）：

- `storage:app` — 仅应用目录内读写。
- `net:none` / `net:allowlist` — 默认无网或域名白名单；**须与 WebView session 网络拦截一致**（§2.1）。
- 后续再扩展：`clipboard:read` 等，均需显式声明 + 用户可见。

**页面 ↔ 宿主** 仅通过 **postMessage + 白名单 type**；主进程校验 `appId` 与 manifest。

---

## 6. 应用向 AI 暴露的能力（工具协议）

目标：**每个已安装应用可在 manifest 中声明一组「工具」**，宿主在 **AI 对话** 中与其它内置工具、MCP 一样下发给模型；模型调用时由宿主 **路由到该应用实现**，**主程序不必再写一份同名逻辑**。

### 6.1 与 Skills、MCP、内置工具的分工

| 机制 | 角色 |
|------|------|
| **内置工具** | 宿主原生能力（文件、终端、会话等）。 |
| **MCP** | 外部进程/服务暴露的工具，已有连接与配置。 |
| **`manifest.aiTools`** | **本机已安装 Web 应用** 提供的、**随应用打包** 的能力；实现位于应用目录内（浏览器侧 handler 或 Node 侧模块）。 |
| **Skills** | 规范、模板、上下文；**不**自动等于运行时工具，除非应用自行在 `aiTools` 里暴露对应 invoke。 |

### 6.2 声明格式（建议，`manifest.aiTools`）

数组，每一项至少包含：

| 字段 | 说明 |
|------|------|
| `name` | 应用内唯一短名（如 `summarize`、`run_pipeline`）。 |
| `description` | 给模型看的说明（与 OpenAI function `description` 一致）。 |
| `parameters` | JSON Schema 风格对象（与现有工具 `parameters` 一致）。 |
| `handler` | `browser` \| `node` — 执行环境。 |
| `entry` | `node` 时：相对应用根的路径，导出 **约定签名** 的函数；`browser` 时：与 preload 约定的 **消息 channel / action id**。 |

宿主侧 **全局工具名**（避免冲突）：

- 定案一种即可，例如：`webapp__<appId>__<name>`（`<appId>` 需转义非法字符）。

安装或启用应用时，将上述条目 **注册** 到工具层；**卸载或禁用** 时 **注销**。

### 6.3 调用链（定案）

1. 模型发起工具调用，函数名为 `webapp__<appId>__<name>`，参数为 JSON。
2. **主进程**校验：应用已安装且版本匹配、`aiTools` 中存在、`parameters` 校验通过、**所需权限**（见下）已满足。
3. **路由**：
   - **`handler: node`**：在 **§2** 所述受限子进程中 `require(entry)`，调用导出函数（异步 Promise），`cwd` 限于应用目录，**超时/输出大小** 上限。
   - **`handler: browser`**：通过 **preload bridge** 向该应用 WebContents **发消息**并等待结果（同 §5 消息白名单 + 专用 `AI_TOOL_INVOKE` 类 type），页面内实现逻辑并返回可序列化 JSON。
4. 将结果写回对话（过大则截断 + 提示）。

### 6.4 权限与可见性

- **默认**：不在会话中注入 Web 应用工具，除非用户在 **会话或全局设置** 中勾选 **「允许使用已安装 Web 应用提供的 AI 工具」**，并可 **按 `appId` 白名单**（减少 token 与攻击面）。
- 若某工具需要 **网络 / 剪贴板** 等：须在 manifest 的 **`permissions` / `optionalPermissions`** 中已有对应项；否则 **拒绝调用** 并返回明确错误给模型。
- **敏感参数**（如 token）：优先通过 `openultron.json` / `skills.entries` 由宿主注入环境，**不**鼓励在工具参数里明文传（与现有 AI 配置策略一致）。

### 6.5 版本与兼容

- 升级应用版本后，`aiTools` 增删改 → 宿主 **重新注册**；若会话仍引用旧工具名，返回 **可解析错误**（提示刷新技能列表或重开会话）。
- `host.protocol`（manifest schema）变更时，可同时约定 **`aiTools` schema 版本**，避免旧宿主解析失败。

### 6.6 刻意不做（避免与 MCP 重复造轮）

- **不在此协议里** 再定义一套「通用插件 RPC」；若应用需要暴露大量动态工具，可 **在应用内起一个 MCP server** 并由用户 **在 MCP 配置里连接** —— 与 `aiTools` 二选一或并存，**文档中写清** 即可。

---

## 7. 打包格式（分享）

### 7.1 建议：单文件 ZIP

扩展名可约定为 **`.openwebapp.zip`** 或应用内统一扩展名。

顶层 **必须** 含 `manifest.json`；其余为应用文件。

可选顶层 `meta.json`（与现有技能包 ZIP 风格对齐）：

- `formatVersion`、`exportedAt`、`appId`、`appVersion`、`packagerOpenUltron`、`platform`（打包机信息，仅供参考）。

### 7.2 打包前检查（建议自动化）

- `manifest.json` 与入口文件存在。
- 若启用 Node：**lockfile 存在**（否则警告或禁止导出，策略可配）。
- 可选：包体大小上限（避免误打包 `node_modules`）；若包含 `node_modules`，应明确策略（一般 **不推荐** 打进 zip，应在目标机 `npm ci`）。

---

## 8. 安装与注册

### 8.1 流程

1. 用户选择 zip → 校验 zip 结构、`manifest.host`、协议版本。
2. 展示 **权限与依赖摘要**（含 Node/npm、`optionalPermissions` 说明），用户确认。
3. **id 冲突**：按 **§2.1 定案** — 默认 **按版本并存** `web-apps/<id>/<version>/`；若用户选择覆盖，先备份旧 manifest。
4. 解压到约定目录；写入本地 **注册表**（JSON/SQLite）。
5. 若需 Node：在应用目录内执行安装命令（**不可信包默认 `--ignore-scripts`**，见 §4.2）；失败则回滚并提示。

### 8.2 注册表建议字段

- `id`、`version`、`installPath`、`installedAt`、`manifestHash`（可选）、`resolvedNpmSummary`（可选，仅展示用）。

### 8.3 卸载

- 删除目录 + 注册表项；若含 `node_modules`，一并删除；**易遗漏项**：磁盘空间与大目录清理需明确 UX（进度条、二次确认）。

---

## 9. 升级与多版本

**默认策略（与 §2.1 一致）**：**多版本并存** — 路径 `web-apps/<id>/<version>/`，列表可选 **默认打开版本**；升级新版本即新目录，旧版可删或保留。

可选 **就地覆盖**（高级）：同一 `id` 仅保留单目录时，覆盖前 **备份** 上一版 `manifest.json`， semver 比较与降级规则在 UI 中简短说明。

---

## 10. 安全与信任（分享场景）

- 安装第三方包 = 执行他人代码 → **显著风险提示**；首次打开展示 **权限 + 依赖摘要**。
- 默认 **最小网络**；需要外网时必须在 manifest 中声明并由用户知晓。
- 后续可增强：**包签名**、发布者验证、哈希白名单（企业）；第一版至少 **来源提示 + 手动信任**。

---

## 11. 与 Skills / AI / 经验库的关系

| 能力 | 角色 |
|------|------|
| **get_skill** | 构建时拉取规范、模板、脚手架内容写入应用目录；**不**替代 manifest。 |
| **对话与工具** | 编辑 `manifest`、HTML、server 脚本；上下文绑定当前 `appId`。 |
| **memory / lessons** | 注入短摘要辅助生成，避免整库进 prompt。 |
| **optionalSkills** | 仅声明「软依赖」；缺失时功能降级并提示，**不**自动安装 skill。 |
| **`manifest.aiTools`** | **运行时**供模型调用的工具（§6）；与 Skills **互补**：Skill 偏文档与脚手架，**aiTools** 偏 **对话中直接 invoke**。 |

---

## 12. 补充建议与易遗漏清单

以下为实施与产品层面 **容易遗漏** 的项，建议在迭代中逐项勾选。

### 12.1 产品与合规

- **用户协议/免责声明**：第三方应用风险、数据与网络责任边界。
- **隐私**：应用是否上报遥测默认关闭；若未来有匿名使用数据，需单独开关。

### 12.2 工程与运维

- **路径与跨平台**：Windows/macOS/Linux 路径分隔符、`file://` 与自定义协议安全边界。
- **离线安装**：无网时 npm 安装失败时的明确错误与重试指引。
- **磁盘与大小**：单应用大小上限、总配额、清理缓存入口。
- **日志**：安装/运行失败时写入可读日志路径，便于用户反馈（勿记录密钥）。

### 12.3 开发者体验

- **官方最小模板**：空 manifest + 单页 HTML + 可选 `server/main.js` 示例仓库或内置脚手架。
- **校验 CLI 或脚本**（可选）：`openultron-validate-app ./dir` 检查 manifest 与 lockfile。

### 12.4 测试

- **契约测试**：不同 `host.protocol` 的 manifest 样例；安装器 golden cases。
- **安全回归**：路径穿越、postMessage 任意类型、npm 脚本 hook 是否在允许范围内（若禁用 `postinstall` 等，需文档说明）。

### 12.5 可访问性与国际化

- 管理列表 UI：键盘导航、错误信息可本地化（至少中英预留）。

### 12.6 未来扩展（不阻塞 MVP）

- 浏览器依赖的 **SRI / 子资源完整性**。
- **代码签名** 与 **供应链**（npm audit 提示，不代替用户判断）。
- **应用市场/目录**（策展列表），与「任意 zip 安装」分流。

---

## 13. MVP 建议范围（便于落地）

1. 本地 `web-apps/` 目录 + manifest + 列表 + 沙箱预览（iframe/WebView + CSP）。  
2. 打包 zip / 从 zip 安装 + 宿主版本校验 + 权限摘要确认。  
3. 可选 Node：`package.json` + lockfile + 目录内 `npm ci`，受限子进程运行。  
4. 卸载与注册表。  

**后续**：**§6 `aiTools` 与编排器对接**（可紧跟 MVP 之后，或拆为 1.1 版本）；签名、应用商店、CDN 完整性、多语言模板。

---

## 14. 文档维护

- 本文档随 **manifest schema** 与 **安装协议** 变更而更新；破坏性变更递增 `host.protocol` 或 `schemaVersion`，并在文首 **变更摘要** 中记录。
- **实现状态**：以本文档与代码现状为准，不再维护独立 checklist 文档。
- **IPC/HTTP 通道**：`WEB-APPS-IPC-REFERENCE.md`。
- **MVP manifest Schema（草案）**：`manifest-web-app-mvp.schema.json`。

---

## 15. 参考

- 项目内技能包说明：`docs/SKILLS-PACK-COMPAT.md`（ZIP、元数据、目录约定可对齐）。  
- 外部参考概念：PWA manifest、VS Code Extension、Electron `BrowserView` / `sandbox` 安全模型。

---

## 16. 设计 Review（已由 §2.1 取优补短收敛）

原「自检清单」中的可执行项已并入 **§2.1 补短定案**；本节仅保留 **仍需单开实现文档** 的附录项。

### 16.1 实现阶段附录（建议另文）

- **`manifest` JSON Schema（MVP 草案）**：已提供 `docs/manifest-web-app-mvp.schema.json`；完整字段与 **安装器错误码表**（宿主版本不符、协议过旧、npm 失败码映射）仍待补充。
- **加载实现专页**：自定义协议与 `base`、CORS、资源根路径（与 §2.1「优先自定义协议」一致）。
- **`aiTools` 与编排器对接**：工具名前缀、`handler: browser|node` 的 invoke 实现、超时与返回体大小上限、与会话「是否注入 Web 应用工具」开关的交互。

---

## 17. 同类 / 相近产品的设计与实现对照

以下不是「照搬」，而是帮助对齐 **业界常见分工**：你的设计文档 §2～§8（含 **§6 AI 工具**）与这些模型 **同构**，可按需借鉴命名与边界。

### 17.1 Visual Studio Code：Extension Host + Webview

- **做法**：扩展逻辑跑在 **Extension Host**（独立 Node 进程），与 UI 分离；**Webview** 是隔离的 iframe 式面板，扩展与 Webview 之间 **仅消息传递**，页面不直接碰 Node。[Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)、[Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- **对照 OpenUltron**：你们的「页面沙箱 + 主进程/子进程跑 Node + postMessage」与 **Webview + Extension Host** 同构；**Web Extension**（仅 `browser` 入口、无 Node）对应你们「仅 `runtime.browser`」的应用。
- **可借鉴**：消息协议版本化、webview 与后端能力 **严格异步边界**。

### 17.2 Chrome 扩展 Manifest V3：声明式权限

- **做法**：`permissions` 与 **`host_permissions`** 分离；尽量 **最小权限**；部分权限可 **运行时申请**（optional）。[Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- **对照 OpenUltron**：你们的 `permissions` + `net:allowlist` 与 **host 级网络白名单** 思路一致；可显式区分 **「安装时必显」** 与 **「首次使用时再授权」**（类似 optional_permissions）。

### 17.3 Obsidian 插件：manifest + `minAppVersion`

- **做法**：根目录 `manifest.json`：`id`、`version`、**`minAppVersion`**、`isDesktopOnly`（是否依赖 Electron/Node）等；社区插件为 **解压即用 + 宿主校验**。[PluginManifest 参考](https://docs.obsidian.md/Reference/TypeScript+API/PluginManifest)
- **对照 OpenUltron**：与你们的 `host.openUltron` + ZIP 安装 **几乎一一对应**；`isDesktopOnly` 可映射为「仅 `browser+node` 或依赖本机 Node」。

### 17.4 Electron：渲染进程沙箱 + Context Isolation

- **做法**：**Sandbox** 限制渲染进程系统能力；**Context Isolation** 避免页面直接访问 Node；需能力时通过 **preload + contextBridge** 暴露窄 API。[Security](https://www.electronjs.org/docs/latest/tutorial/security)、[Sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- **对照 OpenUltron**：嵌入「用户生成的 HTML」时，应 **关闭 nodeIntegration**、**启用 contextIsolation**，仅通过 **preload 暴露白名单 bridge**；**BrowserView** 在较新 Electron 中可向 **WebContentsView** 迁移（实现时查当前 Electron 版本文档）。
- **注意**：官方强调 **任意不可信内容在 Electron 内仍属高风险**，需多层防护（与本文 §10 一致）。

### 17.5 PWA / Web App Manifest

- **做法**：`name`、`icons`、`start_url`、**`display`** 等，偏 **安装到桌面/浏览器** 的元数据，**不**解决 Node 与系统权限。
- **对照 OpenUltron**：若未来希望「同一 manifest 在浏览器里也能预览静态部分」，可 **子集** 对齐 PWA 字段；**Node 与 npm 仍以你们自有 `dependencies` 为准**。

### 17.6 在线 IDE（CodeSandbox / Replit 等）— 仅作边界参考

- **做法**：多在 **服务端/容器** 中隔离用户代码，与本机 Electron 桌面应用 **成本模型不同**。
- **对照 OpenUltron**：若不做云端，**不要**追求与线上一致的「任意依赖」；坚持 **本机目录 + 受限子进程 + 可选容器** 即可，避免范围膨胀。

---

## 18. 小结

- **取优补短** 的合并结论在 **§2.1**：业界模型（VS Code / Chrome MV3 / Obsidian / Electron / PWA 子集）与 **已定案短板**（网络拦截、协议加载、CSP、npm 脚本、id 并存、`engines`、宿主快捷键）一并作为实现依据。  
- **应用 → AI 工具**：**§6 `aiTools`** 与内置工具、MCP **同一编排**，全局名 `webapp__<appId>__<name>`；**§11** 与 Skills 分工已写清。  
- **同类对照** 见 §17；**manifest 字段**（`optionalPermissions`、`presentation`、`npm.allowScripts`、**`aiTools`**）已回写到 §3～§8。  
- 下一步：按 **§16.1** 拆 **JSON Schema + 错误码 + 加载专页**，编排层对接 **§6** 工具注册与 invoke。  
- **落地顺序与最小样例** 见 **§20**。

---

## 19. Review 纪要：待决问题与可选补充

以下为 **实现前建议拍板** 的疑问，以及 **可增强但未阻塞 MVP** 的补充项。

### 19.1 待决问题（产品 / 架构）与 **推荐默认**

以下每条先列 **疑问**，再列 **推荐默认**（实现以默认为准，除非产品另行拍板）。

#### UI 与 `aiTools` 并发（尤其 `handler: browser`）

- **疑问**：用户操作界面时，模型若调用同一应用的 browser 工具，是否排队、拒绝、还是允许与 UI 并发？  
- **推荐默认**：**单队列（FIFO）** + **超时**（如单次 invoke 30s 上限）。同一 WebContents 内 AI 调用串行执行；未完成则后续调用等待。超时向模型返回明确错误。无状态/只读类应用可评估并发，**默认仍以队列为准**。

#### 多 WebContents 实例

- **疑问**：同一 `appId` 多窗口时，`aiTools` 路由到哪一个实例？  
- **推荐默认**：**MVP：单实例** — 每个 `appId` 仅允许一个运行/预览实例，已打开则 **focus**，`aiTools` 只绑该实例。**进阶多窗口**：路由到 **当前焦点** WebContents；无焦点则 **最近一次活跃**；皆无则 **拒绝调用** 并提示「请先打开该应用」。

#### 子 Agent（`sessions_spawn`）

- **疑问**：子会话是否继承主会话的 `webapp__*` 工具？  
- **推荐默认**：**默认不继承**。子会话 **不注入** Web 应用工具，以控制 token、权限与行为。若需要：在 `sessions_spawn` 增加可选参数（如 `include_webapp_tools: true` + **`appId` 白名单**），且与全局「允许 Web 应用 AI 工具」开关 **同时** 为真才生效。

#### 工具 `description` 语言

- **疑问**：`description` 是否仅英文？是否增加中文等本地化字段？  
- **推荐默认**：主字段 **`description` 使用英文**（便于模型与生态一致）。可选增加 **`descriptionZh`**（或 `locales.zh`）供 UI/中文场景。编排器组工具列表时：**优先界面语言**对应描述，无则回退英文。**MVP 可仅英文**，本地化字段后续再加。

#### 与备份 / 恢复的关系

- **疑问**：`web-apps/` 是否纳入备份 ZIP？恢复时信任模型是否与「任意 zip 安装」一致？  
- **推荐默认**：**纳入备份**；包内 **不包含** 各应用下 `node_modules`（与分享包策略一致），恢复后 **自动或引导执行 `npm ci`**。恢复流程视为 **安装等价**：同设备整盘恢复可 **低打扰**；**跨设备/他人备份** 建议 **重新展示权限摘要** 或标记迁移来源，与冷安装第三方 zip 区分。

#### 一览（推荐默认汇总）

| 主题 | 推荐默认 |
|------|----------|
| UI vs browser 工具 | 单队列 + 超时 |
| 多窗口 | MVP 单实例；进阶 → 焦点 / 最近活跃 |
| 子 Agent | 默认不继承；可选开关 + `appId` 白名单 |
| 描述语言 | 主英文；可选中文；编排按语言回退 |
| 备份恢复 | 纳入；无 `node_modules`；恢复后 npm；跨设备再确认信任 |

### 19.2 可选补充（增强项）

| 项 | 说明 |
|------|------|
| **Deep link** | 从聊天或外部协议 **一键打开** `openwebapp://<appId>`，便于「去应用里完成」类流程。 |
| **应用内自更新** | 是否允许应用在 manifest 声明 **更新源 URL**（类似 update manifest），与「仅信任 zip 安装」的边界需单独写清。 |
| **无障碍** | §2.1 已列宿主快捷键；应用列表与安装向导的 **屏幕阅读器** 标签可记入实现 checklist。 |
| **冲突检测** | 全局工具名与 **未来内置工具** 重名时的 **保留前缀** 或 **校验失败** 规则。 |

### 19.3 文档自检（本次 Review）

- **已修正**：§7 / §8 子节编号原为 6.x / 7.x，已与章节号对齐。  
- **整体评价**：目标、沙箱、依赖、打包、`aiTools` 与 Skills/MCP 分工 **闭环完整**。  
- **§19.1**：待决项已补充 **推荐默认** 与 **一览表**，实现可直接按表执行；若产品变更，仅更新 §19.1 对应段落。

### 19.4 第二轮：其余可选疑问与简要建议

以下为 **§19.1 之外**、文档尚未逐一写死的点；**不阻塞 MVP**，实现或运营到相关模块时再拍板即可。

| 疑问 | 说明 | 简要建议（非强制默认） |
|------|------|------------------------|
| **`handler: node` 的并发** | §19.1 只写了 browser 队列；Node 侧多请求是否并行？ | 默认可 **并行**（不同子进程或同一进程内 Promise），但设 **单应用并发上限**（如 2～4）与 **全局 CPU/时间预算**，避免拖死宿主。 |
| **工具数量与上下文** | 已装应用多、每应用多 `aiTools` 时，是否全部注入模型？ | 与 **会话开关 + appId 白名单**（§6.4）叠加；可选 **硬上限**（如每会话最多 N 个 webapp 工具定义）或 **slim 描述**（与现有 `slimMode` 对齐）。 |
| **与 `file_operation` 等冲突** | AI 用内置工具改 `web-apps/...` 文件，同时应用在跑 | 文档级约定：**写入应用目录优先停预览或刷新**；实现可 **文件监视** 触发沙箱 reload（与技能热更新思路类似）。 |
| **invoke 失败与崩溃** | 应用抛错、Node 子进程崩溃、页面无响应 | 统一 **错误结构** 回传模型（含 `code`、`message`、是否可重试）；**不**把堆栈全文给模型（防泄露路径）。 |
| **Node 侧子进程** | `aiTools` 的 node 实现里再 `spawn` 子进程 | 在 manifest 或宿主策略中设 **子进程白名单/数量上限**；MVP 可 **仅警告 + 日志**。 |
| **ZIP 跨平台路径** | Windows 与 macOS 打 zip 的路径分隔符 | 打包器 **统一 `/`**；安装器 **normalize**；写入 §7 实现 checklist。 |
| **依赖许可证** | 应用带 GPL 等「传染性」依赖 | 产品免责声明 + **导出 manifest 依赖树**（`npm ls --json`）供用户自查；不做自动法务判断。 |
| **optionalSkills 与「带 UI 应用」** | 同一业务既有 Skill 又有 Web 应用 | 在 `optionalSkills` 或文档中说明 **推荐关系**（Skill 教 AI 怎么用应用）；避免两套 id 无关联。 |
| **网关 / HTTP API** | 外部系统是否可调 `aiTools`（非聊天内模型） | **默认仅对话内**；若开放需 **独立鉴权** 与 **速率限制**，另起设计，勿与 §6 混为一谈。 |
| **计费与配额** | 若未来云端推理，Web 应用工具调用是否计次 | 与主产品计费策略 **后续** 对齐即可。 |

**结论**：核心路径（沙箱、安装、依赖、`aiTools`、§19.1 默认）已覆盖；上表为 **边角与规模化** 时的检查清单，无需在 MVP 前全部定死。

---

## 20. 实施与产品建议（落地优先级）

以下为与 **§19** 互补的 **执行层建议**：不新增协议字段，侧重 **先做啥、别急着做啥、叙事与下一步**。

### 20.1 实现顺序

1. **先做**：应用目录 + `manifest` + 列表 + **沙箱预览** + ZIP **安装/导出** + 安装前 **权限摘要**。  
2. **再做**：**`aiTools` 与编排器对接**（§6）。  

若沙箱与安装不稳定就先接工具，易反复返工。

### 20.2 MVP 范围约束

- 坚持 **§19.1** 已写默认：**单实例**、`handler: browser` **FIFO + 超时**。  
- **多窗口路由、Node 侧复杂并行** 等 **等有真实需求再扩展**，避免第一期做成通用插件平台复杂度。

### 20.3 子 Agent

- 与 **§19.1** 一致：**默认不继承** `webapp__*`；可选开关 + `appId` 白名单。利于 **控 token、控风险、控排障成本**。

### 20.4 安全姿态

- 第三方包：**`--ignore-scripts` 默认**（§2.1 / §4.2）；需要脚本须 manifest + 用户确认。  
- 网络：**WebView session 真实拦截**（§2.1），勿仅写在 manifest。  

宁可安装/调试多一步，降低安全与工单成本。

### 20.5 与 Skills 的叙事（对内对外）

- **一句话**：**带 UI 的 Skills** — 用户可 **打开界面操作**；AI 通过 **`aiTools`** 调同一套能力，**无需宿主重复实现**（与文首摘要、§6、§11 一致）。  
- 避免团队把 **Skill 文档** 与 **Web 应用** 做成两套互不关联的重复建设；`optionalSkills` 与 `appId` 关系见 **§19.4** 表。

### 20.6 文档与议题边界

- **§19.1** = 已拍板默认；**§19.4** = 边角检查清单。  
- 下一步优先产出：**`manifest` 的 JSON Schema** + **一个最小示例应用**（如 `hello-webapp`：静态页 + `aiTools` 占位 + 工具名可见），比继续堆砌「可能问题」更有验证价值。

### 20.7 最小验证物（强烈建议）

- 维护 **`hello-webapp` 级样例**：含 **安装 → 打开预览 →（可选）工具列表中出现 `webapp__…` 注册名** 的闭环；可用 mock 注册验证编排接口。  
- 用于 **回归测试** 与 **对内演示**，确认设计「顺手」后再扩展功能。

### 20.8 实现进度（仓库内）

- 工程阶段与实现状态统一维护在本文档中，避免多份清单漂移。
- **应用库**：路由 **`/web-apps`**，侧栏 **「应用」** 直达（不再放在 Skills 内）。
- **打开**（仅预览）：**`/app-open`**（`appId`、`version`），全屏 **webview** 渲染，无 AI 侧栏；工具栏可进 **工作室** 或回应用库。
- **工作室**：**`/web-app-studio`**（`appId`、`version`），左侧 **webview**、右侧 **ChatPanel**；**新建应用** 创建空白项目后默认进入此页。会话会注入 **当前应用 id / 名称 / 根路径 / 入口 HTML / 预览 URL**；**`file_operation(write)` / `apply_patch`** 成功写入该目录后 **自动防抖刷新** 左侧预览（亦可手动「刷新预览」）。

### 20.9 应用工作室（已实现细节）

以下为实现层说明（含 Phase B/C 已落地项）。

| 能力 | 说明 |
|------|------|
| **展示名称** | 应用库列表与工作室面包屑中的 **名称** 来自 `manifest.json` 的 **`name`**。工作室顶部提供 **展示名称** 输入框 + **保存**，对应 IPC **`web-apps-update-name`**（实现函数 **`updateWebAppDisplayName`**，在 `main.js` 与 `invokeRegistry` 中显式注册，避免仅热更新前端时主进程无 handler）。**`id`** 为目录与安装标识，不在工作室内修改。 |
| **AI 会话** | `ChatPanel` 设 **`studioSandboxMode`**，`projectPath` 为应用根目录绝对路径。前端 `buildSystemPrompt` 注入「应用工作室」边界；主进程 **`orchestrator`** 对路径含 **`web-apps`** 且为绝对路径的会话 **替换** memory 中的「当前应用=OpenUltron / 改名字→IDENTITY.md」块，避免与「改 Hello 页面 / manifest」冲突。 |
| **预览缓存** | 预览 URL 带 **`_ou_refresh`** 查询参数；写入文件后防抖 **bump** 以绕过 webview 强缓存。 |
| **manifest 同步** | AI 若改写 **`manifest.json`**，工作室在工具成功回调中检测路径并 **`getWebApp`** 同步展示名到输入框。 |
| **CSP（B1）** | `local-resource` 对 **`web-apps/**/*.html`** 返回 **`Content-Security-Policy`**（`main.js` 协议处理），限制默认源为 `local-resource` / `data` / `blob`，`connect-src` 收紧为本地协议（出站仍由 B2 拦截）。 |
| **网络会话（B2）** | 预览 **`<webview partition="persist:ou-webapps">`**；**`electron/web-apps/guest-session.js`** 在 **`session.webRequest`** 上默认 **拦截 `http/https` 出站**；若 manifest 含 **`permissions: ["net:allowlist"]`** 且 **`netAllowlist`**（或 `network.allowlist`）列出主机名，则仅放行对应主机。 |
| **npm（B3）** | ZIP 导入后若存在 **`package.json`**：执行 **`npm ci`** 或 **`npm install`**（见 **`npm-install.js`**）；失败则导入失败并返回日志摘要。 |
| **aiTools（C1–C3）** | **`getToolDefinitions(params)`** 带 **`projectPath`** 时合并 **`manifest.aiTools`**（工具名 **`webapp__<id>__<name>`**）；**`orchestrator`** 路由 **`webapp__*`** 至 **`executeWebAppTool`**（`handler: node` 加载应用目录模块）；**`aiWebAppToolsEnabled`** + **`aiWebAppToolsScope`** + **`aiWebAppToolsAllowlist`**（`electron-store`；**设置 → Web 应用** 选「全部」或勾选应用 id，无需手输）。 |

- **IPC 一览**：见 **`docs/WEB-APPS-IPC-REFERENCE.md`**。
- **安装错误码（D2 子集）**：**`docs/WEB-APPS-INSTALL-ERRORS.md`**。
- **MVP manifest JSON Schema（草案）**：**`docs/manifest-web-app-mvp.schema.json`**（与 `validateMvpManifest` 对齐，可扩展字段仍见 §3.2）。

### 20.10 应用工作室：AI 自测约定（所有沙箱应用）

目标：不限于示例应用，**任意** `web-apps/<id>/<version>/` 在工作室中由 AI 改动时，都应进入 **写代码 → 自测 → 修复 → 再测** 的闭环。

| 项 | 约定 |
|----|------|
| **触发** | 功能或修复交付前，在**应用根目录**执行自测；未通过不得宣称完成。 |
| **逻辑** | 有本地 HTTP/Node 服务时，用 **node:test** 或脚本断言关键 API；纯静态至少 **node --check** 或项目既有检查命令。 |
| **UI** | 优先 **Playwright / Cypress** smoke（`data-testid` + 断言）；无条件时 **fetch 入口 HTML** 做弱断言并说明未做 E2E 的原因。 |
| **npm** | 宿主 **`npm-install.js`** 默认 **`--omit=dev`**，E2E 依赖在 devDependencies 时，自测前在应用目录执行 **`npm install --include=dev`**，并按需 **`npx playwright install chromium`** 等。 |
| **入口** | 建议在 **`package.json`** 提供 **`test`**、可选 **`test:e2e`**、**`verify`**；README 一两行说明。 |

**实现**：主进程 **`orchestrator`** 对 `web-apps` 工作室会话在 memory 中注入 **「自测·必做」** 全文；前端 **`WebAppStudioView`** 的补充 system 中有一行短提醒，与设计文档本节一致。

### 20.11 委派「应用工作室 Agent」（主会话 / IM）

- **工具**（内置）：**`web_apps_list`**、**`web_apps_create`**、**`webapp_studio_invoke`**（参数 **`task`** + **`project_path`** / **`app_id`+`version`** / 仅 **`app_id`** / **`app_hint`** / **`create_new`** 等，同前节）。**主会话/协调会话**对 `~/.openultron/web-apps` 的 **`file_operation(write)`、`apply_patch`、cwd 落在该树内的 `execute_command`、非只读 `git_operation`** 由 **`orchestrator._executeTool`** 拒绝，强制走 **`webapp_studio_invoke`**。发给模型的工具列表中，上述三者名称排序靠前，且在 **OpenRouter 等 slim 模式**下**不截断**其 description，避免模型扫不到或误用通用写文件工具。子会话内不可用 `webapp_studio_invoke` / `web_apps_create` / `sessions_spawn`。
- **回传调用方**：子 Agent system 中注入 **【工作室结果】** 格式要求；工具返回值含 `result` / `envelope` / `studio_path`，主会话或飞书协调 Agent 应据此向用户汇总（与 **`sessions_spawn`** 的 envelope 语义一致）。
- **飞书**：协调 Agent 工具列表在 **未开启** `imCoordinator.include_sessions_spawn` 时仍包含 **`webapp_studio_invoke`**，以便仅委派工作室而不开放通用子 Agent。
