/**
 * createGateway 副作用：工具截图缓冲、应用内飞书会话完成回发、主窗口转发、会话落库
 */
const { FEISHU_PROJECT, TELEGRAM_PROJECT, DINGTALK_PROJECT } = require('./session-constants')

/**
 * @param {object} deps
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {{ emit: (ev: string, p: any) => void }} deps.eventBus
 * @param {object} deps.conversationFile
 * @param {(raw: string) => { path?: string, base64?: string }[]} deps.parseScreenshotFromToolResult
 * @param {(t: string) => { cleanedText: string, filePaths: string[] }} deps.extractLocalResourceScreenshots
 * @param {(m: any[]) => string} deps.extractLatestSessionsSpawnResult
 * @param {(m: any[]) => string} deps.extractLatestVisibleText
 * @param {(t: string) => string} deps.stripFeishuScreenshotMisfireText
 * @param {(t: string, b: string) => string[]} deps.extractLocalFilesFromText
 * @param {(p: string) => boolean} deps.isImageFilePath
 * @param {() => string} deps.getWorkspaceRoot
 * @param {(m: any[], ctx: object) => any[]} deps.registerReferenceArtifactsFromMessages
 * @param {(t: string, o?: object) => string} deps.stripToolProtocolAndJsonNoise
 * @param {(t: string) => boolean} deps.hasUsefulVisibleResult
 * @param {(o: object) => Promise<string>} deps.rescueReplyByMasterAgent
 * @param {(t: string, o?: object) => string} deps.stripFalseDeliveredClaims
 * @param {(images: any[], files: any[]) => any[]} deps.normalizeArtifactsFromItems
 * @param {(m: any[]) => any[]} deps.stripToolExecutionFromMessages
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWindow
 * @param {{ info?: Function, warn?: Function }} [deps.appLogger]
 * @param {(t: string) => string} deps.redactSensitiveText
 * @param {(m: any[], sid: string) => void} deps.persistToolArtifactsToRegistry
 * @param {(pp: string, sid: string, m: any[]) => any[]} deps.mergeCompactedConversationMessages
 * @param {(sid: string) => boolean} deps.isRunSessionId
 */
function createGatewaySideEffectHandlers (deps) {
  const {
    BrowserWindow,
    eventBus,
    conversationFile,
    parseScreenshotFromToolResult,
    extractLocalResourceScreenshots,
    extractLatestSessionsSpawnResult,
    extractLatestVisibleText,
    stripFeishuScreenshotMisfireText,
    extractLocalFilesFromText,
    isImageFilePath,
    getWorkspaceRoot,
    registerReferenceArtifactsFromMessages,
    stripToolProtocolAndJsonNoise,
    hasUsefulVisibleResult,
    rescueReplyByMasterAgent,
    stripFalseDeliveredClaims,
    normalizeArtifactsFromItems,
    stripToolExecutionFromMessages,
    getMainWindow,
    appLogger,
    redactSensitiveText,
    persistToolArtifactsToRegistry,
    mergeCompactedConversationMessages,
    isRunSessionId
  } = deps

  const sessionScreenshots = new Map()

  function onToolResult (sessionId, data) {
    const raw = data.result != null ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result)) : ''
    if (!raw) return
    const items = parseScreenshotFromToolResult(raw)
    if (items.length === 0) return
    const list = sessionScreenshots.get(sessionId) || []
    list.push(...items)
    sessionScreenshots.set(sessionId, list)
  }

  async function onChatCompleteAny (sessionId, projectPath, data, fromAppWindow) {
    if (!fromAppWindow || projectPath !== FEISHU_PROJECT) return
    const feishuProjectKey = conversationFile.hashProjectPath(FEISHU_PROJECT)
    const conv = conversationFile.loadConversation(feishuProjectKey, sessionId)
    const chatId = conv && conv.feishuChatId ? conv.feishuChatId : null
    if (!chatId) return
    const list = sessionScreenshots.get(sessionId) || []
    sessionScreenshots.delete(sessionId)
    const last = (data.messages && Array.isArray(data.messages))
      ? [...data.messages].reverse().find(m => m.role === 'assistant' && (() => {
        const c = m.content
        const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(x => (x && x.text) || '').join('') : '')
        return t.trim()
      })())
      : null
    let lastText = ''
    if (last && last.content) {
      lastText = typeof last.content === 'string' ? last.content : (last.content && Array.isArray(last.content) ? last.content.map(c => (c && c.text) || '').join('') : '')
    }
    const { cleanedText: cleanedRaw, filePaths: pathsFromText } = extractLocalResourceScreenshots(lastText)
    const spawnResultText = extractLatestSessionsSpawnResult(data.messages || [])
    const latestVisibleText = String(extractLatestVisibleText(data.messages || []) || '').trim()
    const { cleanedText: spawnCleanedRaw, filePaths: spawnPathsFromText } = extractLocalResourceScreenshots(spawnResultText || '')
    const cleanedFeishu = (stripFeishuScreenshotMisfireText(cleanedRaw) || '').trim()
    const cleanedSpawn = (stripFeishuScreenshotMisfireText(spawnCleanedRaw) || '').trim()
    const fileResolveBase = getWorkspaceRoot()
    const imageItems = []
    const fileItems = []
    const seenPath = new Set()
    const seenBase64Head = new Set()
    const seenFilePath = new Set()
    for (const item of list) {
      if (item.path && !seenPath.has(item.path)) { seenPath.add(item.path); imageItems.push({ path: item.path }) } else if (item.base64) {
        const h = item.base64.slice(0, 80)
        if (!seenBase64Head.has(h)) { seenBase64Head.add(h); imageItems.push({ base64: item.base64 }) }
      }
    }
    for (const p of pathsFromText) {
      if (!seenPath.has(p)) { seenPath.add(p); imageItems.push({ path: p }) }
    }
    for (const p of spawnPathsFromText) {
      if (!seenPath.has(p)) { seenPath.add(p); imageItems.push({ path: p }) }
    }
    for (const p of extractLocalFilesFromText(cleanedRaw, fileResolveBase)) {
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
    for (const p of extractLocalFilesFromText(cleanedSpawn, fileResolveBase)) {
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
    const feishuDocHost = String((conv && conv.feishuDocHost) || '').trim()
    registerReferenceArtifactsFromMessages(data.messages || [], {
      source: 'feishu_assistant',
      channel: 'feishu',
      sessionId: String(sessionId || ''),
      runSessionId: '',
      messageId: '',
      chatId: String(chatId || ''),
      docHost: feishuDocHost,
      role: 'assistant'
    })
    const hasSpawnCall = Array.isArray(data.messages) && data.messages.some(m =>
      m && m.role === 'assistant' && Array.isArray(m.tool_calls) &&
      m.tool_calls.some(tc => tc?.function?.name === 'sessions_spawn')
    )
    const visibleResultText = String(cleanedFeishu || cleanedSpawn || latestVisibleText || '').trim()
    let rawTextToSend = visibleResultText || (
      imageItems.length > 0
        ? '截图已发至当前会话。'
        : (fileItems.length > 0 ? '文件已发至当前会话。' : '任务已执行完成，但未生成可展示的文本结果。')
    )
    if (hasSpawnCall && imageItems.length === 0 && fileItems.length === 0 && !hasUsefulVisibleResult(visibleResultText)) {
      const userText = (() => {
        const msgs = Array.isArray(conv?.messages) ? conv.messages : []
        const u = [...msgs].reverse().find((m) => m && m.role === 'user')
        return u ? String(u.content || '').trim() : ''
      })()
      const rescued = await rescueReplyByMasterAgent({
        userText,
        channel: 'feishu',
        hintText: String(visibleResultText || '').trim()
      })
      rawTextToSend = String(rescued || '').trim() || '任务仍在处理中，请稍后再试。'
    }
    const safeRawTextToSend = stripToolProtocolAndJsonNoise(rawTextToSend, { dropJsonEnvelope: true })
    const textToSend = stripFalseDeliveredClaims(safeRawTextToSend, {
      hasImages: imageItems.length > 0,
      hasFiles: fileItems.length > 0,
      channel: 'feishu'
    }) || (
      imageItems.length > 0
        ? '截图已发至当前会话。'
        : (fileItems.length > 0 ? '文件已发至当前会话。' : '任务已执行完成，但未生成可展示的文本结果。')
    )
    const outBinding = { sessionId, projectPath: FEISHU_PROJECT, channel: 'feishu', remoteId: chatId, feishuChatId: chatId }
    const outPayload = { text: textToSend, images: imageItems, files: fileItems }
    try {
      const current = conversationFile.loadConversation(feishuProjectKey, sessionId)
      const existing = Array.isArray(current?.messages) ? current.messages : []
      const artifacts = normalizeArtifactsFromItems(imageItems, fileItems)
      const assistantMsg = {
        role: 'assistant',
        content: textToSend,
        ...(artifacts.length > 0 ? { metadata: { artifacts } } : {})
      }
      conversationFile.saveConversation(feishuProjectKey, {
        id: sessionId,
        messages: stripToolExecutionFromMessages([...existing, assistantMsg]),
        projectPath: FEISHU_PROJECT,
        feishuChatId: String(chatId || ''),
        ...(feishuDocHost ? { feishuDocHost } : {})
      })
      const win = getMainWindow()
      if (win && win.webContents) {
        win.webContents.send('feishu-session-updated', { sessionId })
      }
    } catch (e) {
      appLogger?.warn?.('[Feishu] 应用内会话落库失败', { sessionId: String(sessionId || ''), error: e.message || String(e) })
    }
    appLogger?.info?.('[Feishu] 回发载荷', {
      sessionId: String(sessionId || ''),
      chatId: String(chatId || ''),
      textLen: String(textToSend || '').length,
      textPreview: redactSensitiveText(String(textToSend || '').slice(0, 200)),
      imageCount: imageItems.length,
      fileCount: fileItems.length,
      imagePaths: imageItems.map((x) => (x && x.path) ? String(x.path) : '').filter(Boolean).slice(0, 8),
      filePaths: fileItems.map((x) => (x && x.path) ? String(x.path) : '').filter(Boolean).slice(0, 8)
    })
    if (imageItems.length > 0) appLogger?.info?.('[Feishu] 应用内飞书会话完成，带图回发', { imageCount: imageItems.length })
    eventBus.emit('chat.session.completed', { binding: outBinding, payload: outPayload })
  }

  function forwardToMainWindow (sessionId, _projectPath, channel, data) {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, { ...data, sessionId })
    }
  }

  function onRemoteUserMessage (sessionId, projectPath, userContent) {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('gateway-remote-user-message', { sessionId, projectPath, userContent })
    }
  }

  function onChatComplete (sessionId, messages, projectPath) {
    try {
      if (Array.isArray(messages) && messages.length) persistToolArtifactsToRegistry(messages, sessionId)
      const toSave = Array.isArray(messages)
        ? mergeCompactedConversationMessages(projectPath, sessionId, messages)
        : []
      if (!toSave.length) return
      if ((projectPath === FEISHU_PROJECT || projectPath === TELEGRAM_PROJECT || projectPath === DINGTALK_PROJECT) && isRunSessionId(sessionId)) return
      const projectKey = conversationFile.hashProjectPath(projectPath)
      conversationFile.saveConversation(projectKey, { id: sessionId, messages: toSave, projectPath })
      console.log('[Gateway] 会话已保存:', sessionId, '条数:', toSave.length)
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (win && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('gateway-session-updated', { sessionId, projectPath })
      }
    } catch (e) {
      console.error('[Gateway] onChatComplete 保存失败:', e.message)
    }
  }

  return {
    onToolResult,
    onChatCompleteAny,
    forwardToMainWindow,
    onRemoteUserMessage,
    onChatComplete
  }
}

module.exports = { createGatewaySideEffectHandlers }
