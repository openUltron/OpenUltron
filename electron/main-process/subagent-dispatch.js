/**
 * sessions_spawn：internal / 外部 CLI 子 Agent 派发、上下文拼接与超时封装
 */

const { buildExecutionEnvelope } = require('../ai/execution-envelope')
const { buildWebAppStudioDelegateCallerBlock } = require('../ai/webapp-studio-context')
const { getSubagentOrchestration } = require('../openultron-config')
const spawnReg = require('../ai/subagent-spawn-registry')
const { resolveAgentProfile, isProfileAllowed } = require('../ai/agent-profile')
const { sanitizeInjectedSystemPrompt } = require('../ai/system-prompt-guard')

/** @param {object} deps — 见 main.js 原 createSubagentDispatch 调用处 */
function createSubagentDispatch(deps) {
  const {
    path,
    fs,
    getWorkspaceRoot,
    runCliCommand,
    normalizeExternalLogChunk,
    isExternalNetworkTimeoutChunk,
    getExternalEnvVariants,
    appLogger,
    findRecentPageTarget,
    conversationFile,
    getAssistantText,
    getResolvedAIConfigForProvider,
    getResolvedAIConfig,
    aiOrchestrator,
    getToolsForSubChat,
    extractLatestVisibleText,
    stripToolProtocolAndJsonNoise,
    looksLikeNoResultPlaceholderText,
    resolveCapabilityRoute,
    detectRequestedExternalRuntime,
    scanExternalSubAgents,
    EXTERNAL_SUBAGENT_SPECS,
    sessionRegistry,
    eventBus
  } = deps

  let preferredExternalRuntime = null

  function normalizeRuntimeToken(token = '') {
    const t = String(token || '').trim().toLowerCase()
    if (!t || t === 'internal' || t === 'auto') return t
    if (t === 'gateway_cli') return 'gateway'
    const spec = EXTERNAL_SUBAGENT_SPECS.find((s) =>
      String(s.id).toLowerCase() === t ||
      (Array.isArray(s.aliases) && s.aliases.map((a) => String(a).toLowerCase()).includes(t))
    )
    return spec ? String(spec.id).toLowerCase() : t
  }

  function dedupeList(base = []) {
    const uniq = []
    const seen = new Set()
    for (const id of base) {
      const token = String(id || '').trim().toLowerCase()
      if (!token || seen.has(token)) continue
      seen.add(token)
      uniq.push(token)
    }
    return uniq
  }

  function resolveRequestedRuntime(input = '') {
    const token = normalizeRuntimeToken(input)
    if (!token) return ''
    if (token === 'internal' || token === 'auto') return token
    return `external:${token}`
  }

  function setPreferredExternalRuntime(rawRuntime = '') {
    const raw = String(rawRuntime || '').trim()
    if (!raw.startsWith('external:')) return
    const token = normalizeRuntimeToken(raw.slice('external:'.length))
    if (token && token !== 'internal' && token !== 'auto') {
      preferredExternalRuntime = token
    }
  }

  function buildSubAgentDeliveryPrompt(projectPath = '') {
    return [
      '[产物回传规则]',
      '子 Agent 只负责执行与产出，不直接向外部渠道发送消息。',
      '严禁调用任何 send_message 类工具或 IM 发送接口（例如 feishu_send_message / telegram_send_message / dingtalk_send_message / lark.im_v1_message_create）。',
      '当任务产出图片/截图/文件时，返回：产物绝对路径 + 简洁执行结论。',
      '是否对外发送由主 Agent 统一处理。',
      '若任务涉及实现功能、改代码或改页面：最后一轮**必须用自然语言**说明是否已按需求完成、改了哪些路径/文件、如何验证（例如打开哪个路由/入口）；禁止在仅改文件后无说明就结束，否则主会话无法向用户交代。'
    ].join('\n')
  }

  function normalizeSystemPromptSource(source) {
    const raw = String(source || '').trim()
    if (!raw) return 'unknown'
    return raw.replace(/[^a-z0-9._:-]/gi, '_').slice(0, 80)
  }

  function stripSystemPromptStamp(text = '') {
    const v = String(text || '')
    if (!v.startsWith('[子系统注入提示]')) return v
    const markerEnd = v.indexOf('\n')
    if (markerEnd < 0) return ''
    return v.slice(markerEnd + 1)
  }

  function buildExternalPrompt({ task, systemPrompt, roleName, projectPath, channelProjectPath, systemPromptSource = 'unknown' }) {
    const blocks = []
    if (roleName) blocks.push(`角色：${roleName}`)
    if (systemPrompt) blocks.push(`系统约束：\n${systemPrompt}`)
    blocks.push(buildSubAgentDeliveryPrompt(channelProjectPath || projectPath))
    if (projectPath) blocks.push(`工作目录：${projectPath}`)
    blocks.push(`任务：\n${task}`)
    blocks.push('请直接输出最终答案，不要输出工具调用 XML。')
    return blocks.join('\n\n')
  }

  async function runByExternalSubAgent(spec, ctx, resolvedCommand = '', heartbeat = null, onLog = null) {
    const systemPromptSource = normalizeSystemPromptSource(ctx.systemPromptSource)
    const rawProjectPath = String(ctx.projectPath || '').trim()
    const cwd = (rawProjectPath && path.isAbsolute(rawProjectPath) && fs.existsSync(rawProjectPath))
      ? rawProjectPath
      : getWorkspaceRoot()
    const prompt = buildExternalPrompt({ ...ctx, projectPath: cwd, channelProjectPath: rawProjectPath, systemPromptSource })
    const command = String(resolvedCommand || spec.command || '').trim() || spec.command
    const timeoutMs = 180000
    const attempts = []
    const builders = Array.isArray(spec.runArgBuilders) ? spec.runArgBuilders : []
    const envVariants = getExternalEnvVariants(spec.id)
    for (let idx = 0; idx < builders.length; idx++) {
      const buildArgs = builders[idx]
      const args = buildArgs(prompt)
      for (let v = 0; v < envVariants.length; v++) {
        const envVariant = envVariants[v]
        try { if (typeof onLog === 'function') onLog({ type: 'meta', text: `cmd=${command} ${args.join(' ')}`, mode: envVariant.mode, attempt: `${idx + 1}/${builders.length}` }) } catch (_) {}
        console.log('[SubAgentDispatch] 外部子Agent执行尝试', `external:${spec.id}`, `attempt=${idx + 1}/${builders.length}`, `mode=${envVariant.mode}`, `cmd=${command}`, `cwd=${cwd}`, `timeoutMs=${timeoutMs}`)
        console.log('[SubAgentDispatch] 外部子Agent提示工作目录', `external:${spec.id}`, cwd)
        try {
          appLogger?.info?.('[SubAgentDispatch] 外部子Agent执行尝试', {
            runtime: `external:${spec.id}`,
            attempt: idx + 1,
            total: builders.length,
            mode: envVariant.mode,
            command,
            cwd,
            systemPromptSource,
            rawProjectPath,
            argsPreview: args.map((x) => String(x)).slice(0, 4)
          })
        } catch (_) {}
        const r = await runCliCommand(command, args, {
          cwd,
          timeoutMs,
          env: envVariant.env,
          shouldAbort: (stderrChunk) => isExternalNetworkTimeoutChunk(stderrChunk),
          onStdout: (chunk) => {
            const line = normalizeExternalLogChunk(chunk)
            if (!line) return
            console.log(`[SubAgentExternal][${spec.id}][${envVariant.mode}][stdout] ${line}`)
            try { appLogger?.info?.(`[SubAgentExternal][${spec.id}][${envVariant.mode}][stdout] ${line}`) } catch (_) {}
            try { if (typeof onLog === 'function') onLog({ type: 'stdout', text: String(chunk || ''), mode: envVariant.mode }) } catch (_) {}
          },
          onStderr: (chunk) => {
            const line = normalizeExternalLogChunk(chunk)
            if (!line) return
            console.warn(`[SubAgentExternal][${spec.id}][${envVariant.mode}][stderr] ${line}`)
            try { appLogger?.warn?.(`[SubAgentExternal][${spec.id}][${envVariant.mode}][stderr] ${line}`) } catch (_) {}
            try { if (typeof onLog === 'function') onLog({ type: 'stderr', text: String(chunk || ''), mode: envVariant.mode }) } catch (_) {}
          }
        })
        const output = String(r.stdout || r.stderr || '').trim()
        const errout = String(r.stderr || '').trim()
        if (!r.success) {
          console.warn('[SubAgentDispatch] 外部子Agent单次尝试失败', `external:${spec.id}`, `mode=${envVariant.mode}`, `exit=${r.exitCode}`, `error=${r.error || ''}`, `stderr=${errout.slice(-300)}`)
          try { if (typeof onLog === 'function') onLog({ type: 'meta', text: `attempt failed: mode=${envVariant.mode} exit=${r.exitCode} error=${r.error || ''}` }) } catch (_) {}
        }
        try { if (typeof heartbeat === 'function') heartbeat({ event: 'attempt_done', success: !!r.success, exitCode: r.exitCode, error: r.error || '' }) } catch (_) {}
        attempts.push({
          args,
          mode: envVariant.mode,
          success: !!r.success,
          exitCode: r.exitCode,
          error: r.error || '',
          stderr: errout.slice(-300)
        })
        if (r.success && output) {
          try { if (typeof onLog === 'function') onLog({ type: 'meta', text: `attempt success: mode=${envVariant.mode} exit=${r.exitCode}` }) } catch (_) {}
          return {
            success: true,
            result: output,
            runtime: `external:${spec.id}`,
            systemPromptSource,
            messages: [{ role: 'assistant', content: output }],
            attempts
          }
        }
      }
    }
    const last = attempts[attempts.length - 1] || {}
    const msg = last.error || last.stderr || `外部子 Agent ${spec.id} 执行失败`
    try { if (typeof onLog === 'function') onLog({ type: 'meta', text: `all attempts failed: ${msg}` }) } catch (_) {}
    return { success: false, error: msg, runtime: `external:${spec.id}`, systemPromptSource, attempts }
  }

  function resolveRuntimeChain(runtime, availableExternalIds, preferenceOrder = []) {
    const extIds = dedupeList(availableExternalIds || [])
    const normalized = String(runtime || '').trim().toLowerCase()
    const normalizedPreference = dedupeList(preferenceOrder).map((item) => normalizeRuntimeToken(item))
      .filter((item) => item && item !== 'internal' && item !== 'auto')
      .filter((item) => extIds.includes(item))
    const pickAutoChain = (base = []) => {
      const ordered = normalizedPreference.slice()
      const rest = base.filter((id) => !ordered.includes(id))
      return dedupeList([...ordered, ...rest])
    }
    if (!normalized) return ['internal']
    if (normalized === 'auto') {
      const chain = pickAutoChain(extIds)
      const preferred = normalizeRuntimeToken(preferredExternalRuntime)
      if (preferred && chain.includes(preferred)) {
        chain.splice(chain.indexOf(preferred), 1)
        chain.unshift(preferred)
      }
      return chain.length ? [...chain, 'internal'] : ['internal']
    }
    if (normalized === 'internal') return ['internal']
    if (normalized === 'external') return [...pickAutoChain(extIds), 'internal']
    if (normalized.startsWith('external:')) {
      const pick = normalizeRuntimeToken(normalized.slice('external:'.length).trim())
      if (!pick) return ['internal']
      return [pick, 'internal']
    }
    const pick = normalizeRuntimeToken(normalized)
    if (extIds.includes(pick)) {
      return [pick, 'internal']
    }
    return ['internal']
  }

  function inferPreferredExternalRuntimeFromText(text = '') {
    return detectRequestedExternalRuntime(text)
  }

  function buildDelegatedTaskWithParentContext(task = '', { projectPath = '', parentSessionId = '' } = {}) {
    const rawTask = String(task || '').trim()
    if (!rawTask || !parentSessionId || !projectPath) return rawTask
    try {
      const lines = []
      const target = findRecentPageTarget(projectPath, parentSessionId)
      if (target && target.kind === 'file' && target.value) {
        lines.push(`最近网页文件: ${target.value}`)
      } else if (target && target.kind === 'url' && target.value) {
        lines.push(`最近网页URL: ${target.value}`)
      }
      const projectKey = conversationFile.hashProjectPath(projectPath)
      const conv = conversationFile.loadConversation(projectKey, parentSessionId)
      const msgs = Array.isArray(conv?.messages) ? conv.messages : []
      const recent = msgs
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(-6)
        .map((m) => {
          const txt = m.role === 'assistant' ? getAssistantText(m) : String(m.content || '')
          const oneLine = String(txt || '').replace(/\s+/g, ' ').trim()
          if (!oneLine) return ''
          return `${m.role === 'user' ? '用户' : '助手'}: ${oneLine.slice(0, 180)}`
        })
        .filter(Boolean)
      if (recent.length > 0) {
        lines.push('最近对话:')
        lines.push(...recent)
      }
      if (lines.length === 0) return rawTask
      return `${rawTask}\n\n[主会话上下文]\n${lines.map((x) => `- ${x}`).join('\n')}`
    } catch (_) {
      return rawTask
    }
  }

  async function runByInternalSubAgent({ task, systemPrompt, systemPromptSource, roleName, model, projectPath, provider, eventSink, feishuChatId, feishuTenantKey, feishuDocHost, feishuSenderOpenId, feishuSenderUserId, capability, webappStudioDelegate, parentSessionIdForDelegate, profileResolved, subagentMinimalMemory, inheritIdentityFromProfile }, subSessionId) {
    const normalizedSystemPromptSource = normalizeSystemPromptSource(systemPromptSource)
    const messages = []
    const rolePrompt = roleName && String(roleName).trim()
      ? `你当前扮演的角色是「${String(roleName).trim()}」。请按该角色完成任务，并仅输出该角色应给出的结果。`
      : ''
    const capabilityPrompt = capability === 'docs'
      ? '本任务属于飞书文档写作/修改能力。请优先调用文档能力工具（feishu_doc_capability 或可用的 lark docx 工具）执行真实创建/修改；不要只返回纯文本草稿。完成后返回文档链接/ID与变更摘要。'
      : ''
    const delegateBlock = webappStudioDelegate && parentSessionIdForDelegate
      ? buildWebAppStudioDelegateCallerBlock(parentSessionIdForDelegate)
      : ''
    const deliveryPrompt = buildSubAgentDeliveryPrompt(projectPath || '')
    const pr = profileResolved && typeof profileResolved === 'object' ? profileResolved : null
    const profileExtra = pr && String(pr.prompt || '').trim() ? String(pr.prompt).trim() : ''
    const mergedSystemPrompt = [delegateBlock, rolePrompt, capabilityPrompt, systemPrompt && String(systemPrompt).trim() ? String(systemPrompt).trim() : '', profileExtra, deliveryPrompt]
      .filter(Boolean)
      .join('\n\n')
    if (mergedSystemPrompt) messages.push({ role: 'system', content: mergedSystemPrompt })
    messages.push({ role: 'user', content: String(task || '').trim() })

    let resolvedConfig = null
    if (provider != null && String(provider).trim() !== '') {
      resolvedConfig = getResolvedAIConfigForProvider(String(provider).trim())
      if (!resolvedConfig) {
        return { success: false, error: `未找到或未配置该供应商的 API Key: ${provider}`, subSessionId, runtime: 'internal' }
      }
    }
    if (!resolvedConfig) resolvedConfig = getResolvedAIConfig()
    if (pr && pr.max_turns > 0) {
      resolvedConfig = { ...resolvedConfig, maxToolIterations: pr.max_turns }
    }
    let pickModel = model
    if ((pickModel == null || String(pickModel).trim() === '') && pr && pr.model && String(pr.model).trim()) {
      pickModel = String(pr.model).trim()
    }
    if (pickModel != null && String(pickModel).trim() !== '') {
      const pick = String(pickModel).trim()
      const pool = Array.isArray(resolvedConfig.modelPool)
        ? resolvedConfig.modelPool.map(x => String(x || '').trim()).filter(Boolean)
        : []
      if (pool.length > 0 && !pool.includes(pick)) {
        return { success: false, error: `模型 ${pick} 不在全局模型池中`, subSessionId, runtime: 'internal' }
      }
      if ((provider == null || String(provider).trim() === '') && resolvedConfig.modelBindings && resolvedConfig.modelBindings[pick]) {
        const byModelProvider = getResolvedAIConfigForProvider(resolvedConfig.modelBindings[pick])
        if (byModelProvider) resolvedConfig = { ...byModelProvider, defaultModel: pick }
      }
    }

    const pp = projectPath && String(projectPath).trim() ? String(projectPath).trim() : '__main_chat__'
    const result = await aiOrchestrator.startChat({
      sessionId: subSessionId,
      messages,
      model: pickModel && String(pickModel).trim() ? String(pickModel).trim() : undefined,
      tools: getToolsForSubChat({ projectPath: pp, profile: pr }),
      sender: eventSink || null,
      config: resolvedConfig,
      projectPath: pp,
      panelId: undefined,
      feishuChatId: feishuChatId && String(feishuChatId).trim() ? String(feishuChatId).trim() : undefined,
      feishuTenantKey: feishuTenantKey && String(feishuTenantKey).trim() ? String(feishuTenantKey).trim() : undefined,
      feishuDocHost: feishuDocHost && String(feishuDocHost).trim() ? String(feishuDocHost).trim() : undefined,
      feishuSenderOpenId: feishuSenderOpenId && String(feishuSenderOpenId).trim() ? String(feishuSenderOpenId).trim() : undefined,
      feishuSenderUserId: feishuSenderUserId && String(feishuSenderUserId).trim() ? String(feishuSenderUserId).trim() : undefined,
      subagentMinimalMemory: !!subagentMinimalMemory,
      inheritIdentityFromProfile: !!inheritIdentityFromProfile,
      allowChannelSend: false
    })
    if (!result.success) {
      return { success: false, error: result.error || '子 Agent 执行失败', subSessionId, runtime: 'internal' }
    }
    const msgs = result.messages || []
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant' && m.content != null)
    let resultText = ''
    if (lastAssistant && lastAssistant.content) {
      if (typeof lastAssistant.content === 'string') resultText = lastAssistant.content.trim()
      else if (Array.isArray(lastAssistant.content)) resultText = lastAssistant.content.map(c => (c && c.text) || '').join('').trim()
    }
    if (!resultText) {
      const visible = String(extractLatestVisibleText(msgs) || '').trim()
      resultText = stripToolProtocolAndJsonNoise(visible, { dropJsonEnvelope: true }).trim()
    }
    if (looksLikeNoResultPlaceholderText(resultText)) resultText = ''
    if (!String(resultText || '').trim()) {
      try {
        appLogger?.warn?.('[SubAgentDispatch] internal 子 Agent 无最终 assistant 文本，主会话将依赖 envelope.summary / commandLogs', {
          subSessionId,
          lastMsgRoles: msgs.slice(-6).map((m) => m && m.role).filter(Boolean)
        })
      } catch (_) {}
    }
    return { success: true, result: resultText, subSessionId, messages: msgs, runtime: 'internal', systemPromptSource: normalizedSystemPromptSource }
  }

  async function runSubChat(opts) {
    const {
      task,
      systemPrompt,
      systemPromptSource: rawSystemPromptSource,
      roleName,
      model,
      projectPath,
      provider,
      runtime,
      parentSessionId,
      parentRunId,
      feishuChatId,
      feishuTenantKey,
      feishuDocHost,
      feishuSenderOpenId,
      feishuSenderUserId,
      stream,
      webappStudioDelegate,
      profile,
      agent,
      waitForResult = true
    } = opts || {}
    const subSessionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const parentRun = String(parentRunId || '').trim()
    const pp0 = (projectPath != null && String(projectPath).trim() !== '')
      ? String(projectPath).trim()
      : '__main_chat__'
    const subOrc = getSubagentOrchestration()
    const profileId = String(profile || agent || 'executor').trim() || 'executor'
    const profileResolved = resolveAgentProfile(profileId, pp0) || resolveAgentProfile('executor', pp0)
    if (!isProfileAllowed(profileId, subOrc.allowedProfiles)) {
      const systemPromptSource = normalizeSystemPromptSource(rawSystemPromptSource)
      const err = `子 Agent profile 不在允许列表: ${profileId}`
      return {
        success: false,
        error: err,
        subSessionId,
        parentRunId: parentRun || undefined,
        systemPromptSource,
        envelope: buildExecutionEnvelope({
          success: false,
          error: err,
          subSessionId,
          parentRunId: parentRun || undefined,
          systemPromptSource
        }, 'internal')
      }
    }
    const nest = spawnReg.validateNestedSpawnEligibility(parentSessionId || '', subOrc)
    if (!nest.ok) {
      const systemPromptSource = normalizeSystemPromptSource(rawSystemPromptSource)
      return {
        success: false,
        error: nest.error,
        subSessionId,
        parentRunId: parentRun || undefined,
        systemPromptSource,
        envelope: buildExecutionEnvelope({
          success: false,
          error: nest.error,
          subSessionId,
          parentRunId: parentRun || undefined,
          systemPromptSource
        }, 'internal')
      }
    }
    if (waitForResult === false && subOrc.allowAsyncSpawn === false) {
      const systemPromptSource = normalizeSystemPromptSource(rawSystemPromptSource)
      const err = '异步 spawn 未启用（请在 openultron.json 将 subagentOrchestration.allowAsyncSpawn 设为 true）'
      return {
        success: false,
        error: err,
        subSessionId,
        parentRunId: parentRun || undefined,
        systemPromptSource,
        envelope: buildExecutionEnvelope({
          success: false,
          error: err,
          subSessionId,
          parentRunId: parentRun || undefined,
          systemPromptSource
        }, 'internal')
      }
    }
    const slot = spawnReg.acquireSpawnSlot(parentSessionId || '', subOrc)
    if (!slot.ok) {
      const msg = slot.reason === 'subagent_global_concurrent_cap' ? '子 Agent 全局并发已达上限' : '当前会话子 Agent 数量已达上限'
      const systemPromptSource = normalizeSystemPromptSource(rawSystemPromptSource)
      return {
        success: false,
        error: msg,
        subSessionId,
        parentRunId: parentRun || undefined,
        systemPromptSource,
        envelope: buildExecutionEnvelope({
          success: false,
          error: msg,
          subSessionId,
          parentRunId: parentRun || undefined,
          commandLogs: [],
          systemPromptSource
        }, 'internal')
      }
    }
    spawnReg.registerSubagentSpawn(parentSessionId || '', subSessionId, profileId)
    const useMinimalMem = subOrc.subagentMinimalMemory && !(profileResolved && profileResolved.inherit_identity)
    const inheritIdentityFromProfile = !!(profileResolved && profileResolved.inherit_identity)
    const subagentAsyncOutcomes = require('../ai/subagent-async-outcomes')
    const runSubChatBody = async () => {
      const systemPromptSource = normalizeSystemPromptSource(rawSystemPromptSource)
      const sanitized = sanitizeInjectedSystemPrompt(systemPrompt, { source: systemPromptSource })
      if (!sanitized.ok) {
        const err = sanitized.error || 'system_prompt 无效或被拦截'
        return {
          success: false,
          error: err,
          subSessionId,
          parentRunId: parentRun || undefined,
          systemPromptSource,
          envelope: buildExecutionEnvelope({
            success: false,
            error: err,
            subSessionId,
            parentRunId: parentRun || undefined,
            commandLogs: [`[meta] sub-agent system_prompt blocked source=${systemPromptSource}`],
            systemPromptSource
          }, 'internal')
        }
      }
      const finalSystemPrompt = sanitized.value
      const sanitizedSystemPrompt = stripSystemPromptStamp(finalSystemPrompt || '')
    const route = resolveCapabilityRoute({ text: String(task || ''), runtime: String(runtime || '') }, appLogger)
    let delegatedTask = buildDelegatedTaskWithParentContext(task, {
      projectPath: pp0,
      parentSessionId: parentSessionId || ''
    })
    if (route.capability === 'docs') {
      delegatedTask = `${delegatedTask}\n\n[能力约束]\n- 本任务为飞书文档写作/修改任务。\n- 必须优先调用文档能力工具（feishu_doc_capability 或可用 lark docx 工具）执行真实写入。\n- 最终返回文档链接/ID与变更摘要。`
    }
    const commandLogLines = []
    const pushCommandLog = (line) => {
      const text = String(line || '').replace(/\r/g, '').trim()
      if (!text) return
      const rows = text.split('\n').map(x => x.trim()).filter(Boolean)
      for (const r of rows) commandLogLines.push(r)
      if (commandLogLines.length > 2000) commandLogLines.splice(0, commandLogLines.length - 2000)
    }
    const emitPartial = () => {
      if (!stream || typeof stream.sendToolResult !== 'function') return
      const tail = commandLogLines.slice(-240).join('\n')
      stream.sendToolResult({
        running: true,
        partial: true,
        stdout: tail,
        log_lines: commandLogLines.slice(-240),
        line_count: commandLogLines.length
      })
    }
    pushCommandLog(`[meta] sub-agent started runtime=${runtime || 'auto'} effective_pending`)
    if (parentRun) pushCommandLog(`[meta] parent_run_id=${parentRun}`)
    emitPartial()
    const appendToolResultLine = (name, rawResult) => {
      const n = String(name || '').trim() || 'tool'
      const s = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult || {})
      if (!s) return
      try {
        const obj = JSON.parse(s)
        let out = ''
        if (obj.stdout != null) out += String(obj.stdout)
        if (obj.stderr != null) out += (out ? '\n' : '') + String(obj.stderr)
        if (!out && obj.result != null) out = String(obj.result)
        if (!out && obj.error != null) out = `ERROR: ${String(obj.error)}`
        if (!out) out = s
        pushCommandLog(`[${n}] ${String(out).replace(/\s+/g, ' ').trim()}`)
        return
      } catch (_) {}
      pushCommandLog(`[${n}] ${String(s).replace(/\s+/g, ' ').trim()}`)
    }
    const userRuntime = String(runtime || '').trim()
    const routeFromRuntime = resolveCapabilityRoute({ text: String(task || ''), runtime: userRuntime || '' }, appLogger)
    let effectiveRuntime = userRuntime
    if (!effectiveRuntime || effectiveRuntime.toLowerCase() === 'auto') {
      const inferred = routeFromRuntime.externalRuntime || inferPreferredExternalRuntimeFromText([task, sanitizedSystemPrompt, roleName].filter(Boolean).join('\n'))
      effectiveRuntime = inferred || 'auto'
    }
    const normalizedForChain = resolveRequestedRuntime(effectiveRuntime)
    effectiveRuntime = normalizedForChain || effectiveRuntime || 'auto'
    const shouldReportAutoFallback = subOrc.reportAutoFallback !== false
    pushCommandLog(`[meta] effective_runtime=${effectiveRuntime || 'internal'}`)
    emitPartial()
    const scan = await scanExternalSubAgents(false)
    const availableExternal = scan.filter(a => a.available)
    const availableExternalIds = availableExternal.map(a => a.id)
    const availableExternalById = new Map(availableExternal.map(a => [a.id, a]))
    const runtimeChain = resolveRuntimeChain(normalizedForChain, availableExternalIds, subOrc.externalRuntimePreference)
    const attemptErrors = []
    const SUBAGENT_RUN_TIMEOUT_MS = 1800000
    const runCore = async () => {
      try {
        sessionRegistry.markRunning(subSessionId, {
          projectPath: projectPath || '__main_chat__',
          projectName: 'sub-agent',
          model: effectiveRuntime || 'auto',
          sender: null,
          abortController: null
        })
        sessionRegistry.updateProgress(subSessionId, {
          phase: 'tool_running',
          progress: 8,
          last_action: `子Agent准备执行（${effectiveRuntime || 'auto'}）`,
          eta: null
        })
      } catch (_) {}
      try {
        appLogger?.info?.('[SubAgentDispatch] 开始派发子Agent', {
          subSessionId,
          parentRunId: parentRun || undefined,
          requestedRuntime: userRuntime || 'auto',
          effectiveRuntime: effectiveRuntime || 'auto',
          capability: routeFromRuntime.capability || 'general',
          deliveryPolicy: routeFromRuntime.deliveryPolicy || 'defer',
          riskLevel: routeFromRuntime.riskLevel || 'safe',
          runtimeChain,
          availableExternalIds,
          taskPreview: String(task || '').slice(0, 120)
        })
        appLogger?.info?.(`[SubAgentDispatch] runtime=${effectiveRuntime || 'auto'} chain=${runtimeChain.join('>')} available=${availableExternalIds.join(',') || 'none'}`)
        console.log('[SubAgentDispatch] runtime=', effectiveRuntime || 'auto', 'chain=', runtimeChain.join('>'), 'available=', availableExternalIds.join(',') || 'none')
        if ((effectiveRuntime || 'auto') === 'auto' && availableExternalIds.length === 0 && shouldReportAutoFallback) {
          console.warn('[SubAgentDispatch] auto 模式下无可用外部子Agent，将使用 internal')
          pushCommandLog('[meta] auto 模式无可用外部子 Agent，已回退 internal')
        }
        if (shouldReportAutoFallback && effectiveRuntime.startsWith('external:') && runtimeChain[0] !== effectiveRuntime.slice('external:'.length)) {
          console.warn('[SubAgentDispatch] 指定外部子Agent不可用，将按回退链执行', effectiveRuntime, runtimeChain.join('>'))
          pushCommandLog(`[meta] 指定外部子 Agent 不可用，按回退链执行: ${runtimeChain.join(' > ')}`)
        }
      } catch (_) {}

      for (const rt of runtimeChain) {
        try {
          if (rt === 'internal') {
            pushCommandLog('[meta] attempt internal started')
            emitPartial()
            try {
              sessionRegistry.updateProgress(subSessionId, {
                phase: 'tool_running',
                progress: 25,
                last_action: '回退到 internal 执行',
                eta: null
              })
              if (parentSessionId) {
                sessionRegistry.updateProgress(parentSessionId, {
                  phase: 'tool_running',
                  progress: 20,
                  last_action: '子Agent回退到 internal 执行',
                  eta: null
                })
              }
            } catch (_) {}
            const internalEventSink = {
              send: (channel, data) => {
                try {
                  if (channel === 'ai-chat-tool-call') {
                    const nm = data?.toolCall?.name || ''
                    const argsPreview = String(data?.toolCall?.arguments || '').slice(0, 240)
                    pushCommandLog(`[tool_call] ${nm}${argsPreview ? ` ${argsPreview}` : ''}`)
                    emitPartial()
                  } else if (channel === 'ai-chat-tool-result') {
                    appendToolResultLine(data?.name || '', data?.result)
                    emitPartial()
                  } else if (channel === 'ai-chat-token') {
                    const tok = String(data?.token || '').trim()
                    if (tok) {
                      pushCommandLog(`[token] ${tok.slice(0, 120)}`)
                      emitPartial()
                    }
                  }
                } catch (_) {}
              }
            }
            const out = await runByInternalSubAgent({
              task: delegatedTask,
              systemPrompt: finalSystemPrompt,
              roleName,
              model,
              systemPromptSource,
              capability: routeFromRuntime.capability || 'general',
              projectPath,
              provider,
              eventSink: internalEventSink,
              feishuChatId,
              feishuTenantKey,
              feishuDocHost,
              feishuSenderOpenId,
              feishuSenderUserId,
              webappStudioDelegate: webappStudioDelegate === true,
              parentSessionIdForDelegate: parentSessionId || '',
              profileResolved,
              subagentMinimalMemory: useMinimalMem,
              inheritIdentityFromProfile
            }, subSessionId)
            if (out.success) {
              pushCommandLog('[meta] attempt internal success')
              emitPartial()
              try { sessionRegistry.markComplete(subSessionId) } catch (_) {}
              try {
                appLogger?.info?.('[SubAgentDispatch] 子Agent执行成功', {
                  subSessionId,
                  parentRunId: parentRun || undefined,
                  runtime: 'internal',
                  attemptedRuntimes: runtimeChain.slice(0, attemptErrors.length + 1)
                })
              } catch (_) {}
              return {
                ...out,
                parentRunId: parentRun || undefined,
                subSessionId,
                commandLogs: [...commandLogLines],
                attemptedRuntimes: runtimeChain.slice(0, attemptErrors.length + 1),
                envelope: buildExecutionEnvelope(
                  {
                  success: true,
                  result: out.result,
                  commandLogs: [...commandLogLines],
                  subSessionId,
                  parentRunId: parentRun || undefined,
                  attemptedRuntimes: runtimeChain.slice(0, attemptErrors.length + 1),
                  runtime: out.runtime || 'internal',
                  systemPromptSource
                },
                out.runtime || 'internal'
              )
            }
            }
            pushCommandLog(`[meta] attempt internal failed: ${out.error || '执行失败'}`)
            emitPartial()
            try {
              appLogger?.warn?.('[SubAgentDispatch] 子Agent执行失败，将尝试回退', {
                subSessionId,
                runtime: 'internal',
                error: out.error || '执行失败'
              })
            } catch (_) {}
            attemptErrors.push(`[internal] ${out.error || '执行失败'}`)
            try {
              sessionRegistry.updateProgress(subSessionId, {
                phase: 'tool_running',
                progress: 24,
                last_action: `internal失败，准备重试: ${String(out.error || '执行失败').slice(0, 120)}`,
                eta: null
              })
            } catch (_) {}
            continue
          }
          const spec = EXTERNAL_SUBAGENT_SPECS.find(s => s.id === rt)
          if (!spec || !availableExternalIds.includes(rt)) {
            pushCommandLog(`[meta] attempt external:${rt} skipped: unavailable`)
            emitPartial()
            try {
              appLogger?.warn?.('[SubAgentDispatch] 外部子Agent不可用，跳过', {
                subSessionId,
                runtime: `external:${rt}`
              })
            } catch (_) {}
            attemptErrors.push(`[external:${rt}] 不可用（未安装或不可执行）`)
            continue
          }
          const found = availableExternalById.get(rt)
          const resolvedCommand = found && found.path ? String(found.path).trim() : ''
          const extStart = Date.now()
          let beatTimer = null
          const heartbeat = (evt = {}) => {
            const elapsed = Math.max(0, Math.floor((Date.now() - extStart) / 1000))
            const txt = evt && evt.event === 'attempt_done'
              ? `子Agent(${rt})尝试结束，exit=${evt.exitCode}${evt.success ? '' : `，${evt.error || '失败'}`}`
              : `子Agent(${rt})执行中，已运行 ${elapsed}s`
            try {
              sessionRegistry.updateProgress(subSessionId, {
                phase: 'tool_running',
                progress: Math.min(88, 18 + Math.floor(elapsed / 15) * 3),
                last_action: txt,
                eta: null
              })
              if (parentSessionId) {
                sessionRegistry.updateProgress(parentSessionId, {
                  phase: 'tool_running',
                  progress: Math.min(70, 12 + Math.floor(elapsed / 15) * 2),
                  last_action: txt,
                  eta: null
                })
              }
            } catch (_) {}
          }
          beatTimer = setInterval(() => heartbeat({ event: 'tick' }), 15000)
          heartbeat({ event: 'tick' })
          let out = null
          try {
            out = await runByExternalSubAgent(
              spec,
              { task: delegatedTask, systemPrompt: finalSystemPrompt, roleName, projectPath, systemPromptSource },
              resolvedCommand,
              heartbeat,
              (evt = {}) => {
                const tp = String(evt.type || 'meta')
                const mode = evt.mode ? `[${evt.mode}] ` : ''
                const txt = String(evt.text || '')
                pushCommandLog(`[${rt}][${tp}] ${mode}${txt}`)
                emitPartial()
              }
            )
          } finally {
            try { if (beatTimer) clearInterval(beatTimer) } catch (_) {}
          }
          if (out.success) {
            pushCommandLog(`[meta] attempt external:${rt} success`)
            emitPartial()
            try { sessionRegistry.markComplete(subSessionId) } catch (_) {}
            try { setPreferredExternalRuntime(out.runtime || `external:${rt}`) } catch (_) {}
            try {
              appLogger?.info?.('[SubAgentDispatch] 子Agent执行成功', {
                subSessionId,
                parentRunId: parentRun || undefined,
                runtime: out.runtime || `external:${rt}`,
                attemptedRuntimes: runtimeChain.slice(0, attemptErrors.length + 1)
              })
            } catch (_) {}
            return {
              success: true,
              result: out.result || '',
              commandLogs: [...commandLogLines],
              subSessionId,
              parentRunId: parentRun || undefined,
              messages: out.messages || [],
              runtime: out.runtime,
              attemptedRuntimes: runtimeChain.slice(0, attemptErrors.length + 1),
              envelope: buildExecutionEnvelope(
                {
                  success: true,
                  result: out.result || '',
                  commandLogs: [...commandLogLines],
                  subSessionId,
                  parentRunId: parentRun || undefined,
                  attemptedRuntimes: runtimeChain.slice(0, attemptErrors.length + 1),
                  runtime: out.runtime,
                  systemPromptSource: out.systemPromptSource || systemPromptSource
                },
                out.runtime || `external:${rt}`
              )
            }
          }
          pushCommandLog(`[meta] attempt external:${rt} failed: ${out.error || '执行失败'}`)
          emitPartial()
          try {
            const attemptSummary = Array.isArray(out.attempts)
              ? out.attempts.map((x, i) => ({
                i: i + 1,
                mode: x.mode || '',
                success: !!x.success,
                exitCode: x.exitCode,
                error: x.error || '',
                stderr: x.stderr || '',
                args: Array.isArray(x.args) ? x.args.slice(0, 4).map(v => String(v)) : []
              }))
              : []
            appLogger?.warn?.('[SubAgentDispatch] 外部子Agent执行失败，将尝试回退', {
              subSessionId,
              runtime: out.runtime || `external:${rt}`,
              error: out.error || '执行失败',
              attempts: attemptSummary
            })
            console.warn('[SubAgentDispatch] 外部子Agent失败并回退', out.runtime || `external:${rt}`, out.error || '执行失败', attemptSummary)
          } catch (_) {}
          attemptErrors.push(`[${out.runtime || `external:${rt}`}] ${out.error || '执行失败'}`)
          try {
            sessionRegistry.updateProgress(subSessionId, {
              phase: 'tool_running',
              progress: 24,
              last_action: `子Agent(${rt})失败，准备回退`,
              eta: null
            })
          } catch (_) {}
        } catch (e) {
          try {
            appLogger?.warn?.('[SubAgentDispatch] 子Agent执行异常，将尝试回退', {
              subSessionId,
              runtime: rt,
              error: e.message || String(e)
            })
          } catch (_) {}
          attemptErrors.push(`[${rt}] ${e.message || String(e)}`)
          try {
            sessionRegistry.updateProgress(subSessionId, {
              phase: 'tool_running',
              progress: 24,
              last_action: `子Agent(${rt})异常，准备回退: ${String(e.message || String(e)).slice(0, 120)}`,
              eta: null
            })
          } catch (_) {}
        }
      }

      try {
        appLogger?.error?.('[SubAgentDispatch] 子Agent派发失败', {
          subSessionId,
          parentRunId: parentRun || undefined,
          requestedRuntime: userRuntime || 'auto',
          effectiveRuntime: effectiveRuntime || 'auto',
          runtimeChain,
          errors: attemptErrors
        })
      } catch (_) {}
      try { sessionRegistry.markError(subSessionId, attemptErrors.join(' | ') || '子 Agent 执行失败') } catch (_) {}
      pushCommandLog(`[meta] sub-agent failed: ${attemptErrors.join(' | ') || '子 Agent 执行失败'}`)
      emitPartial()
      return {
        success: false,
        error: attemptErrors.join(' | ') || '子 Agent 执行失败',
        subSessionId,
        parentRunId: parentRun || undefined,
        commandLogs: [...commandLogLines],
        systemPromptSource,
        envelope: buildExecutionEnvelope(
          {
            success: false,
            error: attemptErrors.join(' | ') || '子 Agent 执行失败',
            commandLogs: [...commandLogLines],
            subSessionId,
            parentRunId: parentRun || undefined,
            systemPromptSource
          },
          'internal'
        )
      }
    }
    try {
      return await Promise.race([
        runCore(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('SUBAGENT_TIMEOUT')), SUBAGENT_RUN_TIMEOUT_MS))
      ])
    } catch (e) {
      if (e && e.message === 'SUBAGENT_TIMEOUT') {
        pushCommandLog('[meta] sub-agent run timeout')
        emitPartial()
        try { sessionRegistry.markError(subSessionId, '子 Agent 执行超时') } catch (_) {}
        return {
          success: false,
          error: '子 Agent 执行超时',
          subSessionId,
          parentRunId: parentRun || undefined,
          commandLogs: [...commandLogLines],
          systemPromptSource,
          envelope: buildExecutionEnvelope({
            success: false,
            error: '子 Agent 执行超时',
            commandLogs: [...commandLogLines],
            subSessionId,
            parentRunId: parentRun || undefined,
            systemPromptSource
          }, 'internal')
        }
      }
      throw e
    }
    }

    if (waitForResult === false && subOrc.allowAsyncSpawn !== false) {
      subagentAsyncOutcomes.markPending(subSessionId, {
        parentSessionId: parentSessionId || '',
        parentRunId: parentRun || undefined,
        taskPreview: String(task || '').slice(0, 200)
      })
      runSubChatBody()
        .then((out) => {
          try {
            if (eventBus && typeof eventBus.emitAsync === 'function') {
              eventBus.emitAsync('subagent.async.completed', {
                subSessionId,
                parentSessionId: parentSessionId || '',
                success: !!(out && out.success !== false)
              })
            }
          } catch (_) {}
          subagentAsyncOutcomes.complete(subSessionId, out)
        })
        .catch((e) => {
          subagentAsyncOutcomes.complete(subSessionId, {
            success: false,
            error: e.message || String(e),
            subSessionId,
            systemPromptSource: normalizeSystemPromptSource(rawSystemPromptSource),
            parentRunId: parentRun || undefined,
            envelope: buildExecutionEnvelope(
              {
                success: false,
                error: e.message || String(e),
                subSessionId,
                parentRunId: parentRun || undefined,
                systemPromptSource: normalizeSystemPromptSource(rawSystemPromptSource)
              },
              'internal'
            )
          })
        })
        .finally(() => {
          try { spawnReg.unregisterSubagentChild(parentSessionId || '', subSessionId) } catch (_) {}
          try { spawnReg.clearSubagentSpawnMeta(subSessionId) } catch (_) {}
          try { spawnReg.releaseSpawnSlot(parentSessionId || '') } catch (_) {}
        })
      return {
        success: true,
        async: true,
        accepted: true,
        subSessionId,
        sub_session_id: subSessionId,
        parentRunId: parentRun || undefined,
        parent_run_id: parentRun || undefined,
        systemPromptSource: normalizeSystemPromptSource(rawSystemPromptSource),
        message: '子 Agent 已在后台运行。请用 sessions_subagent_poll(sub_session_id=...) 获取结果。'
      }
    }

    try {
      return await runSubChatBody()
    } finally {
      try { spawnReg.unregisterSubagentChild(parentSessionId || '', subSessionId) } catch (_) {}
      try { spawnReg.clearSubagentSpawnMeta(subSessionId) } catch (_) {}
      try { spawnReg.releaseSpawnSlot(parentSessionId || '') } catch (_) {}
    }
  }

  return { runSubChat }
}

module.exports = { createSubagentDispatch }
