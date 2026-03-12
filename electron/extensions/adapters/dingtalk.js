/**
 * DingTalk 聊天渠道适配器：
 * - 入站由 HTTP 回调触发 receive(payload)
 * - 出站走 dingtalk-notify（文本/语音）
 */
const { createInboundMessage, createSessionBinding } = require('../../core/message-model')
const conversationFile = require('../../ai/conversation-file')
const dingtalkSessionState = require('../../ai/dingtalk-session-state')
const dingtalkNotify = require('../../ai/dingtalk-notify')
const { ingestRoundAttachments } = require('../../ai/attachment-ingest')
const http = require('http')
const https = require('https')
const path = require('path')

const DINGTALK_PROJECT = '__dingtalk__'
const HISTORY_CMD_RE = /^\s*\/(history|memory)\s*$/i
const repliedIds = new Set()
const REPLIED_MAX = 500

function compactText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function isAllowed(allowFrom, remoteId) {
  if (allowFrom == null || allowFrom === '*') return true
  if (!Array.isArray(allowFrom)) return true
  const id = String(remoteId || '').trim()
  if (!id) return false
  return allowFrom.some(a => String(a).trim() === id)
}

function readField(obj, fields) {
  for (const key of fields) {
    const value = key.split('.').reduce((acc, seg) => (acc && acc[seg] != null ? acc[seg] : undefined), obj)
    if (value != null && value !== '') return value
  }
  return ''
}

function parseContentText(content) {
  if (content == null) return ''
  if (typeof content === 'string') {
    const t = content.trim()
    if (!t) return ''
    try {
      const j = JSON.parse(t)
      if (j && typeof j === 'object') {
        return compactText(j.text?.content || j.content || j.title || '')
      }
    } catch (_) {}
    return compactText(t)
  }
  if (typeof content === 'object') {
    return compactText(content.text?.content || content.content || content.title || '')
  }
  return ''
}

function collectInboundAttachmentCandidates(data = {}) {
  const out = []
  const content = data.content && typeof data.content === 'object'
    ? data.content
    : (() => {
        try {
          return typeof data.content === 'string' ? JSON.parse(data.content) : {}
        } catch (_) {
          return {}
        }
      })()
  const candidates = [
    {
      type: 'image',
      url: content?.downloadUrl || content?.download_url || content?.picUrl || content?.pic_url || '',
      name: content?.fileName || content?.filename || content?.name || `image-${Date.now()}.jpg`,
      mime: content?.mimeType || content?.contentType || 'image/jpeg'
    },
    {
      type: 'file',
      url: content?.fileUrl || content?.file_url || content?.downloadUrl || content?.download_url || '',
      name: content?.fileName || content?.filename || content?.name || `file-${Date.now()}.bin`,
      mime: content?.mimeType || content?.contentType || 'application/octet-stream'
    },
    {
      type: 'audio',
      url: content?.audioUrl || content?.audio_url || content?.voiceUrl || content?.voice_url || '',
      name: content?.fileName || content?.filename || content?.name || `audio-${Date.now()}.ogg`,
      mime: content?.mimeType || content?.contentType || 'audio/ogg'
    }
  ]
  for (const c of candidates) {
    const u = String(c.url || '').trim()
    if (!u || !/^https?:\/\//i.test(u)) continue
    out.push({ ...c, url: u })
  }
  return out
}

function downloadByUrl(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString)
    const client = u.protocol === 'http:' ? http : https
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search || ''}`,
      method: 'GET'
    }, (res) => {
      const chunks = []
      res.on('data', (ch) => chunks.push(ch))
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: String(res.headers['content-type'] || '').trim()
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function buildAttachmentPathContext(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  const lines = [
    '[Inbound Attachment Paths]',
    '仅将以下 local_path 视为本轮有效附件；若用户要求读取文件，优先使用这些路径。'
  ]
  let idx = 1
  for (const a of attachments) {
    if (!a || !a.path) continue
    lines.push(`${idx}. [${a.type || 'file'}] ${a.name || path.basename(a.path)}`)
    lines.push(`   local_path: ${a.path}`)
    idx++
  }
  return idx > 1 ? lines.join('\n') : ''
}

function buildDisplayText(baseText, attachments = []) {
  const base = compactText(baseText || '')
  if (!Array.isArray(attachments) || attachments.length === 0) return base
  const lines = []
  for (const a of attachments) {
    if (!a) continue
    lines.push(`[${a.type || 'file'}] ${a.name || ''}`.trim())
    if (a.path) lines.push(`local_path: ${a.path}`)
  }
  const att = lines.join('\n')
  if (!base) return att || '[附件]'
  return `${base}\n${att}`
}

function normalizeInbound(payload) {
  const body = payload && typeof payload === 'object' ? payload : {}
  const data = body.data && typeof body.data === 'object'
    ? body.data
    : (body.event && typeof body.event === 'object' ? body.event : body)
  const headers = body.headers && typeof body.headers === 'object' ? body.headers : {}

  const messageType = String(readField(data, ['msgtype', 'msgType', 'messageType']) || '').toLowerCase()
  const conversationType = String(readField(data, ['conversationType']) || '')
  const conversationId = String(readField(data, ['conversationId', 'openConversationId', 'conversation_id']) || '').trim()
  const openConversationId = String(readField(data, ['openConversationId', 'conversationId']) || '').trim()
  const senderId = String(readField(data, ['senderId', 'senderStaffId', 'senderUserId']) || '').trim()
  const senderName = String(readField(data, ['senderNick', 'senderName']) || '').trim()
  const sessionWebhook = String(readField(data, ['sessionWebhook', 'session_webhook']) || '').trim()
  const robotCode = String(readField(data, ['robotCode', 'chatbotUserId']) || '').trim()

  let text = compactText(readField(data, ['text.content', 'text', 'content.text', 'content']) || '')
  if (!text) text = parseContentText(data.content)

  // 非文本消息回调：尽可能给出可读占位，避免直接吞掉
  if (!text && messageType && messageType !== 'text') {
    if (messageType.includes('image') || messageType === 'picture') text = '[图片]'
    else if (messageType.includes('file')) text = '[文件]'
    else if (messageType.includes('audio') || messageType.includes('voice')) text = '[语音]'
    else text = `[${messageType}]`
  }

  const messageId = String(readField(data, ['msgId', 'messageId']) || headers.eventId || body.event_id || '').trim()
  const mentioned = typeof data.isInAtList === 'boolean'
    ? data.isInAtList
    : (Array.isArray(data.atUsers) ? data.atUsers.length > 0 : false)
  const requireMention = conversationType === '2' // 2 = group

  const remoteId = conversationId || senderId
  const attachmentCandidates = collectInboundAttachmentCandidates(data)
  return {
    remoteId,
    text,
    messageId,
    conversationType,
    requireMention,
    mentioned,
    sessionWebhook,
    robotCode,
    openConversationId,
    senderName,
    attachmentCandidates
  }
}

function createDingtalkAdapter(eventBus, getChannelConfig) {
  let running = false
  let lastError = null

  async function receive(payload) {
    const normalized = normalizeInbound(payload)
    const remoteId = normalized.remoteId
    if (!remoteId) return { ok: true, skipped: true, reason: 'missing remote id' }
    if (!normalized.text && (!normalized.attachmentCandidates || normalized.attachmentCandidates.length === 0)) {
      return { ok: true, skipped: true, reason: 'empty content' }
    }

    if (normalized.messageId) {
      const before = repliedIds.size
      repliedIds.add(normalized.messageId)
      if (repliedIds.size === before) return { ok: true, skipped: true, reason: 'duplicated message' }
      if (repliedIds.size > REPLIED_MAX) {
        const arr = Array.from(repliedIds)
        arr.slice(0, REPLIED_MAX / 2).forEach(id => repliedIds.delete(id))
      }
    }

    const cfg = getChannelConfig ? getChannelConfig('dingtalk') : null
    if (cfg && !isAllowed(cfg.allowFrom, remoteId)) {
      return { ok: true, skipped: true, reason: 'not in allowFrom' }
    }

    // 群聊：若平台明确给出 at 列表/标记，且本次未@机器人，则跳过
    if (normalized.requireMention && !normalized.mentioned && payload?.data && (payload.data.isInAtList !== undefined || Array.isArray(payload.data.atUsers))) {
      return { ok: true, skipped: true, reason: 'group message without mention' }
    }

    const text = normalized.text
    const isNew = /^\s*\/new\s*$/i.test(text)
    const projectKey = conversationFile.hashProjectPath(DINGTALK_PROJECT)
    let sessionId = ''

    if (isNew) {
      sessionId = dingtalkSessionState.newSessionForConversation(remoteId)
      const now = new Date().toISOString()
      conversationFile.updateConversationMeta(projectKey, sessionId, {
        title: `钉钉: ${String(remoteId).slice(0, 20)}`,
        updatedAt: now,
        createdAt: now,
        messageCount: 0
      })
      await dingtalkNotify.sendMessage({
        session_webhook: normalized.sessionWebhook,
        open_conversation_id: normalized.openConversationId || remoteId,
        robot_code: normalized.robotCode,
        text: '已开启新会话。'
      }).catch(() => {})
      return { ok: true, skipped: true, reason: 'new session created' }
    }

    if (HISTORY_CMD_RE.test(text || '')) {
      await dingtalkNotify.sendMessage({
        session_webhook: normalized.sessionWebhook,
        open_conversation_id: normalized.openConversationId || remoteId,
        robot_code: normalized.robotCode,
        text: '钉钉通道暂不支持 /history；你可以发送 /new 开启新会话。'
      }).catch(() => {})
      return { ok: true, skipped: true, reason: 'history command consumed' }
    }

    sessionId = dingtalkSessionState.getOrCreateCurrentSessionId(remoteId)
    const conv = conversationFile.loadConversation(projectKey, sessionId)
    if (!conv) {
      const now = new Date().toISOString()
      conversationFile.updateConversationMeta(projectKey, sessionId, {
        title: `钉钉: ${String(remoteId).slice(0, 20)}`,
        updatedAt: now,
        createdAt: now,
        messageCount: 0
      })
    }

    const rawAttachments = []
    for (const candidate of normalized.attachmentCandidates || []) {
      try {
        const dl = await downloadByUrl(candidate.url)
        rawAttachments.push({
          name: candidate.name || path.basename(candidate.url),
          mime: dl.contentType || candidate.mime || 'application/octet-stream',
          size: dl.buffer.length,
          buffer: dl.buffer
        })
      } catch (_) {}
    }
    let normalizedAttachments = []
    let attachmentContextText = ''
    if (rawAttachments.length > 0) {
      const ingestRes = await ingestRoundAttachments({
        sessionId,
        source: 'dingtalk',
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
    const message = createInboundMessage('dingtalk', remoteId, inboundText, normalized.messageId, normalizedAttachments)
    message.metadata = {
      displayText: buildDisplayText(text, normalizedAttachments),
      senderName: normalized.senderName || '',
      attachments: normalizedAttachments
    }
    const binding = createSessionBinding(sessionId, DINGTALK_PROJECT, 'dingtalk', remoteId)
    binding.session_webhook = normalized.sessionWebhook || ''
    binding.open_conversation_id = normalized.openConversationId || remoteId
    binding.robot_code = normalized.robotCode || ''

    eventBus.emit('chat.message.received', { message, binding })
    return { ok: true }
  }

  return {
    id: 'dingtalk',
    configKey: 'dingtalk',
    async start(config) {
      const cfg = config || {}
      if (!cfg.receive_enabled) {
        running = false
        lastError = null
        return
      }
      running = true
      lastError = null
    },
    async stop() {
      running = false
    },
    isRunning() {
      return running
    },
    getLastError() {
      return lastError
    },
    async receive(payload) {
      try {
        return await receive(payload)
      } catch (e) {
        lastError = e.message || String(e)
        return { ok: false, error: lastError }
      }
    },
    async send(binding, payload) {
      const text = compactText(payload?.text || '') || '（无回复内容）'
      const options = {
        text,
        audio_text: payload?.audio_text || payload?.audioText || '',
        audio_voice: payload?.audio_voice,
        audio_lang: payload?.audio_lang,
        audio_rate: payload?.audio_rate,
        audio_volume: payload?.audio_volume,
        audio_pitch: payload?.audio_pitch,
        session_webhook: binding?.session_webhook,
        open_conversation_id: binding?.open_conversation_id || binding?.remoteId,
        robot_code: binding?.robot_code
      }
      const result = await dingtalkNotify.sendMessage(options)
      if (!result?.success) throw new Error(result?.message || '钉钉回发失败')
    }
  }
}

module.exports = { createDingtalkAdapter }
