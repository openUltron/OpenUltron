'use strict'

const { formatCommandFromToolCall } = require('./im-tool-call-format')

/**
 * IM / Gateway 侧：主 Agent 协调 run 空结果时的直跑重试。
 */
function createImChannelMasterAgentFallbacks(deps) {
  const {
    stripToolProtocolAndJsonNoise,
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
    runMainAgentDirectRetry
  }
}

module.exports = { createImChannelMasterAgentFallbacks }
