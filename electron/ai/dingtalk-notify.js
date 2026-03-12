// 钉钉通知：发送文本 / 语音（audio_text -> 内置 TTS）
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const openultronConfig = require('../openultron-config')
const feishuNotify = require('./feishu-notify')

const execFileAsync = promisify(execFile)

const API_HOST = 'api.dingtalk.com'
const LEGACY_HOST = 'oapi.dingtalk.com'

let cachedAccessToken = ''
let tokenExpireAt = 0
const EXPIRE_BUFFER_MS = 60 * 1000

function getConfig() {
  return openultronConfig.getDingtalk()
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function makeTmpFile(ext = '.tmp') {
  const tmpRoot = path.join(os.tmpdir(), 'openultron-dingtalk-tts')
  ensureDir(tmpRoot)
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
  return path.join(tmpRoot, name)
}

function postJson(host, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {})
    const opts = {
      host,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data, 'utf-8'),
        ...headers
      }
    }
    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const j = JSON.parse(buf || '{}')
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j)
          else reject(new Error(j.errmsg || j.message || j.msg || `HTTP ${res.statusCode}`))
        } catch (e) {
          reject(new Error(buf || e.message))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data)
    req.end()
  })
}

function postMultipart(host, pathName, formParts, headers = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----DingTalkForm' + Date.now()
    const bufs = []
    for (const part of formParts) {
      bufs.push(Buffer.from(`--${boundary}\r\n`, 'utf-8'))
      bufs.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${part.filename != null ? `; filename="${part.filename}"` : ''}\r\n`, 'utf-8'))
      if (part.contentType) bufs.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'utf-8'))
      bufs.push(Buffer.from('\r\n', 'utf-8'))
      bufs.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(String(part.body || ''), 'utf-8'))
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
        'Content-Length': body.length,
        ...headers
      }
    }
    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const j = JSON.parse(buf || '{}')
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j)
          else reject(new Error(j.errmsg || j.message || j.msg || `HTTP ${res.statusCode}`))
        } catch (e) {
          reject(new Error(buf || e.message))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

function safeJsonParam(obj) {
  return JSON.stringify(obj || {}).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpireAt - EXPIRE_BUFFER_MS) return cachedAccessToken
  const cfg = getConfig()
  const appKey = String(cfg.app_key || '').trim()
  const appSecret = String(cfg.app_secret || '').trim()
  if (!appKey || !appSecret) throw new Error('请先配置钉钉 app_key 与 app_secret')
  const res = await postJson(API_HOST, '/v1.0/oauth2/accessToken', { appKey, appSecret })
  const token = String(res.accessToken || '').trim()
  if (!token) throw new Error(res.message || '获取钉钉 accessToken 失败')
  cachedAccessToken = token
  tokenExpireAt = Date.now() + (Number(res.expireIn || 7200) * 1000)
  return token
}

async function sendBySessionWebhook(sessionWebhook, payload) {
  if (!sessionWebhook || !String(sessionWebhook).trim()) throw new Error('缺少 sessionWebhook')
  const u = new URL(String(sessionWebhook).trim())
  const pathName = `${u.pathname}${u.search || ''}`
  return postJson(u.host, pathName, payload)
}

async function uploadVoiceMedia(accessToken, filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`语音文件不存在: ${filePath}`)
  const buf = fs.readFileSync(filePath)
  const res = await postMultipart(
    LEGACY_HOST,
    `/media/upload?access_token=${encodeURIComponent(accessToken)}&type=voice`,
    [{ name: 'media', body: buf, filename: path.basename(filePath), contentType: 'audio/ogg' }]
  )
  const mediaId = String(res.media_id || '').trim()
  if (!mediaId) throw new Error(res.errmsg || '上传语音媒体失败')
  return mediaId
}

async function sendRobotGroupMessage(accessToken, { openConversationId, robotCode, msgKey, msgParam }) {
  if (!openConversationId || !robotCode) throw new Error('缺少 openConversationId 或 robotCode')
  const body = {
    openConversationId: String(openConversationId).trim(),
    robotCode: String(robotCode).trim(),
    msgKey: String(msgKey || 'sampleText').trim(),
    msgParam: typeof msgParam === 'string' ? msgParam : safeJsonParam(msgParam)
  }
  return postJson(
    API_HOST,
    '/v1.0/robot/groupMessages/send',
    body,
    { 'x-acs-dingtalk-access-token': accessToken }
  )
}

async function synthesizeEdgeTtsToMp3(text, outputPath, options = {}) {
  let EdgeTTS
  try {
    ({ EdgeTTS } = require('node-edge-tts'))
  } catch (_) {
    throw new Error('内置 TTS 引擎初始化失败：node-edge-tts 未加载')
  }
  if (!text || !String(text).trim()) throw new Error('TTS 文本为空')
  const cfg = {
    voice: feishuNotify.resolveTtsVoice(options.voice) || 'zh-CN-XiaoyiNeural',
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

async function convertMp3ToOggOpus(inputMp3, outputOgg) {
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputMp3,
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '32k',
      outputOgg
    ], {
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (e) {
    const msg = String(e?.stderr || e?.message || 'ffmpeg 转码失败').trim()
    throw new Error(`ffmpeg 转码失败: ${msg.slice(0, 300)}`)
  }
}

async function synthesizeToVoiceFile(audioText, options = {}) {
  const mp3Path = makeTmpFile('.mp3')
  const oggPath = makeTmpFile('.ogg')
  try {
    await synthesizeEdgeTtsToMp3(audioText, mp3Path, options)
    await convertMp3ToOggOpus(mp3Path, oggPath)
    return oggPath
  } finally {
    try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path) } catch (_) {}
  }
}

function buildSessionWebhookTextPayload(text) {
  return {
    msgtype: 'text',
    text: {
      content: String(text || '').trim().slice(0, 4000)
    }
  }
}

async function sendMessage(options = {}) {
  const {
    text,
    audio_text, audio_file_path, audio_voice, audio_lang, audio_rate, audio_volume, audio_pitch,
    session_webhook, open_conversation_id, robot_code, chat_id
  } = options
  const cfg = getConfig()
  const webhook = String(session_webhook || '').trim()
  const openConversationId = String(open_conversation_id || chat_id || cfg.default_chat_id || '').trim()
  const robotCode = String(robot_code || cfg.default_robot_code || '').trim()

  try {
    let textRes = null
    let audioRes = null

    if (text && String(text).trim()) {
      if (webhook) {
        textRes = await sendBySessionWebhook(webhook, buildSessionWebhookTextPayload(text))
      } else if (openConversationId && robotCode) {
        const token = await getAccessToken()
        textRes = await sendRobotGroupMessage(token, {
          openConversationId,
          robotCode,
          msgKey: 'sampleText',
          msgParam: { content: String(text).trim().slice(0, 4000) }
        })
      } else {
        throw new Error('发送钉钉文本需提供 session_webhook 或 (open_conversation_id + robot_code)')
      }
    }

    let voicePath = audio_file_path ? String(audio_file_path).trim() : ''
    if (!voicePath && audio_text && String(audio_text).trim()) {
      voicePath = await synthesizeToVoiceFile(String(audio_text).trim(), {
        voice: audio_voice,
        lang: audio_lang,
        rate: audio_rate,
        volume: audio_volume,
        pitch: audio_pitch
      })
    }

    if (voicePath) {
      if (!(openConversationId && robotCode)) {
        // sessionWebhook 普遍不支持语音结构，降级成文本提示
        if (webhook) {
          await sendBySessionWebhook(webhook, buildSessionWebhookTextPayload('语音已生成，但当前会话 webhook 不支持直接发送语音。请配置 open_conversation_id + robot_code 后重试。'))
          audioRes = { fallback: true }
        } else {
          throw new Error('发送钉钉语音需提供 open_conversation_id + robot_code')
        }
      } else {
        const token = await getAccessToken()
        const mediaId = await uploadVoiceMedia(token, voicePath)
        audioRes = await sendRobotGroupMessage(token, {
          openConversationId,
          robotCode,
          msgKey: 'sampleAudio',
          msgParam: { mediaId }
        })
      }
      if (audio_text) {
        try { if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath) } catch (_) {}
      }
    }

    if (!textRes && !audioRes) {
      return { success: false, message: '请提供 text 或 audio_text 或 audio_file_path' }
    }
    return { success: true, message: '钉钉发送成功', textRes, audioRes }
  } catch (e) {
    return { success: false, message: e.message || '钉钉发送失败' }
  }
}

module.exports = {
  getConfig,
  sendMessage,
  getAccessToken
}

