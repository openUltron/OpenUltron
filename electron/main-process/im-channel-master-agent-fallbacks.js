'use strict'

const { formatCommandFromToolCall } = require('./im-tool-call-format')

/**
 * IM / Gateway 侧：主 Agent 文本整理、兜底生成、协调 run 空结果时的直跑重试。
 */
function createImChannelMasterAgentFallbacks(deps) {
  const {
    aiOrchestrator,
    stripToolProtocolAndJsonNoise,
    looksLikeGenericGreeting,
    parseScreenshotFromToolResult,
    getToolsForSubChat,
    path,
    getWorkspaceRoot,
    getAssistantText,
    getCurrentRoundMessages,
    extractLatestVisibleText,
    extractLocalResourceScreenshots,
    extractScreenshotsFromMessages,
    stripFeishuScreenshotMisfireText,
    extractLocalFilesFromText,
    isImageFilePath
  } = deps

  async function refineReplyByMasterAgent({
    userText = '',
    draftText = '',
    spawnText = '',
    hasImages = false,
    hasFiles = false,
    channel = ''
  } = {}) {
    const baseDraft = String(draftText || '').trim()
    if (!baseDraft) return ''
    const shouldRefine =
      looksLikeGenericGreeting(baseDraft) ||
      !!String(spawnText || '').trim() ||
      baseDraft.length > 220
    if (!shouldRefine) return baseDraft
    try {
      const channelName = channel === 'feishu' ? '飞书' : (channel === 'telegram' ? 'Telegram' : (channel === 'dingtalk' ? '钉钉' : '当前渠道'))
      const prompt = [
        `用户问题：${String(userText || '').trim()}`,
        `子Agent结果：${String(spawnText || '').trim() || '（无）'}`,
        `当前草稿：${baseDraft}`,
        `产物：图片=${hasImages ? '有' : '无'}，文件=${hasFiles ? '有' : '无'}，渠道=${channelName}`,
        '请输出最终回复（中文，60~220字）：',
        '1) 先给执行结论；2) 再给关键结果；3) 如有产物说明已发送；4) 禁止自我介绍和寒暄；5) 禁止编造未完成内容。'
      ].join('\n')
      const refined = await aiOrchestrator.generateText({
        prompt,
        systemPrompt: '你是主Agent最终回复整理器，只做结果归纳，不使用工具，不输出Markdown代码块。'
      })
      const cleaned = stripToolProtocolAndJsonNoise(refined || '', { dropJsonEnvelope: true })
      return String(cleaned || '').trim() || baseDraft
    } catch (_) {
      return baseDraft
    }
  }

  async function rescueReplyByMasterAgent({
    userText = '',
    channel = '',
    hintText = ''
  } = {}) {
    const q = String(userText || '').trim()
    if (!q) return ''
    try {
      const channelName = channel === 'feishu' ? '飞书' : (channel === 'telegram' ? 'Telegram' : (channel === 'dingtalk' ? '钉钉' : '当前渠道'))
      const prompt = [
        `用户请求：${q}`,
        hintText ? `已知上下文：${String(hintText || '').trim().slice(0, 800)}` : '',
        `渠道：${channelName}`,
        '请直接给出可执行结果，不要说“我来/我会/稍等/正在处理”。',
        '若信息不足，请明确列出最少需要的补充信息（不超过3条）。',
        '禁止输出工具调用协议、JSON、代码块。'
      ].filter(Boolean).join('\n')
      const out = await aiOrchestrator.generateText({
        prompt,
        systemPrompt: '你是主Agent执行兜底器。仅输出可直接发给用户的最终文本。'
      })
      return stripToolProtocolAndJsonNoise(String(out || ''), { dropJsonEnvelope: true }).trim()
    } catch (_) {
      return ''
    }
  }

  async function runMainAgentDirectRetry({
    aiGateway,
    baseRunSessionId,
    messages = [],
    projectPath = '',
    binding = {},
    chatId = '',
    appendCommandLine = () => {},
    scheduleStreamFlush = () => {}
  } = {}) {
    if (!aiGateway || typeof aiGateway.runChat !== 'function') {
      return { success: false, error: 'aiGateway 不可用' }
    }
    const retryRunSessionId = `${baseRunSessionId}-direct-${Date.now()}`
    const collectedScreenshots = []
    const completePromise = new Promise((resolve, reject) => {
      const fakeSender = {
        send: (channel, data) => {
          if (channel === 'ai-chat-complete' && data && data.messages) return resolve(data.messages)
          if (channel === 'ai-chat-error') return reject(new Error((data && data.error) || 'AI 出错'))
          if (channel === 'ai-chat-tool-call' && data && data.toolCall) {
            appendCommandLine(formatCommandFromToolCall(data.toolCall))
            scheduleStreamFlush()
          }
          if (channel === 'ai-chat-tool-result' && data) {
            const raw = data.result != null ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result)) : ''
            if (raw) {
              for (const item of parseScreenshotFromToolResult(raw)) collectedScreenshots.push(item)
            }
          }
        }
      }
      const retryMessages = [
        ...messages,
        {
          role: 'system',
          content: '上一轮子Agent返回空结果。请由主Agent直接调用工具完成任务。禁止调用 sessions_spawn。'
        }
      ]
      const runChatPayload = {
        sessionId: retryRunSessionId,
        messages: retryMessages,
        model: undefined,
        tools: getToolsForSubChat(),
        projectPath
      }
      if (binding.channel === 'feishu') {
        runChatPayload.feishuChatId = chatId
        const tenantKey = String(binding.feishuTenantKey || '').trim()
        if (tenantKey) runChatPayload.feishuTenantKey = tenantKey
        const docHost = String(binding.feishuDocHost || '').trim()
        if (docHost) runChatPayload.feishuDocHost = docHost
        const senderOpenId = String(binding.feishuSenderOpenId || '').trim()
        if (senderOpenId) runChatPayload.feishuSenderOpenId = senderOpenId
        const senderUserId = String(binding.feishuSenderUserId || '').trim()
        if (senderUserId) runChatPayload.feishuSenderUserId = senderUserId
      }
      aiGateway.runChat(runChatPayload, fakeSender).catch(reject)
    })
    try {
      const finalMessages = await completePromise
      const latestAssistant = [...finalMessages]
        .reverse()
        .find((m) => m && m.role === 'assistant' && getAssistantText(m).trim())
      const toSend = latestAssistant ? getAssistantText(latestAssistant) : ''
      const currentRound = getCurrentRoundMessages(finalMessages)
      const fallbackVisible = String(extractLatestVisibleText(currentRound) || '').trim()
      const rawText = toSend || fallbackVisible
      const { cleanedText: cleanedRaw, filePaths: pathFromText } = extractLocalResourceScreenshots(rawText)
      const screenshotsFromTools = extractScreenshotsFromMessages(currentRound)
      const cleanedText = stripFeishuScreenshotMisfireText(cleanedRaw)
      const fileResolveBase = (projectPath && path.isAbsolute(projectPath)) ? projectPath : getWorkspaceRoot()
      const images = []
      const files = []
      const seenImagePath = new Set()
      const seenFilePath = new Set()
      const seenBase64Head = new Set()
      for (const item of [...collectedScreenshots, ...screenshotsFromTools]) {
        if (item.path) {
          if (seenImagePath.has(item.path)) continue
          seenImagePath.add(item.path)
          images.push({ path: item.path })
        } else if (item.base64) {
          const head = item.base64.slice(0, 80)
          if (seenBase64Head.has(head)) continue
          seenBase64Head.add(head)
          images.push({ base64: item.base64 })
        }
      }
      for (const p of pathFromText) {
        if (seenImagePath.has(p)) continue
        seenImagePath.add(p)
        images.push({ path: p })
      }
      for (const p of extractLocalFilesFromText(cleanedText, fileResolveBase)) {
        if (isImageFilePath(p)) {
          if (seenImagePath.has(p)) continue
          seenImagePath.add(p)
          images.push({ path: p })
        } else {
          if (seenFilePath.has(p)) continue
          seenFilePath.add(p)
          files.push({ path: p })
        }
      }
      return { success: true, text: cleanedText, images, files }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return {
    refineReplyByMasterAgent,
    rescueReplyByMasterAgent,
    runMainAgentDirectRetry
  }
}

module.exports = { createImChannelMasterAgentFallbacks }
