/**
 * 飞书 / Telegram / 钉钉 入站回复：文本清洗、截图路径解析、可见文本提取（无 Electron UI 依赖）
 * @param {{ path: typeof import('path'), fs: typeof import('fs'), getAppRoot: () => string, getAppRootPath: (...p: string[]) => string, stripRawToolCallXml: (t: string) => string }} deps
 */
function createInboundMessageTextHelpers (deps) {
  const { path, fs, getAppRoot, getAppRootPath, stripRawToolCallXml } = deps

  function extractLocalResourceScreenshots (text) {
    const re = /!\[([^\]]*)\]\((local-resource:\/\/screenshots\/[^)]+)\)/g
    const filePaths = []
    let match
    while ((match = re.exec(text)) !== null) {
      const urlPath = match[2]
      const filename = urlPath.replace(/^local-resource:\/\/screenshots\//i, '').replace(/^\/+/, '')
      if (filename) {
        const fullPath = getAppRootPath('screenshots', filename)
        filePaths.push(fullPath)
      }
    }
    const cleanedText = text.replace(/!\[[^\]]*\]\(local-resource:\/\/screenshots\/[^)]+\)/g, '【截图】')
    return { cleanedText, filePaths }
  }

  function extractLocalFilesFromText (text, baseDir = '') {
    const src = String(text || '')
    if (!src.trim()) return []
    const out = []
    const seen = new Set()
    const base = String(baseDir || '').trim()
    const absBase = base && path.isAbsolute(base) ? base : ''
    const addIfValid = (p) => {
      if (!p || typeof p !== 'string') return
      const raw = p.trim().replace(/^['"`]|['"`]$/g, '')
      if (!raw) return
      if (/^(https?:|local-resource:)/i.test(raw)) return
      const candidates = []
      if (raw.startsWith('/')) {
        candidates.push(raw)
      } else if (absBase) {
        candidates.push(path.resolve(absBase, raw.replace(/^\.\//, '')))
      } else {
        return
      }
      for (const full of candidates) {
        if (seen.has(full)) continue
        try {
          if (!fs.existsSync(full)) continue
          const st = fs.statSync(full)
          if (!st.isFile()) continue
          seen.add(full)
          out.push(full)
        } catch (_) {}
      }
    }

    const codePathRe = /`([^`\n]+)`/g
    let m
    while ((m = codePathRe.exec(src)) !== null) {
      const candidate = String(m[1] || '').trim()
      if (!candidate) continue
      if (!/[\\/]/.test(candidate) && !/\.[a-z0-9]{1,8}$/i.test(candidate)) continue
      addIfValid(candidate)
    }

    const linkPathRe = /\]\(([^)\n]+)\)/g
    while ((m = linkPathRe.exec(src)) !== null) addIfValid(m[1])

    const namedPathRe = /(file_path|local_path|path)\s*[:：]\s*([^\s]+)/gi
    while ((m = namedPathRe.exec(src)) !== null) addIfValid(m[2])

    return out
  }

  function isImageFilePath (filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase()
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)
  }

  function getCurrentRoundMessages (messages) {
    if (!Array.isArray(messages) || messages.length === 0) return []
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx < 0) return messages
    return messages.slice(lastUserIdx + 1)
  }

  function detectImageExtFromBuffer (buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png'
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9) return 'jpg'
    if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif'
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
    if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp'
    return null
  }

  function isValidImageBase64 (input) {
    if (!input || typeof input !== 'string') return false
    let raw = input.trim()
    if (!raw) return false
    if (raw.includes('...(已截断') || raw.includes('...(truncated)')) return false
    const m = raw.match(/^data:[^;,]+;base64,(.*)$/i)
    if (m) raw = m[1] || ''
    raw = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
    while (raw.length % 4 !== 0) raw += '='
    if (raw.length < 128) return false
    const buf = Buffer.from(raw, 'base64')
    if (!buf || buf.length < 16) return false
    return !!detectImageExtFromBuffer(buf)
  }

  function extractScreenshotsFromMessages (messages) {
    const out = []
    if (!Array.isArray(messages)) return out
    const seenPath = new Set()
    const seenBase64 = new Set()
    for (const msg of messages) {
      if (msg.role !== 'tool') continue
      let raw = msg.content
      if (raw == null) continue
      if (typeof raw !== 'string') raw = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
      let filePath = null
      let fileUrl = null
      let imageBase64 = null
      try {
        const obj = JSON.parse(raw)
        if (obj && typeof obj === 'object') {
          filePath = obj.file_path || obj.filePath
          fileUrl = obj.file_url || obj.fileUrl
          imageBase64 = obj.image_base64 || obj.imageBase64
        }
      } catch (e) {
        const pathMatch = raw.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        if (pathMatch) filePath = pathMatch[1]
        if (!filePath) {
          const urlMatch = raw.match(/"file_url"\s*:\s*"(local-resource:\/\/[^"]+)"/)
          if (urlMatch) fileUrl = urlMatch[1]
        }
        if (!imageBase64 && raw.includes('"image_base64"')) {
          const b64Match = raw.match(/"image_base64"\s*:\s*"([^"]*)"/)
          if (b64Match && b64Match[1].length > 100) imageBase64 = b64Match[1]
        }
      }
      if (filePath && typeof filePath === 'string' && filePath.includes('screenshots') && !seenPath.has(filePath)) {
        seenPath.add(filePath)
        out.push({ path: filePath })
      } else if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('local-resource://')) {
        if (fileUrl.startsWith('local-resource://screenshots/')) {
          const filename = fileUrl.replace(/^local-resource:\/\/screenshots\//i, '').replace(/^\/+/, '')
          if (filename) {
            const fullPath = getAppRootPath('screenshots', filename)
            if (!seenPath.has(fullPath)) { seenPath.add(fullPath); out.push({ path: fullPath }) }
          }
        } else if (fileUrl.startsWith('local-resource://artifacts/')) {
          const rel = fileUrl.replace(/^local-resource:\/\//i, '').replace(/\//g, path.sep)
          const fullPath = path.join(getAppRoot(), rel)
          if (!seenPath.has(fullPath) && fs.existsSync(fullPath)) { seenPath.add(fullPath); out.push({ path: fullPath }) }
        }
      }
      if (imageBase64 && typeof imageBase64 === 'string' && isValidImageBase64(imageBase64) && !seenBase64.has(imageBase64.slice(0, 50))) {
        seenBase64.add(imageBase64.slice(0, 50))
        out.push({ base64: imageBase64 })
      }
    }
    return out
  }

  function parseScreenshotFromToolResult (result) {
    const out = []
    let filePath = null
    let fileUrl = null
    let imageBase64 = null
    let obj = null
    if (result == null) return out
    if (typeof result === 'object' && !Array.isArray(result) && !result.error) {
      obj = result
      filePath = obj.file_path || obj.filePath || obj.path
      fileUrl = obj.file_url || obj.fileUrl
      imageBase64 = obj.image_base64 || obj.imageBase64
    } else {
      const resultStr = typeof result === 'string' ? result : String(result)
      try {
        obj = JSON.parse(resultStr)
        if (obj && typeof obj === 'object' && !obj.error) {
          filePath = obj.file_path || obj.filePath || obj.path
          fileUrl = obj.file_url || obj.fileUrl
          imageBase64 = obj.image_base64 || obj.imageBase64
        }
      } catch (e) {
        const pathMatch = resultStr.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        if (pathMatch) filePath = pathMatch[1]
        if (!filePath) {
          const pathAlt = resultStr.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
          if (pathAlt) filePath = pathAlt[1]
        }
        if (!filePath) {
          const urlMatch = resultStr.match(/"file_url"\s*:\s*"(local-resource:\/\/[^"]+)"/)
          if (urlMatch) fileUrl = urlMatch[1]
        }
        if (resultStr.includes('"image_base64"')) {
          const b64Match = resultStr.match(/"image_base64"\s*:\s*"([^"]*)"/)
          if (b64Match && b64Match[1].length > 100) imageBase64 = b64Match[1]
        }
      }
    }
    if (filePath && typeof filePath === 'string' && filePath.length > 0) {
      const pathToPush = path.isAbsolute(filePath) ? filePath : getAppRootPath('screenshots', path.basename(filePath))
      out.push({ path: pathToPush })
    }
    if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('local-resource://')) {
      if (fileUrl.startsWith('local-resource://screenshots/')) {
        const filename = fileUrl.replace(/^local-resource:\/\/screenshots\//i, '').replace(/^\/+/, '')
        if (filename) out.push({ path: getAppRootPath('screenshots', filename) })
      } else if (fileUrl.startsWith('local-resource://artifacts/')) {
        const rel = fileUrl.replace(/^local-resource:\/\//i, '').replace(/\//g, path.sep)
        const fullPath = path.join(getAppRoot(), rel)
        if (fs.existsSync(fullPath)) out.push({ path: fullPath })
      }
    }
    if (imageBase64 && typeof imageBase64 === 'string' && isValidImageBase64(imageBase64)) {
      out.push({ base64: imageBase64 })
    }
    return out
  }

  function redactSensitiveText (text) {
    if (!text || typeof text !== 'string') return text
    let s = String(text)
    s = s.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[REDACTED]')
    s = s.replace(/("?(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|secret|password|passwd|token)"?\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    s = s.replace(/((?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|secret|password|passwd|token)\s*=\s*)([^\s"'`,;}{]{4,})/gi, '$1[REDACTED]')
    s = s.replace(/((?:x-api-key|authorization)\s*[:=]\s*)([^\s"'`,;}{]{4,})/gi, '$1[REDACTED]')
    s = s.replace(/\bsk-[A-Za-z0-9]{8,}\b/g, 'sk-[REDACTED]')
    s = s.replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)([^&\s]+)/gi, '$1[REDACTED]')
    return s
  }

  function stripToolProtocolAndJsonNoise (text, { dropJsonEnvelope = true } = {}) {
    if (!text || typeof text !== 'string') return text
    let s = redactSensitiveText(String(text))
    s = stripRawToolCallXml(s)
    s = s.replace(/^\s*<\/?(tool_call|function|parameter)\b[^>]*>\s*$/gim, '')
    s = s.replace(/^\s*<function=[^>]*>\s*$/gim, '')
    s = s.replace(/^\s*<parameter=[^>]*>\s*$/gim, '')
    s = s.replace(/^\s*<\/(function|parameter|tool_call)>\s*$/gim, '')
    s = s.replace(/^\s*\[(tool_call|tool_result|meta|token)\][^\n]*$/gim, '')

    const trimmed = s.trim()
    if (dropJsonEnvelope && trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          const keys = Object.keys(obj)
          const hasToolEnvelope =
            keys.includes('success') ||
            keys.includes('content') ||
            keys.includes('stdout') ||
            keys.includes('stderr') ||
            keys.includes('result') ||
            keys.includes('meta') ||
            keys.includes('tool_call_id') ||
            keys.includes('tool_calls')
          const hasVersionMeta = obj.meta && typeof obj.meta === 'object' && (
            Object.prototype.hasOwnProperty.call(obj.meta, 'lastTouchedVersion') ||
            Object.prototype.hasOwnProperty.call(obj.meta, 'lastTouchedAt')
          )
          if (hasToolEnvelope || hasVersionMeta) {
            return ''
          }
        }
      } catch (_) {}
    }

    s = s.replace(/^\s*\{"success"\s*:\s*(true|false)[\s\S]*\}\s*$/gim, '')
    return redactSensitiveText(s.replace(/\n{3,}/g, '\n\n').trim())
  }

  function stripFeishuScreenshotMisfireText (text) {
    if (!text || typeof text !== 'string') return text
    let s = stripToolProtocolAndJsonNoise(text)
    s = s.replace(/由于飞书通知需要配置[^。]*chat_id[^。]*。[^\n]*请提供[^。]*。[^\n]*我就可以把截图发给你了[^。]*。?/g, '')
    s = s.replace(/由于飞书通知需要配置[^\n]+/g, '')
    s = s.replace(/请提供你的飞书会话\s*ID[^\n]+/g, '')
    s = s.replace(/或者到[^\n]+配置默认会话[^\n]+/g, '')
    s = s.replace(/我就可以把截图发给你了[^\n]*/g, '')
    s = s.replace(/截图文件路径[：:]\s*`[^`]+`\s*/g, '')
    s = s.replace(/^截图已保存[。.]?\s*/gm, '')
    return s.replace(/\n{3,}/g, '\n\n').trim()
  }

  function stripFalseDeliveredClaims (text, { hasImages = false, hasFiles = false, channel = '' } = {}) {
    if (!text || typeof text !== 'string') return text
    if (hasImages || hasFiles) return text
    const ch = String(channel || '').toLowerCase()
    let s = text
    if (ch === 'feishu') {
      s = s.replace(/系统已自动发送到当前飞书会话。?/g, '')
      s = s.replace(/并通过系统自动发送到当前飞书会话。?/g, '')
      s = s.replace(/截图已发至当前会话。?/g, '')
      s = s.replace(/已自动发送到当前飞书会话。?/g, '')
      s = s.replace(/截图已获取[！!。.]?/g, '')
      s = s.replace(/截图已发送[！!。.]?/g, '')
      s = s.replace(/截图如下[：:]?/g, '')
      s = s.replace(/已按[^。\n]*截图[^。\n]*发送[！!。.]?/g, '')
    }
    return s.replace(/\n{3,}/g, '\n\n').trim()
  }

  function getAssistantText (message) {
    if (!message || message.role !== 'assistant') return ''
    const c = message.content
    if (typeof c === 'string') return stripToolProtocolAndJsonNoise(c, { dropJsonEnvelope: false })
    if (Array.isArray(c)) {
      return stripToolProtocolAndJsonNoise(c
        .map((part) => {
          if (!part) return ''
          if (typeof part === 'string') return part
          if (typeof part.text === 'string') return part.text
          return ''
        }).join(''), { dropJsonEnvelope: false })
    }
    return ''
  }

  function extractLatestSessionsSpawnResult (messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) return ''
    const spawnCallIds = new Set()
    for (const m of messages) {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
      for (const tc of m.tool_calls) {
        if (tc?.function?.name === 'sessions_spawn' && tc.id) spawnCallIds.add(String(tc.id))
      }
    }
    let last = ''
    const pickTextFromToolContent = (content) => {
      if (typeof content === 'string') return content.trim()
      if (Array.isArray(content)) {
        const txt = content
          .map((x) => {
            if (!x) return ''
            if (typeof x === 'string') return x
            if (typeof x.text === 'string') return x.text
            return ''
          })
          .join('')
          .trim()
        return txt
      }
      return ''
    }
    for (const m of messages) {
      if (!m || m.role !== 'tool') continue
      const tcid = String(m.tool_call_id || '')
      if (!tcid || !spawnCallIds.has(tcid)) continue
      const raw = pickTextFromToolContent(m.content)
      if (!raw) continue
      try {
        const obj = JSON.parse(raw)
        const r = obj && obj.result != null ? String(obj.result).trim() : ''
        const s = obj && obj.stdout != null ? String(obj.stdout).trim() : ''
        const msg = obj && obj.message != null ? String(obj.message).trim() : ''
        const envSummary = obj && obj.envelope && obj.envelope.summary != null
          ? String(obj.envelope.summary).trim()
          : ''
        if (r) last = r
        else if (s) last = s
        else if (msg) last = msg
        else if (envSummary) last = envSummary
      } catch (_) {}
    }
    return last
  }

  /** 子 Agent sessions_spawn 结果文本：去协议噪声并压成单行语义，供渠道侧选句 */
  function compactSpawnResultText (text = '') {
    const t = stripToolProtocolAndJsonNoise(String(text || ''), { dropJsonEnvelope: true }).trim()
    return t.replace(/\s+/g, ' ').trim()
  }

  /** 是否像寒暄/空回复，用于协调 Agent 选主答还是 spawn 摘要 */
  function looksLikeGenericGreeting (text = '') {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (!t || t.length > 80) return false
    if (/^(你好|您好|hi\b|hello\b|在吗|在么|早上好|下午好|晚上好|哈喽|嗨)[，,。.!\s]*$/i.test(t)) return true
    if (/^(ok|好的|好哒|收到|谢谢|感谢|嗯|恩|👍|谢谢老板)[，,。.!\s]*$/i.test(t)) return true
    return false
  }

  /** 去掉「已派发」等对用户无增量价值的套话 */
  function stripDispatchBoilerplateText (text = '') {
    let s = String(text || '')
    s = s.replace(/已派发给子\s*Agent[^。\n]*/gi, '')
    s = s.replace(/任务已派发给[^。\n]*/gi, '')
    s = s.replace(/子\s*Agent\s*正在[^。\n]*/gi, '')
    return s.replace(/\n{3,}/g, '\n\n').trim()
  }

  function hasScreenshotClaimText (text) {
    const t = String(text || '').trim()
    if (!t) return false
    return /(截图已获取|已截图|已完成截图|截图并发送|截图已发送|截图如下|已按.+截图)/i.test(t)
  }

  function extractLatestVisibleText (messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) return ''
    const pickText = (content) => {
      if (typeof content === 'string') return content.trim()
      if (Array.isArray(content)) {
        return content
          .map((x) => {
            if (!x) return ''
            if (typeof x === 'string') return x
            if (typeof x.text === 'string') return x.text
            return ''
          })
          .join('')
          .trim()
      }
      return ''
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || m.role === 'user' || m.role === 'system') continue
      if (m.role === 'assistant') {
        const t = String(getAssistantText(m) || '').trim()
        if (t) return t
        continue
      }
      if (m.role === 'tool') {
        const raw = pickText(m.content)
        if (!raw) continue
        let t = raw
        try {
          const obj = JSON.parse(raw)
          const candidates = [
            obj && obj.result != null ? String(obj.result).trim() : '',
            obj && obj.message != null ? String(obj.message).trim() : '',
            obj && obj.summary != null ? String(obj.summary).trim() : '',
            obj && obj.content != null ? String(obj.content).trim() : ''
          ].filter(Boolean)
          if (candidates.length > 0) t = candidates[0]
        } catch (_) {}
        t = stripToolProtocolAndJsonNoise(t, { dropJsonEnvelope: true }).trim()
        if (!t || /^\[(meta|tool_call|token)\]/i.test(t)) continue
        return t
      }
      const t = stripToolProtocolAndJsonNoise(pickText(m.content), { dropJsonEnvelope: true }).trim()
      if (t) return t
    }
    return ''
  }

  function overwriteLatestAssistantText (messages = [], text = '') {
    if (!Array.isArray(messages) || messages.length === 0) return messages
    const next = [...messages]
    for (let i = next.length - 1; i >= 0; i--) {
      const m = next[i]
      if (!m || m.role !== 'assistant') continue
      const old = getAssistantText(m)
      if (!String(old || '').trim()) continue
      next[i] = { ...m, content: String(text || '').trim() }
      return next
    }
    return next
  }

  function hasResultSignals (text = '') {
    const t = String(text || '').trim()
    if (!t) return false
    if (t.length >= 90) return true
    if (/(https?:\/\/|\/Users\/|[A-Za-z]:\\|file:\/\/|\.html\b|\.md\b|\.png\b|\.jpg\b|\.zip\b)/i.test(t)) return true
    const lines = t.split('\n').map(x => x.trim()).filter(Boolean)
    if (lines.length >= 3) return true
    const listLike = lines.filter((x) => /^[-*]\s+/.test(x) || /^\d+\.\s+/.test(x)).length
    if (listLike >= 2) return true
    if (/^#{1,3}\s+/.test(t)) return true
    return false
  }

  function isLowInformationReply (text = '') {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (!t) return true
    if (/[?？]\s*$/.test(t)) return false
    if (hasResultSignals(t)) return false
    return t.length <= 60
  }

  function looksLikeNoResultPlaceholderText (text = '') {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (!t) return false
    const patterns = [
      /任务已执行完成，但未生成可展示的文本结果/,
      /未生成可展示的文本结果/,
      /未生成可展示结果/,
      /无回复内容/,
      /无可展示结果/
    ]
    return patterns.some((re) => re.test(t))
  }

  function hasUsefulVisibleResult (text = '') {
    const t = String(text || '').trim()
    if (!t) return false
    if (looksLikeNoResultPlaceholderText(t)) return false
    if (isLowInformationReply(t)) return false
    return true
  }

  return {
    extractLocalResourceScreenshots,
    extractLocalFilesFromText,
    isImageFilePath,
    getCurrentRoundMessages,
    detectImageExtFromBuffer,
    isValidImageBase64,
    extractScreenshotsFromMessages,
    parseScreenshotFromToolResult,
    redactSensitiveText,
    stripToolProtocolAndJsonNoise,
    stripFeishuScreenshotMisfireText,
    stripFalseDeliveredClaims,
    getAssistantText,
    extractLatestSessionsSpawnResult,
    compactSpawnResultText,
    looksLikeGenericGreeting,
    stripDispatchBoilerplateText,
    hasScreenshotClaimText,
    extractLatestVisibleText,
    overwriteLatestAssistantText,
    hasResultSignals,
    isLowInformationReply,
    looksLikeNoResultPlaceholderText,
    hasUsefulVisibleResult
  }
}

module.exports = { createInboundMessageTextHelpers }
