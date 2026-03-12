// AI Agent 核心编排器
// 支持 OpenAI 兼容 API 和 Anthropic Messages API，自动按模型名切换

const https = require('https')
const http = require('http')
const path = require('path')
const { URL } = require('url')
const { SSEParser } = require('./stream-parser')
const { shouldCompress, compressMessages, flushMemoryBeforeCompaction } = require('./context-compressor')
const { getTopMemoriesForProject, saveMemory, readGlobalMemoryMd, readSoulMd, readIdentityMd, readAgentDisplayName, readUserMd, readBootMd, readAgentsMd, readToolsMd, readLessonsLearned, appendToDiary } = require('./memory-store')
const { loadPrompt } = require('./system-prompts')
const { sanitizeAssistantIdentityWording, sanitizeAssistantModelIdentity } = require('./identity-wording')
const { getAppRootPath, getWorkspaceRoot } = require('../app-root')
const responseCache = require('./response-cache')
const sessionRegistry = require('./session-registry')

/** 仅当 sender 存在且未销毁时才可推送（sender 可能非 WebContents，无 isDestroyed） */
function canSend(sender) {
  if (!sender) return false
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return false
  return true
}

// Claude 模型前缀
const CLAUDE_PREFIXES = ['claude-']

class Orchestrator {
  constructor(getAIConfigOrStore, toolRegistry, mcpManager) {
    this.getAIConfig = typeof getAIConfigOrStore === 'function' ? getAIConfigOrStore : null
    this.store = this.getAIConfig ? null : getAIConfigOrStore
    this.toolRegistry = toolRegistry
    this.mcpManager = mcpManager || null
    this.activeSessions = new Map()
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

  _isModelCatalogQuery(text) {
    const s = String(text || '').toLowerCase()
    if (!s) return false
    return (
      /你是什么模型|你是啥模型|当前模型|现在用的模型|用的什么模型|可用模型|有哪些模型|能用什么模型|模型列表|配置了哪些模型|供应商/.test(s) ||
      /what model are you|which model are you using|current model|available models|model list|which models can you use|configured models|providers/.test(s)
    )
  }

  _isProviderScopedModelQuery(text) {
    const s = String(text || '').toLowerCase()
    if (!s) return false
    return (
      /供应商|按供应商|各供应商|provider|providers|by provider/.test(s)
    )
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

  // ---------- 启动 Agent 对话循环 ----------
  async startChat({ sessionId, messages, model, tools, sender, config: externalConfig, projectPath, panelId, feishuChatId }) {
    const config = externalConfig || this.getConfig()
    if (!config.apiKey || !String(config.apiKey).trim()) {
      const baseUrl = (config.apiBaseUrl || '').trim()
      const isOpenRouter = /openrouter\.ai/i.test(baseUrl)
      const hint = isOpenRouter
        ? '请先在「设置 → 配置」中为 OpenRouter 填写并保存 API Key（可在 https://openrouter.ai/keys 获取）'
        : '请先配置 API Key'
      if (canSend(sender)) sender.send('ai-chat-error', { sessionId, error: hint })
      return { success: false, error: hint }
    }

    const abortController = new AbortController()
    this.activeSessions.set(sessionId, { abortController, projectPath: projectPath || '', feishuChatId: feishuChatId || '' })

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

    // 包装 sender，拦截关键事件更新注册表（HTTP 调用时 sender 为 null，不推送）
    const wrappedSender = {
      send: (channel, data) => {
        if (canSend(sender)) sender.send(channel, data)
        if (channel === 'ai-chat-token' && data.sessionId === sessionId) {
          sessionRegistry.updateToken(registryId, data.token || '')
        }
        if (channel === 'ai-chat-tool-call' && data.sessionId === sessionId) {
          sessionRegistry.updateToolCall(registryId, data.toolCall || {})
        }
      },
      isDestroyed: () => !canSend(sender)
    }

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
    const isAnthropic = this._isClaudeModel(useModel)
    const maxIterations = config.maxToolIterations || 0 // 0 = 不限制（安全上限 200）
    const safeMax = maxIterations > 0 ? maxIterations : 200
    const displayName = readAgentDisplayName() || 'Ultron'
    const normalizeAssistantContent = (content) =>
      typeof content === 'string'
        ? sanitizeAssistantIdentityWording(sanitizeAssistantModelIdentity(content, useModel), displayName)
        : content
    let iteration = 0
    let currentMessages = [...messages]

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

      // 0. 当前应用边界（最高优先级）
      memParts.push(
        '[当前应用]\n' +
        '你正在运行并直接操作的应用是 **OpenUltron**（本应用）。\n' +
        '当用户要求修改或配置**本机其他项目**、某仓库或用户提到的任意名称时：自行决定用 execute_command 执行哪些命令定位，用 file_operation 读改配置；不得未执行就称找不到或向用户索要路径。可先调用 query_command_log 查看当前项目下已执行命令的成功/失败与已查看路径，再决定本次命令，实现自我进化。具体项目名称、常见路径与配置文件名由你自行检索或根据用户表述判断，提示词中不预设。\n' +
        '当执行中遇到「命令不存在」「依赖缺失」（如 tesseract、ffmpeg、python 包等）时：先判断是否存在内置工具可完成任务；若有内置工具必须优先使用，禁止安装依赖。仅当确实不存在内置替代方案时，才可执行最小化安装步骤并继续任务；安装命令超时或失败时，自动换一种安装方式重试一次（无需向用户弹确认），仍失败再给降级方案。\n' +
        'TTS/语音场景是强制例外：必须优先使用内置工具，不要安装依赖。先用 tts_voice_manager(list_voices/list_aliases) 获取音色与别名，再用 tts_voice_manager(set_alias/set_default) 记录用户选择；飞书发送用 feishu_send_message 的 audio_* 参数，Telegram 发送用 telegram_send_message 的 audio_* 参数；不要执行 npm/brew/pip 安装 node-edge-tts 或其他 TTS 依赖。\n' +
        `默认工作空间：${getWorkspaceRoot()}。\n` +
        `当无真实项目路径时：脚本优先写入 ${path.join(getWorkspaceRoot(), 'scripts')}，新建项目优先放入 ${path.join(getWorkspaceRoot(), 'projects')}，避免散落在其他目录。\n` +
        '**回复风格**：不要写「我来帮你…」「让我执行…」等固定话术；不要输出「可能的原因和建议」「请提供以下任一信息」等模板式列表。直接执行、根据结果继续或简短说明已尝试与下一步。未明确要求修改外部项目时，默认在 OpenUltron 内完成。'
      )

      // 0.1 当前模型（从 prompts/current-model.md 或默认）
      const currentModelText = loadPrompt('current-model', { model: useModel })
      if (currentModelText) memParts.push(currentModelText)

      // 0.5 飞书会话（从 prompts/feishu-session.md 或默认）
      const session = this.activeSessions.get(sessionId)
      if (session && session.feishuChatId) {
        const feishuText = loadPrompt('feishu-session')
        if (feishuText) memParts.push(feishuText)
        memParts.push(
          '[飞书附件处理规则]\n' +
          '当用户消息中已包含附件的 local_path（例如 [Inbound Attachment Paths] 或 local_path: /...）时：\n' +
          '1) 必须优先使用这些路径读取/分析；\n' +
          '2) 不要在 ~/Downloads 或其他目录盲目搜索同名文件；\n' +
          '3) 若路径读取失败，再明确说明失败原因并给出下一步。'
        )
      }

      // 0.6 联网与实时信息（prompts/realtime-info.md）
      const realtimeText = loadPrompt('realtime-info')
      if (realtimeText) memParts.push(realtimeText)

      // 0.65 浏览器自动化（prompts/browser-automation.md）
      const browserText = loadPrompt('browser-automation')
      if (browserText) memParts.push(browserText)

      // 0.66 桌面原生通知（prompts/desktop-notification.md）
      const desktopNotifText = loadPrompt('desktop-notification')
      if (desktopNotifText) memParts.push(desktopNotifText)

      // 1. 全局偏好文件 MEMORY.md
      const globalMd = readGlobalMemoryMd()
      if (globalMd) memParts.push(`[全局偏好 - MEMORY.md]\n${globalMd}`)

      // 2. 本应用 SOUL.md（性格/价值观层）
      const soulMd = readSoulMd()
      if (soulMd) memParts.push(`[SOUL.md - 性格与原则]\n${soulMd}`)

      // 2.1 IDENTITY.md（Agent 名字、形象、vibe、代词）
      const identityMd = readIdentityMd()
      if (identityMd) memParts.push(`[IDENTITY.md]\n${identityMd}`)
      // 回复与自我介绍：仅用 IDENTITY/SOUL，禁止通用话术（尤其飞书等渠道）
      memParts.push(
        '[回复与自我介绍]\n' +
        '打招呼、回复「你好」「在吗」或自我介绍时，**严格只按 IDENTITY.md 与 SOUL.md** 中的名字、语气与身份来回复。禁止自称「OpenUltron 的 AI 助手」「随时为您服务」等通用话术；若 IDENTITY 里已有名字与 vibe，就用该名字与语气，不要额外套用上述模板。'
      )
      // 上下文消歧 + 正确路径：名字/身份指本应用；文件在应用根目录，非 prompts 下
      memParts.push(
        '[名字与身份修改]\n' +
        '当用户说「改名字」「改身份」「修改角色」「你可以修改名字/身份吗」等且**未明确说是某外部项目**时，指**本应用（OpenUltron）**的身份配置。\n' +
        '**正确路径**：IDENTITY.md、SOUL.md 位于**应用根目录**（与 prompts 目录同级），例如 ~/.openultron/IDENTITY.md、~/.openultron/SOUL.md。文件名必须为**大写** IDENTITY.md、SOUL.md，**不要**写入 prompts/ 目录，**不要**使用 identity.md（小写）。修改时请用 file_operation 写入上述路径，或引导用户点击「编辑我的名字与角色」打开正确文件。'
      )

      // 2.2 USER.md（用户信息：姓名、时区、工作、偏好等）
      const userMd = readUserMd()
      if (userMd) memParts.push(`[USER.md]\n${userMd}`)

      // 2.3 BOOT.md（会话启动时简短指令）
      const bootMd = readBootMd()
      if (bootMd) memParts.push(`[BOOT.md - 启动指令]\n${bootMd}`)

      // 2.4 AGENTS.md / TOOLS.md（工作区 Agent 与工具说明，若存在则注入）
      const agentsMd = readAgentsMd()
      if (agentsMd) memParts.push(`[AGENTS.md - 工作区 Agent 说明]\n${agentsMd}`)
      const toolsMd = readToolsMd()
      if (toolsMd) memParts.push(`[TOOLS.md - 工作区工具说明]\n${toolsMd}`)

      // 2.5 学习新技能流程（prompts/learn-skill-flow.md）
      const learnFlowText = loadPrompt('learn-skill-flow')
      if (learnFlowText) memParts.push(learnFlowText)

      // 2.6 从网上学习 OpenClaw 玩家新能力（prompts/learn-from-web-openclaw.md）
      const learnWebText = loadPrompt('learn-from-web-openclaw')
      if (learnWebText) memParts.push(learnWebText)

      // 2.7 OpenUltron 可配置能力与引导用户获取参数（prompts/openultron-config-guide.md）
      const configGuideText = loadPrompt('openultron-config-guide')
      if (configGuideText) memParts.push(configGuideText)

      // 2.8 可用供应商与模型（主会话 vs 子任务；先验证再切换）
      memParts.push(
        '[可用供应商与模型]\n' +
        '**主会话**的供应商与模型由用户在设置页配置。为**子任务**指定模型请用 sessions_spawn(provider=..., model=...)，勿用 ai_config_control 改主会话以免错配。若必须改主会话：先调用 verify_provider_model(provider=..., model=...) 验证该供应商+模型可用，仅当返回 success 后再调用 ai_config_control 的 switch_provider 或 switch_model（switch_model 切到别家模型时须同时传 provider）。\n' +
        '**当用户询问「有哪些模型可以用」等且未要求按供应商展开时**：先 list_configured_models，严格按主模型+模型池回答。\n' +
        '仅当用户明确要求按供应商查看时，才调用 list_providers_and_models。\n' +
        '派生子 Agent：可先 verify_provider_model(provider, model) 确认可用，再 sessions_spawn(task=..., provider=..., model=...)。'
      )

      // 3. 项目相关碎片记忆
      if (projectPath) {
        const topMemories = getTopMemoriesForProject(projectPath, 5)
        if (topMemories.length > 0) {
          const memText = topMemories.map((m, i) => `${i + 1}. ${m.content}`).join('\n')
          memParts.push(`[项目记忆]\n${memText}`)
        }
      }

      // 4. 知识库经验教训（自动注入，无需再调 read_lessons_learned 即可直接利用）
      const lessonsContent = readLessonsLearned()
      if (lessonsContent && lessonsContent.trim()) {
        memParts.push(`[知识库 - 经验教训]\n${lessonsContent.trim()}\n\n**使用方式**：上述经验已直接给到你，后续同类任务请优先按其中「正确做法/可复用步骤」执行，避免重复试错。写 lesson_save 时须写详细：含具体场景、失败原因或成功做法、可复用的命令/路径/步骤（便于下次直接套用），不要只写一句话概括。`)
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

    // 清洗工具 schema
    const sanitizedTools = (tools || []).map(t => {
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

    console.log('[AI] startChat →', isAnthropic ? 'Anthropic' : 'OpenAI', 'model:', useModel, 'baseUrl:', config.apiBaseUrl)

    // 上下文压缩：阈值内每轮开始都会检查，超阈值即压缩（频次高、尽量省 token）
    const compressionConfig = config.contextCompression || {}
    const fakeSender = { send: () => {} }
    const callForSummary = async (msgs, maxTokens) => {
      const callFn = isAnthropic ? this._callAnthropicLLM.bind(this) : this._callOpenAILLM.bind(this)
      const result = await callFn(
        { messages: msgs, model: useModel, tools: undefined, temperature: 0, max_tokens: maxTokens || 1000 },
        config, fakeSender, `summary-${sessionId}`, new AbortController().signal
      )
      return result?.content || ''
    }
    const maybeCompress = async () => {
      if (!shouldCompress(currentMessages, compressionConfig)) return
      console.log('[AI] 触发上下文压缩...')
      flushMemoryBeforeCompaction(currentMessages, callForSummary).catch(() => {})
      currentMessages = await compressMessages(currentMessages, compressionConfig, callForSummary)
    }
    await maybeCompress()

    try {
      let modelCatalogNudgeCount = 0
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

        // 每轮开始前检查：多轮 tool 调用后上下文会膨胀，再次压缩以省 token
        await maybeCompress()

        iteration++

        // 响应缓存：上一轮纯 Q&A 且当前用户消息与上一轮完全一致时直接复用，减少 token
        const lastUserContent = responseCache.getLastUserContent(currentMessages)
        const isModelCatalogQuestion = this._isModelCatalogQuery(lastUserContent)
        const isProviderScopedModelQuery = this._isProviderScopedModelQuery(lastUserContent)
        let response = null
        let fromCache = false
        if (lastUserContent && !isModelCatalogQuestion) {
          const cached = responseCache.get(sessionId, lastUserContent)
          if (cached) {
            response = { content: cached, toolCalls: [] }
            fromCache = true
            wrappedSender.send('ai-chat-token', { sessionId, token: cached })
          }
        }
        if (!response) {
          const modelCandidates = [{ model: useModel, routeConfig: config }]
          for (const r of fallbackRoutes) {
            if (!r || !r.model || !r.config) continue
            if (r.model === useModel) continue
            modelCandidates.push({ model: String(r.model), routeConfig: r.config })
          }
          for (const m of fallbackModels) {
            if (!modelCandidates.some(x => x.model === m)) modelCandidates.push({ model: m, routeConfig: config })
          }
          for (let mi = 0; mi < modelCandidates.length; mi++) {
            const tryModel = modelCandidates[mi].model
            const tryConfig = modelCandidates[mi].routeConfig || config
            const tryAnthropic = this._isClaudeModel(tryModel)
            const callFn = tryAnthropic ? this._callAnthropicLLM.bind(this) : this._callOpenAILLM.bind(this)
            try {
              const messagesToSend = tryAnthropic ? currentMessages : this._sanitizeOpenAIMessages(currentMessages)
              const toolModes = sanitizedTools.length > 0
                ? [{ tools: sanitizedTools, withTools: true }, { tools: undefined, withTools: false }]
                : [{ tools: undefined, withTools: false }]
              let lastModeErr = null
              for (let ti = 0; ti < toolModes.length; ti++) {
                const mode = toolModes[ti]
                try {
                  response = await callFn({
                    messages: messagesToSend,
                    model: tryModel,
                    tools: mode.tools,
                    temperature: tryConfig.temperature ?? 0,
                    max_tokens: tryConfig.maxTokens || 0
                  }, tryConfig, wrappedSender, sessionId, abortController.signal)
                  if (!mode.withTools) {
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
                    ti < toolModes.length - 1
                  if (shouldRetryWithoutTools) {
                    console.warn(`[AI] 模型 ${tryModel} 工具调用受限（${classify.kind}），自动改为无工具模式重试:`, modeErr.message)
                    continue
                  }
                  throw modeErr
                }
              }
              if (!response && lastModeErr) throw lastModeErr
              if (mi > 0) {
                const host = String((tryConfig.apiBaseUrl || '')).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
                console.log(`[AI] 已故障转移到备用模型: ${tryModel} @ ${host}`)
                wrappedSender.send('ai-chat-token', { sessionId, token: `\n\n> ⚠️ 主模型不可用，已自动切换至备用模型 ${tryModel}${host ? ` @ ${host}` : ''}\n\n` })
              }
              break
            } catch (err) {
              const classify = this._classifyLlmError(err)
              if (classify.action === 'fail_fast') {
                throw err
              }
              if (mi < modelCandidates.length - 1) {
                console.warn(`[AI] 模型 ${tryModel} 调用失败，尝试下一个:`, err.message)
              } else {
                throw err  // 所有备用模型都失败，抛出错误
              }
            }
        }
        }

        if (abortController.signal.aborted) break

        if (response.toolCalls && response.toolCalls.length > 0) {
          // 内容重复检测：本轮助手文案与上一条助手消息几乎相同则视为死循环（如反复说「我来获取模型列表验证」）
          // 不直接报错结束，而是注入提示让 AI 换表述或说明无法完成
          const lastAssistant = [...currentMessages].reverse().find(m => m.role === 'assistant')
          const prevContent = (lastAssistant && typeof lastAssistant.content === 'string') ? lastAssistant.content.trim() : ''
          const currContent = (response.content && typeof response.content === 'string') ? response.content.trim() : ''
          const prevHead = prevContent.slice(0, 80)
          const currHead = currContent.slice(0, 80)
          const contentRepeatDetected = prevHead.length >= 20 && currHead.length >= 20 && (prevHead === currHead || prevContent === currContent || prevContent.includes(currHead) || currContent.includes(prevHead))
          const hasModelCatalogTool = response.toolCalls.some(tc => {
            const n = String(tc?.function?.name || '').trim()
            return n === 'list_configured_models' || n === 'list_providers_and_models' || n === 'verify_provider_model'
          })
          if (contentRepeatDetected && !hasModelCatalogTool) {
            const normalizedToolCallsForRepeat = response.toolCalls.map((tc, idx) => ({
              id: (tc.id && String(tc.id).trim()) || `call_${idx}_${Date.now()}`,
              type: tc.type === 'function' ? 'function' : 'function',
              function: {
                name: tc.function?.name || '',
                arguments: this._normalizeToolArguments(tc.function?.arguments)
              }
            }))
            // 仍向前端发送 tool-call / tool-result，让用户能看到「本轮的命令执行情况」（结果为已跳过）
            for (const toolCall of normalizedToolCallsForRepeat) {
              wrappedSender.send('ai-chat-tool-call', {
                sessionId,
                toolCall: {
                  id: toolCall.id,
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments
                }
              })
            }
            const skipReason = '检测到与上一轮几乎相同的回复，已跳过执行；请换一种表述或直接说明无法完成。'
            for (const toolCall of normalizedToolCallsForRepeat) {
              wrappedSender.send('ai-chat-tool-result', {
                sessionId,
                toolCallId: toolCall.id,
                name: toolCall.function.name,
                result: JSON.stringify({ skipped: true, reason: skipReason })
              })
            }
            currentMessages.push({
              role: 'assistant',
              content: normalizeAssistantContent(response.content || null),
              tool_calls: normalizedToolCallsForRepeat
            })
            currentMessages.push({
              role: 'user',
              content: '[系统] 检测到与上一轮几乎相同的回复，请换一种表述或直接说明无法完成并建议用户换一种方式；勿重复同一句话。'
            })
            continue
          }

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
              let result
              try {
                const args = this._parseToolArgumentsObject(toolCall.function.arguments)
                // 记录实际使用的工具名称与参数，便于排查「chrome-devtools vs webview_control」等选择
                try {
                  console.log('[AI][ToolCall]', {
                    sessionId,
                    name: toolCall.function.name,
                    argsPreview: JSON.stringify(args).slice(0, 300)
                  })
                } catch (_) { /* ignore */ }
                result = await this._executeTool(toolCall.function.name, args, wrappedSender, sessionId, toolCall.id)
              } catch (e) {
                result = { error: e.message }
              }
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
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

          // ---- 循环检测：不终止会话，注入一条系统提示让 AI 看到后换思路继续 ----
          const loopError = this._detectLoop(loopDetector, normalizedToolCalls, toolResults)

          // 工具结果过长时截断，避免单次工具输出撑爆上下文、浪费 token
          const TOOL_RESULT_MAX_LEN = 12000
          for (let i = 0; i < toolResults.length; i++) {
            const { toolCall, resultStr } = toolResults[i]
            let content = resultStr
            if (typeof resultStr === 'string' && resultStr.length > TOOL_RESULT_MAX_LEN) {
              content = resultStr.slice(0, TOOL_RESULT_MAX_LEN) + `\n...(已截断，共 ${resultStr.length} 字)`
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
              content: `[系统] ${loopError} 请换一种思路或命令再试，勿重复相同操作；若仍无法完成再告知用户。`
            })
          }
          continue
        }
        // 对“模型身份/可用模型”问题强制先查工具，避免口胡
        if (isModelCatalogQuestion) {
          const requiredTool = isProviderScopedModelQuery ? 'list_providers_and_models' : 'list_configured_models'
          if (!this._hasToolCallAfterLastUser(currentMessages, requiredTool)) {
            if (modelCatalogNudgeCount < 2) {
              modelCatalogNudgeCount++
              currentMessages.push({
                role: 'user',
                content: isProviderScopedModelQuery
                  ? '[系统] 你必须先调用 list_providers_and_models，再严格按返回结果回答。禁止根据训练知识猜测模型、供应商、数量或默认值。'
                  : '[系统] 你必须先调用 list_configured_models，并仅按主模型+模型池回答。禁止按供应商扩写或根据训练知识猜测。'
              })
              continue
            }
          }
        }
        // 无工具调用：写入响应缓存（仅真实 API 返回、纯 Q&A 时），便于下次相同问题命中
        if (!isModelCatalogQuestion && !fromCache && response && response.content && (!response.toolCalls || response.toolCalls.length === 0)) {
          responseCache.set(sessionId, lastUserContent, normalizeAssistantContent(response.content))
        }
        currentMessages.push({
          role: 'assistant',
          content: response ? normalizeAssistantContent(response.content || null) : null
        })
        break
      }

      if (iteration >= safeMax) {
        wrappedSender.send('ai-chat-error', {
          sessionId,
          error: `已达到安全上限 (${safeMax} 轮)，循环终止`
        })
      }

      wrappedSender.send('ai-chat-complete', { sessionId, messages: currentMessages })
      sessionRegistry.markComplete(registryId)
      this._extractMemoriesAsync(currentMessages, projectPath, config, useModel, isAnthropic)
      this._notifyFeishuOnComplete(currentMessages)
      return { success: true, messages: currentMessages }
    } catch (error) {
      if (abortController.signal.aborted) {
        wrappedSender.send('ai-chat-complete', { sessionId, messages: currentMessages })
        sessionRegistry.markComplete(registryId)
        this._extractMemoriesAsync(currentMessages, projectPath, config, useModel, isAnthropic)
        this._notifyFeishuOnComplete(currentMessages)
        return { success: true, messages: currentMessages }
      } else {
        wrappedSender.send('ai-chat-error', { sessionId, error: error.message })
        sessionRegistry.markError(registryId, error.message)
        return { success: false, error: error.message }
      }
    } finally {
      this.activeSessions.delete(sessionId)
    }
  }

  /** 会话正常结束时，若飞书配置了「任务完成通知」，则发一条摘要到默认会话 */
  _notifyFeishuOnComplete(messages) {
    try {
      const feishuNotify = require('./feishu-notify')
      const config = feishuNotify.getConfig()
      if (!config.notify_on_complete || !(config.default_chat_id && config.default_chat_id.trim())) return
      const lastAssistant = [...(messages || [])].reverse().find(m => m.role === 'assistant')
      let summary = ''
      if (lastAssistant && lastAssistant.content) {
        if (typeof lastAssistant.content === 'string') {
          summary = lastAssistant.content.trim().slice(0, 400)
        } else if (Array.isArray(lastAssistant.content)) {
          const text = lastAssistant.content.map(c => (c && c.text) || '').join('').trim().slice(0, 400)
          summary = text
        }
      }
      if (!summary) summary = '会话已完成'
      feishuNotify.sendMessage({
        text: `【Git Manager 任务完成】\n${summary}`
      }).catch(e => console.warn('[Feishu] 任务完成通知发送失败:', e.message))
    } catch (e) {
      console.warn('[Feishu] 任务完成通知失败:', e.message)
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

  // 异步提取对话中的记忆（后台运行，不影响用户体验）
  async _extractMemoriesAsync(messages, projectPath, config, model, isAnthropic) {
    // 仅对包含有效对话的消息执行
    const dialogMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant')
    if (dialogMsgs.length < 2) return

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

    try {
      const fakeSender = { send: () => {} }
      const callFn = isAnthropic ? this._callAnthropicLLM.bind(this) : this._callOpenAILLM.bind(this)
      const result = await callFn(
        { messages: [{ role: 'user', content: extractPrompt }], model, tools: undefined, temperature: 0, max_tokens: 500 },
        config, fakeSender, `memory-extract-${Date.now()}`, new AbortController().signal
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
      console.log(`[AI] 自动提取 ${items.length} 条记忆`)
    } catch (e) {
      // 静默失败，不影响主流程
      console.warn('[AI] 记忆提取失败:', e.message)
    }
  }

  stopChat(sessionId) {
    const session = this.activeSessions.get(sessionId)
    if (session) {
      session.abortController.abort()
      this.activeSessions.delete(sessionId)
    }
  }

  // ---------- 单轮非流式文本生成（用于 commit message 等简单场景）----------
  async generateText({ prompt, model: overrideModel, systemPrompt, config: externalConfig } = {}) {
    const config = externalConfig || this.getConfig()
    if (!config.apiKey || !String(config.apiKey).trim()) {
      const isOpenRouter = /openrouter\.ai/i.test(config.apiBaseUrl || '')
      throw new Error(isOpenRouter
        ? '请先在「设置 → 配置」中为 OpenRouter 填写并保存 API Key（可在 https://openrouter.ai/keys 获取）'
        : '请先配置 AI API Key')
    }

    const useModel = overrideModel || config.defaultModel || 'deepseek-v3'
    const isAnthropic = this._isClaudeModel(useModel)

    const messages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }]

    return new Promise((resolve, reject) => {
      let url, reqBody, headers

      if (isAnthropic) {
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
      } else {
        url = new URL(`${config.apiBaseUrl}/chat/completions`)
        reqBody = {
          model: useModel,
          messages,
          stream: false,
          temperature: config.temperature ?? 0
        }
        if (config.maxTokens) reqBody.max_tokens = config.maxTokens
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        }
      }

      const postData = JSON.stringify(reqBody)
      headers['Content-Length'] = Buffer.byteLength(postData)

      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http
      const req = httpModule.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: 30000
      })

      req.on('response', (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            try {
              const err = JSON.parse(body)
              reject(new Error(err.error?.message || err.message || `HTTP ${res.statusCode}`))
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`))
            }
            return
          }
          try {
            const data = JSON.parse(body)
            const content = isAnthropic
              ? (data.content?.[0]?.text || '')
              : (data.choices?.[0]?.message?.content || '')
            resolve(content.trim())
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

  _classifyLlmError(err) {
    const status = Number(err && (err.httpStatus || err.statusCode || 0)) || 0
    const raw = String(err && err.message ? err.message : err || '')
    const msg = raw.toLowerCase()

    const isAuth = status === 401 || status === 403 ||
      /invalid api key|unauthorized|authentication|auth failed|forbidden/.test(msg)
    if (isAuth) return { kind: 'auth', action: 'fail_fast' }

    const isBilling = /insufficient_quota|quota|billing|余额|欠费|credit|payment required/.test(msg)
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

  // ========== OpenAI 兼容 API ==========
  _callOpenAILLM(body, config, sender, sessionId, signal) {
    const { maxRetries, baseDelayMs, maxDelayMs } = this._getRetryConfig(config)

    const attemptOnce = (attempt) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('已取消')); return }

      const url = new URL(`${config.apiBaseUrl}/chat/completions`)
      // max_tokens=0 表示不限制，不传该字段让 API 使用模型默认值
      const reqBody = { ...body, stream: true }
      if (!reqBody.max_tokens) delete reqBody.max_tokens
      const postData = JSON.stringify(reqBody)

      const onError = (err) => {
        if (this._shouldRetryError(err, attempt, maxRetries)) {
          const delay = this._getRetryDelayMs(attempt, baseDelayMs, maxDelayMs)
          console.warn(`[AI] API 调用失败，将在 ${delay}ms 后重试 (${attempt + 1}/${maxRetries})：`, err.message)
          this._sleep(delay, signal)
            .then(() => attemptOnce(attempt + 1).then(resolve, reject))
            .catch(() => reject(err))
          return
        }
        reject(err)
      }

      const req = this._makeRequest(url, 'POST', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Length': Buffer.byteLength(postData)
      }, signal)
      // 流式请求超时（如上游无响应或卡住），避免一直“转圈”且无报错
      const STREAM_TIMEOUT_MS = 120000
      req.setTimeout(STREAM_TIMEOUT_MS, () => {
        if (!req.destroyed) req.destroy(new Error(`请求超时（${STREAM_TIMEOUT_MS / 1000} 秒内无响应）`))
      })

      const parser = new SSEParser()
      let fullContent = ''
      let toolCalls = []
      let toolCallBuffers = {}

      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          this._readErrorBody(res, url, onError)
          return
        }
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          if (signal.aborted) { req.destroy(); return }
          const events = parser.parse(chunk)
          for (const event of events) {
            if (event.type === 'done' || event.type !== 'data') continue
            const choice = event.data.choices?.[0]
            if (!choice?.delta) continue

            if (choice.delta.content) {
              fullContent += choice.delta.content
              if (canSend(sender)) sender.send('ai-chat-token', { sessionId, token: choice.delta.content })
            }

            if (choice.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallBuffers[idx]) {
                  toolCallBuffers[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' }
                }
                if (tc.id) toolCallBuffers[idx].id = tc.id
                if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name
                if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments
              }
            }

            if (choice.finish_reason) {
              toolCalls = Object.values(toolCallBuffers).map((tc, idx) => ({
                id: (tc.id && String(tc.id).trim()) || `call_${idx}_${Date.now()}`,
                type: 'function',
                function: { name: tc.name || '', arguments: this._normalizeToolArguments(tc.arguments) }
              }))
            }
          }
        })
        res.on('end', () => {
          if (toolCalls.length === 0 && Object.keys(toolCallBuffers).length > 0) {
            toolCalls = Object.values(toolCallBuffers).map((tc, idx) => ({
              id: (tc.id && String(tc.id).trim()) || `call_${idx}_${Date.now()}`,
              type: 'function',
              function: { name: tc.name || '', arguments: this._normalizeToolArguments(tc.arguments) }
            }))
          }
          resolve({ content: fullContent, toolCalls })
        })
        res.on('error', onError)
      })

      req.on('error', onError)
      req.write(postData)
      req.end()
    })

    return attemptOnce(0)
  }

  // ========== Anthropic Messages API ==========
  _callAnthropicLLM(body, config, sender, sessionId, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('已取消')); return }

      // Anthropic 端点：baseUrl 去掉末尾 /v1 后加 /v1/messages
      const baseUrl = config.apiBaseUrl.replace(/\/v1\/?$/, '')
      const url = new URL(`${baseUrl}/v1/messages`)

      // 转换消息格式
      const { system, messages: anthropicMessages } = this._toAnthropicMessages(body.messages)

      // 转换工具格式
      const anthropicTools = body.tools ? this._toAnthropicTools(body.tools) : undefined

      const reqBody = {
        model: body.model,
        max_tokens: body.max_tokens || 16384, // Anthropic 必须指定，0 时用 16384
        temperature: body.temperature,
        stream: true,
        messages: anthropicMessages
      }
      if (system) reqBody.system = system
      if (anthropicTools && anthropicTools.length > 0) reqBody.tools = anthropicTools

      const postData = JSON.stringify(reqBody)

      const req = this._makeRequest(url, 'POST', {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(postData)
      }, signal)
      const STREAM_TIMEOUT_MS = 120000
      req.setTimeout(STREAM_TIMEOUT_MS, () => {
        if (!req.destroyed) req.destroy(new Error(`请求超时（${STREAM_TIMEOUT_MS / 1000} 秒内无响应）`))
      })

      const parser = new SSEParser()
      let fullContent = ''
      let toolCalls = []
      // content blocks: index -> { type, id?, name?, text?, input? }
      let contentBlocks = {}

      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          this._readErrorBody(res, url, reject)
          return
        }
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          if (signal.aborted) { req.destroy(); return }
          const events = parser.parse(chunk)
          for (const event of events) {
            if (event.type !== 'data') continue
            const d = event.data
            if (!d || !d.type) continue

            switch (d.type) {
              case 'content_block_start': {
                const idx = d.index
                const block = d.content_block || {}
                contentBlocks[idx] = {
                  type: block.type,
                  id: block.id || '',
                  name: block.name || '',
                  text: block.text || '',
                  input: ''
                }
                break
              }
              case 'content_block_delta': {
                const idx = d.index
                const delta = d.delta || {}
                const block = contentBlocks[idx]
                if (!block) break
                if (delta.type === 'text_delta' && delta.text) {
                  block.text += delta.text
                  fullContent += delta.text
                  if (canSend(sender)) sender.send('ai-chat-token', { sessionId, token: delta.text })
                } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                  block.input += delta.partial_json
                }
                break
              }
              case 'message_delta': {
                // 结束，收集 tool_use blocks
                const stopReason = d.delta?.stop_reason
                if (stopReason === 'tool_use' || stopReason === 'end_turn') {
                  for (const [, block] of Object.entries(contentBlocks)) {
                    if (block.type === 'tool_use') {
                      toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: {
                          name: block.name,
                          arguments: block.input
                        }
                      })
                    }
                  }
                }
                break
              }
            }
          }
        })
        res.on('end', () => {
          // 兜底：如果 message_delta 没触发也要收集
          if (toolCalls.length === 0) {
            for (const [, block] of Object.entries(contentBlocks)) {
              if (block.type === 'tool_use') {
                toolCalls.push({
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: block.input }
                })
              }
            }
          }
          resolve({ content: fullContent, toolCalls })
        })
        res.on('error', reject)
      })

      req.on('error', reject)
      req.write(postData)
      req.end()
    })
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
    const maxRetries = Number.isFinite(raw.maxRetries) ? raw.maxRetries : 2
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

    const msg = String(err.message || '').toLowerCase()
    return (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('eai_again') ||
      msg.includes('enotfound') ||
      msg.includes('etimedout')
    )
  }

  _getRetryDelayMs(attempt, baseDelayMs, maxDelayMs) {
    const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt))
    const jitter = Math.floor(Math.random() * 200)
    return exp + jitter
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

  _makeRequest(url, method, headers, signal) {
    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    const req = httpModule.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers
    })

    const onAbort = () => { req.destroy(); }
    signal.addEventListener('abort', onAbort, { once: true })

    return req
  }

  _readErrorBody(res, url, reject) {
    let errorBody = ''
    res.on('data', chunk => { errorBody += chunk })
    res.on('end', () => {
      const detail = `[${res.statusCode}] ${url.hostname}${url.pathname}`
      console.error('[AI] API error', detail, errorBody.substring(0, 500))
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
        const e = new Error(`${detail}: ${msg}`)
        e.httpStatus = res.statusCode
        e.apiHost = url.hostname
        e.apiPath = url.pathname
        reject(e)
      } catch {
        const msg = errorBody.substring(0, 200)
        const e = new Error(`${detail}: ${msg}`)
        e.httpStatus = res.statusCode
        e.apiHost = url.hostname
        e.apiPath = url.pathname
        reject(e)
      }
    })
  }

  async _executeTool(name, args, sender, sessionId, toolCallId = '') {
    if (!this.toolRegistry) {
      return { error: `工具系统未初始化` }
    }
    // Route MCP tools to MCP manager
    if (name.startsWith('mcp__') && this.mcpManager) {
      return await this.mcpManager.callTool(name, args)
    }
    const tool = this.toolRegistry.getTool(name)
    if (!tool) {
      return { error: `未知工具: ${name}` }
    }

    // 身份文件路径兜底：避免 AI 把 IDENTITY/SOUL 写到 /tmp 等错误目录
    if (name === 'file_operation' && args && typeof args.path === 'string') {
      const rawPath = String(args.path || '').trim()
      const normalized = rawPath.replace(/\\/g, '/').toLowerCase()
      const isIdentityTarget = normalized.endsWith('/identity.md') || normalized === 'identity.md'
      const isSoulTarget = normalized.endsWith('/soul.md') || normalized === 'soul.md'
      if (isIdentityTarget) {
        args = { ...args, path: getAppRootPath('IDENTITY.md') }
      } else if (isSoulTarget) {
        args = { ...args, path: getAppRootPath('SOUL.md') }
      }
    }

    // 强制注入项目路径，避免 AI 遗漏或填错
    // 注意：__main_chat__/__feishu__/__gateway__ 是会话标识，不是实际文件系统路径
    const session = this.activeSessions.get(sessionId)
    const projectPath = String(session?.projectPath || '').trim()
    const hasRealProjectPath = !!projectPath && !projectPath.startsWith('__') && path.isAbsolute(projectPath)
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
      if (name === 'file_operation' && args.path && !args.path.startsWith('/')) {
        args = { ...args, path: `${projectPath}/${args.path}` }
      }
      if (name === 'analyze_project' && !args.projectPath && !args.project_path) {
        args = { ...args, projectPath }
      }
    } else if (name === 'file_operation' && args.path && !args.path.startsWith('/')) {
      // 无真实项目路径时，默认将相对路径落到统一 workspace 根目录
      args = { ...args, path: path.join(defaultWorkspaceCwd, args.path) }
    }
    // 飞书会话下调用 feishu_send_message 时，未传 chat_id 则使用当前会话的 chat_id（用户在本会话发消息，回复应回同一会话）
    if (name === 'feishu_send_message' && session?.feishuChatId && !(args && args.chat_id && String(args.chat_id).trim())) {
      args = { ...args, chat_id: session.feishuChatId }
    }

    return await tool.execute(args, {
      sender,
      sessionId,
      projectPath,
      toolCallId,
      channel: session?.feishuChatId ? 'feishu' : 'main',
      remoteId: session?.feishuChatId || '',
      feishuChatId: session?.feishuChatId || ''
    })
  }
}

module.exports = { Orchestrator }
