'use strict'

/**
 * 注册 `chat.session.completed`：出站产物登记、会话侧记忆、经 chatChannelRegistry 发送；失败时飞书兜底文案。
 */
function registerChannelsSessionCompletedSend(deps) {
  const {
    eventBus,
    chatChannelRegistry,
    registerArtifactsFromItems,
    rememberSessionArtifacts,
    appLogger,
    feishuNotify
  } = deps

  async function handleChatSessionCompleted(payload) {
    const { binding, payload: outPayload } = payload || {}
    if (!binding || !binding.channel) return
    if (binding.sessionId && outPayload && (Array.isArray(outPayload.images) || Array.isArray(outPayload.files))) {
      try {
        const reg = registerArtifactsFromItems({
          images: Array.isArray(outPayload.images) ? outPayload.images : [],
          files: Array.isArray(outPayload.files) ? outPayload.files : [],
          context: {
            source: `${binding.channel}_outbound`,
            channel: binding.channel,
            sessionId: String(binding.sessionId || ''),
            runSessionId: '',
            messageId: '',
            chatId: String(binding.remoteId || ''),
            role: 'assistant'
          }
        })
        outPayload.images = reg.images
        outPayload.files = reg.files
      } catch (e) {
        appLogger?.warn?.('[ArtifactRegistry] register outbound payload failed', { error: e.message || String(e) })
      }
    }
    try {
      if (binding.sessionId && outPayload && (Array.isArray(outPayload.images) || Array.isArray(outPayload.files))) {
        rememberSessionArtifacts(binding.sessionId, outPayload)
      }
    } catch (_) {}
    const adapter = chatChannelRegistry.get(binding.channel)
    if (adapter && adapter.send) {
      const maxAttempts = 2
      let lastErr = null
      for (let i = 1; i <= maxAttempts; i++) {
        try {
          const res = await adapter.send(binding, outPayload || {})
          if (res && res.success === false) {
            throw new Error(res.message || res.textMessage || 'channel_send_failed')
          }
          return
        } catch (e) {
          lastErr = e
          appLogger?.warn?.('[ChatChannel] send failed', {
            channel: binding.channel,
            attempt: i,
            maxAttempts,
            remoteId: String(binding.remoteId || ''),
            error: e?.message || String(e)
          })
          if (i < maxAttempts) {
            await new Promise((r) => setTimeout(r, 900))
          }
        }
      }
      if (binding.channel === 'feishu') {
        try {
          const chatId = String(binding.remoteId || '').trim()
          if (chatId) {
            await feishuNotify.sendMessage({
              chat_id: chatId,
              text: `系统提示：本次结果同步到飞书失败（${String(lastErr?.message || '未知错误').slice(0, 160)}）。请稍后重试。`
            })
          }
        } catch (_) {}
      }
      console.error('[ChatChannel] send failed:', lastErr?.message || String(lastErr || 'unknown'))
    }
  }

  eventBus.on('chat.session.completed', handleChatSessionCompleted)
}

module.exports = { registerChannelsSessionCompletedSend }
