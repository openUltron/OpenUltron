// Telegram 通知：发送文本 / 语音（audio_text -> 内置 TTS 生成 ogg/opus 后发送）
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const openultronConfig = require('../openultron-config')
const feishuNotify = require('./feishu-notify')
const { execFfmpegWithFallback } = feishuNotify
const { redactSensitiveText } = require('../core/sensitive-text')
const API_BASE = 'api.telegram.org'

function getConfig() {
  return openultronConfig.getTelegram()
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function makeTmpFile(ext = '.tmp') {
  const tmpRoot = path.join(os.tmpdir(), 'openultron-telegram-tts')
  ensureDir(tmpRoot)
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
  return path.join(tmpRoot, name)
}

function apiRequest(token, method, body = {}) {
  return new Promise((resolve, reject) => {
    const pathName = `/bot${token}/${method}`
    const data = JSON.stringify(body)
    const opts = {
      host: API_BASE,
      path: pathName,
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
          const j = JSON.parse(buf || '{}')
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

function apiRequestMultipart(token, method, formParts) {
  return new Promise((resolve, reject) => {
    const boundary = '----TelegramForm' + Date.now()
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
      host: API_BASE,
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }
    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const j = JSON.parse(buf || '{}')
          if (j.ok) resolve(j.result)
          else reject(new Error(j.description || 'Telegram API error'))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
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
  await execFfmpegWithFallback([
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
}

async function sendVoiceByPath(token, chatId, filePath, caption) {
  if (!fs.existsSync(filePath)) throw new Error(`语音文件不存在: ${filePath}`)
  const voiceBuf = fs.readFileSync(filePath)
  const formParts = [
    { name: 'chat_id', body: String(chatId) },
    { name: 'voice', body: voiceBuf, filename: path.basename(filePath), contentType: 'audio/ogg' }
  ]
  if (caption && String(caption).trim()) formParts.push({ name: 'caption', body: String(caption).trim().slice(0, 1024) })
  return apiRequestMultipart(token, 'sendVoice', formParts)
}

async function sendMessage(options = {}) {
  const cfg = getConfig()
  const token = String(cfg.bot_token || '').trim()
  if (!token) return { success: false, message: '请先配置 Telegram bot_token' }

  const chatId = String(options.chat_id || options.receive_id || '').trim()
  if (!chatId) return { success: false, message: '请提供 chat_id' }

  const out = { text_message_id: '', audio_message_id: '' }
  try {
    const text = options.text != null ? redactSensitiveText(String(options.text)).trim() : ''
    if (text) {
      const r = await apiRequest(token, 'sendMessage', { chat_id: chatId, text })
      out.text_message_id = String(r?.message_id || '')
    }

    let audioPath = options.audio_file_path ? String(options.audio_file_path).trim() : ''
    const audioText = options.audio_text != null ? redactSensitiveText(String(options.audio_text)).trim() : ''
    if (!audioPath && audioText) {
      const mp3Path = makeTmpFile('.mp3')
      const oggPath = makeTmpFile('.ogg')
      try {
        await synthesizeEdgeTtsToMp3(audioText, mp3Path, {
          voice: options.audio_voice,
          lang: options.audio_lang,
          rate: options.audio_rate,
          volume: options.audio_volume,
          pitch: options.audio_pitch
        })
        await convertMp3ToOggOpus(mp3Path, oggPath)
        audioPath = oggPath
      } finally {
        try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path) } catch (_) {}
      }
    }

    if (audioPath) {
      const r2 = await sendVoiceByPath(token, chatId, audioPath, options.audio_caption || '')
      out.audio_message_id = String(r2?.message_id || '')
      if (audioText) {
        try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath) } catch (_) {}
      }
    }

    if (!out.text_message_id && !out.audio_message_id) {
      return { success: false, message: '请提供 text 或 audio_file_path 或 audio_text' }
    }
    return { success: true, ...out, message: 'Telegram 发送成功' }
  } catch (e) {
    return { success: false, message: e.message || 'Telegram 发送失败', ...out }
  }
}

module.exports = {
  getConfig,
  sendMessage
}
