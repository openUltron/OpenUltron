/**
 * 对话工具列表、视觉检测、附件上传
 */
function registerAiToolsAttachmentsIpc (deps) {
  const {
    registerChannel,
    getToolsForChat,
    modelSupportsVision,
    ingestRoundAttachments,
    path,
    fs,
    artifactRegistry,
    appLogger
  } = deps

  registerChannel('ai-get-tools', async () => {
    return { success: true, tools: getToolsForChat() }
  })

  registerChannel('ai-model-supports-vision', async (event, { model, providerBaseUrl } = {}) => {
    try {
      const supportsVision = modelSupportsVision({ model, providerBaseUrl })
      return { success: true, supportsVision }
    } catch (e) {
      return { success: false, supportsVision: false, message: e.message || 'detect failed' }
    }
  })

  registerChannel('ai-upload-attachments', async (event, { sessionId, source, attachments, imageMode }) => {
    try {
      if (!sessionId || String(sessionId).trim() === '') {
        return { success: false, message: 'missing sessionId' }
      }
      const result = await ingestRoundAttachments({
        sessionId: String(sessionId).trim(),
        source: source || 'main',
        attachments: Array.isArray(attachments) ? attachments : [],
        imageMode: imageMode === 'vision' ? 'vision' : 'ocr'
      })
      try {
        const accepted = Array.isArray(result?.accepted) ? result.accepted : []
        for (const item of accepted) {
          const p = String(item?.localPath || '').trim()
          if (!p || !path.isAbsolute(p) || !fs.existsSync(p)) continue
          artifactRegistry.registerFileArtifact({
            path: p,
            filename: item?.name || path.basename(p),
            kind: item?.kind || 'file',
            source: 'app_upload',
            channel: 'app',
            sessionId: String(sessionId).trim(),
            messageId: '',
            chatId: '',
            role: 'user'
          })
        }
      } catch (e) {
        appLogger?.warn?.('[ArtifactRegistry] register app uploads failed', { error: e.message || String(e) })
      }
      return result
    } catch (e) {
      return { success: false, message: e.message || 'attachment ingest failed' }
    }
  })
}

module.exports = { registerAiToolsAttachmentsIpc }
