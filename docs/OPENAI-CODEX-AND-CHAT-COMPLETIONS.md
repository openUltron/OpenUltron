# Codex 能用，但 OpenUltron 连 `api.openai.com` 报错？

## 根本原因：不是「一种授权通吃」，而是多条「产品 × 接口 × 计费」轨道

OpenAI 侧大致可以拆成 **三条常见轨道**（简化理解）：

| 轨道 | 典型凭证 | 典型 HTTP | 计费 / 权益 |
|------|----------|-----------|-------------|
| **① Platform（用量计费）** | **`sk-…` API Key** | `POST /v1/chat/completions` 或 `POST /v1/responses`（视 Key 权限） | [platform.openai.com](https://platform.openai.com) 账户余额 / 账单 |
| **② Codex / ChatGPT 订阅（OAuth）** | **`access_token`**（浏览器登录等） | 在 OpenClaw 源码里，**`openai-codex` 默认不是打 `api.openai.com`**，而是 **`https://chatgpt.com/backend-api`** + 专用 **`openai-codex-responses`** 传输（见下节） | **订阅权益**，与 ① 的「API 用量」不是同一张账单 |
| **③ 受限 Key / 权限** | 同上，但 Key 未勾选 **Responses** 等 scope | 某一端会 **401**（如缺 `api.responses.write`） | 需在控制台为 Key 勾选权限，或换接口形态 |

**同一串 JWT 在 Codex CLI 里能跑**，只说明 **② 在官方支持的链路上成立**；**不能**推出：这串 token 对 **① 的 `chat/completions`** 一定有额度，或对 **Responses** 一定带齐 scope。

---

## 为啥 OpenClaw「用 OAuth 就行」，我这里却 401 再 429？

**先对齐一点：OpenClaw 的 Codex 线路也是「浏览器里登录 / OAuth」**（例如向导里选 `openai-codex`、`models auth login --provider openai-codex`），并不是只有 `sk-` 才叫「正规」。  
差别不在「是不是浏览器授权」，而在：**登录的是哪条 OAuth 产品、拿到的 token 带哪些 scope、运行时把请求打到哪条 HTTP、失败时会不会误切到另一条计费轨道**。

[OpenClaw 文档](https://docs.clawd.bot/providers/openai) 把两条路写得很清楚（与「随便把 token 填进一个 HTTP 客户端」不是一回事）：

1. **`openai/gpt-*`（API Key）**  
   - 走 **`sk-…`**，面向 **Platform**，文档写明会经 **`openai/*` 的 Responses 路径**转发（与旧式「只认 chat/completions」的集成不同）。

2. **`openai-codex/gpt-*`（Codex 订阅）**  
   - 同样是 **浏览器 OAuth**，但是 **针对 Codex 订阅这一条**（如 `openclaw onboard --auth-choice openai-codex`、`openclaw models auth login --provider openai-codex`），模型前缀是 **`openai-codex/…`**，由网关/pi-ai 按 **订阅权益** 路由到约定端点，**不是**「把 JWT 当成 Platform 的 `chat/completions` 通用额度」。

因此 OpenClaw 能稳定，通常是因为：

- **要么**用 **`sk-`**，在 **Platform + 有 Responses 权限** 的前提下走 **Responses**（与 Codex CLI 的 HTTP 形态一致）；  
- **要么**用 **Codex OAuth**，走 **`openai-codex/…` 这条产品轨道**，由运行时（如 pi-ai）按官方约定带 token、endpoint、scope，**不会**在失败时退到一个「订阅 token 根本没有 Platform 用量」的 **`chat/completions`** 上硬撞。

而你在 OpenUltron 里若出现：

1. **`[401] …/responses` + `api.responses.write`**  
   → 当前凭证对 **Responses** 这条 HTTP **没有写权限**（受限 Key、或 token scope 不含 Responses 等）。

2. **自动改走 `chat/completions` 后出现 `[429] quota`**  
   → 说明 **Platform 这条轨道**上，当前账户 **没有可用用量**（或该 token **根本不是按 Platform 用量计费的 Key**）。  
   **Codex 订阅 OAuth** 与 **Platform API 用量** 是两套账；**退回到 `chat/completions` 等于换到 ①**，没有 **`sk-` + 余额** 就会 429。

**结论**：不是「没找到根本原因」，而是 **OpenClaw 从产品设计上就区分了 `openai/*` 与 `openai-codex/*`，且主路径对齐 Responses / 官方 OAuth；** 若本地只有 Codex JWT、又没有 Platform 额度，**任何**在 401 后改打 **`chat/completions`** 的实现都会撞上 **429**——这与「Codex 能聊天」不矛盾。

---

## OpenClaw 源码里怎么写的（[openclaw/openclaw](https://github.com/openclaw/openclaw)）

下面是对 **`extensions/openai/`** 的阅读结论，便于和「只往 `api.openai.com` 塞 JWT」对比。

### 1. `openai-codex`：浏览器 OAuth，但 **Base URL 是 ChatGPT 后端**

[`openai-codex-provider.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/openai/openai-codex-provider.ts) 中：

- `OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api"`（**不是** `https://api.openai.com/v1`）。
- `normalizeCodexTransport`：在适用条件下把模型上的 **`openai-responses`** 换成 **`openai-codex-responses`**，并把 **`api.openai.com` 的 base** 换成上面的 **`chatgpt.com/backend-api`**。
- `runOpenAICodexOAuth` 调用 `loginOpenAICodexOAuth`（浏览器完成登录）。

也就是说：**OpenClaw 的「ChatGPT OAuth / Codex」线路，请求是打到 **ChatGPT 的 backend-api** 这一套，而不是把你浏览器拿到的 token 当成「Platform 通用 Bearer」去撞 `api.openai.com/v1`。**

### 2. `openai`：只有 **`sk-` API Key**，并把 Completions 规范成 **Platform Responses**

[`openai-provider.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/openai/openai-provider.ts) 中：

- 认证方式是 **`createProviderApiKeyAuthMethod`**（`OPENAI_API_KEY` / `--openai-api-key`）。
- `normalizeOpenAITransport`：在 `api.openai.com` 上把 **`openai-completions`** 规范成 **`openai-responses`**（与文档「`openai/*` 走 Responses」一致）。

### 3. 官方自己在 UI 里区分两条路

同文件 `buildMissingAuthMessage` 大意是：若只登录了 **Codex OAuth**、没有 **`OPENAI_API_KEY`**，会提示用 **`openai-codex/gpt-5.4`（OAuth）** 或设置 **`OPENAI_API_KEY`** 才能用 **`openai/gpt-5.4`**——**没有把「Codex OAuth」自动当成 `openai` 的 API Key。**

### 和 OpenUltron 的差异（为何你会 401 → 429）

| | OpenClaw（源码行为） | OpenUltron（常见配置） |
|--|----------------------|-------------------------|
| ChatGPT/Codex OAuth | **`chatgpt.com/backend-api` + `openai-codex-*`** | 常把 JWT 配在 **`api.openai.com`** |
| Platform | **`sk-` → `api.openai.com` + Responses** | **按「接口类型」走 Responses / Chat，不自动跨线切换** |

因此：**「OpenClaw 浏览器登录能用」≠「同一 token 填到 `api.openai.com` 一定等价」**——人家在 **`openai-codex` 分支上根本走的是 **另一套 base URL**。

---

## OpenUltron 当前行为（实现状态）

在「设置 → AI 配置」中，供应商为 **OpenAI（api.openai.com）** 时可选择 **接口类型**：

- **自动**：`sk-` → **Chat Completions**；JWT（`eyJ…`）→ **`POST https://chatgpt.com/backend-api/codex/responses`**（与 OpenClaw `openai-codex` 一致，走 **Codex / ChatGPT 订阅** 侧，**不再**默认打 `api.openai.com/v1/responses`）。  
- ChatGPT Codex 端点要求 **`instructions` 必填**（无 system 消息时应用会填默认一句），且 **`store: false`**（否则会返回 `400 Store must be set to false`），应用已自动带上；且**不支持**传 `temperature`（否则会 `400 Unsupported parameter: temperature`），已自动省略。  
- Codex 的 `input` 内 **user** 消息文本块用 **`input_text`**（及 `input_image` 等）；**assistant** 历史文本块用 **`output_text`** / **`refusal`**，与 Platform 全用 `input_text` 不同，应用已按角色区分。  
- **Codex 订阅（chatgpt.com 后端）**：显式固定上述 Codex 端点（即使 Base URL 仍填 `api.openai.com/v1`）。  
- **Responses (Platform)**：`POST {apiBaseUrl}/responses`（Platform API Key / 需 `api.responses.write` 等）。  
- **Chat**：`POST {apiBaseUrl}/chat/completions`。

**不会在** Responses / Codex 与 **Chat Completions** 之间自动切换；请按凭证在设置里选择 **Responses (Platform)**、**Codex** 或 **Chat**。模型不可用或限流时，仅通过 **备用模型 / 模型池** 继续对话（与接口类型无关）。

---

## 在本应用里怎么用官方 OpenAI？

1. **Codex CLI / ChatGPT 登录态（JWT）**  
   - 使用 **自动** 或 **Codex 订阅**；确保 token 与 ChatGPT 后端兼容。Base URL 仍可填 `https://api.openai.com/v1`（实际请求会发往 `chatgpt.com/backend-api`）。

2. **Platform 用量（`sk-`）**  
   - 在 [platform.openai.com/api-keys](https://platform.openai.com/api-keys) 创建 **`sk-…`**，保证账户 **有可用额度**。  
   - 需要 **Platform Responses** 时选 **Responses (Platform)**，并确保 Key 含 Responses 权限。

3. **聚合网关**  
   - OpenRouter 等兼容 **`/v1/chat/completions`** 的网关，填对应 Base URL 与 Key。

---

## 与本文档旧版表述的差异

- 早期版本曾写「仅 chat/completions」——**已过时**；当前支持 **Responses**、**Chat Completions**、**ChatGPT Codex 后端** 多路径。  
- 若仍见 429，多为 **Platform chat/completions** 无额度；若已用 **JWT 自动模式**，应确认请求是否走 **ChatGPT Codex** 而非误配 Platform。
