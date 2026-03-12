/**
 * 飞书通知：鉴权与发送消息（文本 / 图片 / 富文本 post）
 * 配置来自 <appRoot>/openultron.json 的 feishu 字段
 */
const https = require('https')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const openultronConfig = require('../openultron-config')

const CONFIG_PATH = openultronConfig.getPath()

const AUTH_URL = 'open.feishu.cn'
const EDGE_TTS_VOICE_HOST = 'speech.platform.bing.com'
const EDGE_TTS_VOICE_PATH = '/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const AUTH_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const MESSAGE_PATH = '/open-apis/im/v1/messages'
const IMAGE_UPLOAD_PATH = '/open-apis/im/v1/images'
const FILE_UPLOAD_PATH = '/open-apis/im/v1/files'
const execFileAsync = promisify(execFile)
const VOICE_CACHE_PATH = path.join(path.dirname(CONFIG_PATH), 'edge-tts-voices-cache.json')

let cachedToken = null
let tokenExpireAt = 0
const EXPIRE_BUFFER_MS = 60 * 1000 // 提前 1 分钟刷新

function detectImageExtFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png'
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9) return 'jpg'
  // GIF
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  // WebP: RIFF....WEBP
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp'
  return null
}

function normalizeImageBase64(input) {
  if (!input || typeof input !== 'string') throw new Error('image_base64 为空')
  let raw = input.trim()
  let hintedMime = null
  // 支持 data URL：data:image/png;base64,xxxx
  const m = raw.match(/^data:([^;,]+);base64,(.*)$/i)
  if (m) {
    hintedMime = (m[1] || '').toLowerCase()
    raw = m[2] || ''
  }
  // 去掉空白/换行并兼容 url-safe base64
  raw = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  // 补齐 padding
  while (raw.length % 4 !== 0) raw += '='
  const buf = Buffer.from(raw, 'base64')
  if (!buf || buf.length === 0) throw new Error('image_base64 解码失败')
  const ext = detectImageExtFromBuffer(buf)
  if (!ext) throw new Error("Can't recognize image format.")
  return { buffer: buf, ext, hintedMime }
}

function getConfig() {
  return openultronConfig.getFeishu()
}

function setConfig(payload) {
  openultronConfig.setFeishu(payload)
  cachedToken = null
  tokenExpireAt = 0
}

function httpsPost(host, pathName, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const opts = {
      host,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data, 'utf-8')
      }
    }
    if (token) opts.headers.Authorization = `Bearer ${token}`

    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const json = JSON.parse(buf)
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json)
          else reject(new Error(json.msg || json.error_description || buf || `HTTP ${res.statusCode}`))
        } catch (e) {
          reject(new Error(buf || e.message))
        }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function httpsGetBuffer(host, pathName, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      host,
      path: pathName,
      method: 'GET',
      headers: {}
    }
    if (token) opts.headers.Authorization = `Bearer ${token}`
    const req = https.request(opts, (res) => {
      const chunks = []
      res.on('data', (ch) => chunks.push(ch))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ buffer: body, headers: res.headers || {} })
          return
        }
        const text = body.toString('utf8')
        try {
          const json = JSON.parse(text)
          const msg = json.msg || json.error_description || json.code || text || `HTTP ${res.statusCode}`
          reject(new Error(msg))
        } catch {
          reject(new Error(text || `HTTP ${res.statusCode}`))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function httpsGetJson(host, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      host,
      path: pathName,
      method: 'GET',
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        ...headers
      }
    }
    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const json = JSON.parse(buf || '[]')
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json)
          else reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 300)}`))
        } catch (e) {
          reject(new Error(`解析 JSON 失败: ${e.message}`))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function combineErrors(errors = []) {
  return errors
    .filter(Boolean)
    .map(e => String(e && e.message ? e.message : e))
    .filter(Boolean)
    .join(' | ')
}

async function downloadMessageResourceByKey(messageId, key, type) {
  if (!messageId || !String(messageId).trim()) throw new Error('missing message_id')
  if (!key || !String(key).trim()) throw new Error(`missing ${type}_key`)
  const token = await getTenantAccessToken()
  const mid = encodeURIComponent(String(messageId).trim())
  const rid = encodeURIComponent(String(key).trim())
  const t = encodeURIComponent(type)
  const pathWithQuery = `/open-apis/im/v1/messages/${mid}/resources/${rid}?type=${t}`
  const { buffer, headers } = await httpsGetBuffer(AUTH_URL, pathWithQuery, token)
  return { buffer, headers }
}

function parseFilenameFromDisposition(disposition, fallback = 'download.bin') {
  const text = String(disposition || '')
  const m1 = text.match(/filename\*=UTF-8''([^;]+)/i)
  if (m1 && m1[1]) {
    try { return decodeURIComponent(m1[1]) } catch { return m1[1] }
  }
  const m2 = text.match(/filename=\"?([^\";]+)\"?/i)
  if (m2 && m2[1]) return m2[1]
  return fallback
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function normalizeVoiceAliasKey(alias) {
  return String(alias || '').trim().toLowerCase()
}

function getTtsAliasMap() {
  const cfg = getConfig()
  const raw = (cfg && cfg.tts_voice_aliases && typeof cfg.tts_voice_aliases === 'object') ? cfg.tts_voice_aliases : {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    const nk = normalizeVoiceAliasKey(k)
    const nv = String(v || '').trim()
    if (nk && nv) out[nk] = nv
  }
  return out
}

function getTtsDefaultVoice() {
  const cfg = getConfig()
  return String((cfg && cfg.tts_default_voice) || '').trim()
}

function readVoiceCache() {
  try {
    if (!fs.existsSync(VOICE_CACHE_PATH)) return []
    const raw = JSON.parse(fs.readFileSync(VOICE_CACHE_PATH, 'utf-8'))
    if (!raw || !Array.isArray(raw.voices)) return []
    return raw.voices
  } catch (_) {
    return []
  }
}

function writeVoiceCache(voices) {
  try {
    const dir = path.dirname(VOICE_CACHE_PATH)
    ensureDir(dir)
    fs.writeFileSync(VOICE_CACHE_PATH, JSON.stringify({
      updatedAt: new Date().toISOString(),
      voices: Array.isArray(voices) ? voices : []
    }, null, 2), 'utf-8')
  } catch (_) {}
}

function normalizeVoiceItem(v) {
  return {
    shortName: String(v.ShortName || v.shortName || '').trim(),
    locale: String(v.Locale || v.locale || '').trim(),
    gender: String(v.Gender || v.gender || '').trim(),
    friendlyName: String(v.FriendlyName || v.friendlyName || '').trim(),
    name: String(v.Name || v.name || '').trim(),
    voiceTag: v.VoiceTag || v.voiceTag || {},
    status: String(v.Status || v.status || '').trim()
  }
}

async function listEdgeTtsVoices(options = {}) {
  const localeFilter = String(options.locale || '').trim().toLowerCase()
  let voices = []
  if (!options.forceRefresh) voices = readVoiceCache()
  if (!Array.isArray(voices) || voices.length === 0) {
    try {
      const online = await httpsGetJson(EDGE_TTS_VOICE_HOST, EDGE_TTS_VOICE_PATH)
      voices = Array.isArray(online) ? online.map(normalizeVoiceItem).filter(v => v.shortName) : []
      if (voices.length > 0) writeVoiceCache(voices)
    } catch (e) {
      voices = readVoiceCache()
      if (!Array.isArray(voices) || voices.length === 0) throw e
    }
  }
  if (localeFilter) {
    voices = voices.filter(v => String(v.locale || '').toLowerCase().startsWith(localeFilter))
  }
  return voices
}

function resolveTtsVoice(inputVoice) {
  const aliasMap = getTtsAliasMap()
  const input = String(inputVoice || '').trim()
  const normalized = normalizeVoiceAliasKey(input)
  if (normalized && aliasMap[normalized]) return aliasMap[normalized]
  if (input) return input
  const def = getTtsDefaultVoice()
  if (def) {
    const nd = normalizeVoiceAliasKey(def)
    return aliasMap[nd] || def
  }
  return ''
}

async function setTtsVoiceAlias(alias, voice) {
  const a = normalizeVoiceAliasKey(alias)
  const v = String(voice || '').trim()
  if (!a) throw new Error('alias 不能为空')
  if (!v) throw new Error('voice 不能为空')
  const cfg = getConfig()
  const aliases = getTtsAliasMap()
  aliases[a] = v
  setConfig({
    ...cfg,
    tts_voice_aliases: aliases
  })
  return { alias: a, voice: v }
}

async function removeTtsVoiceAlias(alias) {
  const a = normalizeVoiceAliasKey(alias)
  if (!a) throw new Error('alias 不能为空')
  const cfg = getConfig()
  const aliases = getTtsAliasMap()
  delete aliases[a]
  setConfig({
    ...cfg,
    tts_voice_aliases: aliases
  })
  return { alias: a }
}

async function setTtsDefaultVoice(voiceOrAlias) {
  const raw = String(voiceOrAlias || '').trim()
  if (!raw) throw new Error('voice_or_alias 不能为空')
  const cfg = getConfig()
  setConfig({
    ...cfg,
    tts_default_voice: raw
  })
  const resolved = resolveTtsVoice(raw)
  return { defaultVoice: raw, resolvedVoice: resolved || raw }
}

function makeTmpFile(ext = '.tmp') {
  const tmpRoot = path.join(os.tmpdir(), 'openultron-feishu-tts')
  ensureDir(tmpRoot)
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
  return path.join(tmpRoot, name)
}

function resolveFfmpegBundledPath(tool) {
  try {
    const staticPkg = require('ffmpeg-static')
    // ffmpeg-static 返回 ffmpeg 路径，ffprobe 在同目录
    const base = typeof staticPkg === 'string' ? staticPkg : staticPkg.path
    if (tool === 'ffmpeg') {
      if (fs.existsSync(base)) return base
    } else {
      const probePath = path.join(path.dirname(base), 'ffprobe')
      if (fs.existsSync(probePath)) return probePath
    }
  } catch (_) {}
  return null
}

function resolveFfprobePath() {
  const bundled = resolveFfmpegBundledPath('ffprobe')
  if (bundled) return bundled
  const candidates = ['/usr/local/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/bin/ffprobe', 'ffprobe']
  for (const p of candidates) {
    if (p === 'ffprobe') return p
    try { if (fs.existsSync(p)) return p } catch (_) {}
  }
  return 'ffprobe'
}

async function ffprobeDurationSec(filePath) {
  try {
    const { stdout } = await execFileAsync(resolveFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      filePath
    ], { timeout: 10000, maxBuffer: 1024 * 1024 })
    const s = Number(String(stdout || '').trim())
    if (!Number.isFinite(s) || s <= 0) return undefined
    return s
  } catch (_) {
    return undefined
  }
}

function resolveFfmpegPath() {
  const bundled = resolveFfmpegBundledPath('ffmpeg')
  if (bundled) return bundled
  const candidates = ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
  for (const p of candidates) {
    if (p === 'ffmpeg') return p
    try { if (fs.existsSync(p)) return p } catch (_) {}
  }
  return 'ffmpeg'
}

async function convertMp3ToOpus(inputMp3, outputOpus) {
  const ffmpegBin = resolveFfmpegPath()
  try {
    await execFileAsync(ffmpegBin, [
      '-y',
      '-i', inputMp3,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libopus',
      '-b:a', '24k',
      outputOpus
    ], {
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (e) {
    const msg = String(e?.stderr || e?.message || 'ffmpeg 转码失败').trim()
    if (/not found|enoent/i.test(msg)) {
      throw new Error('未检测到 ffmpeg。请先安装 ffmpeg（macOS: brew install ffmpeg）')
    }
    throw new Error(`ffmpeg 转码失败: ${msg.slice(0, 300)}`)
  }
}

async function synthesizeEdgeTtsToMp3(text, outputPath, options = {}) {
  let EdgeTTS
  try {
    ({ EdgeTTS } = require('node-edge-tts'))
  } catch (_) {
    throw new Error('内置 TTS 引擎初始化失败：node-edge-tts 未加载。请检查当前安装包是否完整（不要在运行时安装依赖）。')
  }
  if (!text || !String(text).trim()) throw new Error('TTS 文本为空')
  const cfg = {
    voice: resolveTtsVoice(options.voice) || 'zh-CN-XiaoyiNeural',
    lang: options.lang || 'zh-CN',
    outputFormat: options.outputFormat || 'audio-24khz-48kbitrate-mono-mp3',
    pitch: options.pitch || 'default',
    rate: options.rate || 'default',
    volume: options.volume || 'default',
    timeout: Number(options.timeout) > 0 ? Number(options.timeout) : 20000
  }
  const tts = new EdgeTTS(cfg)
  await tts.ttsPromise(String(text), outputPath)
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
    throw new Error('TTS 生成音频失败（空文件）')
  }
}

/** DELETE 请求（用于撤回消息等） */
function httpsDelete(host, pathName, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      host,
      path: pathName,
      method: 'DELETE',
      headers: {}
    }
    if (token) opts.headers.Authorization = `Bearer ${token}`

    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const json = JSON.parse(buf || '{}')
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json)
          else reject(new Error(json.msg || json.error_description || buf || `HTTP ${res.statusCode}`))
        } catch (e) {
          reject(new Error(buf || e.message))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** multipart/form-data POST（用于上传图片） */
function httpsPostMultipart(host, pathName, formParts, token) {
  return new Promise((resolve, reject) => {
    const boundary = '----FeishuForm' + Date.now()
    const bufs = []
    for (const part of formParts) {
      bufs.push(Buffer.from(`--${boundary}\r\n`, 'utf-8'))
      bufs.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${part.filename != null ? `; filename="${part.filename}"` : ''}\r\n`, 'utf-8'))
      if (part.contentType) bufs.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'utf-8'))
      bufs.push(Buffer.from('\r\n', 'utf-8'))
      bufs.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, 'utf-8'))
      bufs.push(Buffer.from('\r\n', 'utf-8'))
    }
    bufs.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
    const body = Buffer.concat(bufs)
    const opts = {
      host,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }
    if (token) opts.headers.Authorization = `Bearer ${token}`

    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const json = JSON.parse(buf)
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json)
          else reject(new Error(json.msg || json.error_description || buf || `HTTP ${res.statusCode}`))
        } catch (e) {
          reject(new Error(buf || e.message))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function getTenantAccessToken() {
  if (cachedToken && Date.now() < tokenExpireAt - EXPIRE_BUFFER_MS) {
    return cachedToken
  }
  const config = getConfig()
  if (!config.app_id || !config.app_secret) {
    throw new Error('请先配置飞书 app_id 与 app_secret（AI 管理 → 飞书通知）')
  }
  const res = await httpsPost(AUTH_URL, AUTH_PATH, {
    app_id: config.app_id,
    app_secret: config.app_secret
  })
  if (!res.tenant_access_token) {
    throw new Error(res.msg || '获取飞书 token 失败')
  }
  cachedToken = res.tenant_access_token
  tokenExpireAt = Date.now() + (res.expire || 7200) * 1000
  return cachedToken
}

/**
 * 发送文本消息到指定会话（群或私聊）
 */
async function sendText(receiveId, text, receiveIdType = 'chat_id') {
  const token = await getTenantAccessToken()
  const body = {
    receive_id: receiveId,
    msg_type: 'text',
    content: JSON.stringify({ text: String(text || '').slice(0, 40000) })
  }
  const pathWithQuery = `${MESSAGE_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`
  const res = await httpsPost(AUTH_URL, pathWithQuery, body, token)
  return res
}

/**
 * 上传图片，返回 image_key（飞书要求先上传再发图）
 * @param {Buffer} imageBuffer - 图片二进制
 * @param {string} [filename='image.png'] - 文件名，用于 Content-Type 推断
 */
async function uploadImage(imageBuffer, filename = 'image.png') {
  const token = await getTenantAccessToken()
  const ext = path.extname(filename).toLowerCase() || '.png'
  const mime = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
  }[ext] || 'image/png'
  const formParts = [
    { name: 'image_type', body: 'message' },
    { name: 'image', body: imageBuffer, filename, contentType: mime }
  ]
  const res = await httpsPostMultipart(AUTH_URL, IMAGE_UPLOAD_PATH, formParts, token)
  const key = res.data && res.data.image_key
  if (!key) throw new Error(res.msg || '上传图片未返回 image_key')
  return key
}

/**
 * 发送图片消息（需先通过 uploadImage 获得 image_key，或传 base64 由本方法上传）
 */
async function sendImage(receiveId, imageKeyOrOptions, receiveIdType = 'chat_id') {
  let image_key = imageKeyOrOptions
  if (typeof imageKeyOrOptions === 'object' && imageKeyOrOptions != null) {
    if (imageKeyOrOptions.image_base64) {
      const normalized = normalizeImageBase64(imageKeyOrOptions.image_base64)
      const ext = normalized.ext || 'png'
      const defaultName = `image.${ext}`
      let name = imageKeyOrOptions.filename || defaultName
      // 若 filename 无扩展名，按检测出的真实格式补齐，避免 Content-Type 错配
      if (!path.extname(name)) name = `${name}.${ext}`
      image_key = await uploadImage(normalized.buffer, name)
    } else {
      image_key = imageKeyOrOptions.image_key
    }
  }
  if (!image_key) throw new Error('缺少 image_key 或 image_base64')
  const token = await getTenantAccessToken()
  const body = {
    receive_id: receiveId,
    msg_type: 'image',
    content: JSON.stringify({ image_key })
  }
  const pathWithQuery = `${MESSAGE_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`
  const res = await httpsPost(AUTH_URL, pathWithQuery, body, token)
  return res
}

/**
 * 上传文件到飞书，返回 file_key（用于发送文件消息）
 * @param {Buffer|string} filePathOrBuffer - 文件路径或二进制 Buffer
 * @param {string} [fileName] - 显示文件名（Buffer 时必填）
 * @param {string} [fileType] - 如 pdf、doc、mp4；不传则根据文件名推断
 */
async function uploadFile(filePathOrBuffer, fileName, fileType, durationSec) {
  const token = await getTenantAccessToken()
  let body
  let name = fileName
  let type = fileType
  if (Buffer.isBuffer(filePathOrBuffer)) {
    if (!name) throw new Error('uploadFile: 传入 Buffer 时需提供 fileName')
    body = filePathOrBuffer
  } else {
    const fp = String(filePathOrBuffer)
    if (!fs.existsSync(fp)) throw new Error('文件不存在: ' + fp)
    name = name || path.basename(fp)
    body = fs.readFileSync(fp)
  }
  const ext = path.extname(name).toLowerCase().replace(/^\./, '') || 'bin'
  const mimeMap = {
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp4: 'video/mp4', mp3: 'audio/mpeg', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg'
  }
  const mime = type ? (mimeMap[type.replace(/^\./, '')] || 'application/octet-stream') : (mimeMap[ext] || 'application/octet-stream')
  const formParts = [
    { name: 'file_type', body: type || ext },
    { name: 'file_name', body: name },
    { name: 'file', body, filename: name, contentType: mime }
  ]
  if (Number.isFinite(Number(durationSec)) && Number(durationSec) > 0) {
    formParts.push({ name: 'duration', body: String(Math.round(Number(durationSec))) })
  }
  const res = await httpsPostMultipart(AUTH_URL, FILE_UPLOAD_PATH, formParts, token)
  const key = res.data && res.data.file_key
  if (!key) throw new Error(res.msg || '上传文件未返回 file_key')
  return key
}

/**
 * 发送文件消息（需先通过 uploadFile 获得 file_key）
 */
async function sendFile(receiveId, fileKey, fileName, receiveIdType = 'chat_id') {
  if (!fileKey || !fileName) throw new Error('发送文件消息需提供 file_key 与 file_name')
  const token = await getTenantAccessToken()
  const body = {
    receive_id: receiveId,
    msg_type: 'file',
    content: JSON.stringify({ file_key: fileKey, file_name: fileName })
  }
  const pathWithQuery = `${MESSAGE_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`
  const res = await httpsPost(AUTH_URL, pathWithQuery, body, token)
  return res
}

async function sendAudio(receiveId, fileKey, durationSec, receiveIdType = 'chat_id') {
  if (!fileKey) throw new Error('发送语音消息需提供 file_key')
  const token = await getTenantAccessToken()
  const content = { file_key: fileKey }
  if (Number.isFinite(Number(durationSec)) && Number(durationSec) > 0) content.duration = Math.round(Number(durationSec))
  const body = {
    receive_id: receiveId,
    msg_type: 'audio',
    content: JSON.stringify(content)
  }
  const pathWithQuery = `${MESSAGE_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`
  const res = await httpsPost(AUTH_URL, pathWithQuery, body, token)
  return res
}

async function sendMedia(receiveId, fileKey, imageKey, fileName, receiveIdType = 'chat_id') {
  if (!fileKey) throw new Error('发送图文消息需提供 file_key')
  const token = await getTenantAccessToken()
  const content = { file_key: fileKey }
  if (imageKey && String(imageKey).trim()) content.image_key = String(imageKey).trim()
  if (fileName && String(fileName).trim()) content.file_name = String(fileName).trim()
  const body = {
    receive_id: receiveId,
    msg_type: 'media',
    content: JSON.stringify(content)
  }
  const pathWithQuery = `${MESSAGE_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`
  const res = await httpsPost(AUTH_URL, pathWithQuery, body, token)
  return res
}

async function synthesizeAndUploadAudioByTts(text, options = {}) {
  const mp3Path = makeTmpFile('.mp3')
  const opusPath = makeTmpFile('.opus')
  try {
    await synthesizeEdgeTtsToMp3(text, mp3Path, {
      voice: options.voice,
      lang: options.lang,
      rate: options.rate,
      volume: options.volume,
      pitch: options.pitch,
      timeout: options.timeout
    })
    await convertMp3ToOpus(mp3Path, opusPath)
    const durationSec = await ffprobeDurationSec(opusPath)
    const fileKey = await uploadFile(opusPath, options.file_name || 'tts.opus', 'opus', durationSec)
    return { fileKey, durationSec, localPath: opusPath }
  } finally {
    try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path) } catch (_) {}
    try { if (fs.existsSync(opusPath)) fs.unlinkSync(opusPath) } catch (_) {}
  }
}

/**
 * 发送富文本消息（post）
 * @param {string} receiveId - 群/会话 ID
 * @param {object} postPayload - 富文本结构，如 { zh_cn: { title: '标题', content: [[{ tag: 'text', text: '段落1' }], [{ tag: 'a', href: 'https://...', text: '链接' }]] } }
 */
async function sendPost(receiveId, postPayload, receiveIdType = 'chat_id') {
  const token = await getTenantAccessToken()
  const body = {
    receive_id: receiveId,
    msg_type: 'post',
    content: JSON.stringify(postPayload)
  }
  const pathWithQuery = `${MESSAGE_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`
  const res = await httpsPost(AUTH_URL, pathWithQuery, body, token)
  return res
}

async function downloadImageByKey(imageKey, options = {}) {
  if (!imageKey || !String(imageKey).trim()) throw new Error('downloadImageByKey: missing imageKey')
  const key = String(imageKey).trim()
  const messageId = options && options.messageId ? String(options.messageId).trim() : ''
  let result = null
  const errs = []
  if (messageId) {
    try {
      result = await downloadMessageResourceByKey(messageId, key, 'image')
    } catch (e) {
      errs.push(new Error(`message_resource(image): ${e.message}`))
      // 安全优先：携带 message_id 时必须命中该消息资源，避免误下到其他历史资源
      throw new Error(combineErrors(errs) || 'download image failed by message resource')
    }
  }
  if (!result) {
    try {
      const token = await getTenantAccessToken()
      const pathWithQuery = `/open-apis/im/v1/images/${encodeURIComponent(key)}?image_type=message`
      result = await httpsGetBuffer(AUTH_URL, pathWithQuery, token)
    } catch (e) {
      errs.push(new Error(`images_api: ${e.message}`))
    }
  }
  if (!result) throw new Error(combineErrors(errs) || 'download image failed')
  const { buffer, headers } = result
  const contentType = String(headers['content-type'] || 'image/png').split(';')[0]
  const fileName = parseFilenameFromDisposition(headers['content-disposition'], `image-${Date.now()}.png`)
  return { buffer, contentType, fileName }
}

async function downloadFileByKey(fileKey, options = {}) {
  if (!fileKey || !String(fileKey).trim()) throw new Error('downloadFileByKey: missing fileKey')
  const key = String(fileKey).trim()
  const messageId = options && options.messageId ? String(options.messageId).trim() : ''
  let result = null
  const errs = []
  if (messageId) {
    try {
      result = await downloadMessageResourceByKey(messageId, key, 'file')
    } catch (e) {
      errs.push(new Error(`message_resource(file): ${e.message}`))
      // 安全优先：携带 message_id 时必须命中该消息资源，避免误下到其他历史资源
      throw new Error(combineErrors(errs) || 'download file failed by message resource')
    }
  }
  if (!result) {
    try {
      const token = await getTenantAccessToken()
      const pathWithQuery = `/open-apis/im/v1/files/${encodeURIComponent(key)}`
      result = await httpsGetBuffer(AUTH_URL, pathWithQuery, token)
    } catch (e) {
      errs.push(new Error(`files_api: ${e.message}`))
    }
  }
  if (!result) throw new Error(combineErrors(errs) || 'download file failed')
  const { buffer, headers } = result
  const contentType = String(headers['content-type'] || 'application/octet-stream').split(';')[0]
  const fileName = parseFilenameFromDisposition(headers['content-disposition'], `file-${Date.now()}.bin`)
  return { buffer, contentType, fileName }
}

/**
 * 统一发送：支持 text / image / file / post / audio / media。使用 default_chat_id 若未传 chat_id。
 * 文件：可传 file_key + file_name；或 file_path（本地路径）由本方法先上传再发送。
 */
async function sendMessage(options = {}) {
  const {
    chat_id, receive_id, text, image_key, image_base64, post, file_key, file_name, file_path,
    audio_file_key, audio_file_name, audio_file_path, audio_duration, audio_text, audio_voice, audio_lang, audio_rate, audio_volume, audio_pitch,
    media_file_key, media_file_name, media_file_path, media_image_key
  } = options
  const id = chat_id || receive_id
  const config = getConfig()
  const receiveId = id && id.trim() ? id.trim() : (config.default_chat_id && config.default_chat_id.trim())
  if (!receiveId) {
    return { success: false, message: '请提供 chat_id/receive_id 或在飞书通知中配置默认会话' }
  }
  const receiveIdType = options.receive_id_type || 'chat_id'

  try {
    if (post != null && typeof post === 'object') {
      const res = await sendPost(receiveId, post, receiveIdType)
      return { success: true, message_id: res.data && res.data.message_id, message: '富文本发送成功' }
    }
    if (audio_file_key || audio_file_path || audio_text) {
      let key = audio_file_key
      let durationSec = Number.isFinite(Number(audio_duration)) ? Number(audio_duration) : undefined
      if (!key && audio_file_path && fs.existsSync(audio_file_path)) {
        key = await uploadFile(audio_file_path, audio_file_name || path.basename(audio_file_path), 'opus', durationSec)
        if (!durationSec) durationSec = await ffprobeDurationSec(audio_file_path)
      }
      if (!key && audio_text && String(audio_text).trim()) {
        const resolvedVoice = resolveTtsVoice(audio_voice)
        const tts = await synthesizeAndUploadAudioByTts(String(audio_text), {
          voice: resolvedVoice || audio_voice,
          lang: audio_lang,
          rate: audio_rate,
          volume: audio_volume,
          pitch: audio_pitch,
          file_name: audio_file_name || 'tts.opus'
        })
        key = tts.fileKey
        durationSec = tts.durationSec
      }
      if (!key) return { success: false, message: '发送语音需提供 audio_file_key / audio_file_path / audio_text 之一' }
      const res = await sendAudio(receiveId, key, durationSec, receiveIdType)
      return { success: true, message_id: res.data && res.data.message_id, message: '语音发送成功' }
    }
    if (media_file_key || media_file_path) {
      let key = media_file_key
      let name = media_file_name
      if (!key && media_file_path && fs.existsSync(media_file_path)) {
        key = await uploadFile(media_file_path, media_file_name || path.basename(media_file_path), 'mp4')
        name = name || path.basename(media_file_path)
      }
      if (!key) return { success: false, message: '发送图文需提供 media_file_key 或 media_file_path' }
      const res = await sendMedia(receiveId, key, media_image_key, name, receiveIdType)
      return { success: true, message_id: res.data && res.data.message_id, message: '图文发送成功' }
    }
    const hasImageKey = image_key && String(image_key).trim()
    const hasImageBase64 = image_base64 && (typeof image_base64 === 'string' && image_base64.length > 0)
    if (hasImageKey || hasImageBase64) {
      const res = await sendImage(receiveId, {
        image_key: hasImageKey ? image_key.trim() : undefined,
        image_base64: hasImageBase64 ? image_base64 : undefined,
        filename: options.image_filename
      }, receiveIdType)
      return { success: true, message_id: res.data && res.data.message_id, message: '图片发送成功' }
    }
    if (file_key || file_path) {
      const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
      const lowerPath = String(file_path || '').trim().toLowerCase()
      const ext = lowerPath ? path.extname(lowerPath) : ''
      // 兜底：调用方把图片误传到 file_path 时，强制按图片上传发送，避免 file 模式报 Invalid request param
      if (!file_key && file_path && ext && imageExts.has(ext) && fs.existsSync(file_path)) {
        const buf = fs.readFileSync(file_path)
        if (!buf || buf.length === 0) return { success: false, message: '图片文件为空' }
        const res = await sendImage(receiveId, {
          image_base64: buf.toString('base64'),
          filename: file_name || path.basename(file_path)
        }, receiveIdType)
        return { success: true, message_id: res.data && res.data.message_id, message: '图片发送成功' }
      }
      let key = file_key
      let name = file_name
      if (file_path && fs.existsSync(file_path)) {
        key = await uploadFile(file_path)
        name = name || path.basename(file_path)
      }
      if (!key || !name) {
        return { success: false, message: '发送文件需提供 file_key+file_name 或 file_path' }
      }
      const res = await sendFile(receiveId, key, name, receiveIdType)
      return { success: true, message_id: res.data && res.data.message_id, message: '文件发送成功' }
    }
    const content = text != null ? String(text) : ''
    if (!content) {
      return { success: false, message: '请提供 text、image_key/image_base64、file_key/file_path、post、audio_* 或 media_* 之一' }
    }
    const res = await sendText(receiveId, content, receiveIdType)
    return { success: true, message_id: res.data && res.data.message_id, message: '发送成功' }
  } catch (e) {
    return { success: false, message: e.message || '发送失败' }
  }
}

/**
 * 撤回机器人自己发送的消息（用于取消占位消息）
 * @param {string} messageId - 发送接口返回的 message_id（如 om_xxx）
 */
async function deleteMessage(messageId) {
  if (!messageId || !String(messageId).trim()) {
    return { success: false, message: '缺少 message_id' }
  }
  const id = String(messageId).trim()
  try {
    const token = await getTenantAccessToken()
    const pathName = `${MESSAGE_PATH}/${encodeURIComponent(id)}`
    await httpsDelete(AUTH_URL, pathName, token)
    return { success: true, message: '已撤回' }
  } catch (e) {
    return { success: false, message: e.message || '撤回失败' }
  }
}

/**
 * 在用户消息上添加表情回复（如 Typing 表示「敲键盘」），参考 OpenClaw 打字指示
 * @param {string} messageId - 用户消息的 message_id（来自 im.message.receive 事件）
 * @param {string} emojiType - 飞书 emoji_type，如 'Typing'（敲键盘）
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
 */
async function addMessageReaction(messageId, emojiType = 'Typing') {
  if (!messageId || !String(messageId).trim()) {
    return { success: false, message: '缺少 message_id', reaction_id: null }
  }
  const id = String(messageId).trim()
  try {
    const token = await getTenantAccessToken()
    const pathName = `${MESSAGE_PATH}/${encodeURIComponent(id)}/reactions`
    const body = { reaction_type: { emoji_type: emojiType } }
    const res = await httpsPost(AUTH_URL, pathName, body, token)
    const reactionId = res.data && res.data.reaction_id
    return { success: true, reaction_id: reactionId || null, message: '已添加' }
  } catch (e) {
    return { success: false, message: e.message || '添加表情失败', reaction_id: null }
  }
}

/**
 * 删除指定消息上的表情回复（与 addMessageReaction 成对，回复完成后取消「敲键盘」）
 * @param {string} messageId - 用户消息的 message_id
 * @param {string} reactionId - 添加时返回的 reaction_id
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete
 */
async function deleteMessageReaction(messageId, reactionId) {
  if (!messageId || !String(messageId).trim() || !reactionId || !String(reactionId).trim()) {
    return { success: false, message: '缺少 message_id 或 reaction_id' }
  }
  const mid = String(messageId).trim()
  const rid = String(reactionId).trim()
  try {
    const token = await getTenantAccessToken()
    const pathName = `${MESSAGE_PATH}/${encodeURIComponent(mid)}/reactions/${encodeURIComponent(rid)}`
    await httpsDelete(AUTH_URL, pathName, token)
    return { success: true, message: '已移除' }
  } catch (e) {
    return { success: false, message: e.message || '移除表情失败' }
  }
}

module.exports = {
  getConfig,
  setConfig,
  getTenantAccessToken,
  sendText,
  sendImage,
  sendPost,
  sendAudio,
  sendMedia,
  synthesizeAndUploadAudioByTts,
  listEdgeTtsVoices,
  resolveTtsVoice,
  getTtsAliasMap,
  getTtsDefaultVoice,
  setTtsVoiceAlias,
  removeTtsVoiceAlias,
  setTtsDefaultVoice,
  uploadImage,
  uploadFile,
  downloadImageByKey,
  downloadFileByKey,
  sendFile,
  sendMessage,
  deleteMessage,
  addMessageReaction,
  deleteMessageReaction,
  CONFIG_PATH,
  resolveFfmpegPath,
  resolveFfprobePath
}
