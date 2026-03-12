/**
 * Telegram 聊天渠道适配器：长轮询 getUpdates，收到消息时 emit chat.message.received，回发时 sendMessage。
 * 需配置 bot_token、enabled；enabled 为 true 时 start 启动轮询。
 */
const https = require('https')
const { createInboundMessage, createSessionBinding } = require('../../core/message-model')
const conversationFile = require('../../ai/conversation-file')
const telegramSessionState = require('../../ai/telegram-session-state')
const telegramNotify = require('../../ai/telegram-notify')

const TELEGRAM_PROJECT = '__telegram__'
const API_BASE = 'api.telegram.org'
const POLL_TIMEOUT = 25
const MAX_UPDATE_ID_LEN = 1e6

/**
 * allowFrom：'*' 或 undefined/空 = 全部允许；数组 = 仅允许列表中的 chat_id
 */
function isAllowed(allowFrom, remoteId) {
  if (allowFrom == null || allowFrom === '*') return true
  if (!Array.isArray(allowFrom)) return true
  const id = String(remoteId || '').trim()
  if (!id) return false
  return allowFrom.some(a => String(a).trim() === id)
}

/**
 * @param {import('../../core/events')} eventBus
 * @param {(key: string) => any} [getChannelConfig] - 按 configKey 取配置，用于 allowFrom 校验
 * @returns {{ id: string; configKey: string; start: Function; stop: Function; isRunning: Function; send: Function }}
 */
function createTelegramAdapter(eventBus, getChannelConfig) {
  let polling = false
  let pollAbort = null
  let lastError = null
  let token = ''

  function apiRequest(method, body = {}) {
    return new Promise((resolve, reject) => {
      const path = `/bot${token}/${method}`
      const data = JSON.stringify(body)
      const opts = {
        host: API_BASE,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data, 'utf-8')
        }
      }
      const req = https.request(opts, (res) => {
        let buf = ''
        res.on('data', (ch) => { buf += ch })
        res.on('end', () => {
          try {
            const j = JSON.parse(buf)
            if (j.ok) resolve(j.result)
            else reject(new Error(j.description || 'Telegram API error'))
          } catch (e) {
            reject(e)
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')) })
      req.write(data)
      req.end()
    })
  }

  async function poll(offset) {
    if (!polling || !token) return
    try {
      const path = `/bot${token}/getUpdates?timeout=${POLL_TIMEOUT}${offset != null ? `&offset=${offset}` : ''}`
      const opts = { host: API_BASE, path }
      const req = https.request(opts, (res) => {
        let buf = ''
        res.on('data', (ch) => { buf += ch })
        res.on('end', () => {
          if (!polling) return
          try {
            const j = JSON.parse(buf)
            if (!j.ok) {
              lastError = j.description || 'getUpdates failed'
              setImmediate(() => poll(j.result && j.result.length ? j.result[j.result.length - 1].update_id + 1 : null))
              return
            }
            lastError = null
            const updates = j.result || []
            let nextOffset = offset
            for (const u of updates) {
              nextOffset = u.update_id + 1
              const msg = u.message
              if (!msg || !msg.chat) continue
              const chatId = String(msg.chat.id)
              const text = msg.text ? String(msg.text).trim() : ''
              const messageId = msg.message_id != null ? String(msg.message_id) : undefined
              handleUpdate(chatId, text, messageId)
            }
            if (nextOffset != null && nextOffset > MAX_UPDATE_ID_LEN) nextOffset = null
            setImmediate(() => poll(nextOffset))
          } catch (e) {
            lastError = e.message || String(e)
            setImmediate(() => poll(offset))
          }
        })
      })
      req.on('error', (e) => {
        lastError = e.message || String(e)
        if (polling) setImmediate(() => poll(offset))
      })
      req.setTimeout((POLL_TIMEOUT + 5) * 1000, () => { req.destroy() })
      req.end()
    } catch (e) {
      lastError = e.message || String(e)
      if (polling) setTimeout(() => poll(offset), 2000)
    }
  }

  function handleUpdate(chatId, text, messageId) {
    if (getChannelConfig) {
      const config = getChannelConfig('telegram')
      if (config && !isAllowed(config.allowFrom, chatId)) return
    }
    const isNew = /^\s*\/new\s*$/i.test(text) || text === '/new'
    const projectKey = conversationFile.hashProjectPath(TELEGRAM_PROJECT)
    let sessionId
    if (isNew) {
      sessionId = telegramSessionState.newSessionForChat(chatId)
      const now = new Date().toISOString()
      conversationFile.updateConversationMeta(projectKey, sessionId, {
        title: `Telegram: ${chatId}`,
        updatedAt: now,
        createdAt: now,
        messageCount: 0
      })
      apiRequest('sendMessage', { chat_id: chatId, text: '已开启新会话。' }).catch(() => {})
      return
    }
    sessionId = telegramSessionState.getOrCreateCurrentSessionId(chatId)
    const conv = conversationFile.loadConversation(projectKey, sessionId)
    if (!conv) {
      const now = new Date().toISOString()
      conversationFile.updateConversationMeta(projectKey, sessionId, {
        title: `Telegram: ${chatId}`,
        updatedAt: now,
        createdAt: now,
        messageCount: 0
      })
    }
    const message = createInboundMessage('telegram', chatId, text, messageId)
    const binding = createSessionBinding(sessionId, TELEGRAM_PROJECT, 'telegram', chatId)
    eventBus.emit('chat.message.received', { message, binding })
  }

  return {
    id: 'telegram',
    configKey: 'telegram',
    async start(config) {
      const cfg = config || {}
      token = (cfg.bot_token || '').trim()
      if (!token) throw new Error('请先填写 Telegram Bot Token')
      polling = true
      lastError = null
      poll(null)
    },
    async stop() {
      polling = false
    },
    isRunning() {
      return polling && !!token
    },
    getLastError() {
      return lastError
    },
    async send(binding, payload) {
      const chatId = binding.remoteId
      const text = (payload.text && payload.text.trim()) ? payload.text.trim() : '（无回复内容）'
      const maybeAudioText = payload && (payload.audio_text || payload.audioText)
      if (maybeAudioText && String(maybeAudioText).trim()) {
        const res = await telegramNotify.sendMessage({
          chat_id: chatId,
          text,
          audio_text: String(maybeAudioText).trim()
        })
        if (!res?.success) {
          await apiRequest('sendMessage', { chat_id: chatId, text: `${text}\n\n[语音发送失败: ${(res && res.message) || 'unknown'}]` }).catch(() => {})
        }
      } else {
        await apiRequest('sendMessage', { chat_id: chatId, text })
      }
      // Telegram sendPhoto 需 URL 或 file_id，暂不传 base64；若有图可后续用 multipart 上传
      if (payload.images && payload.images.length > 0) {
        await apiRequest('sendMessage', { chat_id: chatId, text: `[${payload.images.length} 张截图已生成，请在应用内查看]` }).catch(() => {})
      }
    }
  }
}

module.exports = { createTelegramAdapter }
