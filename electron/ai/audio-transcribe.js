const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { execFile } = require('child_process')
const http = require('http')
const https = require('https')
const { readAIConfig, toLegacyConfig } = require('./ai-config-file')

const DEFAULT_TIMEOUT_MS = 180000
const LOCAL_ASR_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TEXT_CHARS = 8000
const TRANSCRIBE_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1']

function clampText(text) {
  const s = String(text || '').trim()
  if (!s) return ''
  if (s.length <= MAX_TEXT_CHARS) return s
  return s.slice(0, MAX_TEXT_CHARS) + '\n...(truncated)'
}

function runExec(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : LOCAL_ASR_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      ...options
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
        return
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

async function commandExists(cmd) {
  try {
    if (process.platform === 'win32') {
      await runExec('where', [cmd], { timeoutMs: 4000 })
    } else {
      await runExec('which', [cmd], { timeoutMs: 4000 })
    }
    return true
  } catch (_) {
    return false
  }
}

function makeTmpRoot() {
  const dir = path.join(os.tmpdir(), 'openultron-asr', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function tryReadTxtFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return ''
  const files = fs.readdirSync(rootDir)
    .filter((n) => n.toLowerCase().endsWith('.txt'))
    .sort()
  for (const f of files) {
    const full = path.join(rootDir, f)
    try {
      const txt = fs.readFileSync(full, 'utf8')
      if (txt && txt.trim()) return clampText(txt)
    } catch (_) {}
  }
  return ''
}

async function transcribeByWhisperCpp(filePath, options = {}) {
  const candidates = ['whisper-cli', 'whisper-cpp', 'main']
  let cmd = ''
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await commandExists(c)) { cmd = c; break }
  }
  if (!cmd) return { ok: false, error: 'whisper.cpp command not found' }

  const tmpDir = makeTmpRoot()
  const outPrefix = path.join(tmpDir, 'asr')
  const lang = String(options.lang || 'auto').trim()
  const args = ['-f', filePath, '-otxt', '-of', outPrefix]
  if (lang && lang !== 'auto') args.push('-l', lang)
  try {
    await runExec(cmd, args, { timeoutMs: LOCAL_ASR_TIMEOUT_MS })
    const txt = tryReadTxtFiles(tmpDir)
    if (!txt) return { ok: false, error: `${cmd} finished but produced empty transcript` }
    return { ok: true, text: txt, engine: cmd }
  } catch (e) {
    const detail = String(e?.stderr || e?.message || `${cmd} failed`).trim()
    return { ok: false, error: `${cmd}: ${detail.slice(0, 240)}` }
  }
}

async function transcribeByWhisperPy(filePath, options = {}) {
  const hasWhisper = await commandExists('whisper')
  if (!hasWhisper) return { ok: false, error: 'whisper command not found' }
  const tmpDir = makeTmpRoot()
  const args = [
    filePath,
    '--model', String(options.model || 'base'),
    '--output_format', 'txt',
    '--output_dir', tmpDir,
    '--fp16', 'False'
  ]
  const lang = String(options.lang || 'auto').trim()
  if (lang && lang !== 'auto') args.push('--language', lang)
  try {
    await runExec('whisper', args, { timeoutMs: LOCAL_ASR_TIMEOUT_MS })
    const txt = tryReadTxtFiles(tmpDir)
    if (!txt) return { ok: false, error: 'whisper finished but produced empty transcript' }
    return { ok: true, text: txt, engine: 'whisper' }
  } catch (e) {
    const detail = String(e?.stderr || e?.message || 'whisper failed').trim()
    return { ok: false, error: `whisper: ${detail.slice(0, 240)}` }
  }
}

async function transcribeAudioLocal(filePath, options = {}) {
  const attempts = []
  const r1 = await transcribeByWhisperCpp(filePath, options)
  if (r1.ok) return { ...r1, source: 'local' }
  attempts.push(r1.error || 'whisper.cpp failed')

  const r2 = await transcribeByWhisperPy(filePath, options)
  if (r2.ok) return { ...r2, source: 'local' }
  attempts.push(r2.error || 'whisper failed')

  return { ok: false, text: '', error: attempts.join(' | ') || 'local asr unavailable', source: 'local' }
}

function readProviderConfig() {
  const ai = readAIConfig()
  const legacy = toLegacyConfig(ai)
  const baseUrl = String(legacy?.config?.apiBaseUrl || '').trim()
  const keyByProvider = legacy?.providerKeys && typeof legacy.providerKeys === 'object'
    ? legacy.providerKeys
    : {}
  const apiKey = String(keyByProvider[baseUrl] || legacy?.config?.apiKey || '').trim()
  return { baseUrl, apiKey }
}

function buildMultipart({ fileBuffer, fileName, model }) {
  const boundary = `----OpenUltronBoundary${crypto.randomBytes(8).toString('hex')}`
  const parts = []
  const appendField = (name, value) => {
    parts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'))
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`, 'utf8'))
    parts.push(Buffer.from(String(value), 'utf8'))
    parts.push(Buffer.from('\r\n', 'utf8'))
  }
  appendField('model', model)
  appendField('response_format', 'text')
  parts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'))
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`, 'utf8'))
  parts.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n', 'utf8'))
  parts.push(fileBuffer)
  parts.push(Buffer.from('\r\n', 'utf8'))
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  const body = Buffer.concat(parts)
  return { body, boundary }
}

function postMultipart(urlString, apiKey, multipart, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString)
    const client = u.protocol === 'http:' ? http : https
    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      method: 'POST',
      path: `${u.pathname}${u.search || ''}`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
        'Content-Length': multipart.body.length
      }
    }, (res) => {
      const chunks = []
      res.on('data', (ch) => chunks.push(ch))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const ok = res.statusCode >= 200 && res.statusCode < 300
        if (!ok) {
          let msg = raw
          try {
            const j = JSON.parse(raw)
            msg = j?.error?.message || j?.message || raw
          } catch (_) {}
          reject(new Error(`HTTP ${res.statusCode}: ${String(msg || '').slice(0, 220)}`))
          return
        }
        resolve(raw)
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    req.write(multipart.body)
    req.end()
  })
}

async function transcribeAudioFile(filePath, options = {}) {
  const absPath = path.resolve(String(filePath || ''))
  if (!absPath || !fs.existsSync(absPath)) {
    return { ok: false, text: '', error: 'audio file not found' }
  }
  const fileBuffer = fs.readFileSync(absPath)
  if (!fileBuffer || fileBuffer.length === 0) {
    return { ok: false, text: '', error: 'audio file is empty' }
  }

  const name = path.basename(absPath) || 'audio.bin'
  const localFirst = options.localFirst !== false

  if (localFirst) {
    const local = await transcribeAudioLocal(absPath, {
      lang: options.lang || 'auto',
      model: options.localModel || 'base'
    })
    if (local.ok && local.text) return local
    if (options.localOnly) return local
  }

  const { baseUrl, apiKey } = readProviderConfig()
  if (!baseUrl || !apiKey) {
    return { ok: false, text: '', error: 'missing ai provider api config and local asr unavailable', source: 'cloud' }
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models.map((x) => String(x || '').trim()).filter(Boolean)
    : TRANSCRIBE_MODELS
  let lastError = null
  for (const model of models) {
    try {
      const multipart = buildMultipart({ fileBuffer, fileName: name, model })
      const raw = await postMultipart(endpoint, apiKey, multipart, timeoutMs)
      let text = String(raw || '').trim()
      try {
        const j = JSON.parse(raw)
        text = String(j?.text || j?.transcript || '').trim()
      } catch (_) {}
      text = clampText(text)
      if (!text) throw new Error('empty transcription')
      return { ok: true, text, model, source: 'cloud', engine: model }
    } catch (e) {
      lastError = e
    }
  }

  return {
    ok: false,
    text: '',
    error: lastError ? (lastError.message || String(lastError)) : 'transcription failed',
    source: 'cloud'
  }
}

module.exports = {
  transcribeAudioFile
}
