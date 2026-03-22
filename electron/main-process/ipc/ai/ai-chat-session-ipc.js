/**
 * Gateway 对话启停、会话视图注册、编辑器文件回调
 */
const sessionRegistry = require('../../../ai/session-registry')

function registerAiChatSessionIpc (deps) {
  const { registerChannel, aiGateway, pendingEditorFilesRequests } = deps

  registerChannel('ai-chat-start', async (event, { sessionId, messages, model, tools, projectPath, panelId, stopPrevious }) => {
    try {
      if (stopPrevious && sessionId) aiGateway.stopChat(sessionId)
      const sender = event?.sender ?? null
      const ipcSender = sender ? { send: (ch, d) => sender.send(ch, d) } : null
      const promise = aiGateway.runChat(
        { sessionId, messages, model, tools, projectPath: projectPath || '', panelId: panelId || undefined, fromAppWindow: true },
        ipcSender
      )
      if (sender) {
        promise.catch(e => console.error('[AI] startChat error:', e.message))
        return { success: true }
      }
      const result = await promise
      return result != null ? result : { success: true }
    } catch (error) {
      return { success: false, message: error.message, error: error.message }
    }
  })

  registerChannel('ai-chat-stop', async (event, { sessionId }) => {
    aiGateway.stopChat(sessionId)
    return { success: true }
  })

  registerChannel('ai-session-register-view', (event, { sessionId, projectPath, projectName, sessionTitle, model, apiBaseUrl, lastContent }) => {
    const r = sessionRegistry.registerView(sessionId, { projectPath, projectName, sessionTitle, model, apiBaseUrl, lastContent, viewSender: event?.sender ?? null })
    return r && typeof r.success === 'boolean' ? r : { success: true }
  })

  registerChannel('ai-session-unregister-view', (event, { sessionId }) => {
    if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
      return { success: false, message: '无权操作该会话' }
    }
    sessionRegistry.unregisterView(sessionId)
    return { success: true }
  })

  registerChannel('ai-session-update-meta', (event, { sessionId, model, projectName, sessionTitle, apiBaseUrl, lastContent }) => {
    if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
      return { success: false, message: '无权操作该会话' }
    }
    sessionRegistry.updateMeta(sessionId, { model, projectName, sessionTitle, apiBaseUrl, lastContent })
    return { success: true }
  })

  registerChannel('ai-session-list', (event) => {
    const sender = event?.sender ?? null
    const sessions = sessionRegistry.getSnapshot().filter(s => sessionRegistry.isOwnedBy(s.sessionId, sender))
    return { success: true, sessions }
  })

  registerChannel('ai-session-pause', (event, { sessionId }) => {
    if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
      return { success: false, message: '无权操作该会话' }
    }
    const ok = sessionRegistry.pause(sessionId)
    return { success: ok }
  })

  registerChannel('ai-session-resume', (event, { sessionId }) => {
    if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
      return { success: false, message: '无权操作该会话' }
    }
    const ok = sessionRegistry.resume(sessionId)
    return { success: ok }
  })

  registerChannel('ai-session-stop', (event, { sessionId }) => {
    if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
      return { success: false, message: '无权操作该会话' }
    }
    const ok = sessionRegistry.stop(sessionId)
    return { success: ok }
  })

  registerChannel('ai-session-inject', (event, { sessionId, message }) => {
    if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
      return { success: false, message: '无权操作该会话' }
    }
    const ok = sessionRegistry.injectMessage(sessionId, message)
    return { success: ok }
  })

  registerChannel('ai-editor-open-files-response', (event, { requestId, files }) => {
    const pending = pendingEditorFilesRequests.get(requestId)
    if (pending) {
      pending.resolve({
        success: true,
        files: files || [],
        count: (files || []).length
      })
    }
    return { ok: true }
  })
}

module.exports = { registerAiChatSessionIpc }
