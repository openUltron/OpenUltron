const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { getWorkspacePath } = require('../app-root')
const { runImageOcr } = require('./image-ocr')
const { transcribeAudioFile } = require('./audio-transcribe')

const MAX_SINGLE_FILE_BYTES = 20 * 1024 * 1024
const MAX_ROUND_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_TEXT_CHARS_PER_FILE = 8000

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs',
  '.c', '.h', '.cpp', '.hpp', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.log',
  '.ini', '.toml', '.conf', '.env', '.gitignore', '.dockerfile'
])
const AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm', '.mp4', '.mpeg', '.mpga'
])

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function sanitizeSessionId(input) {
  const s = String(input || 'unknown-session').trim()
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'unknown-session'
}

function sanitizeName(input) {
  const base = path.basename(String(input || 'file'))
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return safe || 'file'
}

function toBuffer(item) {
  if (Buffer.isBuffer(item.buffer)) return item.buffer
  if (typeof item.dataBase64 === 'string' && item.dataBase64.length > 0) {
    return Buffer.from(item.dataBase64, 'base64')
  }
  if (item.path && fs.existsSync(item.path)) {
    return fs.readFileSync(item.path)
  }
  return null
}

function classifyKind(name, mime) {
  const ext = path.extname(name || '').toLowerCase()
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('text/')) return 'text'
  if (m.startsWith('audio/')) return 'audio'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'file'
}

function extractText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ''
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  if (text.length > MAX_TEXT_CHARS_PER_FILE) {
    text = text.slice(0, MAX_TEXT_CHARS_PER_FILE) + '\n...(truncated)'
  }
  return text
}

function trimOcrText(s) {
  const text = String(s || '').trim()
  if (!text) return ''
  if (text.length <= MAX_TEXT_CHARS_PER_FILE) return text
  return text.slice(0, MAX_TEXT_CHARS_PER_FILE) + '\n...(truncated)'
}

function extractPdfTextBestEffort(filePath) {
  try {
    // macOS / Linux 通常自带 strings；无需额外安装依赖
    const out = execFileSync('strings', ['-n', '4', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024
    }) || ''
    const lines = String(out)
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => /[\u4e00-\u9fa5A-Za-z0-9]/.test(s))
      .slice(0, 220)
    if (!lines.length) return ''
    let text = lines.join('\n')
    if (text.length > MAX_TEXT_CHARS_PER_FILE) text = text.slice(0, MAX_TEXT_CHARS_PER_FILE) + '\n...(truncated)'
    return text
  } catch {
    return ''
  }
}

function buildRoundDir(sessionId) {
  const root = getWorkspacePath('attachments')
  const sid = sanitizeSessionId(sessionId)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const id = crypto.randomBytes(4).toString('hex')
  const roundDir = path.join(root, sid, `${ts}-${id}`)
  ensureDir(roundDir)
  return roundDir
}

function saveMeta(fileDir, meta) {
  fs.writeFileSync(path.join(fileDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

function formatBytes(n) {
  const bytes = Number(n || 0)
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

function buildAttachmentContext(accepted = []) {
  if (!Array.isArray(accepted) || accepted.length === 0) return ''
  const out = ['[Attachment Context]']
  for (const [i, item] of accepted.entries()) {
    const idx = i + 1
    const prefix = `${idx}. [${item.kind}] ${item.name} (${item.mime || 'application/octet-stream'}, ${formatBytes(item.size)})`
    out.push(prefix)
    out.push(`   local_path: ${item.localPath}`)
    if (item.extractedText) {
      out.push('   content:')
      out.push('```text')
      out.push(item.extractedText)
      out.push('```')
      if (item.kind === 'audio' && (item.asrSource || item.asrEngine)) {
        const src = item.asrSource || 'unknown'
        const eng = item.asrEngine ? `/${item.asrEngine}` : ''
        out.push(`   asr: ${src}${eng}`)
      }
    } else if (item.kind === 'image') {
      if (item.visionText) {
        out.push('   vision:')
        out.push('```text')
        out.push(item.visionText)
        out.push('```')
      } else if (item.visionInput) {
        out.push('   note: image provided directly to vision-capable model; no local OCR was executed.')
      } else {
        out.push('   note: image saved; no OCR/vision output available, use local_path if further reading is needed.')
      }
    } else {
      out.push('   note: binary file saved; use local_path if tool-based reading is needed.')
    }
  }
  return out.join('\n')
}

async function ingestRoundAttachments({
  sessionId,
  source = 'main',
  attachments = [],
  imageMode = 'ocr',
  perFileLimit = MAX_SINGLE_FILE_BYTES,
  roundLimit = MAX_ROUND_TOTAL_BYTES
} = {}) {
  const accepted = []
  const rejected = []
  let totalAcceptedBytes = 0

  const items = Array.isArray(attachments) ? attachments : []
  const roundDir = buildRoundDir(sessionId)

  for (let idx = 0; idx < items.length; idx++) {
    const raw = items[idx] || {}
    const name = sanitizeName(raw.name || raw.fileName || `file-${idx + 1}`)
    const mime = String(raw.mime || raw.contentType || '').trim() || 'application/octet-stream'
    const declaredSize = Number(raw.size || 0)

    const buffer = toBuffer(raw)
    if (!buffer) {
      rejected.push({ name, size: declaredSize || 0, code: 'NO_DATA', error: 'Attachment has no readable data' })
      continue
    }
    const size = buffer.length
    if (size > perFileLimit) {
      rejected.push({ name, size, code: 'FILE_TOO_LARGE', error: `Single file exceeds limit ${formatBytes(perFileLimit)}` })
      continue
    }
    if (totalAcceptedBytes + size > roundLimit) {
      rejected.push({ name, size, code: 'ROUND_TOO_LARGE', error: `Round total exceeds limit ${formatBytes(roundLimit)}` })
      continue
    }

    const kind = classifyKind(name, mime)
    const attachmentId = `${Date.now()}-${idx}-${crypto.randomBytes(3).toString('hex')}`
    const fileDir = path.join(roundDir, attachmentId)
    ensureDir(fileDir)
    const dataPath = path.join(fileDir, name)
    fs.writeFileSync(dataPath, buffer)

    const item = {
      attachmentId,
      clientId: raw.clientId || '',
      source,
      kind,
      name,
      mime,
      size,
      localPath: dataPath,
      status: 'ok',
      extractedText: '',
      visionText: '',
      visionInput: false,
      asrSource: '',
      asrEngine: ''
    }

    if (kind === 'text') {
      item.extractedText = extractText(buffer)
    } else if (kind === 'image') {
      if (imageMode === 'vision') {
        item.visionInput = true
      } else {
        const ocr = await runImageOcr(dataPath)
        if (ocr.ok && ocr.text) {
          item.visionText = trimOcrText(ocr.text)
          item.status = 'ok'
        } else {
          item.status = 'degraded'
          item.visionText = ''
        }
      }
    } else if (kind === 'audio') {
      const asr = await transcribeAudioFile(dataPath, { timeoutMs: 180000 })
      if (asr.ok && asr.text) {
        item.extractedText = asr.text
        item.asrSource = String(asr.source || '')
        item.asrEngine = String(asr.engine || asr.model || '')
        item.status = 'ok'
      } else {
        item.status = 'degraded'
        item.asrSource = String(asr.source || '')
      }
    } else if (path.extname(name).toLowerCase() === '.pdf') {
      const pdfText = extractPdfTextBestEffort(dataPath)
      if (pdfText) {
        item.extractedText = pdfText
        item.status = 'ok'
      } else {
        item.status = 'degraded'
      }
    }

    saveMeta(fileDir, {
      ...item,
      declaredSize,
      savedAt: new Date().toISOString()
    })

    accepted.push(item)
    totalAcceptedBytes += size
  }

  return {
    success: true,
    accepted,
    rejected,
    totalAcceptedBytes,
    contextText: buildAttachmentContext(accepted),
    limits: {
      perFileLimit,
      roundLimit
    },
    storageRoot: roundDir
  }
}

module.exports = {
  MAX_SINGLE_FILE_BYTES,
  MAX_ROUND_TOTAL_BYTES,
  ingestRoundAttachments,
  buildAttachmentContext
}
