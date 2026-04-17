'use strict'

const { parseToolCallArgs, formatCommandFromToolCall } = require('./im-tool-call-format')
const { resolveDeterministicOutboundText } = require('./outbound-result-text')

function channelSessionKey(binding) {
  return `${binding.projectPath}:${binding.sessionId}`
}

function registerImChannelMessagePipeline(deps) {
  const {
    eventBus,
    path,
    fs,
    FEISHU_PROJECT,
    TELEGRAM_PROJECT,
    DINGTALK_PROJECT,
    channelCurrentRun,
    channelKeyByRunSessionId,
    runStartTimeBySessionId,
    abortedRunSessionIds,
    completedRunSessionIds,
    getMainWindow,
    feishuNotify,
    appLogger,
    conversationFile,
    artifactRegistry,
    sessionRegistry,
    getWorkspaceRoot,
    getAIConfigLegacy,
    stripToolExecutionFromMessages,
    parseInboundModelCommand,
    applyGlobalDefaultModel,
    registerArtifactsFromItems,
    registerReferenceArtifactsFromMessages,
    normalizeArtifactsFromItems,
    attachArtifactsToLatestAssistant,
    triggerAutoEvolveFromSession,
    runMainAgentDirectRetry,
    getToolsForCoordinatorChat,
    getCoordinatorSystemPrompt,
    aiGateway,
    extractLocalResourceScreenshots,
    extractLocalFilesFromText,
    isImageFilePath,
    getCurrentRoundMessages,
    extractScreenshotsFromMessages,
    parseScreenshotFromToolResult,
    stripFeishuScreenshotMisfireText,
    stripFalseDeliveredClaims,
    getAssistantText,
    extractLatestSessionsSpawnResult,
    compactSpawnResultText,
    extractLatestVisibleText,
    overwriteLatestAssistantText,
    hasOutboundVisibleResult,
    stripToolProtocolAndJsonNoise,
    redactSensitiveText,
    looksLikeGenericGreeting,
    stripDispatchBoilerplateText,
    hasScreenshotClaimText
  } = deps

function formatRunningDuration(startTime) {
  const ms = Math.max(0, Date.now() - Number(startTime || 0))
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec > 0 ? `${min}分${remSec}秒` : `${min}分`
  const hour = Math.floor(min / 60)
  const remMin = min % 60
  return remMin > 0 ? `${hour}小时${remMin}分` : `${hour}小时`
}

function statusTextForUser(status) {
  if (status === 'running') return '执行中'
  if (status === 'paused') return '已暂停'
  if (status === 'idle') return '空闲'
  if (status === 'error') return '异常'
  if (status === 'completed') return '已完成'
  return status || '未知'
}

function phaseTextForUser(phase) {
  const p = String(phase || '').trim()
  if (!p) return ''
  if (p === 'tool_running') return '执行步骤中'
  if (p === 'thinking') return '思考中'
  if (p === 'executing') return '执行中'
  if (p === 'paused') return '已暂停'
  if (p === 'completed') return '已完成'
  if (p === 'failed') return '失败'
  return p
}

function summarizeTaskText(text, maxLen = 44) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s
}

function isDelegatedAgentToolName(name) {
  const n = String(name || '').trim()
  return n === 'sessions_spawn' || n === 'webapp_studio_invoke'
}

function updateRunEntry(key, runSessionId, patch = {}) {
  const runs = channelCurrentRun.get(key) || []
  const idx = runs.findIndex(r => r.runSessionId === runSessionId)
  if (idx < 0) return
  runs[idx] = { ...runs[idx], ...patch }
}

function humanizeLastAction(action) {
  const a = String(action || '').trim()
  if (!a) return ''
  if (/调用工具:\s*sessions_spawn/i.test(a)) return '已派发给子 Agent 执行'
  if (/调用工具:\s*webapp_studio_invoke/i.test(a)) return '已委派应用工作室 Agent'
  if (/调用工具:\s*/i.test(a)) return a.replace(/^调用工具:\s*/i, '正在执行：')
  return a
}

function computeDisplayProgress(rawProgress, startTime, status) {
  const raw = Number(rawProgress || 0)
  if (status === 'completed') return 100
  if (status === 'error' || status === 'failed') return Math.max(0, Math.min(100, raw))
  const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(startTime || 0)) / 1000))
  // 展示层“保守抬升”：长任务无新事件时也让用户看到在推进，最高不超过 92%
  const timeBased = Math.min(92, 4 + Math.floor(elapsedSec / 30) * 4)
  return Math.max(0, Math.min(100, Math.max(raw, timeBased)))
}

function buildSingleRunProgressSummary(key, runSessionId) {
  const runs = (channelCurrentRun.get(key) || [])
  const run = runs.find(r => r.runSessionId === runSessionId)
  if (!run) return ''
  const snapshot = sessionRegistry.getSnapshot()
  const s = snapshot.find(x => x.sessionId === runSessionId)
  if (!s) {
    const taskText = summarizeTaskText(run.delegatedTask || run.userTask || '')
    const duration = formatRunningDuration(run.startTime)
    const parts = [
      '状态：执行中',
      `已运行：${duration}`,
      taskText ? `任务：${taskText}` : ''
    ].filter(Boolean)
    return parts.map((p) => `- ${p}`).join('\n')
  }
  const status = statusTextForUser(s?.status || 'running')
  const progressPct = computeDisplayProgress(s?.progress?.progress || 0, run.startTime, s?.status || 'running')
  const phase = s?.progress?.phase ? phaseTextForUser(String(s.progress.phase)) : ''
  const lastAction = s?.progress?.last_action ? humanizeLastAction(String(s.progress.last_action)) : ''
  const eta = s?.progress?.eta ? String(s.progress.eta) : ''
  const duration = formatRunningDuration(run.startTime)
  const taskText = summarizeTaskText(run.delegatedTask || run.userTask || '')
  const parts = [
    `状态：${status}`,
    phase ? `阶段：${phase}` : '',
    `进度：${Math.max(0, Math.min(100, progressPct))}%`,
    `已运行：${duration}`,
    eta ? `预计剩余：${eta}` : '',
    taskText ? `任务：${taskText}` : '',
    lastAction ? `当前：${lastAction}` : ''
  ].filter(Boolean)
  return parts.map((p) => `- ${p}`).join('\n')
}

function createLongRunNotifier({ binding, mainSessionId, projectPath, chatId, key, runSessionId }) {
  // 不再向渠道发送「任务仍在处理中，请耐心等待」等进度提示，避免刷屏
  return () => {}
}

async function processMessageReplace(payload) {
  const { binding } = payload || {}
  if (!binding || (binding.channel !== 'feishu' && binding.channel !== 'telegram' && binding.channel !== 'dingtalk')) return
  const key = channelSessionKey(binding)
  const mainSessionId = binding.sessionId
  const messageText = String(payload?.message?.text || '').trim()
  const projectPath = binding.channel === 'feishu'
    ? FEISHU_PROJECT
    : (binding.channel === 'telegram' ? TELEGRAM_PROJECT : DINGTALK_PROJECT)
  const chatId = binding.remoteId
  // 不再走「纯截图补发」快捷分支（写死「已补发上次结果的截图」等），一律由主 Agent 流程处理
  // 平铺并发策略：同一会话新消息直接派生新 run，不自动中止已有 run。
  // 若需中止/等待，由模型显式调用 stop_previous_task / wait_for_previous_run。
  const existingRuns = channelCurrentRun.get(key) || []
  try {
    appLogger?.info?.('[SubAgentDispatch] 平铺并发派发', {
      sessionKey: key,
      runningCount: existingRuns.length,
      incomingMessageId: payload?.message?.messageId || ''
    })
  } catch (_) {}
  const runId = Date.now()
  const runSessionId = `${mainSessionId}-run-${runId}`
  const startTime = Date.now()
  if (binding.channel === 'feishu' && payload.message && payload.message.messageId) {
    try {
      const res = await feishuNotify.addMessageReaction(payload.message.messageId, 'Typing')
      if (res && res.success && res.reaction_id) payload.typingReactionId = res.reaction_id
    } catch (_) { /* 在用户消息上加「敲键盘」表情失败则忽略 */ }
  }
  if (!channelCurrentRun.has(key)) channelCurrentRun.set(key, [])
  const stopLongRunNotify = createLongRunNotifier({
    binding,
    mainSessionId,
    projectPath,
    chatId,
    key,
    runSessionId
  })
  const promise = handleChatMessageReceived(payload, runSessionId, mainSessionId, key, runId, startTime).finally(() => {
    completedRunSessionIds.add(runSessionId)
    try { stopLongRunNotify() } catch (_) {}
    const arr = channelCurrentRun.get(key)
    if (arr) {
      const i = arr.findIndex(r => r.runSessionId === runSessionId)
      if (i >= 0) arr.splice(i, 1)
      if (arr.length === 0) channelCurrentRun.delete(key)
    }
    channelKeyByRunSessionId.delete(runSessionId)
    runStartTimeBySessionId.delete(runSessionId)
    completedRunSessionIds.delete(runSessionId)
  })
  const runEntry = {
    runId,
    runSessionId,
    promise,
    startTime,
    stopLongRunNotify,
    userTask: summarizeTaskText(messageText),
    delegatedTask: undefined,
    delegatedRole: undefined
  }
  channelCurrentRun.get(key).push(runEntry)
  channelKeyByRunSessionId.set(runSessionId, key)
  runStartTimeBySessionId.set(runSessionId, startTime)
}

// 应用层：每条新消息派生子 Agent（runSessionId），子 Agent 可停前边或等待前边；完成时合并回主会话并回发
async function handleChatMessageReceived(payload, runSessionId, mainSessionId, key, runId, startTime) {
  const { message, binding } = payload || {}
  if (!message || !binding) return
  if (binding.channel !== 'feishu' && binding.channel !== 'telegram' && binding.channel !== 'dingtalk') return
  const typingReactionId = payload.typingReactionId || null
  const userMessageId = message.messageId || null
  const feishuStreamEnabled = (() => {
    if (binding.channel !== 'feishu') return false
    try {
      const cfg = require('./openultron-config').getFeishu()
      // 仅在显式开启 card 流式模式时启用；文本消息 update 在部分环境会返回 NOT a card
      return !!(cfg && cfg.streaming_reply_enabled !== false && cfg.streaming_reply_mode === 'card')
    } catch (_) {
      return false
    }
  })()
  const chatId = binding.remoteId
  const projectPath = binding.channel === 'feishu'
    ? FEISHU_PROJECT
    : (binding.channel === 'telegram' ? TELEGRAM_PROJECT : DINGTALK_PROJECT)
  const projectKey = conversationFile.hashProjectPath(projectPath)
  let conv = conversationFile.loadConversation(projectKey, mainSessionId)
  if (!conv) {
    const now = new Date().toISOString()
    const titlePrefix = binding.channel === 'feishu'
      ? '飞书'
      : (binding.channel === 'telegram' ? 'Telegram' : '钉钉')
    conversationFile.updateConversationMeta(projectKey, mainSessionId, {
      title: `${titlePrefix}: ${String(chatId).slice(0, 20)}`,
      updatedAt: now,
      createdAt: now,
      messageCount: 0
    })
  }
  const displayText = message?.metadata?.displayText || message.text
  const attachments = Array.isArray(message?.metadata?.attachments)
    ? message.metadata.attachments
    : (Array.isArray(message?.attachments) ? message.attachments : [])
  const inboundArtifactRefs = []
  const inboundAttachmentsForUi = []
  for (const a of attachments) {
    if (!a) continue
    const p = String(a.path || '').trim()
    let uiPath = p
    if (p && path.isAbsolute(p) && fs.existsSync(p)) {
      try {
        const rec = artifactRegistry.registerFileArtifact({
          path: p,
          filename: a.name || path.basename(p),
          kind: a.type === 'image' ? 'image' : (a.type === 'audio' ? 'audio' : 'file'),
          source: `${binding.channel}_inbound`,
          channel: binding.channel,
          sessionId: mainSessionId,
          runSessionId,
          messageId: userMessageId || '',
          chatId: chatId || '',
          role: 'user'
        })
        if (rec?.path) uiPath = rec.path
        if (rec) {
          inboundArtifactRefs.push({
            artifactId: rec.artifactId,
            kind: rec.kind,
            path: rec.path,
            name: rec.filename || a.name || path.basename(rec.path),
            ts: rec.createdAt || new Date().toISOString()
          })
        }
      } catch (e) {
        appLogger?.warn?.('[ArtifactRegistry] inbound register failed', { error: e.message || String(e) })
      }
    }
    inboundAttachmentsForUi.push({ ...a, ...(uiPath ? { path: uiPath } : {}) })
  }
  let userDisplayText = String(displayText || '').trim() || (attachments.length > 0 ? '[附件]' : String(message?.text || '').trim())
  const modelCmd = parseInboundModelCommand(userDisplayText)
  if (modelCmd && modelCmd.modelId) {
    const apply = applyGlobalDefaultModel(modelCmd.modelId)
    if (!apply.success) {
      if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
        await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
      }
      const errBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
      await eventBus.emitAsync('chat.session.completed', { binding: errBinding, payload: { text: `切换模型失败：${apply.error}` } })
      return
    }
    const rest = (modelCmd.remainderText || '').trim()
    if (!rest) {
      if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
        await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
      }
      const okBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
      await eventBus.emitAsync('chat.session.completed', { binding: okBinding, payload: { text: `已切换全局模型为：${modelCmd.modelId}` } })
      return
    }
    userDisplayText = rest
  }
  const historyMessages = (conv && conv.messages) ? [...conv.messages] : []
  historyMessages.push({
    role: 'user',
    content: userDisplayText || '[附件]',
    ...(inboundArtifactRefs.length > 0 ? { metadata: { artifacts: inboundArtifactRefs } } : {})
  })
  const earlyToSave = stripToolExecutionFromMessages(historyMessages)
  const earlySavePayload = { id: mainSessionId, messages: earlyToSave, projectPath }
  if (binding.channel === 'feishu') {
    earlySavePayload.feishuChatId = chatId
    if (binding.feishuTenantKey) earlySavePayload.feishuTenantKey = String(binding.feishuTenantKey).trim()
    if (binding.feishuDocHost) earlySavePayload.feishuDocHost = String(binding.feishuDocHost).trim()
  }
  conversationFile.saveConversation(projectKey, earlySavePayload)
  if (userMessageId && inboundArtifactRefs.length > 0) {
    try {
      artifactRegistry.bindArtifactsToMessage({
        sessionId: mainSessionId,
        messageId: userMessageId,
        role: 'user',
        artifactIds: inboundArtifactRefs.map((x) => x.artifactId).filter(Boolean)
      })
    } catch (e) {
      appLogger?.warn?.('[ArtifactRegistry] bind inbound message failed', { error: e.message || String(e) })
    }
  }

  const messages = (conv && conv.messages) ? [...conv.messages] : []
  messages.push({ role: 'system', content: getCoordinatorSystemPrompt(binding.channel) })
  messages.push({ role: 'user', content: userDisplayText || String(message?.text || '').trim() || '[附件]' })
  const originalConvLength = messages.length - 1
  const nowIso = new Date().toISOString()
  conversationFile.updateConversationMeta(projectKey, mainSessionId, { updatedAt: nowIso })
  if (binding.channel === 'feishu' && getMainWindow() && getMainWindow().webContents) {
    getMainWindow().webContents.send('feishu-session-user-message', {
      sessionId: mainSessionId,
      text: displayText,
      attachments: inboundAttachmentsForUi,
      messageId: userMessageId || ''
    })
  }
  const legacy = getAIConfigLegacy()
  const resolvedKey = legacy && legacy.providerKeys && legacy.config && legacy.providerKeys[legacy.config.apiBaseUrl]
  const apiKey = resolvedKey || (legacy && legacy.config && legacy.config.apiKey) || ''
  if (!apiKey) {
    if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
      await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
    }
    const errBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
    await eventBus.emitAsync('chat.session.completed', { binding: errBinding, payload: { text: '请先在应用内配置 API Key 后再使用。' } })
    return
  }
  const collectedScreenshots = []
  const streamState = {
    enabled: feishuStreamEnabled,
    messageId: '',
    thinkingText: '',
    commandLines: [],
    lastSentText: '',
    flushTimer: null
  }
  const emitUiToolCall = (toolCall = {}) => {
    if (!getMainWindow() || !getMainWindow().webContents) return
    try {
      getMainWindow().webContents.send('ai-chat-tool-call', {
        sessionId: mainSessionId,
        toolCall
      })
    } catch (_) {}
  }
  const emitUiToolResult = (name, resultPayload) => {
    if (!getMainWindow() || !getMainWindow().webContents) return
    try {
      getMainWindow().webContents.send('ai-chat-tool-result', {
        sessionId: mainSessionId,
        name: String(name || ''),
        result: typeof resultPayload === 'string' ? resultPayload : JSON.stringify(resultPayload || {})
      })
    } catch (_) {}
  }
  const appendCommandLine = (line) => {
    if (!streamState.enabled) return
    const t = redactSensitiveText(String(line || '')).replace(/\r/g, '').trim()
    if (!t) return
    const wasEmpty = streamState.commandLines.length === 0
    streamState.commandLines.push(t)
    if (streamState.commandLines.length > 120) streamState.commandLines.splice(0, streamState.commandLines.length - 120)
    if (wasEmpty) {
      flushStream(false).catch((e) => {
        appLogger?.warn?.('[FeishuStream] 首次命令刷新失败', { runSessionId, error: e?.message || String(e) })
      })
    }
  }
  const buildStreamText = () => {
    if (!streamState.enabled) return ''
    const parts = []
    const safeThinking = stripToolProtocolAndJsonNoise(String(streamState.thinkingText || ''), { dropJsonEnvelope: true })
    if (safeThinking && safeThinking.trim()) {
      const clippedThinking = String(safeThinking).slice(-1800)
      parts.push(clippedThinking)
    } else {
      parts.push('思考中...')
    }
    if (streamState.commandLines.length > 0) {
      parts.push('')
      parts.push('执行命令：')
      parts.push(...streamState.commandLines.slice(-18))
    }
    return parts.join('\n').slice(0, 3800)
  }
  const shouldStartStreamMessage = () => {
    if (!streamState.enabled) return false
    if (streamState.messageId) return true
    // 仅当子 Agent 已返回可展示的命令过程时才启动流式（避免“你好”这类秒回触发）
    return streamState.commandLines.length > 0
  }
  const ensureStreamMessage = async () => {
    if (!streamState.enabled || streamState.messageId) return
    if (!shouldStartStreamMessage()) return
    const created = await feishuNotify.sendMessage({
      chat_id: chatId,
      text: '思考中...'
    }).catch(() => null)
    if (created && created.success && created.message_id) {
      streamState.messageId = String(created.message_id)
      streamState.lastSentText = '思考中...'
    }
  }
  const flushStream = async (force = false) => {
    if (!streamState.enabled) return
    const nextText = buildStreamText()
    if (!nextText) return
    if (!force && nextText === streamState.lastSentText) return
    await ensureStreamMessage()
    if (!streamState.messageId) return
    const updated = await feishuNotify.updateTextMessage(streamState.messageId, nextText).catch(() => null)
    if (updated && updated.success) {
      streamState.lastSentText = nextText
    } else {
      appLogger?.warn?.('[FeishuStream] 流式消息更新失败', {
        runSessionId,
        hasMessageId: !!streamState.messageId,
        reason: (updated && updated.message) || 'unknown'
      })
    }
  }
  const scheduleStreamFlush = () => {
    if (!streamState.enabled) return
    if (streamState.flushTimer) return
    streamState.flushTimer = setTimeout(async () => {
      streamState.flushTimer = null
      await flushStream(false)
    }, 1200)
  }
  const completePromise = new Promise((resolve, reject) => {
    const fakeSender = {
      send: (channel, data) => {
        if (channel === 'ai-chat-complete' && data && data.messages) {
          resolve(data.messages)
        }
        if (channel === 'ai-chat-error') reject(new Error((data && data.error) || 'AI 出错'))
        if (channel === 'ai-chat-tool-call' && data && data.toolCall) {
          const tc = data.toolCall
          // 仅展示与子 Agent 执行相关的命令过程
          if (isDelegatedAgentToolName(tc.name)) {
            appendCommandLine(formatCommandFromToolCall(tc))
            scheduleStreamFlush()
          }
          if (tc.name === 'sessions_spawn') {
            const args = parseToolCallArgs(tc.arguments)
            const delegatedTask = summarizeTaskText(args && args.task ? args.task : '')
            const delegatedRole = summarizeTaskText(args && args.role_name ? args.role_name : '', 16)
            if (delegatedTask || delegatedRole) {
              updateRunEntry(key, runSessionId, {
                delegatedTask: delegatedTask || undefined,
                delegatedRole: delegatedRole || undefined
              })
            }
          }
          if (tc.name === 'webapp_studio_invoke') {
            const args = parseToolCallArgs(tc.arguments)
            const delegatedTask = summarizeTaskText(args && args.task ? args.task : '')
            if (delegatedTask) {
              updateRunEntry(key, runSessionId, {
                delegatedTask,
                delegatedRole: '应用工作室'
              })
            }
          }
        }
        if (channel === 'ai-chat-tool-result' && data) {
          const raw = data.result != null ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result)) : ''
          if (raw) {
            // execute_command 的流式增量（partial/running）不做截图解析，避免高频 JSON 解析拖慢主线程
            let skipParse = false
            try {
              const obj = JSON.parse(raw)
              if (obj && typeof obj === 'object' && (obj.partial === true || obj.running === true)) skipParse = true
            } catch (_) { /* ignore */ }
            const items = skipParse ? [] : parseScreenshotFromToolResult(raw)
            if (items.length > 0) {
              appLogger?.info?.('[Feishu] 从 tool 结果收集到截图', { name: data.name, count: items.length })
            }
            for (const item of items) collectedScreenshots.push(item)
            // 子 Agent 流式日志里仅提取“执行了什么命令”，不展示执行结果
            if (isDelegatedAgentToolName(data.name)) {
              try {
                const obj = JSON.parse(raw)
                const lines = Array.isArray(obj?.log_lines) ? obj.log_lines : []
                for (const line of lines.slice(-60)) {
                  const s = String(line || '').trim()
                  const m = s.match(/^\[tool_call\]\s+(.+)$/i)
                  if (m && m[1]) appendCommandLine(`- ${m[1].trim()}`)
                }
              } catch (_) {}
            }
            if (!skipParse) scheduleStreamFlush()
          }
        }
        if (channel === 'ai-chat-token' && data && typeof data.token === 'string') {
          streamState.thinkingText += data.token
          if (streamState.thinkingText.length > 4000) streamState.thinkingText = streamState.thinkingText.slice(-4000)
          scheduleStreamFlush()
        }
        if (binding.channel === 'feishu' && getMainWindow() && getMainWindow().webContents && data) {
          const p = { ...data, sessionId: mainSessionId }
          if (channel === 'ai-chat-token' || channel === 'ai-chat-tool-call' || channel === 'ai-chat-tool-result' || channel === 'ai-chat-complete' || channel === 'ai-chat-error') {
            getMainWindow().webContents.send(channel, p)
          }
        }
      }
    }
    const runChatPayload = {
      sessionId: runSessionId,
      messages,
      model: undefined,
      tools: getToolsForCoordinatorChat(),
      projectPath
    }
    if (binding.channel === 'feishu') {
      runChatPayload.feishuChatId = chatId
      const tenantKey = String(binding.feishuTenantKey || message?.metadata?.tenantKey || '').trim()
      if (tenantKey) runChatPayload.feishuTenantKey = tenantKey
      const cfgDocHost = (() => {
        try { return String(require('./openultron-config').getFeishu()?.doc_host || '').trim() } catch (_) { return '' }
      })()
      const docHost = String(binding.feishuDocHost || message?.metadata?.feishuDocHost || cfgDocHost || '').trim()
      if (docHost) runChatPayload.feishuDocHost = docHost
      const senderOpenId = String(binding.feishuSenderOpenId || message?.metadata?.senderOpenId || '').trim()
      if (senderOpenId) runChatPayload.feishuSenderOpenId = senderOpenId
      const senderUserId = String(binding.feishuSenderUserId || message?.metadata?.senderUserId || '').trim()
      if (senderUserId) runChatPayload.feishuSenderUserId = senderUserId
    }
    aiGateway.runChat(runChatPayload, fakeSender).catch(reject)
  })
  try {
    const finalMessages = await completePromise
    const wasAborted = abortedRunSessionIds.has(runSessionId)
    if (wasAborted) {
      abortedRunSessionIds.delete(runSessionId)
      if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
        await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
      }
      return
    }
    completedRunSessionIds.add(runSessionId)
    let delta = finalMessages.slice(originalConvLength)
    const getMsgText = (m) => {
      if (!m) return ''
      if (typeof m.content === 'string') return m.content.trim()
      if (Array.isArray(m.content)) return m.content.map((x) => (x && x.text) || '').join('').trim()
      return ''
    }
    const firstDelta = delta[0]
    if (firstDelta && firstDelta.role === 'user') {
      const firstText = getMsgText(firstDelta)
      if (firstText && firstText === String(message?.text || '').trim()) {
        delta = delta.slice(1)
      }
    }
    const latestAssistant = [...delta]
      .reverse()
      .find((m) => m && m.role === 'assistant' && getAssistantText(m).trim())
    const toSend = latestAssistant ? getAssistantText(latestAssistant) : ''
    const { cleanedText: cleanedRaw, filePaths: pathsFromText } = extractLocalResourceScreenshots(toSend)
    const currentRound = getCurrentRoundMessages(finalMessages)
    const spawnResultText = compactSpawnResultText(extractLatestSessionsSpawnResult(currentRound))
    const { cleanedText: spawnCleanedRaw, filePaths: spawnPathsFromText } = extractLocalResourceScreenshots(spawnResultText || '')
    const screenshotsFromTools = extractScreenshotsFromMessages(currentRound)
    let imageItems = []
    const seenPath = new Set()
    const seenBase64Head = new Set()
    for (const item of collectedScreenshots) {
      if (item.path && !seenPath.has(item.path)) {
        seenPath.add(item.path)
        imageItems.push({ path: item.path })
      } else if (item.base64) {
        const head = item.base64.slice(0, 80)
        if (!seenBase64Head.has(head)) { seenBase64Head.add(head); imageItems.push({ base64: item.base64 }) }
      }
    }
    for (const p of pathsFromText) {
      if (!seenPath.has(p)) { seenPath.add(p); imageItems.push({ path: p }) }
    }
    for (const p of spawnPathsFromText) {
      if (!seenPath.has(p)) { seenPath.add(p); imageItems.push({ path: p }) }
    }
    for (const item of screenshotsFromTools) {
      if (item.path && !seenPath.has(item.path)) {
        seenPath.add(item.path)
        imageItems.push({ path: item.path })
      } else if (item.base64) {
        const head = item.base64.slice(0, 80)
        if (!seenBase64Head.has(head)) { seenBase64Head.add(head); imageItems.push({ base64: item.base64 }) }
      }
    }
    const cleanedText = stripFeishuScreenshotMisfireText(cleanedRaw)
    const cleanedSpawnText = stripFeishuScreenshotMisfireText(spawnCleanedRaw)
    const fileResolveBase = (projectPath && path.isAbsolute(projectPath)) ? projectPath : getWorkspaceRoot()
    let fileItems = []
    const seenFilePath = new Set()
    for (const p of extractLocalFilesFromText(cleanedText, fileResolveBase)) {
      if (isImageFilePath(p)) {
        if (!seenPath.has(p)) { seenPath.add(p); imageItems.push({ path: p }) }
      } else {
        if (!seenFilePath.has(p)) { seenFilePath.add(p); fileItems.push({ path: p }) }
      }
    }
    for (const p of extractLocalFilesFromText(cleanedSpawnText, fileResolveBase)) {
      if (isImageFilePath(p)) {
        if (!seenPath.has(p)) {
          seenPath.add(p)
          imageItems.push({ path: p })
        }
      } else if (!seenFilePath.has(p)) {
        seenFilePath.add(p)
        fileItems.push({ path: p })
      }
    }
    const regResult = registerArtifactsFromItems({
      images: imageItems,
      files: fileItems,
      context: {
        source: `${binding.channel}_assistant`,
        channel: binding.channel,
        sessionId: mainSessionId,
        runSessionId,
        messageId: userMessageId || '',
        chatId: chatId || '',
        role: 'assistant'
      }
    })
    imageItems = regResult.images
    fileItems = regResult.files
    const refArtifacts = registerReferenceArtifactsFromMessages(currentRound, {
      source: `${binding.channel}_assistant`,
      channel: binding.channel,
      sessionId: mainSessionId,
      runSessionId,
      messageId: userMessageId || '',
      chatId: chatId || '',
      docHost: String(binding?.feishuDocHost || '').trim(),
      role: 'assistant'
    }).map((x) => ({
      artifactId: x.artifactId,
      kind: x.kind,
      path: x.path,
      name: x.filename || '',
      ts: x.createdAt || new Date().toISOString()
    }))
    let allRefs = [...regResult.refs, ...refArtifacts]
    if (userMessageId && allRefs.length > 0) {
      try {
        artifactRegistry.bindArtifactsToMessage({
          sessionId: mainSessionId,
          messageId: userMessageId,
          role: 'assistant',
          artifactIds: allRefs.map((x) => x.artifactId).filter(Boolean)
        })
      } catch (e) {
        appLogger?.warn?.('[ArtifactRegistry] bind assistant message failed', { error: e.message || String(e) })
      }
    }
    let hasSpawnCall = currentRound.some((m) =>
      m && m.role === 'assistant' && Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => isDelegatedAgentToolName(tc?.function?.name))
    )
    const latestVisibleText = String(extractLatestVisibleText(currentRound) || '').trim()
    const seedFallbackText = (toSend && String(toSend).trim())
      ? String(toSend).trim()
      : ((spawnResultText && String(spawnResultText).trim())
          ? String(spawnResultText).trim()
          : ((latestVisibleText && String(latestVisibleText).trim()) ? String(latestVisibleText).trim() : ''))
    const rawFallbackText = seedFallbackText
    const safeRawFallbackText = stripToolProtocolAndJsonNoise(rawFallbackText, { dropJsonEnvelope: true })
    const safeUsefulRawFallbackText = hasOutboundVisibleResult(safeRawFallbackText) ? safeRawFallbackText : ''
    const cleanedTextTrim = String(cleanedText || '').trim()
    const cleanedSpawnTrim = String(cleanedSpawnText || '').trim()
    const preferSpawnText = !!cleanedSpawnTrim && (
      !!hasSpawnCall ||
      !cleanedTextTrim ||
      looksLikeGenericGreeting(cleanedTextTrim)
    )
    const spawnStripped = stripToolProtocolAndJsonNoise(cleanedSpawnTrim, { dropJsonEnvelope: true })
    const spawnOutboundOk = hasOutboundVisibleResult(spawnStripped)
    // 有委派时优先子 Agent 摘要；若摘要被判定为不可外发（空/噪声），回退主 Agent 正文，避免只剩兜底句
    const baseTextToSend = preferSpawnText
      ? (spawnOutboundOk
        ? cleanedSpawnTrim
        : (cleanedTextTrim || cleanedSpawnTrim || (rawFallbackText || (imageItems.length > 0 ? '截图已发至当前会话。' : null))))
      : (cleanedTextTrim || cleanedSpawnTrim || (rawFallbackText || (imageItems.length > 0 ? '截图已发至当前会话。' : null)))
    const safeBaseTextToSend = stripToolProtocolAndJsonNoise(baseTextToSend, { dropJsonEnvelope: true })
    const safeUsefulBaseTextToSend = hasOutboundVisibleResult(safeBaseTextToSend) ? safeBaseTextToSend : ''
    let directRetryResolvedText = ''
    let directRetryErrorText = ''
    let directRetryAddedArtifacts = false
    const shouldRescueByMain = !hasSpawnCall &&
      imageItems.length === 0 && fileItems.length === 0 &&
      !hasOutboundVisibleResult(safeBaseTextToSend)
    if (shouldRescueByMain) {
      appendCommandLine('- 主Agent无结果，触发直执行重试')
      scheduleStreamFlush()
      const directRetry = await runMainAgentDirectRetry({
        aiGateway,
        baseRunSessionId: runSessionId,
        messages,
        projectPath,
        binding,
        chatId,
        appendCommandLine,
        scheduleStreamFlush
      })
      if (directRetry && directRetry.success) {
        const retryText = String(directRetry.text || '').trim()
        if (retryText) {
          const retryClean = stripToolProtocolAndJsonNoise(retryText, { dropJsonEnvelope: true })
          if (hasOutboundVisibleResult(retryClean)) {
            directRetryResolvedText = retryClean
          }
        }
        const seenImagePath = new Set(imageItems.map((x) => String(x?.path || '')).filter(Boolean))
        const seenFilePath = new Set(fileItems.map((x) => String(x?.path || '')).filter(Boolean))
        for (const it of (Array.isArray(directRetry.images) ? directRetry.images : [])) {
          if (!it) continue
          if (it.path) {
            const p = String(it.path)
            if (!p || seenImagePath.has(p)) continue
            seenImagePath.add(p)
            imageItems.push({ path: p })
            directRetryAddedArtifacts = true
          } else if (it.base64) {
            imageItems.push({ base64: String(it.base64) })
            directRetryAddedArtifacts = true
          }
        }
        for (const it of (Array.isArray(directRetry.files) ? directRetry.files : [])) {
          if (!it || !it.path) continue
          const p = String(it.path)
          if (!p || seenFilePath.has(p)) continue
          seenFilePath.add(p)
          fileItems.push({ path: p })
          directRetryAddedArtifacts = true
        }
      } else {
        directRetryErrorText = `执行失败：主Agent直执行失败（${String(directRetry?.error || '未知错误').trim()}）`
      }
      if (directRetryResolvedText) {
        try {
          appLogger?.info?.('[MainAgent] 主Agent兜底生成成功', {
            runSessionId,
            messageId: userMessageId || '',
            length: directRetryResolvedText.length
          })
        } catch (_) {}
      }
    }
    let textToSend = resolveDeterministicOutboundText({
      candidates: [safeUsefulBaseTextToSend, directRetryResolvedText, safeUsefulRawFallbackText],
      stripToolProtocolAndJsonNoise,
      hasUsefulVisibleResult: hasOutboundVisibleResult,
      stripFalseDeliveredClaims,
      channel: binding.channel,
      hasImages: imageItems.length > 0,
      hasFiles: fileItems.length > 0,
      explicitErrorText: directRetryErrorText
    })
    
    const noArtifacts = imageItems.length === 0 && fileItems.length === 0
    const visibleResultText = String(cleanedSpawnTrim || cleanedTextTrim || safeRawFallbackText || '').trim()
    const noUsefulResult = !hasOutboundVisibleResult(visibleResultText)
    if (hasSpawnCall && noArtifacts && noUsefulResult) {
      appendCommandLine('- 子Agent空结果，主Agent直执行重试')
      scheduleStreamFlush()
      const directRetry = await runMainAgentDirectRetry({
        aiGateway,
        baseRunSessionId: runSessionId,
        messages,
        projectPath,
        binding,
        chatId,
        appendCommandLine,
        scheduleStreamFlush
      })
      if (directRetry && directRetry.success) {
        const retryText = String(directRetry.text || '').trim()
        if (retryText) {
          const retryClean = stripToolProtocolAndJsonNoise(retryText, { dropJsonEnvelope: true })
          if (hasOutboundVisibleResult(retryClean)) textToSend = retryClean
        }
        const seenImagePath = new Set(imageItems.map(x => String(x?.path || '')).filter(Boolean))
        const seenFilePath = new Set(fileItems.map(x => String(x?.path || '')).filter(Boolean))
        for (const it of (Array.isArray(directRetry.images) ? directRetry.images : [])) {
          if (it && it.path) {
            const p = String(it.path).trim()
            if (!p || seenImagePath.has(p)) continue
            seenImagePath.add(p)
            imageItems.push({ path: p })
            directRetryAddedArtifacts = true
          } else if (it && it.base64) {
            imageItems.push({ base64: String(it.base64) })
            directRetryAddedArtifacts = true
          }
        }
        for (const it of (Array.isArray(directRetry.files) ? directRetry.files : [])) {
          if (!it || !it.path) continue
          const p = String(it.path).trim()
          if (!p || seenFilePath.has(p)) continue
          seenFilePath.add(p)
          fileItems.push({ path: p })
          directRetryAddedArtifacts = true
        }
        appendCommandLine('- 主Agent直执行重试完成')
      } else {
        const retryErr = String(directRetry?.error || '主Agent直执行失败').trim()
        textToSend = `执行失败：子Agent未返回结果，且主Agent直执行失败（${retryErr}）`
      }
      try {
        appLogger?.warn?.('[SubAgentDispatch] 子Agent返回空结果', {
          runSessionId,
          messageId: userMessageId || '',
          taskPreview: summarizeTaskText(String(message?.text || ''), 80)
        })
      } catch (_) {}
    }
    if (directRetryAddedArtifacts) {
      const retryReg = registerArtifactsFromItems({
        images: imageItems,
        files: fileItems,
        context: {
          source: `${binding.channel}_assistant`,
          channel: binding.channel,
          sessionId: mainSessionId,
          runSessionId,
          messageId: userMessageId || '',
          chatId: chatId || '',
          role: 'assistant'
        }
      })
      imageItems = retryReg.images
      fileItems = retryReg.files
      allRefs = [...allRefs, ...(Array.isArray(retryReg.refs) ? retryReg.refs : [])]
      if (userMessageId && Array.isArray(retryReg.refs) && retryReg.refs.length > 0) {
        try {
          artifactRegistry.bindArtifactsToMessage({
            sessionId: mainSessionId,
            messageId: userMessageId,
            role: 'assistant',
            artifactIds: retryReg.refs.map((x) => x.artifactId).filter(Boolean)
          })
        } catch (e) {
          appLogger?.warn?.('[ArtifactRegistry] bind assistant message failed (retry)', { error: e.message || String(e) })
        }
      }
    }
    textToSend = stripDispatchBoilerplateText(textToSend)
    // 不再快捷补抓截图或写死「已补发截图，请查收」；若回复声称已截图但无附件，仅清理误导文案
    const replyClaimsScreenshot = hasScreenshotClaimText(textToSend)
    if (imageItems.length === 0 && replyClaimsScreenshot) {
      textToSend = stripFalseDeliveredClaims(textToSend, {
        hasImages: false,
        hasFiles: fileItems.length > 0,
        channel: binding.channel
      })
    }
    // 暂停主 Agent 二次改写：保留主流程原始结果，避免风格/语义偏移
    if (streamState.enabled) {
      streamState.thinkingText = textToSend || streamState.thinkingText
      appendCommandLine('- 任务完成，正在汇总结果')
      await flushStream(true)
    }
    const mainConv = conversationFile.loadConversation(projectKey, mainSessionId)
    const baseMessages = (mainConv && mainConv.messages) ? mainConv.messages : []
    const insertAt = Math.min(originalConvLength, baseMessages.length)
    const forcedMsg = []
    const artifacts = [...normalizeArtifactsFromItems(imageItems, fileItems), ...allRefs]
    const mergedRaw = [...baseMessages.slice(0, insertAt), ...delta, ...forcedMsg, ...baseMessages.slice(insertAt)]
    const normalizedMerged = overwriteLatestAssistantText(mergedRaw, textToSend)
    const merged = attachArtifactsToLatestAssistant(normalizedMerged, artifacts)
    const messagesToSave = stripToolExecutionFromMessages(merged)
    const savePayload = { id: mainSessionId, messages: messagesToSave, projectPath }
    if (binding.channel === 'feishu') {
      savePayload.feishuChatId = chatId
      if (binding.feishuTenantKey) savePayload.feishuTenantKey = String(binding.feishuTenantKey).trim()
      if (binding.feishuDocHost) savePayload.feishuDocHost = String(binding.feishuDocHost).trim()
    }
    conversationFile.saveConversation(projectKey, savePayload)
    if (binding.channel === 'feishu' && getMainWindow() && getMainWindow().webContents) {
      getMainWindow().webContents.send('feishu-session-updated', { sessionId: mainSessionId, runSessionId })
    }
    // 统一主流程回发：即使模型内部尝试发送，也不走提前 return
    const outBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
    const outPayload = {
      text: textToSend || (imageItems.length > 0 ? '截图已发至当前会话。' : '任务已执行完成，但未生成可展示的文本结果。'),
      images: imageItems,
      files: fileItems,
      ...(streamState.enabled && streamState.messageId ? { stream_message_id: streamState.messageId } : {})
    }
    if (binding.channel === 'telegram') {
      try {
        const tgCfg = require('./openultron-config').getTelegram()
        if (tgCfg && tgCfg.voice_reply_enabled) outPayload.audio_text = textToSend
      } catch (_) {}
    }
    if (binding.channel === 'dingtalk') {
      try {
        const dtCfg = require('./openultron-config').getDingtalk()
        if (dtCfg && dtCfg.voice_reply_enabled) outPayload.audio_text = textToSend
      } catch (_) {}
    }
    if (imageItems.length > 0) {
      appLogger?.info?.(`[${binding.channel}] 会话完成，带图回发`, { imageCount: imageItems.length })
    }
    await eventBus.emitAsync('chat.session.completed', { binding: outBinding, payload: outPayload })
    triggerAutoEvolveFromSession({
      projectPath,
      sessionId: mainSessionId,
      runId: String(runId),
      reason: `${binding.channel || 'channel'}_completed`,
      force: false
    })
    if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
      // 不阻塞最终回复发送，异步移除“敲键盘”表情
      feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
    }
  } catch (e) {
    completedRunSessionIds.add(runSessionId)
    console.error(`[${binding.channel}] 处理或回复失败:`, e.message)
    if (streamState.enabled) {
      streamState.thinkingText = `处理失败：${e.message || String(e)}`
      appendCommandLine('- 任务失败')
      await flushStream(true).catch(() => {})
    }
    if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
      await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
    }
    const errBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
    await eventBus.emitAsync('chat.session.completed', { binding: errBinding, payload: { text: `处理出错: ${e.message}` } })
    triggerAutoEvolveFromSession({
      projectPath,
      sessionId: mainSessionId,
      runId: String(runId),
      reason: `${binding.channel || 'channel'}_failed`,
      force: false
    })
  } finally {
    if (streamState.flushTimer) {
      try { clearTimeout(streamState.flushTimer) } catch (_) {}
      streamState.flushTimer = null
    }
  }
}

  eventBus.on('chat.message.received', processMessageReplace)
}

module.exports = { registerImChannelMessagePipeline, channelSessionKey }
