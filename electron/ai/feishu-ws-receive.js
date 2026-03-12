/**
 * 飞书 WebSocket 长连接：接收消息事件，解析后通过回调交给上层（main）处理并回发
 * 配置来自 <appRoot>/openultron.json 的 feishu 字段，与 feishu-notify 共用
 */
const openultronConfig = require('../openultron-config')

function getConfig() {
  const f = openultronConfig.getFeishu()
  return { app_id: f.app_id || '', app_secret: f.app_secret || '' }
}

let wsClient = null
let lastError = null

function parseMaybeJson(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function collectContentSignals(node, out) {
  if (node == null) return
  if (typeof node === 'string') {
    const v = node.trim()
    if (v) out.texts.add(v)
    return
  }
  if (Array.isArray(node)) {
    for (const x of node) collectContentSignals(x, out)
    return
  }
  if (typeof node !== 'object') return

  const imageKey = node.image_key
  if (typeof imageKey === 'string' && imageKey.trim()) {
    out.imageKeys.add(imageKey.trim())
  }
  const fileKey = node.file_key
  if (typeof fileKey === 'string' && fileKey.trim()) {
    const key = fileKey.trim()
    const fileName = (typeof node.file_name === 'string' && node.file_name.trim())
      ? node.file_name.trim()
      : (typeof node.name === 'string' ? node.name.trim() : '')
    if (!out.fileKeys.has(key)) out.fileKeys.set(key, fileName)
  }

  for (const k of ['text', 'title']) {
    const v = node[k]
    if (typeof v === 'string' && v.trim()) out.texts.add(v.trim())
  }

  for (const v of Object.values(node)) collectContentSignals(v, out)
}

function hasAtMention(msg, contentObj, rawContentStr) {
  // 1) 飞书事件标准字段
  if (Array.isArray(msg?.mentions) && msg.mentions.length > 0) return true
  // 2) content JSON 内 mentions / at 节点
  if (contentObj && typeof contentObj === 'object') {
    if (Array.isArray(contentObj.mentions) && contentObj.mentions.length > 0) return true
    const s = JSON.stringify(contentObj)
    if (/"tag"\s*:\s*"at"/.test(s) || /"mention"\s*:/.test(s)) return true
  }
  // 3) 富文本 / 文本中的 at 标签兜底
  const raw = String(rawContentStr || '')
  if (!raw) return false
  if (/<at\b/i.test(raw)) return true
  if (/"tag"\s*:\s*"at"/.test(raw)) return true
  if (/"mentions"\s*:\s*\[/.test(raw)) return true
  return false
}

/**
 * 解析飞书 im.message.receive_v1 事件，提取 chat_id、文本、message_id、附件键
 * 事件结构参考：data 可能为 { message: { message_id, chat_id, content, message_type } }
 */
function parseMessageEvent(data) {
  const msg = data && (data.message || (data.data && data.data.message))
  if (!msg) return null
  const chatId = msg.chat_id || (msg.chat && msg.chat.chat_id) || msg.open_chat_id
  const messageId = msg.message_id || msg.open_message_id
  const messageType = String(msg.message_type || '').trim()
  const chatType = String(msg.chat_type || (msg.chat && msg.chat.chat_type) || '').trim().toLowerCase()
  const rawContentStr = typeof msg.content === 'string'
    ? msg.content
    : (typeof (msg.body && msg.body.content) === 'string' ? msg.body.content : '')
  const contentObj = parseMaybeJson(msg.content) || parseMaybeJson(msg.body && msg.body.content) || {}
  const mentioned = hasAtMention(msg, contentObj, rawContentStr)
  const requireMention = chatType === 'group'
  const collected = { texts: new Set(), imageKeys: new Set(), fileKeys: new Map() }
  collectContentSignals(contentObj, collected)

  // 兜底：部分事件把 key 放在 message 顶层
  if (typeof msg.image_key === 'string' && msg.image_key.trim()) {
    collected.imageKeys.add(msg.image_key.trim())
  }
  if (typeof msg.file_key === 'string' && msg.file_key.trim()) {
    collected.fileKeys.set(msg.file_key.trim(), (typeof msg.file_name === 'string' && msg.file_name.trim()) ? msg.file_name.trim() : '')
  }

  let text = Array.from(collected.texts).join(' ').replace(/\s+/g, ' ').trim()
  if (!text && typeof msg.content === 'string' && !parseMaybeJson(msg.content)) {
    text = msg.content.trim()
  }

  const attachments = []
  for (const imageKey of collected.imageKeys) {
    attachments.push({ type: 'image', image_key: imageKey })
  }
  for (const [fileKey, fileName] of collected.fileKeys.entries()) {
    attachments.push({ type: 'file', file_key: fileKey, file_name: fileName || '' })
  }

  // 某些场景 message_type 已明确，但正文未含 key，尝试从已解析对象直接拿
  if (attachments.length === 0 && contentObj && typeof contentObj === 'object') {
    if (messageType === 'image' && typeof contentObj.image_key === 'string' && contentObj.image_key.trim()) {
      attachments.push({ type: 'image', image_key: contentObj.image_key.trim() })
    } else if ((messageType === 'file' || messageType === 'audio') && typeof contentObj.file_key === 'string' && contentObj.file_key.trim()) {
      attachments.push({
        type: messageType === 'audio' ? 'audio' : 'file',
        file_key: contentObj.file_key.trim(),
        file_name: (typeof contentObj.file_name === 'string' && contentObj.file_name.trim()) ? contentObj.file_name.trim() : ''
      })
    }
  }

  // 最后兜底：直接从原始 content 字符串抓取 key（兼容飞书结构变化/解析失败）
  // 仅对非 text 消息启用，避免从普通文本中误抓历史 file_key/image_key 造成串文件
  if (attachments.length === 0 && rawContentStr && messageType !== 'text') {
    const imgMatches = [...rawContentStr.matchAll(/"image_key"\s*:\s*"([^"]+)"/g)]
    for (const m of imgMatches) {
      const key = (m && m[1]) ? m[1].trim() : ''
      if (key) attachments.push({ type: 'image', image_key: key })
    }
    const fileMatches = [...rawContentStr.matchAll(/"file_key"\s*:\s*"([^"]+)"/g)]
    for (const m of fileMatches) {
      const key = (m && m[1]) ? m[1].trim() : ''
      if (!key) continue
      const fileNameMatch = rawContentStr.match(/"file_name"\s*:\s*"([^"]+)"/)
      const fileName = fileNameMatch && fileNameMatch[1] ? fileNameMatch[1].trim() : ''
      attachments.push({ type: messageType === 'audio' ? 'audio' : 'file', file_key: key, file_name: fileName })
    }
  }

  if (!chatId) return null
  const uniq = []
  const seen = new Set()
  for (const a of attachments) {
    if (!a) continue
    const key = a.type === 'image' ? `i:${a.image_key || ''}` : `f:${a.file_key || ''}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    uniq.push(a)
  }
  return {
    chatId,
    messageId,
    text,
    messageType,
    chatType,
    requireMention,
    mentioned,
    attachments: uniq,
    _rawContent: rawContentStr
  }
}

/**
 * 启动 WebSocket 接收；onMessage(payload) 由 main 注册，负责调用 AI 并回发
 * @param { (payload: { chatId: string, text: string, messageId?: string, messageType?: string, attachments?: any[] }) => Promise<void> } onMessage
 */
async function start(onMessage) {
  if (wsClient) return
  lastError = null
  const config = getConfig()
  if (!config.app_id || !config.app_secret) {
    lastError = '请先填写并保存 App ID、App Secret'
    console.warn('[Feishu WS]', lastError)
    throw new Error(lastError)
  }
  let lark
  try {
    lark = require('@larksuiteoapi/node-sdk')
  } catch (e) {
    lastError = '未安装飞书 SDK，请在项目根目录执行: npm install @larksuiteoapi/node-sdk'
    console.warn('[Feishu WS]', lastError)
    throw new Error(lastError)
  }
  const handleMessageEvent = async (data) => {
    console.log('[Feishu WS] 收到消息事件，data 键:', data ? Object.keys(data) : 'null')
    const parsed = parseMessageEvent(data)
    if (!parsed) {
      console.warn('[Feishu WS] 解析失败或缺少 chat_id')
      if (data && typeof data === 'object') {
        try { console.warn('[Feishu WS] 原始 data 摘要:', JSON.stringify(data).slice(0, 600)) } catch (_) {}
      }
      return
    }
    console.log('[Feishu WS] 解析结果:', {
      messageType: parsed.messageType,
      chatType: parsed.chatType,
      requireMention: !!parsed.requireMention,
      mentioned: !!parsed.mentioned,
      textLen: (parsed.text || '').length,
      attachments: (parsed.attachments || []).length,
      imageCount: (parsed.attachments || []).filter(a => a?.type === 'image').length,
      fileCount: (parsed.attachments || []).filter(a => a?.type === 'file').length,
      messageId: parsed.messageId || ''
    })
    if (!parsed.text && (!parsed.attachments || parsed.attachments.length === 0)) {
      console.warn('[Feishu WS] 跳过：无文本内容且无可处理附件', {
        messageType: parsed.messageType,
        hasContent: !!(data && data.message && data.message.content),
        rawContentPreview: String(parsed._rawContent || '').slice(0, 300)
      })
      return
    }
    try {
      await onMessage(parsed)
      console.log('[Feishu WS] 已处理并回复')
    } catch (e) {
      console.error('[Feishu WS] onMessage error:', e)
    }
  }

  const eventHandlers = {
    'im.message.receive_v1': handleMessageEvent,
    'im.message.receive_v2': handleMessageEvent
  }
  const dispatcher = new lark.EventDispatcher({}).register(eventHandlers)

  // 飞书心跳间隔由服务端下发，通过自定义 httpInstance 在拉取连接配置时把 PingInterval 调大（秒）
  const FEISHU_WS_PING_INTERVAL_SEC = 300
  const defaultHttp = lark.defaultHttpInstance
  const wrappedHttpInstance = {
    request: async (config) => {
      const body = await defaultHttp.request(config)
      if (body?.data?.ClientConfig && config?.url && String(config.url).includes('ws/endpoint')) {
        const current = body.data.ClientConfig.PingInterval || 120
        body.data.ClientConfig.PingInterval = Math.max(current, FEISHU_WS_PING_INTERVAL_SEC)
      }
      return body
    }
  }

  try {
    wsClient = new lark.WSClient({
      appId: config.app_id,
      appSecret: config.app_secret,
      httpInstance: wrappedHttpInstance,
      logLevel: (lark.LogLevel && lark.LogLevel.info) !== undefined ? lark.LogLevel.info : 1
    })
    const startOpt = { eventDispatcher: dispatcher }
    const startResult = wsClient.start(startOpt)
    if (startResult && typeof startResult.then === 'function') await startResult
    lastError = null
    console.log('[Feishu WS] 长连接已启动')
    console.log('[Feishu WS] 若在飞书发消息后这里无「收到消息事件」日志，请检查：1) 飞书控制台-事件与回调-事件订阅-已添加事件「接收消息」 2) 应用权限-机器人-已开启接收/发送消息 3) 群里请 @ 机器人 发文本，或私聊机器人发文本')
  } catch (e) {
    lastError = e.message || String(e)
    console.warn('[Feishu WS] 启动失败:', lastError)
    wsClient = null
    throw e
  }
}

function stop() {
  if (wsClient) {
    try { wsClient.stop && wsClient.stop() } catch (_) {}
    wsClient = null
    console.log('[Feishu WS] 已停止')
  }
}

function isRunning() {
  return !!wsClient
}

function getLastError() {
  return lastError || null
}

module.exports = {
  getConfig,
  start,
  stop,
  isRunning,
  getLastError,
  parseMessageEvent
}
