// AI Agent 核心编排器
// 支持 OpenAI 兼容 API 和 Anthropic Messages API，自动按模型名切换

const https = require('https')
const http = require('http')
const net = require('net')
const tls = require('tls')
const path = require('path')
const { URL } = require('url')
const { estimateTokens, shouldCompress, compressMessages, flushMemoryBeforeCompaction, DEFAULT_CONFIG: COMPRESSION_DEFAULTS } = require('./context-compressor')
const { slimToolsForChat, shouldSlimToolDefinitions } = require('./slim-tool-definitions')
const { getTopMemoriesForProject, saveMemory, readGlobalMemoryMd, readSoulMd, readIdentityMd, readAgentDisplayName, readUserMd, readBootMd, readAgentsMd, readToolsMd, readLessonsLearned, appendToDiary } = require('./memory-store')
const { loadPrompt } = require('./system-prompts')
const { sanitizeAssistantIdentityWording, sanitizeAssistantModelIdentity } = require('./identity-wording')
const fs = require('fs')
const { getAppRootPath, getWorkspaceRoot } = require('../app-root')
const sessionRegistry = require('./session-registry')
const { logger: appLogger } = require('../app-logger')
const {
  buildResponsesRequestBody,
  getOpenAiResponsesPostUrl,
  isCodexChatgptResponsesUrl,
  extractResponsesOutputText
} = require('./openai-responses')
const { LLM_TRANSPORT, resolveLlmTransport } = require('./llm-transport')
const {
  streamOpenAiChatCompletions,
  streamOpenAiResponses,
  streamAnthropicMessages
} = require('./llm-stream-callers')
const { isOpenRouterBaseUrl, applyNonStreamOpenAiChatMaxTokens } = require('./openrouter-chat-constants')
const { mergeModelSelectionIntoConfig } = require('./resolve-provider-config')
const { createChatRunId } = require('./run-id')
const { buildWebAppStudioSandboxMemoryBlock } = require('./webapp-studio-context')
const { getWebAppsRoot } = require('../web-apps/registry')
const { shouldForceExecutionContinuation } = require('./visible-result-policy')
const { getChildSubSessionIdsForParent, clearChildrenForParent } = require('./subagent-spawn-registry')

/** 是否为相对路径（与仅以 `/` 开头区分，兼容 Windows 绝对路径） */
function isRelativeFilePath(p) {
  if (p == null || typeof p !== 'string') return false
  const s = String(p).trim()
  if (!s) return false
  return !path.isAbsolute(s)
}

/**
 * 应用工作室：会话绑定 ~/.openultron/web-apps/... 沙箱目录。
 * 此类会话若仍注入「当前应用=OpenUltron」「改名字→IDENTITY.md」，会覆盖前端沙箱提示，导致改 Hello 示例时误改主程序身份文件。
 */
function isWebAppSandboxProject(projectPath) {
  const p = String(projectPath || '').trim()
  if (!p || p.startsWith('__')) return false
  if (!path.isAbsolute(p)) return false
  return /web-apps/i.test(p.replace(/\\/g, '/'))
}

function isPathUnderWebAppsInstallRoot(fp) {
  try {
    const root = path.resolve(getWebAppsRoot())
    const abs = path.resolve(String(fp || '').trim())
    if (!abs) return false
    return abs === root || abs.startsWith(root + path.sep)
  } catch (_) {
    return false
  }
}

const WEBAPP_DELEGATION_REQUIRED_MSG =
  '侧栏「应用」沙箱（~/.openultron/web-apps）须由 **webapp_studio_invoke** 委派应用工作室 Agent 修改，勿在本会话直接改文件。已装列表：**web_apps_list**；新建：**web_apps_create** 或 webapp_studio_invoke(create_new=true)。'

/** 从字符串中匹配第一个「绝对路径 + 图片扩展名」*/
const SCREENSHOT_PATH_RE = /(\/var\/folders\/[^\s'")\]]+\.(?:png|jpg|jpeg|webp))|(\/tmp\/[^\s'")\]]+\.(?:png|jpg|jpeg|webp))|(\/(?:var|Users|tmp)[^\s'")\]]+\.(?:png|jpg|jpeg|webp))/i

function extractScreenshotPathFromResult(result) {
  if (!result || typeof result !== 'object') return null
  const direct = result.file_path || result.filePath || result.path
  if (direct && typeof direct === 'string' && path.isAbsolute(direct.trim())) return direct.trim()
  const texts = [
    result.result,
    result.tip,
    result.message,
    result.text,
    typeof result.content === 'string' ? result.content : null
  ].filter(Boolean).map(String)
  for (const text of texts) {
    const m = text.match(SCREENSHOT_PATH_RE)
    const p = (m && (m[1] || m[2] || m[3] || '')).trim()
    if (p && path.isAbsolute(p) && fs.existsSync(p)) return p
  }
  return null
}

/** 仅当 sender 存在且未销毁时才可推送（sender 可能非 WebContents，无 isDestroyed） */
function canSend(sender) {
  if (!sender) return false
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return false
  return true
}

/**
 * 注入系统上下文的「本机当前时间」块。
 * 模型常把「当前」误写成训练截止附近的年份（如 2025），需给出明确真值源并强调优先于训练先验与网页上的过期日期。
 */
function buildLocalNowContextBlock() {
  const d = new Date()
  const y = d.getFullYear()
  const mo = d.getMonth() + 1
  const day = d.getDate()
  const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch (_) { /* ignore */ }
  const isoLocal = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}T${h}:${mi}:${s}`
  const dateZh = `${y}年${mo}月${day}日`
  return [
    '[当前时间 — 以运行本应用的电脑本机系统时钟为准]',
    `- 日期：${dateZh}（星期${wk}）`,
    `- 时刻：${h}:${mi}:${s}（24 小时制，本地）`,
    `- IANA 时区：${tz || '（未能解析，仍按下方本地时刻理解）'}`,
    `- ISO 本地日期+时刻：${isoLocal}`,
    '',
    '凡涉及「今天、现在、此刻、本周、本月、今年、当前日期/年份」等，必须与上列**公历年月日**一致。',
    '不得以模型训练数据中的默认年份（例如误认为仍是 2025）代替；不得以搜索结果、网页页眉或文章里的旧日期代替「今天」。',
    '若联网内容与上列冲突：以本段为「日历真值」；可向用户简短说明「按本机时间」。'
  ].join('\n')
}

/**
 * 同 session 新消息是否「明显只想停掉当前任务」——命中则跳过 LLM 分类，省一次请求。
 * @returns {boolean|null} true=停止, false=明显不停止, null=交下游模型判断
 */
function quickClassifyStopPreviousIntent(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (raw.length > 96) return null
  const core = raw.replace(/[\s.。!！?？…,，;；、]+$/u, '').trim()
  if (!core) return null
  if (/^(别做了|不要做了|不要了|算了|不用了|先停|先别|停一下|停一停|停下|停掉|停止|取消吧|取消任务|取消执行|取消|中断|别继续|别跑了)(了|吧|啊|呀|哈|哦|呗)?$/u.test(core)) {
    return true
  }
  if (/^(stop|cancel|abort|halt)(\.|!)?$/i.test(core)) return true
  if (/^(please\s+)?(stop|cancel)(\s+(it|now|this|that))?(\.|!)?$/i.test(core)) return true
  return null
}

function pickRecentUserIntentText(messages, maxUserMessages = 3, maxChars = 3200) {
  const list = Array.isArray(messages) ? messages : []
  const users = list.filter(m => m && m.role === 'user').slice(-Math.max(1, maxUserMessages))
  const text = users.map((m) => {
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : (x?.text || ''))).join('\n')
    return c ? JSON.stringify(c) : ''
  }).join('\n')
  return String(text || '').slice(0, Math.max(800, maxChars))
}

function hasAnyKeyword(text, keywords) {
  const t = String(text || '').toLowerCase()
  return (keywords || []).some(k => t.includes(String(k).toLowerCase()))
}

function hasModelIdentityQuestion(text) {
  const raw = String(text || '')
  if (!raw.trim()) return false
  const normalized = raw
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[，,。、！？!?;:：；…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  const zhKeywords = [
    '你是什么模型',
    '你是哪种模型',
    '你是哪个模型',
    '你现在用的模型',
    '当前模型',
    '当前用的是哪个模型',
    '你用的是哪个模型',
    '当前模型是',
    '你是什么 ai 模型',
    '你是什么 llm',
    '你是什么人工智能模型',
    '你的模型',
    '你是什么 llm 模型'
  ]
  const enKeywords = [
    'what model',
    'which model',
    'model name',
    'what llm',
    "what's your model",
    'what model are you',
    'which llm are you',
  ]

  if (hasAnyKeyword(normalized, zhKeywords)) return true
  if (hasAnyKeyword(normalized, enKeywords)) return true

  // 兼容直接问法：“你用的模型是…”
  const directZh = /(你是|你现在用|你现在使用|你用的是|当前|请问(?:你的)?模型|你用的).{0,16}(openai|claude|qwen|gpt|gemini|deepseek|glm|kimi|llm|模型)/u
  const directEn = /(what|which|are you|model|llm|current model|using now|using).{0,24}(model|llm|provider|vendor)/u
  if (directZh.test(normalized) && /(模型|llm|large language model|language model|ai 模型|vendor|provider)/u.test(raw.toLowerCase())) {
    return true
  }
  if (/\b(model|llm)\b/.test(normalized) && /\b(are|is|what|which|who|current)\b/.test(normalized) && directEn.test(normalized)) {
    return true
  }
  return false
}

function detectPromptIntentFlags(userText) {
  const t = String(userText || '')
  return {
    learnSkill: hasAnyKeyword(t, ['学习技能', '新技能', '孵化技能', 'skill', 'skill.md']),
    learnFromWeb: hasAnyKeyword(t, ['网上', '社区', 'github', 'clawhub', '爬', 'web', '搜索']) &&
      hasAnyKeyword(t, ['技能', '玩法', 'skill', 'agent']),
    configGuide: hasAnyKeyword(t, ['配置', '参数', 'api key', 'apikey', 'token', 'provider', 'openrouter', 'openai', '飞书', 'telegram', 'dingtalk', 'webhook']),
    identityInquiry: hasModelIdentityQuestion(t)
  }
}

function clipInjectedSection(text, maxChars) {
  const s = String(text || '').trim()
  const lim = Number(maxChars) || 0
  if (!s || lim <= 0 || s.length <= lim) return s
  return `${s.slice(0, lim)}\n\n...(已截断，原始长度 ${s.length} 字)`
}

function clipInjectedTailSection(text, maxChars) {
  const s = String(text || '').trim()
  const lim = Number(maxChars) || 0
  if (!s || lim <= 0 || s.length <= lim) return s
  return `...(已截断，原始长度 ${s.length} 字，仅注入最近片段)\n\n${s.slice(-lim)}`
}

function estimateTokenBreakdown(messages) {
  const list = Array.isArray(messages) ? messages : []
  const buckets = { system: 0, dialog: 0, tool: 0, other: 0 }
  for (const m of list) {
    if (!m) continue
    const one = estimateTokens([m])
    if (m.role === 'system') buckets.system += one
    else if (m.role === 'tool') buckets.tool += one
    else if (m.role === 'user' || m.role === 'assistant') buckets.dialog += one
    else buckets.other += one
  }
  const total = buckets.system + buckets.dialog + buckets.tool + buckets.other
  const ratio = (n) => total > 0 ? Number(((n / total) * 100).toFixed(1)) : 0
  return {
    total,
    system: buckets.system,
    dialog: buckets.dialog,
    tool: buckets.tool,
    other: buckets.other,
    systemPct: ratio(buckets.system),
    dialogPct: ratio(buckets.dialog),
    toolPct: ratio(buckets.tool),
    otherPct: ratio(buckets.other)
  }
}

function getProxyUrlForTarget(targetUrl) {
  try {
    const isHttps = String(targetUrl?.protocol || '').toLowerCase() === 'https:'
    const env = process.env || {}
    const direct = isHttps
      ? (env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '')
      : (env.http_proxy || env.HTTP_PROXY || '')
    const fallback = env.all_proxy || env.ALL_PROXY || ''
    const raw = String(direct || fallback || '').trim()
    if (!raw) return null
    const u = new URL(raw)
    return u
  } catch {
    return null
  }
}

/**
 * Codex CLI 默认走 OpenAI Responses API（/v1/responses）；本应用走 Chat Completions（/v1/chat/completions）。
 * 同一 OAuth 在 Codex 可用 ≠ 对 chat/completions 有 Platform 额度；429 时勿只理解为「欠费」。
 */
function appendOpenAiPlatformBillingHint(statusCode, hostname, message) {
  const code = Number(statusCode)
  if (code !== 429 && code !== 402) return String(message || '')
  const h = String(hostname || '').toLowerCase()
  if (!h.includes('openai.com')) return String(message || '')
  const m = String(message || '')
  const lower = m.toLowerCase()
  if (!/(quota|billing|exceeded|insufficient|credit|payment|plan|afford|limit)/.test(lower)) return m
  return `${m}\n\n[OpenUltron] 说明：**Codex 能正常使用 ≠ 本应用「发消息」走同一接口**。Codex 官方默认使用 **Responses API**；本应用使用 **chat/completions**。若从 Codex 导入 access_token，对 Platform 的 chat/completions 可能无额度或权限不同。请优先在 platform.openai.com/api-keys 使用 **sk-… API Key**，或改用兼容 chat/completions 的网关。详见仓库 docs/OPENAI-CODEX-AND-CHAT-COMPLETIONS.md`
}

// Claude 模型前缀
const CLAUDE_PREFIXES = ['claude-']
const GLOBAL_MODEL_UNAVAILABLE_TTL_MS = 10 * 60 * 1000

class Orchestrator {
  constructor(getAIConfigOrStore, toolRegistry, mcpManager, opts = {}) {
    this.getAIConfig = typeof getAIConfigOrStore === 'function' ? getAIConfigOrStore : null
    this.store = this.getAIConfig ? null : getAIConfigOrStore
    this.toolRegistry = toolRegistry
    this.mcpManager = mcpManager || null
    this.activeSessions = new Map()
    /** 可选：将工具返回的 image_base64 注册为文件并返回 file_url，避免 base64 进入消息体 */
    this.registerImageBase64 = typeof opts.registerImageBase64 === 'function' ? opts.registerImageBase64 : null
    /** 可选：将截图工具的 file_path 复制到应用目录并返回 file_url，供前端展示 */
    this.registerScreenshotPath = typeof opts.registerScreenshotPath === 'function' ? opts.registerScreenshotPath : null
    /** 可选：每轮会话注入「技能 id 列表」到 system，与 ~/.openultron/skills 磁盘一致，避免前端未刷新导致模型看不到技能 */
    this.getSkillsForPrompt = typeof opts.getSkillsForPrompt === 'function' ? opts.getSkillsForPrompt : null
    /** 自动碎片记忆提取：按会话节流，避免每轮对话都打 LLM */
    this._memoryExtractState = new Map()
    /** 会话级不可用模型缓存：key=sessionId, value=Set("model@@apiBaseUrl") */
    this._sessionUnavailableModels = new Map()
    /** 全局不可用模型缓存（进程级，带 TTL）：key="model@@apiBaseUrl", value=expiresAt(ms) */
    this._globalUnavailableModels = new Map()
  }

  getConfig() {
    if (this.getAIConfig) {
      const legacy = this.getAIConfig()
      return legacy && legacy.config ? legacy.config : {}
    }
    const config = this.store.get('aiConfig', {
      apiBaseUrl: 'https://api.qnaigc.com/v1',
      defaultModel: 'deepseek-v3',
      temperature: 0,
      maxTokens: 0,
      maxToolIterations: 0
    })
    const providerKeys = this.store.get('aiProviderKeys', {})
    const baseUrl = (config.apiBaseUrl || 'https://api.qnaigc.com/v1').trim()
    config.apiBaseUrl = baseUrl
    const resolvedKey = providerKeys[baseUrl] || config.apiKey || ''
    config.apiKey = resolvedKey.trim()
    return config
  }

  _isClaudeModel(model) {
    const m = (model || '').toLowerCase()
    return CLAUDE_PREFIXES.some(p => m.startsWith(p))
  }

  _hasToolCallAfterLastUser(messages, toolName) {
    if (!Array.isArray(messages) || !toolName) return false
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return false
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      const m = messages[i]
      if (!m || m.role !== 'assistant') continue
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : (Array.isArray(m.toolCalls) ? m.toolCalls : [])
      if (calls.some(tc => tc?.function?.name === toolName || tc?.name === toolName)) return true
    }
    return false
  }

  _modelRouteKey(model, routeConfig) {
    const m = String(model || '').trim()
    const base = String(routeConfig?.apiBaseUrl || '').trim()
    return `${m}@@${base}`
  }

  _rememberSessionUnavailableModel(sessionId, model, routeConfig) {
    const sid = String(sessionId || '').trim()
    if (!sid) return
    const key = this._modelRouteKey(model, routeConfig)
    if (!key || key.startsWith('@@')) return
    const set = this._sessionUnavailableModels.get(sid) || new Set()
    set.add(key)
    // 防止异常增长，保留最近 32 条
    if (set.size > 32) {
      const trimmed = Array.from(set).slice(-32)
      this._sessionUnavailableModels.set(sid, new Set(trimmed))
      return
    }
    this._sessionUnavailableModels.set(sid, set)
  }

  _gcGlobalUnavailableModels(now = Date.now()) {
    for (const [key, expiresAt] of this._globalUnavailableModels.entries()) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        this._globalUnavailableModels.delete(key)
      }
    }
  }

  _rememberGlobalUnavailableModel(model, routeConfig, ttlMs = GLOBAL_MODEL_UNAVAILABLE_TTL_MS) {
    const key = this._modelRouteKey(model, routeConfig)
    if (!key || key.startsWith('@@')) return
    const now = Date.now()
    this._gcGlobalUnavailableModels(now)
    const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
      ? Number(ttlMs)
      : GLOBAL_MODEL_UNAVAILABLE_TTL_MS
    this._globalUnavailableModels.set(key, now + ttl)
  }

  _isGlobalUnavailableModel(model, routeConfig) {
    const key = this._modelRouteKey(model, routeConfig)
    if (!key || key.startsWith('@@')) return false
    const now = Date.now()
    const expiresAt = this._globalUnavailableModels.get(key)
    if (!Number.isFinite(expiresAt)) return false
    if (expiresAt <= now) {
      this._globalUnavailableModels.delete(key)
      return false
    }
    return true
  }

  _isSessionUnavailableModel(sessionId, model, routeConfig) {
    const sid = String(sessionId || '').trim()
    if (!sid) return false
    const set = this._sessionUnavailableModels.get(sid)
    if (!set || set.size === 0) return false
    return set.has(this._modelRouteKey(model, routeConfig))
  }

  _isKnownUnavailableModel(sessionId, model, routeConfig) {
    return this._isSessionUnavailableModel(sessionId, model, routeConfig) ||
      this._isGlobalUnavailableModel(model, routeConfig)
  }

  // ---------- 启动 Agent 对话循环 ----------
  async startChat({ sessionId, messages, model, tools, sender, config: externalConfig, projectPath, panelId, feishuChatId, feishuTenantKey, feishuDocHost, feishuSenderOpenId, feishuSenderUserId, subagentMinimalMemory = false, inheritIdentityFromProfile = false, allowChannelSend = true }) {
    const chatRunId = createChatRunId(sessionId)
    let config = externalConfig || this.getConfig()
    const requestedModel = model && String(model).trim() ? String(model).trim() : ''
    // 用户所选模型若绑定到另一供应商（modelBindings / fallbackRoutes），必须切换 apiBaseUrl/apiKey/openAiWireMode，否则会误用默认供应商（如仍走 Codex 的 chatgpt.com）
    if (requestedModel && this.getAIConfig) {
      config = mergeModelSelectionIntoConfig(config, requestedModel, this.getAIConfig, null)
    }
    if (!config.apiKey || !String(config.apiKey).trim()) {
      const baseUrl = (config.apiBaseUrl || '').trim()
      const isOpenRouter = /openrouter\.ai/i.test(baseUrl)
      const hint = isOpenRouter
        ? '请先在「设置 → 配置」中为 OpenRouter 填写并保存 API Key（可在 https://openrouter.ai/keys 获取）'
        : '请先配置 API Key'
      if (canSend(sender)) sender.send('ai-chat-error', { sessionId, error: hint, runId: chatRunId })
      return { success: false, error: hint }
    }

    // 同 session 新消息会开新 run 并覆盖 activeSessions[sessionId]；旧 run 仍在后台跑，finally 里只删“当前仍是自己的”条目，避免旧 run 结束时误删新 run
    const prevActive = this.activeSessions.get(sessionId)
    const abortController = new AbortController()
    this.activeSessions.set(sessionId, {
      abortController,
      chatRunId,
      panelId: panelId && String(panelId).trim() ? String(panelId).trim() : '',
      projectPath: projectPath || '',
      feishuChatId: feishuChatId || '',
      feishuTenantKey: feishuTenantKey || '',
      feishuDocHost: feishuDocHost || '',
      feishuSenderOpenId: feishuSenderOpenId || '',
      feishuSenderUserId: feishuSenderUserId || ''
    })
    if (prevActive?.chatRunId && prevActive.chatRunId !== chatRunId) {
      try {
        appLogger?.info?.('[Orchestrator] 同 session 新开 run，旧 run 仍在后台直至结束或中止', {
          sessionId: String(sessionId).slice(0, 24),
          previousRunId: prevActive.chatRunId,
          runId: chatRunId
        })
      } catch (_) { /* ignore */ }
    }

    // 用 panelId 操作 session-registry（panelId 在页面生命周期内稳定）
    // 没有 panelId 时回退到 sessionId（Heartbeat 等后台场景）
    const registryId = panelId || sessionId
    sessionRegistry.markRunning(registryId, {
      projectPath: projectPath || '',
      model: model || config.defaultModel || 'deepseek-v3',
      apiBaseUrl: config.apiBaseUrl || '',
      sender,
      abortController
    })

    if (isWebAppSandboxProject(projectPath)) {
      appLogger.info('[AI][WebAppSandbox] startChat', { runId: chatRunId, projectPath: String(projectPath || '').trim(), sessionId })
    }

    // 包装 sender：为可观测性统一注入 runId（含流式 LLM 内部直接调的 sender.send）
    const RUN_ID_CHANNELS = new Set([
      'ai-chat-token',
      'ai-chat-tool-call',
      'ai-chat-tool-result',
      'ai-chat-usage',
      'ai-chat-complete',
      'ai-chat-error'
    ])
    const wrappedSender = {
      send: (channel, data) => {
        const payload =
          data &&
          typeof data === 'object' &&
          data.sessionId === sessionId &&
          RUN_ID_CHANNELS.has(channel) &&
          data.runId == null
            ? { ...data, runId: chatRunId }
            : data
        if (canSend(sender)) sender.send(channel, payload)
        if (channel === 'ai-chat-token' && payload && payload.sessionId === sessionId) {
          sessionRegistry.updateToken(registryId, payload.token || '')
        }
        if (channel === 'ai-chat-tool-call' && payload && payload.sessionId === sessionId) {
          sessionRegistry.updateToolCall(registryId, payload.toolCall || {})
        }
      },
      isDestroyed: () => !canSend(sender)
    }

    const webAppSandbox = isWebAppSandboxProject(projectPath)
    const allowedPool = Array.isArray(config.modelPool)
      ? config.modelPool.map(x => String(x || '').trim()).filter(Boolean)
      : []
    let useModel = model || config.defaultModel || 'deepseek-v3'
    if (allowedPool.length > 0 && !allowedPool.includes(useModel)) {
      console.warn(`[AI] 指定模型 ${useModel} 不在模型池中，自动回退主模型 ${config.defaultModel || allowedPool[0]}`)
      useModel = config.defaultModel || allowedPool[0]
    }
    const configuredFallbacks = Array.isArray(config.fallbackModels) ? config.fallbackModels : []
    const poolFallbacks = allowedPool.filter(id => id !== useModel)
    const fallbackModels = [...new Set([...poolFallbacks, ...configuredFallbacks].filter(Boolean))]  // 故障转移备用模型列表
    const fallbackRoutes = Array.isArray(config.fallbackRoutes) ? config.fallbackRoutes : []
    try {
      appLogger.info('[AI] chatRun.start', {
        runId: chatRunId,
        sessionId,
        registryId,
        model: useModel,
        projectPath: String(projectPath || '').trim().slice(0, 200)
      })
    } catch (_) {}
    const isAnthropic = this._isClaudeModel(useModel)
    const maxIterations = config.maxToolIterations || 0 // 0 = 不限制（安全上限 200）
    const safeMax = maxIterations > 0 ? maxIterations : 200
    const displayName = readAgentDisplayName() || 'Ultron'
    const minimalPromptMode = String(process.env.OPENULTRON_PROMPT_STYLE || 'minimal').trim().toLowerCase() !== 'rich'
    let currentMessages = [...messages]
    const intentText = pickRecentUserIntentText(currentMessages)
    const promptIntentFlags = detectPromptIntentFlags(intentText)
    const isModelIdentityInquiry = Boolean(promptIntentFlags && promptIntentFlags.identityInquiry)
    const shouldBypassIdentitySanitization = isModelIdentityInquiry
    const normalizeAssistantContent = (content) =>
      typeof content === 'string'
        ? (shouldBypassIdentitySanitization
            ? content
            : sanitizeAssistantIdentityWording(sanitizeAssistantModelIdentity(content, useModel), displayName))
        : content
    const flattenAssistantText = (content) => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .map((part) => {
          if (!part) return ''
          if (typeof part === 'string') return part
          if (typeof part.text === 'string') return part.text
          return ''
        })
        .join('')
    }
    let iteration = 0
    let forcedContinuationCount = 0
    /** 子会话瘦身：不注入 SOUL/IDENTITY/USER 等（见 agent-orchestration-redesign）；profile inherit_identity 时可恢复身份块 */
    const subMinimal = !!subagentMinimalMemory && String(sessionId || '').startsWith('sub-') && !inheritIdentityFromProfile

    // 循环检测状态
    const loopDetector = {
      recentCalls: [],      // 最近工具调用记录
      recentRounds: [],     // 每轮 { toolNames, allError }，用于检测「同一工具连续失败」
      pingPongWindow: [],
      pollNoProgressCount: 0,
      lastPollKey: null,
    }

    // Memory 注入：全局 MEMORY.md + 项目相关 top-5 记忆
    try {
      const memParts = []
      const activeSession = this.activeSessions.get(sessionId)
      const minimalToolNames = isModelIdentityInquiry
        ? []
        : (Array.isArray(tools)
          ? tools
            .map((t) => String(t?.function?.name || '').trim())
            .filter(Boolean)
            .slice(0, 120)
          : [])
      const minimalParts = minimalPromptMode
        ? (() => {
            const p = []
            if (webAppSandbox) {
              p.push(buildWebAppStudioSandboxMemoryBlock(String(projectPath || '').trim()))
            } else {
              p.push(
                '[执行契约]\n' +
                '目标：完成用户需求；禁止空承诺（如“我现在执行，稍后给结果”）。\n' +
                '规则：只有工具真实成功后才能说已完成；失败要返回真实错误与下一步。\n' +
                `工作空间：${getWorkspaceRoot()}`
              )
            }
            p.push(
              '[工具与执行]\n' +
              `可用工具（节选）：${minimalToolNames.length ? minimalToolNames.join(', ') : '（无）'}\n` +
              '优先直接调用工具完成任务；需要文件改动时做最小改动并返回可验证产物（路径/链接/截图）。'
            )
            if (activeSession && activeSession.feishuChatId) {
              p.push(
                '[渠道约束: 飞书]\n' +
                '需发图/文件时必须有真实附件；禁止只发“已发送”文本。'
              )
            }
            p.push(buildLocalNowContextBlock())
            return p
          })()
        : null
      const sandboxRoot = webAppSandbox ? String(projectPath).trim() : ''
      if (isModelIdentityInquiry) {
        const currentModelText = `当前模型：${(String(useModel || '').trim() || '未知')}。
直接回答这个模型，不要额外解释你的职责、能力边界或处理步骤。`
        memParts.push(
          '[模型身份查询]\n' +
          currentModelText
        )
      } else {
        // 0. 当前应用边界（最高优先级）
        if (webAppSandbox) {
          memParts.push(buildWebAppStudioSandboxMemoryBlock(sandboxRoot))
        } else if (!subMinimal) {
          memParts.push(
            '[当前应用]\n' +
            '你正在运行并直接操作的应用是 **OpenUltron**（本应用）。\n' +
            '用户要求改外部项目时，先执行命令定位项目与文件，再改；不要在未执行时声称“找不到”。\n' +
            '安装命令前先查 query_command_log(recent_successful_commands)，已装过则不重复安装。\n' +
            '排查 OpenUltron 自身异常（Gateway、渠道、内置工具失败）时用 read_app_log 读 app.log 尾部；可按 keyword 缩小范围。\n' +
            '[「附近」与地域类问题]\n' +
            '应用**无内置自动定位**（不提供 GPS/经纬度工具）。用户提到附近、周边、当地、本地天气/美食/景点等时：请用户说明**城市或区域**，或参考 USER.md 等已有信息，再用 web_search / web_fetch；勿编造用户位置。\n' +
            '缺依赖时优先内置工具（如 ffmpeg_run、edge_tts_synthesize），失败再 execute_command 安装或重试一次。\n' +
            '用户明确要求语音时必须真实调用语音相关工具，不得只文字声称完成。\n' +
            `默认工作空间：${getWorkspaceRoot()}。\n` +
            `当无真实项目路径时：脚本优先写入 ${path.join(getWorkspaceRoot(), 'scripts')}，新建项目优先放入 ${path.join(getWorkspaceRoot(), 'projects')}，避免散落在其他目录。\n` +
            '生成 PPT/PDF/Excel 等二进制文件必须用 execute_command 实际生成，并返回绝对路径。\n' +
            '侧栏「应用」/ Web 沙箱（~/.openultron/web-apps）：**必须**用 **webapp_studio_invoke** 改代码或完整新建功能流；**禁止**对 web-apps 下文件使用 file_operation(write)、apply_patch、或将 execute_command 的 cwd 指到该目录（会被拒绝）。**web_apps_list** 查已装（模型应优先用它，勿让用户背 id）；**web_apps_create** 或 webapp_studio_invoke(create_new) 新建；编辑用 app_hint / path / id@version。\n' +
            '委派 **webapp_studio_invoke** 时：若用户要「带界面的功能」（表单、上传、按钮、邮件内容编辑区等），在 **task** 里明确写「须同时修改 index.html（或实际入口页）与 service.js / 后端」，避免子 Agent 只改服务端。\n' +
            '只有工具明确成功才能说“已完成”；失败必须如实反馈错误。\n' +
            '默认直接执行并给结果，减少模板化空话。'
          )
        }

        // 0.1 当前模型（从 prompts/current-model.md 或默认）
        const currentModelText = loadPrompt('current-model', { model: useModel })
        if (!shouldBypassIdentitySanitization && currentModelText) memParts.push(currentModelText)

        // 0.12 任务完成原则（从 prompts/task-persistence.md 或默认；主会话与工作室均注入）
        const taskPersistenceText = loadPrompt('task-persistence')
        if (taskPersistenceText) memParts.push(taskPersistenceText)

        memParts.push(buildLocalNowContextBlock())

        // 0.5 飞书会话（从 prompts/feishu-session.md 或默认）
        const session = this.activeSessions.get(sessionId)
        if (session && session.feishuChatId) {
          const feishuText = loadPrompt('feishu-session')
          if (feishuText) memParts.push(feishuText)
          const feishuDocsText = loadPrompt('feishu-docs')
          if (feishuDocsText) memParts.push(feishuDocsText)
          const feishuSheetBitableText = loadPrompt('feishu-sheets-bitable')
          if (feishuSheetBitableText) memParts.push(feishuSheetBitableText)
          memParts.push(
            '[飞书附件处理规则]\n' +
            '当用户消息中已包含附件的 local_path（例如 [Inbound Attachment Paths] 或 local_path: /...）时：\n' +
            '1) 请优先使用这些路径读取/分析；\n' +
            '2) 避免在 ~/Downloads 或其他目录盲目搜索同名文件；\n' +
            '3) 若路径读取失败，再明确说明失败原因并给出下一步。'
          )
        }

        // 0.6 联网与实时信息（prompts/realtime-info.md）
        const realtimeText = loadPrompt('realtime-info')
        if (realtimeText) memParts.push(realtimeText)

        // 0.62 编程执行优先（prompts/coding-execution.md）
        const codingExecutionText = loadPrompt('coding-execution')
        if (codingExecutionText) memParts.push(codingExecutionText)

        // 0.63 本机技能索引（含 workspace/skills；优先级见 docs/SKILLS-PACK-COMPAT.md）
        if (typeof this.getSkillsForPrompt === 'function') {
          try {
            const proj = String(session?.projectPath || '').trim()
            const skillRows = this.getSkillsForPrompt(proj) || []
            const allLines = skillRows.filter(s => s && s.id).map(s => `- [${s.id}] ${s.name || s.id}`)
            const lines = allLines.slice(0, 40)
            if (allLines.length > 0) {
              memParts.push(
                '[本机已安装技能]\n' +
                `以下展示 ${lines.length}/${allLines.length} 个；**get_skill 的 skill_id 必须为方括号内的完整 id**（例如 weather 技能目录常为 weather-1.0.0，不能用简称 weather）。\n` +
                lines.join('\n') +
                (allLines.length > lines.length ? `\n- ...(其余 ${allLines.length - lines.length} 个已省略)` : '') +
                '\n\n**何时必须用技能**：用户要求「用某技能 / 按 xxx 技能 / 查天气」等时，必须先 **get_skill(action="get", skill_id="完整id")** 再按其步骤执行（常见为 execute_command 调用 curl 等），禁止跳过 get_skill 凭记忆编造天气或步骤。'
              )
              memParts.push(
                '[技能执行与 git 规则]\n' +
                `你有上述可用技能（共 ${allLines.length} 个），请根据用户意图自动判断是否需要使用。需要使用某个技能时，先调用 get_skill(action="get", skill_id="...") 获取完整内容（含描述和步骤）后严格执行。\n\n` +
                '## 技能自动优化规则\n' +
                '当你执行某个技能并在对话中做了调整（如修复了步骤错误、补充了遗漏环节、根据用户反馈优化了流程），' +
                '在对话结束前必须调用 install_skill(action="update") 将最终正确的版本写回该技能文件。\n' +
                '触发条件（满足任一即更新）：\n' +
                '1. 执行技能时遇到报错，调整后成功\n' +
                '2. 用户指出技能步骤有问题并确认了修正方案\n' +
                '3. 你主动补充了技能中缺失的关键步骤且用户认可\n' +
                '4. 你通过 run_script 写出的脚本运行成功且可复用，必须用 install_skill 保存为 type: script 技能\n' +
                '更新时保留原有 frontmatter，只修改正文内容，不得降低原有步骤的完整性。\n\n' +
                '## git commit 确认规则\n' +
                '执行 git commit 前调用 user_confirmation 时，必须带上 allow_push: true 参数，' +
                '让用户可以选择「确认并推送」一步完成提交+推送。若用户选择「确认并推送」，' +
                '工具返回结果中 push_after_commit 为 true，此时在 commit 成功后立即执行 git push origin <当前分支>。'
              )
            }
          } catch (e) {
            console.warn('[AI] 技能索引注入失败:', e.message)
          }
        }

        // 0.65 浏览器自动化（prompts/browser-automation.md）
        const browserText = loadPrompt('browser-automation')
        if (browserText) memParts.push(browserText)

        // 0.66 桌面原生通知（prompts/desktop-notification.md）
        const desktopNotifText = loadPrompt('desktop-notification')
        if (desktopNotifText) memParts.push(desktopNotifText)

        // 0.67 通用工具缺口兜底（prompts/tool-gap-fallback.md）
        const toolGapFallbackText = loadPrompt('tool-gap-fallback')
        if (toolGapFallbackText) memParts.push(toolGapFallbackText)

        // 1. 全局偏好文件 MEMORY.md
        if (!subMinimal) {
          const globalMd = readGlobalMemoryMd()
          if (globalMd) memParts.push(`[全局偏好 - MEMORY.md]\n${clipInjectedSection(globalMd, 1800)}`)
        }

        // 2. 本应用 SOUL.md / IDENTITY.md（应用工作室沙箱会话不注入，避免与「改 Hello 页面」冲突）
        if (!webAppSandbox && !subMinimal) {
          const soulMd = readSoulMd()
          if (soulMd) memParts.push(`[SOUL.md - 性格与原则]\n${clipInjectedSection(soulMd, 1800)}`)

          // 2.1 IDENTITY.md（Agent 名字、形象、vibe、代词）
          const identityMd = readIdentityMd()
          if (identityMd) memParts.push(`[IDENTITY.md]\n${clipInjectedSection(identityMd, 1500)}`)
          // 回复与自我介绍：仅用 IDENTITY/SOUL，禁止通用话术（尤其飞书等渠道）
          memParts.push(
            '[回复与自我介绍]\n' +
            '打招呼、回复「你好」「在吗」或自我介绍时，请按 IDENTITY.md 与 SOUL.md 中的名字、语气与身份来回复。不要自称「OpenUltron 的 AI 助手」「随时为您服务」等通用话术；若 IDENTITY 里已有名字与 vibe，就用该名字与语气，不要额外套用上述模板。'
          )
          // 上下文消歧 + 正确路径：名字/身份指本应用；文件在应用根目录，非 prompts 下
          memParts.push(
            '[名字与身份修改]\n' +
            '当用户说「改名字」「改身份」「修改角色」「你可以修改名字/身份吗」等且**未明确说是某外部项目**时，指**本应用（OpenUltron）**的身份配置。\n' +
            '**正确路径**：IDENTITY.md、SOUL.md 位于**应用根目录**（与 prompts 目录同级），例如 ~/.openultron/IDENTITY.md、~/.openultron/SOUL.md。文件名请使用**大写** IDENTITY.md、SOUL.md，请勿写入 prompts/ 目录或使用 identity.md（小写）。修改时请用 file_operation 写入上述路径，或引导用户点击「编辑我的名字与角色」打开正确文件。'
          )
        }

        // 2.2 USER.md（用户信息：姓名、时区、工作、偏好等）
        if (!subMinimal) {
          const userMd = readUserMd()
          if (userMd) memParts.push(`[USER.md]\n${clipInjectedSection(userMd, 1200)}`)

          // 2.3 BOOT.md（会话启动时简短指令）
          const bootMd = readBootMd()
          if (bootMd) memParts.push(`[BOOT.md - 启动指令]\n${clipInjectedSection(bootMd, 900)}`)
        }

        // 2.4 AGENTS.md / TOOLS.md（工作区 Agent 与工具说明，若存在则注入）
        const agentsMd = readAgentsMd()
        if (agentsMd) memParts.push(`[AGENTS.md - 工作区 Agent 说明]\n${clipInjectedSection(agentsMd, 1200)}`)
        const toolsMd = readToolsMd()
        if (toolsMd) memParts.push(`[TOOLS.md - 工作区工具说明]\n${clipInjectedSection(toolsMd, 1200)}`)

        // 2.5–2.7 学习/配置引导（子会话瘦身时跳过）
        if (!subMinimal) {
          const learnFlowText = loadPrompt('learn-skill-flow')
          if (learnFlowText && promptIntentFlags.learnSkill) memParts.push(clipInjectedSection(learnFlowText, 1800))

          const learnWebText = loadPrompt('learn-skills-from-web')
          if (learnWebText && promptIntentFlags.learnFromWeb) memParts.push(clipInjectedSection(learnWebText, 1800))

          const configGuideText = loadPrompt('openultron-config-guide')
          if (configGuideText && promptIntentFlags.configGuide) memParts.push(clipInjectedSection(configGuideText, 2200))
        }

        // 2.8 可用供应商与模型（主会话 vs 子任务；先验证再切换）
        memParts.push(
          '[可用供应商与模型]\n' +
          '**主会话**的供应商与模型由用户在设置页配置。为**子任务**指定模型请用 sessions_spawn(provider=..., model=...)，勿用 ai_config_control 改主会话以免错配。若需改主会话：先调用 verify_provider_model(provider=..., model=...) 验证该供应商+模型可用，仅当返回 success 后再调用 ai_config_control 的 switch_provider 或 switch_model（switch_model 切到别家模型时请同时传 provider）。\n' +
          '用户问当前/可用模型时，可选用 list_configured_models 或 list_providers_and_models 获取配置后回答，也可根据上下文自然回答。\n' +
          '派生子 Agent：可先 verify_provider_model(provider, model) 确认可用，再 sessions_spawn(task=..., provider=..., model=...)。'
        )

        // 3. 项目相关碎片记忆
        if (!subMinimal && projectPath) {
          const topMemories = getTopMemoriesForProject(projectPath, 5)
          if (topMemories.length > 0) {
            const memText = topMemories.map((m, i) => `${i + 1}. ${clipInjectedSection(m.content, 220)}`).join('\n')
            memParts.push(`[项目记忆]\n${memText}`)
          }
        }

        // 3.1 项目 AGENT.md（与主窗口原 ChatPanel 注入路径一致：.gitManager/AGENT.md）
        if (!subMinimal) {
          const pp = String(projectPath || '').trim()
          if (pp && !pp.startsWith('__') && path.isAbsolute(pp)) {
            try {
              const agentMdPath = path.join(pp, '.gitManager', 'AGENT.md')
              if (fs.existsSync(agentMdPath)) {
                const raw = fs.readFileSync(agentMdPath, 'utf-8').trim()
                if (raw) memParts.push(`## 项目上下文（AGENT.md）\n${clipInjectedSection(raw, 4000)}`)
              }
            } catch (_) { /* ignore */ }
          }
        }

        // 4. 知识库经验教训（自动注入，无需再调 read_lessons_learned 即可直接利用）
        if (!subMinimal) {
          const lessonsContent = readLessonsLearned()
          if (lessonsContent && lessonsContent.trim()) {
            memParts.push(`[知识库 - 经验教训]\n${clipInjectedTailSection(lessonsContent.trim(), 2200)}\n\n**使用方式**：优先复用上述经验，避免重复试错；写 lesson_save 时记录具体场景、原因、命令或路径。`)
          }
        }

        memParts.push(
          '[记忆工具选用]\n' +
          '• **memory_save**：用户偏好、项目配置、重要事实等「可检索的碎片事实」。\n' +
          '• **lesson_save**：踩坑与可复用做法、命令/路径/步骤类「经验教训」（写入 LESSONS_LEARNED）；用户明确拒绝某类操作时用 category **策略**。\n' +
          '偏「是什么」走 memory_save；偏「下次别怎样 / 怎样做」走 lesson_save，避免混用。'
        )

        if (!isModelIdentityInquiry && minimalPromptMode && Array.isArray(minimalParts) && minimalParts.length > 0) {
          memParts.splice(0, memParts.length, ...minimalParts)
        }
      }

      const memSystemMsg = {
        role: 'system',
        content: memParts.join('\n\n') + '\n\n（以上为背景参考信息，请勿主动提及其来源）'
      }
      const firstNonSystem = currentMessages.findIndex(m => m.role !== 'system')
      if (firstNonSystem >= 0) {
        currentMessages.splice(firstNonSystem, 0, memSystemMsg)
      } else {
        currentMessages.push(memSystemMsg)
      }
    } catch (e) {
      console.warn('[AI] Memory 注入失败:', e.message)
    }

    // 递归清洗 JSON Schema，将所有 null 值替换为合法结构，防止 API 400
    const deepCleanSchema = (schema) => {
      if (schema === null || schema === undefined) {
        return { type: 'object', properties: {} }
      }
      if (typeof schema !== 'object') return schema
      if (Array.isArray(schema)) return schema.map(deepCleanSchema)

      const cleaned = {}
      for (const [key, val] of Object.entries(schema)) {
        if (val === null) {
          // null 的 type 字段替换为 string，其他 null 字段跳过
          if (key === 'type') cleaned[key] = 'string'
          // 其他 null 值直接跳过（不传给 API）
        } else if (typeof val === 'object') {
          cleaned[key] = deepCleanSchema(val)
        } else {
          cleaned[key] = val
        }
      }
      // 确保顶层有 type: object
      if (!cleaned.type && schema.properties !== undefined) {
        cleaned.type = 'object'
      }
      return cleaned
    }

    // 工具定义瘦身（默认全供应商开启）：削减 description / schema 示例，降低每轮请求体积
    const toolDefMerged = {
      slimMode: 'always',
      maxDescriptionChars: 240,
      stripSchemaExamples: true,
      maxPropertyDescriptionChars: 60,
      ...(config.toolDefinitions && typeof config.toolDefinitions === 'object' ? config.toolDefinitions : {})
    }
    const toolsForSanitize = slimToolsForChat(tools || [], toolDefMerged, config.apiBaseUrl)
    if (shouldSlimToolDefinitions(config.apiBaseUrl, toolDefMerged.slimMode)) {
      try {
        const b = Buffer.byteLength(JSON.stringify(tools || []))
        const a = Buffer.byteLength(JSON.stringify(toolsForSanitize))
        if (a < b) appLogger?.info?.('[AI] 工具定义瘦身', { count: toolsForSanitize.length, jsonBytesBefore: b, jsonBytesAfter: a, savedBytes: b - a })
      } catch (_) { /* ignore */ }
    }

    // 清洗工具 schema
    const sanitizedTools = toolsForSanitize.map(t => {
      const fn = t.function || t
      const params = fn.parameters
      return {
        ...t,
        function: {
          ...fn,
          parameters: deepCleanSchema(params) || { type: 'object', properties: {} }
        }
      }
    })

    let openAiKind = ''
    if (!isAnthropic) {
      if (resolveLlmTransport(config, false) === LLM_TRANSPORT.OPENAI_RESPONSES) {
        try {
          const u = getOpenAiResponsesPostUrl(config.apiBaseUrl, config.openAiWireMode, config.apiKey)
          openAiKind = isCodexChatgptResponsesUrl(u) ? 'OpenAI-Codex(chatgpt.com)' : 'OpenAI-Responses(platform)'
        } catch {
          openAiKind = 'OpenAI-Responses'
        }
      } else {
        openAiKind = 'OpenAI-Chat'
      }
    }
    console.log('[AI] startChat →', isAnthropic ? 'Anthropic' : openAiKind, 'model:', useModel, 'baseUrl:', config.apiBaseUrl, 'tools:', sanitizedTools.length)
    if (sanitizedTools.length === 0) console.warn('[AI] 无可用工具，本轮仅会文本回复，不会执行 MCP/浏览器等')

    // 上下文压缩：在每次调用 LLM 前检查（含工具多轮），避免 prompt 先撑爆再失败
    let compressionConfig = { ...COMPRESSION_DEFAULTS, ...(config.contextCompression && typeof config.contextCompression === 'object' ? config.contextCompression : {}) }
    if (isOpenRouterBaseUrl(config.apiBaseUrl)) {
      const soft = Number(compressionConfig.openRouterSoftBudget)
      if (Number.isFinite(soft) && soft > 0) {
        const th = Number(compressionConfig.threshold) || COMPRESSION_DEFAULTS.threshold
        compressionConfig = { ...compressionConfig, threshold: Math.min(th, soft) }
      }
    }
    const fakeSender = { send: () => {} }
    const callForSummary = async (msgs, maxTokens) => {
      const result = await this._callLlmStream(
        { messages: msgs, model: useModel, tools: undefined, temperature: 0, max_tokens: maxTokens || 1000 },
        config, fakeSender, `summary-${sessionId}`, new AbortController().signal, isAnthropic
      )
      return result?.content || ''
    }
    let compressNoticeSent = false
    let compressCooldownUntilIteration = 0
    const ensurePromptCompressed = async (opts = {}) => {
      const maxPasses = opts.maxPasses != null ? Number(opts.maxPasses) : 2
      const notify = !!opts.notify
      const bypassCooldown = !!opts.bypassCooldown
      if (!compressionConfig.enabled) return false

      const coolIter = Number(compressionConfig.compressCooldownIterations)
      const cool = Number.isFinite(coolIter) && coolIter > 0 ? coolIter : COMPRESSION_DEFAULTS.compressCooldownIterations || 2
      if (!bypassCooldown && compressCooldownUntilIteration > 0 && iteration < compressCooldownUntilIteration) {
        const dialogTok = estimateTokens(currentMessages.filter(m => m && m.role !== 'system'))
        const th = Number(compressionConfig.threshold) || COMPRESSION_DEFAULTS.threshold
        if (dialogTok <= th * 1.4) return false
      }

      let changed = false
      let pass = 0
      const passesLimit = Math.max(1, Math.min(3, maxPasses || 2))
      while (pass < passesLimit) {
        if (!shouldCompress(currentMessages, compressionConfig)) break
        pass++
        const baseKeep = Number(compressionConfig.keepRecent) || COMPRESSION_DEFAULTS.keepRecent
        const aggKeep = Number(compressionConfig.aggressiveKeepRecent) || 8
        const cfg = pass >= 2
          ? { ...compressionConfig, keepRecent: Math.min(aggKeep, baseKeep) }
          : compressionConfig
        const dialogEst = estimateTokens(currentMessages.filter(m => m && m.role !== 'system'))
        appLogger?.info?.(`[AI] 触发上下文压缩 第 ${pass} 次${pass >= 2 ? '（紧缩）' : ''}，对话估算 tokens≈${dialogEst}（总估算≈${estimateTokens(currentMessages)}）`)
        if (compressionConfig.flushMemoryBeforeCompress) {
          flushMemoryBeforeCompaction(currentMessages, callForSummary).catch(() => {})
        }
        const tokBeforeTotal = estimateTokens(currentMessages)
        currentMessages = await compressMessages(currentMessages, cfg, callForSummary)
        const tokAfterTotal = estimateTokens(currentMessages)
        const minSave = Number(compressionConfig.minCompressSavingsTokens) || COMPRESSION_DEFAULTS.minCompressSavingsTokens || 1200
        if (tokAfterTotal < tokBeforeTotal - minSave * 0.5) {
          changed = true
          compressCooldownUntilIteration = iteration + cool
        }
        // 若压缩后几乎没有下降（估算误差/摘要过长等），避免在同一轮内继续白做
        if (tokAfterTotal >= tokBeforeTotal - minSave * 0.2) {
          break
        }
        const afterDialog = estimateTokens(currentMessages.filter(m => m && m.role !== 'system'))
        appLogger?.info?.(`[AI] 压缩后对话估算 tokens≈${afterDialog}（总≈${tokAfterTotal}）`)
      }
      if (notify && changed && !compressNoticeSent && canSend(sender)) {
        compressNoticeSent = true
        wrappedSender.send('ai-chat-token', {
          sessionId,
          token:
            '\n\n> 📎 **对话过长**：已自动将更早内容压缩为摘要以节省上下文，**后续仍会照常调用模型**；若模型突然只给很短的收尾，请再发一句「继续」或补充需求。\n\n'
        })
      }
      return changed
    }

    try {
      while (iteration < safeMax) {
        if (abortController.signal.aborted) break

        // 暂停检查：如果被 SessionManager 暂停，等待恢复
        await sessionRegistry.waitIfPaused(registryId)
        if (abortController.signal.aborted) break

        // 检查注入消息（来自 SessionManager 的跨会话指令）
        const injected = sessionRegistry.drainInjectedMessages(registryId)
        for (const msg of injected) {
          currentMessages.push({ role: 'user', content: `[来自总控的指令] ${msg}` })
        }

        iteration++

        // 在调用模型前压缩，保证工具多轮后也不会因 prompt 过长而 402/超限
        await ensurePromptCompressed({ maxPasses: 2, notify: true })
        if (canSend(sender)) {
          wrappedSender.send('ai-chat-usage', {
            sessionId,
            runId: chatRunId,
            iteration,
            usage: estimateTokenBreakdown(currentMessages)
          })
        }

        const lastUserContent = (() => {
          for (let i = currentMessages.length - 1; i >= 0; i--) {
            if (currentMessages[i].role === 'user') {
              const c = currentMessages[i].content
              return typeof c === 'string' ? c : (c ? JSON.stringify(c) : '')
            }
          }
          return ''
        })()
        let response = null
        let responseAcceptedWithTools = false
        {
          const modelCandidates = [{ model: useModel, routeConfig: config }]
          for (const r of fallbackRoutes) {
            if (!r || !r.model || !r.config) continue
            if (r.model === useModel) continue
            modelCandidates.push({ model: String(r.model), routeConfig: r.config })
          }
          for (const m of fallbackModels) {
            if (!modelCandidates.some(x => x.model === m)) {
              const routeFromTable = fallbackRoutes.find((r) => r && r.model === m)
              const routeConfig = routeFromTable && routeFromTable.config ? routeFromTable.config : config
              modelCandidates.push({ model: m, routeConfig })
            }
          }
          const availableCandidates = modelCandidates.filter((c) =>
            !this._isKnownUnavailableModel(sessionId, c.model, c.routeConfig)
          )
          // 极端情况下（缓存过期误判等）不让列表为空
          const candidatesToTry = availableCandidates.length > 0 ? availableCandidates : modelCandidates
          for (let mi = 0; mi < candidatesToTry.length; mi++) {
            const tryModel = candidatesToTry[mi].model
            const tryConfig = candidatesToTry[mi].routeConfig || config
              const tryAnthropic = this._isClaudeModel(tryModel)
              try {
                // 在流式正文前先插入消息内提示，随后同一 assistant 气泡继续追加备用模型输出
              if (mi > 0 && canSend(wrappedSender)) {
                const prev = candidatesToTry[mi - 1]
                const prevModel = prev?.model ? String(prev.model).trim() : ''
                const tryHost = String((tryConfig.apiBaseUrl || '')).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
                const hostHint = tryHost ? `（${tryHost}）` : ''
                const token = prevModel
                  ? `\n\n> ⚠️ **主模型「${prevModel}」不可用**，已自动改用备用模型 **${tryModel}**${hostHint} 继续回复。\n\n`
                  : `\n\n> ⚠️ 已自动改用备用模型 **${tryModel}**${hostHint} 继续回复。\n\n`
                wrappedSender.send('ai-chat-token', { sessionId, token })
                console.log(`[AI] 已故障转移到备用模型: ${tryModel} @ ${tryHost || '(default host)'}`)
              }
              const messagesToSend = tryAnthropic ? currentMessages : this._sanitizeOpenAIMessages(currentMessages)
              const effectiveTools = isModelIdentityInquiry ? [] : sanitizedTools
              const toolModes = effectiveTools.length > 0
                ? [{ tools: effectiveTools, withTools: true }, { tools: undefined, withTools: false }]
                : [{ tools: undefined, withTools: false }]
              let lastModeErr = null
              for (let ti = 0; ti < toolModes.length; ti++) {
                const mode = toolModes[ti]
                try {
                  response = await this._callLlmStream({
                    messages: messagesToSend,
                    model: tryModel,
                    tools: mode.tools,
                    temperature: tryConfig.temperature ?? 0,
                    max_tokens: tryConfig.maxTokens || 0
                  }, tryConfig, wrappedSender, sessionId, abortController.signal, tryAnthropic)
                  responseAcceptedWithTools = !!mode.withTools
                  if (!mode.withTools && !isModelIdentityInquiry) {
                    wrappedSender.send('ai-chat-token', {
                      sessionId,
                      token: '\n\n> ⚠️ 当前模型不允许工具调用，已自动切换为无工具模式继续回答。\n\n'
                    })
                  }
                  break
                } catch (modeErr) {
                  lastModeErr = modeErr
                  const classify = this._classifyLlmError(modeErr)
                  const shouldRetryWithoutTools = mode.withTools &&
                    classify.action === 'disable_tools_then_retry' &&
                    !webAppSandbox &&
                    ti < toolModes.length - 1
                  if (shouldRetryWithoutTools) {
                    console.warn(`[AI] 模型 ${tryModel} 工具调用受限（${classify.kind}），自动改为无工具模式重试，故本轮不会执行 MCP/浏览器等工具:`, modeErr.message)
                    if (isWebAppSandboxProject(projectPath)) {
                      wrappedSender.send('ai-chat-token', {
                        sessionId,
                        token: '\n\n> ⚠️ 当前模型不允许工具调用，已切换为无工具模式：**本轮不会修改应用文件**。\n\n'
                      })
                    }
                    continue
                  }
                  throw modeErr
                }
              }
              if (!response && lastModeErr) throw lastModeErr
              break
            } catch (err) {
              const classify = this._classifyLlmError(err)
              if (classify.action === 'fail_fast') {
                throw err
              }
              if (classify.kind === 'model_unavailable') {
                this._rememberSessionUnavailableModel(sessionId, tryModel, tryConfig)
                this._rememberGlobalUnavailableModel(tryModel, tryConfig)
              }
              if (mi < candidatesToTry.length - 1) {
                console.warn(`[AI] 模型 ${tryModel} 调用失败，尝试下一个:`, err.message)
              } else {
                throw err  // 所有备用模型都失败，抛出错误
              }
            }
        }
        }

        if (abortController.signal.aborted) break

        if (response.toolCalls && response.toolCalls.length > 0) {
          const toolNames = (response.toolCalls || []).map(tc => tc.function?.name || tc.name || '?').filter(Boolean)
          appLogger?.info?.('[AI] 本轮模型返回工具调用', { count: response.toolCalls.length, names: toolNames.join(', ') })
          // OpenRouter 等要求 tool_calls 每项必须有 id 和 type: 'function'
          const normalizedToolCalls = response.toolCalls.map((tc, idx) => ({
            id: (tc.id && String(tc.id).trim()) || `call_${idx}_${Date.now()}`,
            type: tc.type === 'function' ? 'function' : 'function',
            function: {
              name: tc.function?.name || '',
              arguments: this._normalizeToolArguments(tc.function?.arguments)
            }
          }))
          currentMessages.push({
            role: 'assistant',
            content: normalizeAssistantContent(response.content || null),
            tool_calls: normalizedToolCalls
          })

          // 先广播所有 tool-call 事件（让前端立即展示调用列表）
          for (const toolCall of normalizedToolCalls) {
            wrappedSender.send('ai-chat-tool-call', {
              sessionId,
              toolCall: {
                id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
              }
            })
          }

          // 并行执行所有工具，提升速度（与 Claude/Cursor 一致）
          const toolResults = await Promise.all(
            normalizedToolCalls.map(async (toolCall) => {
              if (abortController.signal.aborted) return { toolCall, resultStr: '{"error":"已取消"}' }
              const toolName = String(toolCall.function?.name || '')
              const isScreenshotTool = /take_screenshot|chrome_devtools/.test(toolName)
              let result
              try {
                const args = this._parseToolArgumentsObject(toolCall.function.arguments)
                if (isScreenshotTool) {
                  appLogger?.info?.('[AI][ToolCall] 执行截图相关工具', { name: toolName, sessionId, argsPreview: JSON.stringify(args).slice(0, 200) })
                }
                result = await this._executeTool(toolCall.function.name, args, wrappedSender, sessionId, toolCall.id, {
                  abortSignal: abortController.signal,
                  chatRunId,
                  allowChannelSend
                })
              } catch (e) {
                result = {
                  error: e.message,
                  code: e.code || '',
                  non_retryable: !!e.nonRetryable
                }
                if (isScreenshotTool) {
                  appLogger?.warn?.('[AI][ToolCall] 截图工具执行异常', { name: toolName, error: e.message })
                }
              }
              // 将 image_base64 注册为文件并用 file_url 替代，避免 base64 进入消息体（膨胀、耗 token）
              if (typeof result === 'object' && result && result.image_base64 && this.registerImageBase64) {
                try {
                  const fileUrl = await this.registerImageBase64(result.image_base64, sessionId, chatRunId)
                  if (fileUrl) {
                    result.file_url = fileUrl
                    delete result.image_base64
                  }
                } catch (e) {
                  appLogger?.warn?.('[AI][ToolCall] 注册截图为文件失败，保留 base64', { error: e?.message })
                }
              }
              // 截图工具只返回 file_path 或把路径写在文本里（如「截图已保存到：/var/.../screenshot.png」）时，复制到应用目录并设置 file_url，供前端展示
              if (isScreenshotTool && typeof result === 'object' && result && !result.file_url && this.registerScreenshotPath) {
                let srcPath = result.file_path || result.filePath || result.path
                if (srcPath && typeof srcPath === 'string') srcPath = srcPath.trim()
                if (!srcPath) srcPath = extractScreenshotPathFromResult(result)
                if (srcPath && typeof srcPath === 'string') {
                  try {
                    const fileUrl = await this.registerScreenshotPath(srcPath, sessionId)
                    if (fileUrl) {
                      result.file_url = fileUrl
                      appLogger?.info?.('[AI][ToolCall] 截图路径已注册为 file_url', { path: srcPath.slice(-60), fileUrl })
                    } else {
                      appLogger?.warn?.('[AI][ToolCall] 截图路径注册返回空', { path: srcPath.slice(-60) })
                    }
                  } catch (e) {
                    appLogger?.warn?.('[AI][ToolCall] 注册截图路径失败', { error: e?.message })
                  }
                } else if (isScreenshotTool && typeof result === 'object' && result && !result.file_url && !result.image_base64) {
                  appLogger?.info?.('[AI][ToolCall] 截图工具结果无 file_path/file_url/image_base64', { keys: Object.keys(result || {}) })
                }
              }
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
              if (isScreenshotTool) {
                const hasError = typeof result === 'object' && result && result.error
                const hasImage = typeof result === 'object' && result && result.image_base64
                appLogger?.info?.(hasError ? '[AI][ToolCall] 截图工具返回错误' : hasImage ? '[AI][ToolCall] 截图工具返回成功(含图)' : '[AI][ToolCall] 截图工具返回', { name: toolName, hasError: !!hasError, hasImage: !!hasImage })
              }
              wrappedSender.send('ai-chat-tool-result', {
                sessionId,
                toolCallId: toolCall.id,
                name: toolCall.function.name,
                result: resultStr
              })
              return { toolCall, resultStr }
            })
          )

          if (abortController.signal.aborted) break

          // 不可恢复工具错误：立即终止，避免模型在同一参数错误上无限重试（截图「当前页不可截图」仅展示在命令结果里，不全局报错）
          const nonRetryableFailure = toolResults.find((x) => {
            try {
              const obj = JSON.parse(String(x.resultStr || '{}'))
              if (!(obj && obj.non_retryable)) return false
              if (obj.code === 'SCREENSHOT_INVALID_PAGE' || /当前页不可截图|about:blank/.test(String(obj.error || ''))) return false
              return true
            } catch (_) {
              return false
            }
          })
          if (nonRetryableFailure) {
            let msg = '工具调用失败（不可重试）'
            try {
              const obj = JSON.parse(String(nonRetryableFailure.resultStr || '{}'))
              if (obj && obj.error) msg = String(obj.error)
            } catch (_) {}
            throw new Error(msg)
          }

          // ---- 循环检测：不终止会话，注入一条系统提示让 AI 看到后换思路继续 ----
          const loopError = this._detectLoop(loopDetector, normalizedToolCalls, toolResults)

          // 工具结果过长时截断；浏览器 MCP（快照/DOM/网络等）单条常极大，单独收紧
          const TOOL_RESULT_MAX_LEN = 6000
          const TOOL_RESULT_BROWSER_MAX_LEN = 3000
          /** 委派类工具含 envelope/message，需避免截断掉 JSON 尾部 */
          const TOOL_RESULT_DELEGATION_MAX_LEN = 32000
          for (let i = 0; i < toolResults.length; i++) {
            const { toolCall, resultStr } = toolResults[i]
            const toolName = String(toolCall?.function?.name || toolCall?.name || '')
            const browserHeavy = /mcp__chrome|snapshot|take_snapshot|evaluate|get_console|network|performance|wait_for|scroll|fill|click/i.test(toolName)
            const delegationHeavy = toolName === 'sessions_spawn' || toolName === 'webapp_studio_invoke'
            const maxLen = browserHeavy
              ? TOOL_RESULT_BROWSER_MAX_LEN
              : (delegationHeavy ? TOOL_RESULT_DELEGATION_MAX_LEN : TOOL_RESULT_MAX_LEN)
            let content = resultStr
            if (typeof resultStr === 'string' && resultStr.length > maxLen) {
              content = resultStr.slice(0, maxLen) + `\n...(已截断，共 ${resultStr.length} 字)`
            }
            // 部分上游（如 StepFun/OpenRouter）要求 tool_call_id 必填，流式可能未返回 id，用占位 id
            const toolCallId = (toolCall.id && String(toolCall.id).trim()) || `call_${i}_${Date.now()}`
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content
            })
          }
          if (loopError) {
          currentMessages.push({
            role: 'user',
            content: `[系统] ${loopError} 请换一种思路或命令再试，勿重复相同操作；若仍无法完成再告知用户。`,
            _hideInUI: true,
            meta: { hideInUI: true }
          })
          }
          continue
        }
        // 模型本轮未返回 tool_calls，仅文本回复
        let finalContent = response ? normalizeAssistantContent(response.content || null) : null
        const isEmptyContent = !finalContent ||
          (typeof finalContent === 'string' && !String(finalContent).trim()) ||
          (Array.isArray(finalContent) && (!finalContent.length || finalContent.every(c => !String((c && c.text) || '').trim())))

        // 若上一轮有 sessions_spawn / webapp_studio_invoke 且模型返回空，用 envelope.summary 兜底，避免「有恢复无后续」
        if (isEmptyContent) {
          const lastAssistant = [...currentMessages].reverse().find(m => m.role === 'assistant')
          const hadDelegatedAgent = lastAssistant && lastAssistant.tool_calls &&
            lastAssistant.tool_calls.some((tc) => {
              const n = (tc.function && tc.function.name) || tc.name
              return n === 'sessions_spawn' || n === 'webapp_studio_invoke'
            })
          if (hadDelegatedAgent) {
            let fallbackSummary = ''
            for (let i = currentMessages.length - 1; i >= 0; i--) {
              const m = currentMessages[i]
              if (m.role !== 'tool' || !m.content) continue
              try {
                const obj = typeof m.content === 'string' ? JSON.parse(m.content) : m.content
                if (obj && obj.envelope && typeof obj.envelope.summary === 'string') {
                  fallbackSummary = String(obj.envelope.summary).trim()
                  break
                }
              } catch (_) {}
            }
            finalContent = fallbackSummary ? `子任务已完成：${fallbackSummary}` : '子任务已结束，详见上方工具输出。'
            appLogger?.info?.('[AI] 委派工具后模型返回空，已用 envelope 兜底', { fallbackLen: String(finalContent).length })
          }
        }

        const finalText = flattenAssistantText(finalContent).trim()
        const shouldContinueExecutionLoop =
          responseAcceptedWithTools &&
          forcedContinuationCount < 3 &&
          shouldForceExecutionContinuation(finalText, lastUserContent)
        if (shouldContinueExecutionLoop) {
          forcedContinuationCount++
          appLogger?.warn?.('[AI] 模型未产出最终结果且未调用工具，继续代理循环', {
            sessionId,
            iteration,
            forcedContinuationCount,
            contentPreview: finalText.slice(0, 160) || '(空)'
          })
          currentMessages.push({
            role: 'assistant',
            content: finalContent
          })
          currentMessages.push({
            role: 'user',
            content: '[系统] 你上一轮只描述了将要执行/未完成状态，但没有实际调用工具，也没有返回最终产物。若任务仍需执行，请本轮直接调用合适工具；若已经完成，请只返回真实结果、文件路径或附件信息。禁止再回复“我现在开始”“稍等”“你把它保存为某文件”。',
            _hideInUI: true,
            meta: { hideInUI: true }
          })
          continue
        }
        if (!shouldContinueExecutionLoop) forcedContinuationCount = 0

        const contentPreview = finalContent ? (typeof finalContent === 'string' ? finalContent : JSON.stringify(finalContent)).trim().slice(0, 120) : ''
        appLogger?.info?.('[AI] 本轮模型未返回工具调用，仅文本回复', { contentPreview: contentPreview || '(空)' })
        currentMessages.push({
          role: 'assistant',
          content: finalContent
        })
        break
      }

      if (iteration >= safeMax) {
        wrappedSender.send('ai-chat-error', {
          sessionId,
          error: `已达到安全上限 (${safeMax} 轮)，循环终止`
        })
      }

      // 会话结束再压一轮（若中途已压过，shouldCompress 为 false 则跳过）
      await ensurePromptCompressed({ maxPasses: 2, notify: false, bypassCooldown: true })
      wrappedSender.send('ai-chat-complete', { sessionId, messages: currentMessages })
      sessionRegistry.markComplete(registryId)
      this._extractMemoriesAsync(currentMessages, projectPath, config, useModel, isAnthropic, sessionId, chatRunId)
      require('./session-complete-notify').sendTaskCompleteNotifications(currentMessages).catch(() => {})
      return { success: true, messages: currentMessages }
    } catch (error) {
      if (abortController.signal.aborted) {
        appLogger?.info?.('[Orchestrator] 会话因中止结束', { sessionId: String(sessionId).slice(0, 24) })
        await ensurePromptCompressed({ maxPasses: 2, notify: false, bypassCooldown: true })
        wrappedSender.send('ai-chat-complete', { sessionId, messages: currentMessages })
        sessionRegistry.markComplete(registryId)
        this._extractMemoriesAsync(currentMessages, projectPath, config, useModel, isAnthropic, sessionId, chatRunId)
        require('./session-complete-notify').sendTaskCompleteNotifications(currentMessages).catch(() => {})
        return { success: true, messages: currentMessages }
      } else {
        const userMsg = this._enhanceLlmErrorForUser(error)
        wrappedSender.send('ai-chat-error', { sessionId, error: userMsg })
        sessionRegistry.markError(registryId, userMsg)
        return { success: false, error: userMsg }
      }
    } finally {
      // 仅当当前 run 仍是 activeSessions 中该 session 的条目时才删除，避免旧 run 完成后误删新 run
      const cur = this.activeSessions.get(sessionId)
      if (cur && cur.abortController === abortController) {
        this.activeSessions.delete(sessionId)
      }
    }
  }

  // 循环检测（四种模式：连续重复 / 同一工具连续失败 / pingPong / 轮询无进展）
  _detectLoop(detector, toolCalls, toolResults) {
    const hashStr = (s) => {
      let h = 0
      for (let i = 0; i < Math.min(s.length, 500); i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
      return h.toString(16)
    }

    const callSigs = toolCalls.map(tc => ({
      name: tc.function.name,
      argsHash: hashStr(tc.function.arguments || '')
    }))
    const resultSigs = toolResults.map(r => hashStr(r.resultStr?.slice(0, 200) || ''))
    const roundKey = callSigs.map(c => `${c.name}:${c.argsHash}`).join('|')

    // 0. 同一工具同一参数连续失败：仅当「相同工具+相同参数」连续 3 轮都失败才触发，避免 execute_command 不同命令各失败一次就被误判
    const allError = toolResults.length > 0 && toolResults.every(r => {
      const s = (r.resultStr || '').toString()
      return s.includes('"error"') || s.includes('失败') || s.includes('"success":false')
    })
    detector.recentRounds = detector.recentRounds || []
    detector.recentRounds.push({ roundKey, allError })
    if (detector.recentRounds.length > 8) detector.recentRounds.shift()
    const last3Rounds = detector.recentRounds.slice(-3)
    if (last3Rounds.length === 3 && last3Rounds.every(r => r.allError && r.roundKey === last3Rounds[0].roundKey)) {
      const name = callSigs[0]?.name || '?'
      return `[循环检测] 工具「${name}」同一调用连续 3 轮返回失败，已中断。请勿重复尝试，直接告知用户当前无法完成或换一种方式。`
    }

    // 1. genericRepeat：连续 3 轮完全相同的工具调用
    detector.recentCalls.push(roundKey)
    if (detector.recentCalls.length > 5) detector.recentCalls.shift()
    const last3 = detector.recentCalls.slice(-3)
    if (last3.length === 3 && last3.every(k => k === last3[0])) {
      return `[循环检测] 连续 3 轮调用相同工具（${callSigs[0]?.name || '?'}），已中断。请换一种方式解决问题。`
    }

    // 2. pingPong：A→B→A→B 4次无输出变化
    const fullSig = roundKey + '|' + resultSigs.join('|')
    detector.pingPongWindow.push(fullSig)
    if (detector.pingPongWindow.length > 6) detector.pingPongWindow.shift()
    const ppWindow = detector.pingPongWindow
    if (ppWindow.length >= 4) {
      const a = ppWindow[ppWindow.length - 4]
      const b = ppWindow[ppWindow.length - 3]
      const a2 = ppWindow[ppWindow.length - 2]
      const b2 = ppWindow[ppWindow.length - 1]
      if (a === a2 && b === b2 && a !== b) {
        return `[循环检测] 检测到 A→B→A→B 交替循环（无进展），已中断。`
      }
    }

    // 3. knownPollNoProgress：同一命令连续轮询 exit 0 但结果相同（超过 5 次）
    const allPoll = toolCalls.every(tc => tc.function.name === 'execute_command')
    if (allPoll) {
      const pollKey = roundKey + '|' + resultSigs.join('|')
      if (pollKey === detector.lastPollKey) {
        detector.pollNoProgressCount++
        if (detector.pollNoProgressCount >= 5) {
          return `[循环检测] 连续 5 次轮询无新进展，已中断。命令可能在等待某个永不到来的状态。`
        }
      } else {
        detector.pollNoProgressCount = 0
      }
      detector.lastPollKey = pollKey
    } else {
      detector.pollNoProgressCount = 0
      detector.lastPollKey = null
    }

    return null  // 无循环
  }

  _memoryExtractStateKey(projectPath, sessionId) {
    const pp = String(projectPath || '').trim()
    const sid = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : '_'
    return `${pp}::${sid}`
  }

  /**
   * 自动记忆提取节流：与每轮对话解耦，避免并发挤爆上游导致超时。
   * 首次需足够轮次；之后需间隔 + 新增对话条数双门槛。
   */
  _shouldRunAutoMemoryExtract(projectPath, sessionId, dialogCount) {
    const MIN_INTERVAL_MS = 20 * 60 * 1000
    const MIN_DIALOG_MESSAGES = 6
    const MIN_NEW_MESSAGES = 12
    const key = this._memoryExtractStateKey(projectPath, sessionId)
    const state = this._memoryExtractState.get(key) || {}
    if (state.running) return { ok: false, reason: 'already_running' }
    if (dialogCount < MIN_DIALOG_MESSAGES) return { ok: false, reason: 'too_few_messages' }
    const lastTs = Number(state.lastTs || 0)
    const now = Date.now()
    if (lastTs > 0 && now - lastTs < MIN_INTERVAL_MS) return { ok: false, reason: 'cooldown' }
    const prevCount = Number(state.lastDialogCount || 0)
    if (prevCount > 0 && dialogCount - prevCount < MIN_NEW_MESSAGES) {
      return { ok: false, reason: 'delta_too_small' }
    }
    return { ok: true, reason: 'ready', key }
  }

  // 异步提取对话中的记忆（后台运行，不影响用户体验）
  async _extractMemoriesAsync(messages, projectPath, config, model, isAnthropic, sessionId, chatRunId) {
    // 仅对包含有效对话的消息执行
    const dialogMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant')
    if (dialogMsgs.length < 2) return

    const gate = this._shouldRunAutoMemoryExtract(projectPath, sessionId, dialogMsgs.length)
    if (!gate.ok) return

    const stateKey = gate.key
    const prev = this._memoryExtractState.get(stateKey) || {}
    this._memoryExtractState.set(stateKey, { ...prev, running: true })

    try {
      // 构造记忆提取 prompt
      const dialogText = dialogMsgs
        .slice(-20)  // 只分析最近 20 条
        .map(m => {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          return `[${m.role}]: ${text.slice(0, 1000)}`
        })
        .join('\n\n')

      const extractPrompt = [
        '分析以下对话，提取值得长期记住的关键信息（用户偏好、项目配置、重要结论、解决方案等）。',
        '每条记忆不超过100字，最多提取5条，格式为 JSON 数组：',
        '[{"content": "...", "tags": ["tag1", "tag2"]}]',
        '如无值得记忆的信息，返回空数组 []。',
        '只输出 JSON，不要其它说明。',
        '',
        '对话内容：',
        dialogText
      ].join('\n')

      const fakeSender = { send: () => {} }
      const result = await this._callLlmStream(
        { messages: [{ role: 'user', content: extractPrompt }], model, tools: undefined, temperature: 0, max_tokens: 500 },
        config, fakeSender, `memory-extract-${Date.now()}`, new AbortController().signal, isAnthropic
      )

      let text = (result?.content || '').trim()
      // 去掉 markdown 代码块，模型可能返回 ```json\n[...]\n```
      const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (codeBlock) text = codeBlock[1].trim()
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return

      let items
      const rawStr = jsonMatch[0]
      const tryParse = (str) => {
        try {
          return JSON.parse(str)
        } catch {
          return null
        }
      }
      items = tryParse(rawStr)
        ?? tryParse(rawStr.replace(/,(\s*[}\]])/g, '$1'))
        ?? tryParse(rawStr.replace(/,(\s*[}\]])/g, '$1').replace(/\r?\n/g, ' '))
      if (!items || !Array.isArray(items) || items.length === 0) return

      const savedContents = []
      for (const item of items.slice(0, 5)) {
        if (item?.content?.trim()) {
          saveMemory({
            content: item.content.trim(),
            tags: item.tags || [],
            projectPath: projectPath || null,
            source: 'auto'
          })
          savedContents.push(item.content.trim())
        }
      }
      // 写入当日 Markdown 日记
      if (savedContents.length > 0) appendToDiary(savedContents)
      if (savedContents.length > 0) {
        console.log(`[AI] 自动提取 ${savedContents.length} 条记忆`)
        try {
          appLogger?.info?.('[AI][Memory] auto_fragment_extract', {
            runId: String(chatRunId || '').slice(0, 48),
            sessionId: String(sessionId || '').slice(0, 32),
            savedCount: savedContents.length,
            projectPathSlice: String(projectPath || '').slice(0, 120)
          })
        } catch (_) { /* ignore */ }
      }
    } catch (e) {
      // 静默失败，不影响主流程
      console.warn('[AI] 记忆提取失败:', e.message)
    } finally {
      const s = this._memoryExtractState.get(stateKey) || {}
      this._memoryExtractState.set(stateKey, {
        ...s,
        running: false,
        lastTs: Date.now(),
        lastDialogCount: dialogMsgs.length
      })
    }
  }

  stopChat(sessionId) {
    const childIds = getChildSubSessionIdsForParent(sessionId)
    for (const cid of childIds) {
      try {
        this.stopChat(cid)
      } catch (_) { /* ignore */ }
    }
    clearChildrenForParent(sessionId)
    const session = this.activeSessions.get(sessionId)
    if (session) {
      appLogger?.info?.('[Orchestrator] stopChat 中止会话', { sessionId: String(sessionId).slice(0, 24) })
      session.abortController.abort()
      // session-registry 的 key 与 markRunning 一致：panelId || sessionId；需一并 stop，否则 waitIfPaused 可能永远挂起
      const regId = (session.panelId && String(session.panelId).trim()) || sessionId
      try {
        sessionRegistry.stop(regId)
      } catch (_) { /* ignore */ }
      this.activeSessions.delete(sessionId)
    }
  }

  hasActiveSession(sessionId) {
    return this.activeSessions.has(sessionId)
  }

  /**
   * 用模型判断用户消息是否表达「先停掉当前任务」的意图，用于同 session 新消息时是否先 stopChat。
   * @param {string} userMessageText - 用户最后一条消息的纯文本
   * @returns {Promise<boolean>} 建议先停止当前任务则 true，出错或为否则 false
   */
  async classifyStopPreviousIntent(userMessageText) {
    if (!userMessageText || typeof userMessageText !== 'string') return false
    const trimmed = userMessageText.trim()
    if (!trimmed) return false
    const quick = quickClassifyStopPreviousIntent(trimmed)
    if (quick === true) {
      appLogger?.info?.('[Orchestrator] 关键词判定用户意图为先停止当前任务', { preview: trimmed.slice(0, 40) })
      return true
    }
    const config = this.getConfig()
    if (!config?.apiKey || !String(config.apiKey).trim()) return false
    const systemPrompt = 'You are a classifier. A task is currently running in the chat. The user just sent a new message (may be in Chinese or English, e.g. 停止/先停掉/别做了/cancel/stop). Does the user clearly want to stop, cancel or abort the current task (before doing something else)? Reply with exactly YES or NO, nothing else. If the message is ambiguous or just normal content, reply NO.'
    try {
      const text = await this.generateText({
        prompt: trimmed.slice(0, 500),
        systemPrompt,
        config: { ...config, maxTokens: 16 }
      })
      const yes = /^\s*yes\s*$/i.test(String(text || '').trim())
      if (yes) appLogger?.info?.('[Orchestrator] AI 判定用户意图为先停止当前任务', { preview: trimmed.slice(0, 40) })
      return yes
    } catch (e) {
      appLogger?.warn?.('[Orchestrator] classifyStopPreviousIntent 失败，不停止', { error: e?.message })
      return false
    }
  }

  // ---------- 单轮非流式文本生成（用于 commit message 等简单场景）----------
  async generateText(opts = {}) {
    return this._generateTextOnce(opts)
  }

  async _generateTextOnce({ prompt, model: overrideModel, systemPrompt, config: externalConfig, timeoutMs } = {}) {
    const config = externalConfig || this.getConfig()
    if (!config.apiKey || !String(config.apiKey).trim()) {
      const isOpenRouter = /openrouter\.ai/i.test(config.apiBaseUrl || '')
      throw new Error(isOpenRouter
        ? '请先在「设置 → 配置」中为 OpenRouter 填写并保存 API Key（可在 https://openrouter.ai/keys 获取）'
        : '请先配置 AI API Key')
    }

    const useModel = overrideModel || config.defaultModel || 'deepseek-v3'
    const isAnthropic = this._isClaudeModel(useModel)
    const transport = resolveLlmTransport(config, isAnthropic)

    const messages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }]

    return new Promise((resolve, reject) => {
      let url, reqBody, headers

      if (transport === LLM_TRANSPORT.ANTHROPIC) {
        const baseUrl = config.apiBaseUrl.replace(/\/v1\/?$/, '')
        url = new URL(`${baseUrl}/v1/messages`)
        const { system, messages: anthropicMessages } = this._toAnthropicMessages(messages)
        reqBody = {
          model: useModel,
          max_tokens: config.maxTokens || 4096,
          temperature: config.temperature ?? 0,
          stream: false,
          messages: anthropicMessages
        }
        if (system) reqBody.system = system
        headers = {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        }
      } else if (transport === LLM_TRANSPORT.OPENAI_RESPONSES) {
        url = getOpenAiResponsesPostUrl(config.apiBaseUrl, config.openAiWireMode, config.apiKey)
        reqBody = buildResponsesRequestBody(messages, {
          model: useModel,
          temperature: config.temperature ?? 0,
          max_tokens: config.maxTokens || 0,
          stream: false
        }, {
          codexChatgptBackend: isCodexChatgptResponsesUrl(url)
        })
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        }
      } else {
        url = new URL(`${config.apiBaseUrl}/chat/completions`)
        reqBody = {
          model: useModel,
          messages,
          stream: false,
          temperature: config.temperature ?? 0
        }
        applyNonStreamOpenAiChatMaxTokens(reqBody, config.apiBaseUrl, config.maxTokens)
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        }
      }

      const postData = JSON.stringify(reqBody)
      headers['Content-Length'] = Buffer.byteLength(postData)

      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http
      const socketTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000
      const req = httpModule.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: socketTimeout
      })

      req.on('response', (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            try {
              const err = JSON.parse(body)
              let msg = err.error?.message || err.message || `HTTP ${res.statusCode}`
              msg = appendOpenAiPlatformBillingHint(res.statusCode, url.hostname, msg)
              const e = new Error(msg)
              e.httpStatus = res.statusCode
              reject(e)
            } catch {
              let msg = `HTTP ${res.statusCode}: ${body.substring(0, 200)}`
              msg = appendOpenAiPlatformBillingHint(res.statusCode, url.hostname, msg)
              const e = new Error(msg)
              e.httpStatus = res.statusCode
              reject(e)
            }
            return
          }
          try {
            const data = JSON.parse(body)
            let content = ''
            if (transport === LLM_TRANSPORT.ANTHROPIC) {
              content = data.content?.[0]?.text || ''
            } else if (transport === LLM_TRANSPORT.OPENAI_RESPONSES) {
              content = extractResponsesOutputText(data)
            } else {
              content = data.choices?.[0]?.message?.content || ''
            }
            resolve(String(content || '').trim())
          } catch (e) {
            reject(new Error('响应格式错误'))
          }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
      req.write(postData)
      req.end()
    })
  }

  /** 规范化 OpenAI 消息：role=tool 非空 tool_call_id；role=assistant 的 tool_calls 每项必须有 id 和 type（OpenRouter 等必填） */
  _sanitizeOpenAIMessages(messages) {
    if (!Array.isArray(messages)) return messages
    return messages.map((m, i) => {
      if (m.role === 'tool') {
        const id = (m.tool_call_id != null && String(m.tool_call_id).trim())
          ? m.tool_call_id
          : `call_${i}_${Date.now()}`
        return { ...m, tool_call_id: id }
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const tool_calls = m.tool_calls.map((tc, idx) => ({
          id: (tc.id && String(tc.id).trim()) || `call_${idx}_${Date.now()}`,
          type: tc.type === 'function' ? 'function' : 'function',
          function: {
            name: tc.function?.name || '',
            arguments: this._normalizeToolArguments(tc.function?.arguments)
          }
        }))
        return { ...m, tool_calls }
      }
      return m
    })
  }

  /** 规范化工具参数为合法 JSON 字符串，避免上游校验 "function.arguments must be JSON format" */
  _normalizeToolArguments(rawArgs) {
    if (rawArgs == null) return '{}'
    if (typeof rawArgs === 'object') {
      try {
        return JSON.stringify(rawArgs)
      } catch {
        return '{}'
      }
    }
    const text = String(rawArgs).trim()
    if (!text) return '{}'
    try {
      const parsed = JSON.parse(text)
      return JSON.stringify(parsed)
    } catch {
      return '{}'
    }
  }

  _isOperationNotAllowedError(err) {
    const msg = String(err && err.message ? err.message : err || '').toLowerCase()
    return msg.includes('operation not allowed') || msg.includes('not allowed')
  }

  _llmStreamDeps() {
    return {
      getRetryConfig: (c) => this._getRetryConfig(c),
      sleep: (ms, signal) => this._sleep(ms, signal),
      shouldRetryError: (err, attempt, maxRetries) => this._shouldRetryError(err, attempt, maxRetries),
      getRetryDelayMs: (attempt, baseDelayMs, maxDelayMs, err) => this._getRetryDelayMs(attempt, baseDelayMs, maxDelayMs, err),
      makeRequest: (url, method, headers, signal) => this._makeRequest(url, method, headers, signal),
      readErrorBody: (res, url, cb) => this._readErrorBody(res, url, cb),
      normalizeToolArguments: (raw) => this._normalizeToolArguments(raw)
    }
  }

  _callLlmStream(body, config, sender, sessionId, signal, isAnthropicModel) {
    const deps = this._llmStreamDeps()
    const converters = {
      toAnthropicMessages: (msgs) => this._toAnthropicMessages(msgs),
      toAnthropicTools: (tools) => this._toAnthropicTools(tools)
    }
    const t = resolveLlmTransport(config, isAnthropicModel)
    if (t === LLM_TRANSPORT.ANTHROPIC) {
      return streamAnthropicMessages(deps, converters, body, config, sender, sessionId, signal)
    }
    if (t === LLM_TRANSPORT.OPENAI_RESPONSES) {
      return streamOpenAiResponses(deps, body, config, sender, sessionId, signal)
    }
    return streamOpenAiChatCompletions(deps, body, config, sender, sessionId, signal)
  }

  /**
   * 将 LLM 原始错误转为对用户更友好的文案（OpenRouter 额度/max_tokens 时提示开新会话等）
   */
  _enhanceLlmErrorForUser(err) {
    const base = String(err && err.message ? err.message : err || '未知错误')
    const status = Number(err && err.httpStatus) || 0
    const lower = base.toLowerCase()
    const isCodexSessionExpired =
      status === 401 &&
      /chatgpt\.com\/backend-api\/codex\/responses/.test(lower) &&
      /session expired|expired before this request finished/.test(lower)
    if (isCodexSessionExpired) {
      return `${base}\n\n💡 说明：当前 ChatGPT 会话已过期，Codex 后端请求被拒绝。请先在应用内重新登录 ChatGPT（刷新 access_token）后重试；若希望长期稳定，建议改用 platform.openai.com 的 sk- API Key。`
    }
    // OpenRouter 402「Prompt tokens limit exceeded」：是**输入/上下文**超限（与 max_tokens 输出上限不是一回事）
    const isOpenRouterPromptTooLarge =
      /prompt tokens limit exceeded|input tokens.*exceed|context length exceeded|maximum context|token limit.*prompt/i.test(base)
    if (isOpenRouterPromptTooLarge) {
      return `${base}\n\n💡 说明：这是**输入侧（Prompt / 上下文）**超限，不是「最大输出 Tokens」设太大。报错里「A > B」表示：本次请求累计的 prompt 约 A tokens，而当前账户/模型允许的 prompt 上限约 B。\n\n建议：① **开启新会话**并避免一次粘贴超大内容；② 缩短历史、减少技能/MCP/工作区注入；③ 换更长上下文的模型或升级 OpenRouter 方案。`
    }
    const looksLikeOpenRouterMaxOrCredits =
      status === 402 ||
      /fewer max_tokens|more credits|can only afford|max_tokens.*afford/.test(lower) ||
      (/openrouter/.test(lower) && /credit|quota|billing|afford|max_tokens/.test(lower))
    if (looksLikeOpenRouterMaxOrCredits) {
      return `${base}\n\n💡 建议：① 在「设置 → AI 配置」将「最大输出 Tokens」设为 2048～8192（勿长期为 0，否则网关可能按模型默认极大值预留额度）；② **开启新会话**或删除部分历史消息以缩短上下文；③ 额度不足时可到 OpenRouter 充值或更换供应商。`
    }
    return base
  }

  _classifyLlmError(err) {
    const status = Number(err && (err.httpStatus || err.statusCode || 0)) || 0
    const raw = String(err && err.message ? err.message : err || '')
    const msg = raw.toLowerCase()

    const isAuth = status === 401 || status === 403 ||
      /invalid api key|unauthorized|authentication|auth failed|forbidden|session expired|expired before this request finished/.test(msg)
    if (isAuth) return { kind: 'auth', action: 'fail_fast' }

    const isBilling = status === 402 ||
      /insufficient_quota|quota|billing|余额|欠费|credit|payment required|more credits|can only afford|fewer max_tokens/.test(msg)
    if (isBilling) return { kind: 'billing', action: 'fail_fast' }

    const isModelUnavailable =
      status === 404 ||
      /model .*not found|does not exist|unknown model|invalid model|model_not_found|not available in your region|region/.test(msg)
    if (isModelUnavailable) return { kind: 'model_unavailable', action: 'fallback_model' }

    const isToolRestricted =
      /function calling|tool[_ ]?call|tools are not supported|tool use is not supported|tool_choice/.test(msg)
    if (isToolRestricted) return { kind: 'tool_restricted', action: 'disable_tools_then_retry' }

    const isOperationNotAllowed = /operation not allowed/.test(msg)
    if (isOperationNotAllowed) return { kind: 'operation_not_allowed', action: 'fallback_model' }

    const isVisionRestricted =
      /image|vision|multimodal|input_image|image_url|does not support vision/.test(msg) &&
      (/not support|not supported|invalid parameter|unsupported/.test(msg))
    if (isVisionRestricted) return { kind: 'vision_restricted', action: 'fallback_model' }

    return { kind: 'unknown', action: 'none' }
  }

  /** 将工具参数解析为对象，非对象参数降级为空对象，避免执行层抛异常中断 */
  _parseToolArgumentsObject(rawArgs) {
    const normalized = this._normalizeToolArguments(rawArgs)
    try {
      const parsed = JSON.parse(normalized)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      return {}
    } catch {
      return {}
    }
  }

  // ---------- 格式转换 ----------

  _openAIUserContentToAnthropic(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return String(content || '')
    const out = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text') {
        out.push({ type: 'text', text: String(part.text || '') })
        continue
      }
      if (part.type === 'image_url') {
        const url = part.image_url?.url || ''
        const m = String(url).match(/^data:([^;]+);base64,(.+)$/)
        if (m) {
          out.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: m[1] || 'image/png',
              data: m[2] || ''
            }
          })
        }
      }
    }
    return out.length > 0 ? out : ''
  }

  // OpenAI messages → Anthropic { system, messages }
  _toAnthropicMessages(openaiMessages) {
    let system = ''
    const messages = []

    for (const msg of openaiMessages) {
      if (msg.role === 'system') {
        system += (system ? '\n' : '') + msg.content
        continue
      }

      if (msg.role === 'user') {
        messages.push({ role: 'user', content: this._openAIUserContentToAnthropic(msg.content) })
        continue
      }

      if (msg.role === 'assistant') {
        const content = []
        if (msg.content) {
          content.push({ type: 'text', text: msg.content })
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input = {}
            input = this._parseToolArgumentsObject(tc.function?.arguments)
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input
            })
          }
        }
        messages.push({ role: 'assistant', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content })
        continue
      }

      if (msg.role === 'tool') {
        // Anthropic: tool_result 放在 user 消息里
        // 看 messages 末尾是否已经有一个 pending 的 user tool_result 消息
        const last = messages[messages.length - 1]
        const toolResult = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        }
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
          last.content.push(toolResult)
        } else {
          messages.push({ role: 'user', content: [toolResult] })
        }
        continue
      }
    }

    return { system, messages }
  }

  // OpenAI tools → Anthropic tools
  _toAnthropicTools(openaiTools) {
    return openaiTools.map(t => {
      const fn = t.function || t
      const params = fn.parameters
      const input_schema = (params && typeof params === 'object' && params.type === 'object')
        ? params
        : { type: 'object', properties: params?.properties || {}, required: params?.required || [] }
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema
      }
    })
  }

  // ---------- 通用辅助 ----------

  _getRetryConfig(config) {
    const raw = (config && typeof config === 'object') ? (config.retry || config.retries || {}) : {}
    // maxRetries：与 attempt 比较，attempt>=maxRetries 时不再重试；默认 3 便于 Codex/跨境链路偶发 ECONNRESET 多试一轮
    const maxRetries = Number.isFinite(raw.maxRetries) ? raw.maxRetries : 3
    const baseDelayMs = Number.isFinite(raw.baseDelayMs) ? raw.baseDelayMs : 800
    const maxDelayMs = Number.isFinite(raw.maxDelayMs) ? raw.maxDelayMs : 8000
    return {
      maxRetries: Math.max(0, Math.min(5, maxRetries)),
      baseDelayMs: Math.max(100, Math.min(10000, baseDelayMs)),
      maxDelayMs: Math.max(500, Math.min(30000, maxDelayMs))
    }
  }

  _shouldRetryError(err, attempt, maxRetries) {
    if (!err) return false
    if (attempt >= maxRetries) return false
    if (err.message && /已取消/.test(err.message)) return false

    const status = err.httpStatus || err.statusCode
    if (status) {
      // OpenRouter/OpenAI 常见可重试状态码（5xx / 网关错误 / 限流 / 超时）
      if ([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status)) return true
      if (status >= 500 && status <= 599) return true
      return false
    }

    const code = String(err.code || '').toUpperCase()
    if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true

    const msg = String(err.message || err || '').toLowerCase()
    return (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('socket disconnected') ||
      msg.includes('tls connection') ||
      msg.includes('secure tls') ||
      msg.includes('eai_again') ||
      msg.includes('enotfound') ||
      msg.includes('etimedout')
    )
  }

  /**
   * 429 限流：默认指数退避往往过短（~800ms），上游（尤其 OpenRouter 免费模型）需更久；若响应带 Retry-After 则优先。
   * @param {any} [err] — 含 httpStatus / retryAfterMs（由 _readErrorBody 注入）
   */
  _getRetryDelayMs(attempt, baseDelayMs, maxDelayMs, err) {
    const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt))
    const jitter = Math.floor(Math.random() * 200)
    let delay = exp + jitter

    if (err && Number(err.httpStatus) === 429) {
      if (Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) {
        delay = Math.min(maxDelayMs, Math.max(delay, err.retryAfterMs))
      } else {
        const min429 = Math.min(maxDelayMs, 2500 + 2500 * attempt)
        delay = Math.min(maxDelayMs, Math.max(delay, min429) + Math.floor(Math.random() * 400))
      }
    }
    return delay
  }

  _sleep(ms, signal) {
    if (!ms || ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('已取消')); return }
      const t = setTimeout(() => resolve(), ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(new Error('已取消'))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  _summarizeRequestDiag(req) {
    const d = req && req.__netDiag ? req.__netDiag : null
    if (!d) return ''
    const now = Date.now()
    const elapsed = Math.max(0, now - Number(d.startedAt || now))
    const p = d.phases || {}
    const order = [
      'socket_assigned',
      'dns_lookup',
      'tcp_connect',
      'tls_connect',
      'request_finish',
      'response_headers',
      'first_byte',
      'response_end',
      'socket_error',
      'request_error',
      'socket_close',
      'request_close'
    ]
    const phaseTokens = []
    for (const key of order) {
      const v = p[key]
      if (!v) continue
      const t = Number(v.t || 0)
      if (key === 'dns_lookup') {
        phaseTokens.push(`dns=${t}ms(${v.address || '?'}/${v.family || '?'})`)
        continue
      }
      if (key === 'response_headers') {
        phaseTokens.push(`headers=${t}ms(${v.statusCode || '?'})`)
        continue
      }
      if (key === 'socket_error' || key === 'request_error') {
        phaseTokens.push(`${key}=${t}ms(${v.code || ''}${v.code && v.message ? ',' : ''}${v.message || ''})`)
        continue
      }
      if (key === 'socket_close') {
        phaseTokens.push(`socket_close=${t}ms(hadError=${v.hadError ? '1' : '0'})`)
        continue
      }
      phaseTokens.push(`${key}=${t}ms`)
    }
    const proxy = d.proxy ? ` proxy=${d.proxy}` : ' proxy=direct'
    return `trace=${d.traceId} elapsed=${elapsed}ms${proxy} phases=[${phaseTokens.join(', ')}]`
  }

  _makeRequest(url, method, headers, signal) {
    const isHttps = url.protocol === 'https:'
    const proxyUrl = getProxyUrlForTarget(url)
    const proxyProtocol = String(proxyUrl?.protocol || '').toLowerCase()
    const useHttpProxy = !!proxyUrl && proxyProtocol === 'http:'
    const useSocksProxy = !!proxyUrl && proxyProtocol.startsWith('socks')
    const unsupportedProxy = !!proxyUrl && !useHttpProxy && !useSocksProxy
    const reqOpts = {
      method,
      headers
    }

    if (useSocksProxy) {
      console.warn('[AI] 检测到 SOCKS 代理配置，当前 Node 直连请求暂不支持 SOCKS 隧道，已回退直连：', String(proxyUrl))
    }
    if (unsupportedProxy) {
      console.warn('[AI] 当前仅支持 http:// 代理地址，已回退直连：', String(proxyUrl))
    }

    if (useHttpProxy) {
      const proxyHost = proxyUrl.hostname
      const proxyPort = Number(proxyUrl.port || (proxyProtocol === 'https:' ? 443 : 80))
      const proxyAuth = proxyUrl.username
        ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || '')}`).toString('base64')}`
        : ''
      if (!isHttps) {
        Object.assign(reqOpts, {
          hostname: proxyHost,
          port: proxyPort,
          path: url.toString()
        })
        reqOpts.headers = {
          Host: url.host,
          ...headers
        }
        if (proxyAuth) reqOpts.headers['Proxy-Authorization'] = proxyAuth
      } else {
        Object.assign(reqOpts, {
          hostname: url.hostname,
          port: Number(url.port || 443),
          path: url.pathname + url.search,
          createConnection: (_opts, cb) => {
            const connectSocket = net.connect(proxyPort, proxyHost, () => {
              const connectReq = [
                `CONNECT ${url.hostname}:${Number(url.port || 443)} HTTP/1.1`,
                `Host: ${url.hostname}:${Number(url.port || 443)}`
              ]
              if (proxyAuth) connectReq.push(`Proxy-Authorization: ${proxyAuth}`)
              connectReq.push('Connection: keep-alive', '', '')
              connectSocket.write(connectReq.join('\r\n'))
            })
            connectSocket.setTimeout(30000, () => {
              connectSocket.destroy(new Error('代理 CONNECT 超时'))
            })
            let buf = ''
            const onData = (chunk) => {
              buf += chunk.toString('utf8')
              if (!buf.includes('\r\n\r\n')) return
              connectSocket.removeListener('data', onData)
              const firstLine = buf.split('\r\n')[0] || ''
              if (!/^HTTP\/1\.[01]\s+200/i.test(firstLine)) {
                connectSocket.destroy(new Error(`代理 CONNECT 失败: ${firstLine}`))
                return
              }
              const tlsSocket = tls.connect({
                socket: connectSocket,
                servername: url.hostname
              }, () => cb(null, tlsSocket))
              tlsSocket.on('error', (e) => cb(e))
            }
            connectSocket.on('data', onData)
            connectSocket.on('error', (e) => cb(e))
          }
        })
      }
    } else {
      Object.assign(reqOpts, {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search
      })
    }

    const httpModule = isHttps ? https : http
    const req = httpModule.request(reqOpts)
    const startedAt = Date.now()
    const traceId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    req.__netDiag = {
      traceId,
      startedAt,
      proxy: useHttpProxy ? String(proxyUrl) : '',
      method,
      target: `${url.hostname}${url.pathname}`,
      phases: {}
    }
    const mark = (phase, extra = {}) => {
      const d = req.__netDiag
      if (!d || d.phases[phase]) return
      d.phases[phase] = {
        t: Math.max(0, Date.now() - d.startedAt),
        ...extra
      }
    }

    req.on('socket', (socket) => {
      mark('socket_assigned')
      socket.once('lookup', (err, address, family) => {
        mark('dns_lookup', {
          address: address || '',
          family: family || '',
          error: err ? String(err.message || err) : ''
        })
      })
      if (socket.connecting) {
        socket.once('connect', () => mark('tcp_connect'))
      } else {
        mark('tcp_connect')
      }
      // keep-alive 复用同一 TLSSocket 时 secureConnect 已触发，再挂 once 会堆积并触发 MaxListenersExceededWarning
      if (socket.encrypted) {
        if (socket.secureConnecting) {
          socket.once('secureConnect', () => mark('tls_connect'))
        } else {
          mark('tls_connect')
        }
      }
      socket.once('error', (e) => {
        mark('socket_error', {
          code: String(e?.code || ''),
          message: String(e?.message || '')
        })
      })
      socket.once('close', (hadError) => {
        mark('socket_close', { hadError: !!hadError })
      })
    })
    req.once('finish', () => mark('request_finish'))
    req.once('response', (res) => {
      mark('response_headers', { statusCode: res.statusCode || 0 })
      res.once('data', () => mark('first_byte'))
      res.once('end', () => mark('response_end'))
    })
    req.once('error', (e) => {
      mark('request_error', {
        code: String(e?.code || ''),
        message: String(e?.message || '')
      })
    })
    req.once('close', () => mark('request_close'))

    const onAbort = () => { req.destroy(); }
    signal.addEventListener('abort', onAbort, { once: true })

    return req
  }

  /** @param {import('http').IncomingMessage} res */
  _parseRetryAfterMs(res) {
    try {
      const ra = res.headers['retry-after'] ?? res.headers['Retry-After']
      if (ra == null || ra === '') return null
      const s = String(ra).trim()
      const sec = parseInt(s, 10)
      if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 120000)
      const t = Date.parse(s)
      if (Number.isFinite(t)) return Math.min(Math.max(0, t - Date.now()), 120000)
    } catch (_) { /* ignore */ }
    return null
  }

  _readErrorBody(res, url, reject) {
    let errorBody = ''
    res.on('data', chunk => { errorBody += chunk })
    res.on('end', () => {
      const detail = `[${res.statusCode}] ${url.hostname}${url.pathname}`
      console.error('[AI] API error', detail, errorBody.substring(0, 500))
      const retryAfterMs = this._parseRetryAfterMs(res)
      try {
        const err = JSON.parse(errorBody)
        // OpenAI/OpenRouter: { error: { message, code?, metadata? } }
        // Anthropic: { type: "error", error: { type, message } }
        let msg = err.error?.message || err.message || ''
        if (err.error?.metadata && typeof err.error.metadata === 'object') {
          const meta = err.error.metadata
          let extra = meta.body || meta.upstream_error || meta.details
          // OpenRouter 将上游错误放在 metadata.raw（JSON 字符串）
          if (!extra && typeof meta.raw === 'string') {
            try {
              const raw = JSON.parse(meta.raw)
              const inner = raw.error?.message || raw.message
              if (inner) extra = inner
            } catch { /* ignore */ }
          }
          if (extra) msg += (msg ? ' | ' : '') + (typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 300))
        }
        if (!msg) msg = errorBody.substring(0, 200)
        msg = appendOpenAiPlatformBillingHint(res.statusCode, url.hostname, msg)
        const e = new Error(`${detail}: ${msg}`)
        e.httpStatus = res.statusCode
        e.apiHost = url.hostname
        e.apiPath = url.pathname
        if (retryAfterMs != null) e.retryAfterMs = retryAfterMs
        reject(e)
      } catch {
        let msg = errorBody.substring(0, 200)
        msg = appendOpenAiPlatformBillingHint(res.statusCode, url.hostname, msg)
        const e = new Error(`${detail}: ${msg}`)
        e.httpStatus = res.statusCode
        e.apiHost = url.hostname
        e.apiPath = url.pathname
        if (retryAfterMs != null) e.retryAfterMs = retryAfterMs
        reject(e)
      }
    })
  }

  async _executeTool(name, args, sender, sessionId, toolCallId = '', runMeta = {}) {
    if (!this.toolRegistry) {
      return { error: `工具系统未初始化` }
    }
    const { abortSignal, chatRunId: metaRunId, allowChannelSend = true } = runMeta || {}
    const normalizedToolName = String(name || '').trim()
    const isChannelSendTool = /^(feishu_send_message|feishu_send_file_message|feishu_send_voice_message|telegram_send_message|dingtalk_send_message|lark\.im_v1_message_create)$/.test(normalizedToolName)
    if (!allowChannelSend && isChannelSendTool) {
      return {
        error: `子会话不允许直接调用外发消息工具：${normalizedToolName}`,
        code: 'CHANNEL_SEND_FORBIDDEN',
        non_retryable: true
      }
    }
    // Route MCP tools to MCP manager
    if (name.startsWith('mcp__') && this.mcpManager) {
      if (abortSignal?.aborted) return { error: '已取消' }
      return await this.mcpManager.callTool(name, args, { signal: abortSignal })
    }
    // manifest.aiTools（§6）：webapp__<appId>__<name>
    if (name.startsWith('webapp__')) {
      const sessWeb = this.activeSessions.get(sessionId)
      const pp = String(sessWeb?.projectPath || '').trim()
      try {
        const { executeWebAppTool } = require('../web-apps/ai-tools')
        return await executeWebAppTool(name, args, pp, sessionId)
      } catch (e) {
        return { error: e.message || String(e) }
      }
    }
    const tool = this.toolRegistry.getTool(name)
    if (!tool) {
      return { error: `未知工具: ${name}` }
    }

    if (name === 'get_skill' && appLogger?.info) {
      try {
        appLogger.info('[AI][Tool] get_skill', {
          action: args && args.action,
          skill_id: args && args.skill_id,
          sandbox: args && args.sandbox
        })
      } catch (_) { /* ignore */ }
    }

    // 强制注入项目路径，避免 AI 遗漏或填错
    // 注意：__main_chat__/__feishu__/__gateway__ 是会话标识，不是实际文件系统路径
    const session = this.activeSessions.get(sessionId)
    const projectPath = String(session?.projectPath || '').trim()
    const hasRealProjectPath = !!projectPath && !projectPath.startsWith('__') && path.isAbsolute(projectPath)
    const webAppSandbox = hasRealProjectPath && isWebAppSandboxProject(projectPath)

    // 身份文件路径兜底：避免 AI 把 IDENTITY/SOUL 写到 /tmp 等错误目录
    // 应用工作室（web-apps 沙箱）内不要用全局 IDENTITY/SOUL，否则相对路径 identity.md 会被改写到宿主根，沙箱里「文件完全没变」
    if (name === 'file_operation' && args && typeof args.path === 'string') {
      const rawPath = String(args.path || '').trim()
      const normalized = rawPath.replace(/\\/g, '/').toLowerCase()
      const isIdentityTarget = normalized.endsWith('/identity.md') || normalized === 'identity.md'
      const isSoulTarget = normalized.endsWith('/soul.md') || normalized === 'soul.md'
      if (!webAppSandbox && isIdentityTarget) {
        args = { ...args, path: getAppRootPath('IDENTITY.md') }
      } else if (!webAppSandbox && isSoulTarget) {
        args = { ...args, path: getAppRootPath('SOUL.md') }
      }
    }

    const defaultWorkspaceCwd = getWorkspaceRoot()
    if (name === 'execute_command') {
      const rawCwd = args && typeof args.cwd === 'string' ? String(args.cwd).trim() : ''
      const invalidCwd = !rawCwd || rawCwd.startsWith('__') || !path.isAbsolute(rawCwd)
      if (invalidCwd) {
        args = { ...args, cwd: hasRealProjectPath ? projectPath : defaultWorkspaceCwd }
      }
    }
    if (hasRealProjectPath) {
      if (name === 'git_operation' && !args.repo_path) {
        args = { ...args, repo_path: projectPath }
      }
      // 相对路径拼到当前会话 projectPath；工作室会话保留绝对路径自由，允许越过当前应用根目录访问更广工程上下文。
      if (name === 'file_operation' && args.path && isRelativeFilePath(args.path)) {
        args = { ...args, path: path.join(projectPath, args.path) }
      }
      if (name === 'file_operation' && args.path && /web-apps/i.test(projectPath)) {
        try {
          appLogger?.info?.('[AI][SandboxApp] file_operation', {
            sessionId,
            projectPath,
            resolvedPath: args.path
          })
        } catch (_) { /* ignore */ }
      }
      // apply_patch：相对路径拼到 projectPath；绝对路径保持原值，工作室会话不再强制收束到当前应用根目录。
      if (name === 'apply_patch' && args && Array.isArray(args.changes)) {
        args = {
          ...args,
          changes: args.changes.map((ch) => {
            if (!ch || typeof ch !== 'object' || typeof ch.path !== 'string') return ch
            let fp = ch.path.trim()
            if (!fp) return ch
            if (path.isAbsolute(fp)) return ch
            return { ...ch, path: path.join(projectPath, fp) }
          })
        }
      }
      if (name === 'analyze_project' && !args.projectPath && !args.project_path) {
        args = { ...args, projectPath }
      }
    } else if (name === 'file_operation' && args.path && isRelativeFilePath(args.path)) {
      // 无真实项目路径时，默认将相对路径落到统一 workspace 根目录
      args = { ...args, path: path.join(defaultWorkspaceCwd, args.path) }
    }

    // 主会话 / 非应用工作室：禁止直接改写已安装沙箱应用目录（须 webapp_studio_invoke）
    if (!webAppSandbox) {
      if (name === 'file_operation' && args && String(args.action || '') === 'write' && args.path && isPathUnderWebAppsInstallRoot(args.path)) {
        return { success: false, error: WEBAPP_DELEGATION_REQUIRED_MSG }
      }
      if (name === 'apply_patch' && args && Array.isArray(args.changes)) {
        const touched = args.changes.some(
          (ch) => ch && typeof ch.path === 'string' && isPathUnderWebAppsInstallRoot(ch.path)
        )
        if (touched) {
          return { success: false, error: WEBAPP_DELEGATION_REQUIRED_MSG }
        }
      }
      if (name === 'execute_command' && args && typeof args.cwd === 'string' && isPathUnderWebAppsInstallRoot(args.cwd)) {
        return { success: false, error: WEBAPP_DELEGATION_REQUIRED_MSG }
      }
      if (name === 'git_operation' && args && typeof args.repo_path === 'string' && isPathUnderWebAppsInstallRoot(args.repo_path)) {
        const readOnlyGit = new Set(['status', 'branch_list', 'current_branch', 'diff', 'log', 'stash_list', 'remote'])
        const op = String(args.operation || '').trim()
        if (!readOnlyGit.has(op)) {
          return { success: false, error: WEBAPP_DELEGATION_REQUIRED_MSG }
        }
      }
    }

    // 飞书会话下调用发消息/发文件/发语音时，优先使用当前会话 chat_id。
    // 子 Agent 偶发会把 session/run id 当作 chat_id，导致 invalid receive_id，这里统一兜底纠正。
    const feishuSendToolNames = ['feishu_send_message', 'feishu_send_file_message', 'feishu_send_voice_message']
    if (feishuSendToolNames.includes(name) && session?.feishuChatId) {
      const sessionChatId = String(session.feishuChatId || '').trim()
      const rawChatId = String((args && args.chat_id) || '').trim()
      const looksLikeFeishuChatId = /^oc_[a-zA-Z0-9]+$/.test(rawChatId)
      const looksLikeSessionToken = /^(feishu-|sub-|run-)/.test(rawChatId) || rawChatId.includes('-run-')
      const shouldRewrite = !rawChatId || !looksLikeFeishuChatId || looksLikeSessionToken
      if (shouldRewrite) {
        if (rawChatId !== sessionChatId) {
          console.log('[FeishuToolRoute] 修正', name, 'chat_id', {
            sessionId,
            from: rawChatId || '(empty)',
            to: sessionChatId
          })
        }
        args = { ...(args || {}), chat_id: sessionChatId }
      }
    }

    return await tool.execute(args, {
      sender,
      sessionId,
      projectPath,
      toolCallId,
      runId: String(metaRunId || session?.chatRunId || '').trim(),
      abortSignal: abortSignal || undefined,
      channel: session?.feishuChatId ? 'feishu' : 'main',
      remoteId: session?.feishuChatId || '',
      feishuChatId: session?.feishuChatId || '',
      feishuTenantKey: session?.feishuTenantKey || '',
      feishuDocHost: session?.feishuDocHost || '',
      feishuSenderOpenId: session?.feishuSenderOpenId || '',
      feishuSenderUserId: session?.feishuSenderUserId || ''
    })
  }
}

module.exports = {
  Orchestrator,
  __test: {
    hasModelIdentityQuestion,
    detectPromptIntentFlags
  }
}
