/**
 * Telegram 聊天渠道适配器：长轮询 getUpdates，收到消息时 emit chat.message.received，回发时 sendMessage。
 * 需配置 bot_token、enabled；enabled 为 true 时 start 启动轮询。
 */
const https = require('https')
const path = require('path')
const { createInboundMessage, createSessionBinding } = require('../../core/message-model')
const conversationFile = require('../../ai/conversation-file')
const telegramSessionState = require('../../ai/telegram-session-state')
const telegramNotify = require('../../ai/telegram-notify')
const { ingestRoundAttachments } = require('../../ai/attachment-ingest')
const { logger: appLogger } = require('../../app-logger')

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

function compactText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function extFromMime(mime = '') {
  const m = String(mime || '').toLowerCase()
  if (m.includes('mpeg')) return '.mp3'
  if (m.includes('ogg')) return '.ogg'
  if (m.includes('wav')) return '.wav'
  if (m.includes('aac')) return '.aac'
  if (m.includes('flac')) return '.flac'
  if (m.includes('webm')) return '.webm'
  if (m.includes('mp4')) return '.mp4'
  if (m.includes('jpeg')) return '.jpg'
  if (m.includes('png')) return '.png'
  return ''
}

function buildTelegramDisplayText(text, attachments = []) {
  const base = compactText(text || '')
  if (!Array.isArray(attachments) || attachments.length === 0) return base
  const lines = []
  for (const a of attachments) {
    if (!a) continue
    const type = a.type || 'file'
    lines.push(`[${type}] ${a.name || ''}`.trim())
    if (a.path) lines.push(`local_path: ${a.path}`)
  }
  const att = lines.join('\n')
  if (!base) return att || '[附件]'
  if (!att) return base
  return `${base}\n${att}`
}

function buildAttachmentPathContext(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  const out = [
    '[Inbound Attachment Paths]',
    '仅将以下 local_path 视为本轮有效附件；若用户要求读取/解读文件，优先使用这些路径。'
  ]
  let idx = 1
  for (const a of attachments) {
    if (!a || !a.path) continue
    out.push(`${idx}. [${a.type || 'file'}] ${a.name || path.basename(a.path)}`)
    out.push(`   local_path: ${a.path}`)
    idx++
  }
  return idx > 1 ? out.join('\n') : ''
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

  function downloadFileBuffer(filePath) {
    return new Promise((resolve, reject) => {
      const safe = String(filePath || '').replace(/^\/+/, '')
      const req = https.request({
        host: API_BASE,
        path: `/file/bot${token}/${safe}`,
        method: 'GET'
      }, (res) => {
        const chunks = []
        res.on('data', (ch) => chunks.push(ch))
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`download failed HTTP ${res.statusCode}`))
            return
          }
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(res.headers['content-type'] || '').trim()
          })
        })
      })
      req.on('error', reject)
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('download timeout')) })
      req.end()
    })
  }

  async function fetchRawAttachmentByFileId(fileId, fallbackName, fallbackMime) {
    if (!fileId) return null
    try {
      const file = await apiRequest('getFile', { file_id: fileId })
      const filePath = String(file?.file_path || '').trim()
      if (!filePath) return null
      const dl = await downloadFileBuffer(filePath)
      const guessedName = path.basename(filePath) || fallbackName || `file-${Date.now()}`
      const mime = dl.contentType || fallbackMime || 'application/octet-stream'
      return {
        name: guessedName,
        mime,
        size: dl.buffer.length,
        buffer: dl.buffer
      }
    } catch (e) {
      appLogger?.warn?.('[Telegram] 下载附件失败', { fileId: String(fileId), error: e.message || String(e) })
      return null
    }
  }

  async function collectRawAttachments(msg = {}) {
    const list = []
    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]
      const item = await fetchRawAttachmentByFileId(photo?.file_id, `photo-${Date.now()}.jpg`, 'image/jpeg')
      if (item) list.push(item)
    }
    if (msg.document && msg.document.file_id) {
      const ext = extFromMime(msg.document.mime_type)
      const defaultName = msg.document.file_name || `document-${Date.now()}${ext}`
      const item = await fetchRawAttachmentByFileId(msg.document.file_id, defaultName, msg.document.mime_type || 'application/octet-stream')
      if (item) {
        if (msg.document.file_name && !item.name) item.name = msg.document.file_name
        if (msg.document.mime_type && !item.mime) item.mime = msg.document.mime_type
        list.push(item)
      }
    }
    if (msg.audio && msg.audio.file_id) {
      const ext = extFromMime(msg.audio.mime_type)
      const defaultName = msg.audio.file_name || `audio-${Date.now()}${ext || '.mp3'}`
      const item = await fetchRawAttachmentByFileId(msg.audio.file_id, defaultName, msg.audio.mime_type || 'audio/mpeg')
      if (item) list.push(item)
    }
    if (msg.voice && msg.voice.file_id) {
      const item = await fetchRawAttachmentByFileId(msg.voice.file_id, `voice-${Date.now()}.ogg`, 'audio/ogg')
      if (item) list.push(item)
    }
    return list
  }

  async function poll(offset) {
    if (!polling || !token) return
    try {
      const path = `/bot${token}/getUpdates?timeout=${POLL_TIMEOUT}${offset != null ? `&offset=${offset}` : ''}`
      const opts = { host: API_BASE, path }
      const req = https.request(opts, (res) => {
        let buf = ''
        res.on('data', (ch) => { buf += ch })
        res.on('end', async () => {
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
              const messageId = msg.message_id != null ? String(msg.message_id) : undefined
              await handleUpdate(chatId, msg, messageId)
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

  async function handleUpdate(chatId, msg, messageId) {
    if (getChannelConfig) {
      const config = getChannelConfig('telegram')
      if (config && !isAllowed(config.allowFrom, chatId)) return
    }
    const text = compactText(msg?.text || msg?.caption || '')
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
    const rawAttachments = await collectRawAttachments(msg)
    let normalizedAttachments = []
    let attachmentContextText = ''
    if (rawAttachments.length > 0) {
      const ingestRes = await ingestRoundAttachments({
        sessionId,
        source: 'telegram',
        attachments: rawAttachments
      })
      normalizedAttachments = (ingestRes.accepted || []).map(item => ({
        type: item.kind === 'image' ? 'image' : (item.kind === 'audio' ? 'audio' : 'file'),
        path: item.localPath,
        name: item.name || ''
      }))
      attachmentContextText = ingestRes.contextText || ''
    }
    const attachmentPathContext = buildAttachmentPathContext(normalizedAttachments)
    const inboundText = [text, attachmentPathContext, attachmentContextText].filter(Boolean).join('\n\n').trim() || '[附件]'
    const message = createInboundMessage('telegram', chatId, inboundText, messageId, normalizedAttachments)
    message.metadata = {
      displayText: buildTelegramDisplayText(text, normalizedAttachments),
      attachments: normalizedAttachments
    }
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
