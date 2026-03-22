'use strict'

/**
 * 飞书/TG/钉钉 侧：会话内产物缓存、artifactRegistry 登记、飞书链接引用解析与挂到最后一条 assistant。
 */
function createImChannelArtifactHandlers(deps) {
  const { path, fs, artifactRegistry, appLogger, getAssistantText } = deps

  const recentArtifactsBySession = new Map() // sessionId -> Array<{ path, kind, ts }>

  function rememberSessionArtifacts(sessionId, payload = {}) {
    const sid = String(sessionId || '').trim()
    if (!sid) return
    const now = Date.now()
    const list = recentArtifactsBySession.get(sid) || []
    const pushItem = (p, kind) => {
      const full = String(p || '').trim()
      if (!full || !path.isAbsolute(full)) return
      if (!fs.existsSync(full)) return
      list.push({ path: full, kind, ts: now })
    }
    for (const x of (Array.isArray(payload.images) ? payload.images : [])) {
      if (x && x.path) pushItem(x.path, 'image')
    }
    for (const x of (Array.isArray(payload.files) ? payload.files : [])) {
      if (x && x.path) pushItem(x.path, 'file')
    }
    const dedup = new Map()
    for (const it of list.slice(-80)) {
      dedup.set(`${it.kind}:${it.path}`, it)
    }
    recentArtifactsBySession.set(sid, [...dedup.values()].sort((a, b) => b.ts - a.ts).slice(0, 30))
  }

  function getRememberedSessionArtifacts(sessionId) {
    const sid = String(sessionId || '').trim()
    if (!sid) return { images: [], files: [] }
    const list = recentArtifactsBySession.get(sid) || []
    const images = []
    const files = []
    for (const it of list) {
      if (!it || !it.path || !fs.existsSync(it.path)) continue
      if (it.kind === 'image') images.push({ path: it.path })
      else files.push({ path: it.path })
    }
    return { images, files }
  }

  function normalizeArtifactsFromItems(images = [], files = []) {
    const out = []
    const pushArtifact = (kind, p, artifactId = '') => {
      const full = String(p || '').trim()
      if (!full || !path.isAbsolute(full) || !fs.existsSync(full)) return
      const item = {
        kind,
        path: full,
        name: path.basename(full),
        ts: new Date().toISOString()
      }
      if (artifactId) item.artifactId = String(artifactId)
      out.push(item)
    }
    for (const x of (Array.isArray(images) ? images : [])) {
      if (x && x.path) pushArtifact('image', x.path, x.artifactId || '')
    }
    for (const x of (Array.isArray(files) ? files : [])) {
      if (x && x.path) pushArtifact('file', x.path, x.artifactId || '')
    }
    return out
  }

  function registerArtifactsFromItems({ images = [], files = [], context = {} } = {}) {
    const registeredImages = []
    const registeredFiles = []
    const refs = []
    const registerOne = (input = {}, kindHint = 'file') => {
      try {
        const p = String(input.path || '').trim()
        const existingId = String(input.artifactId || '').trim()
        if (existingId && p && path.isAbsolute(p) && fs.existsSync(p)) {
          refs.push({
            artifactId: existingId,
            kind: kindHint,
            path: p,
            name: input.filename || path.basename(p),
            ts: new Date().toISOString()
          })
          return {
            path: p,
            filename: input.filename || path.basename(p),
            artifactId: existingId
          }
        }
        let rec = null
        if (p && path.isAbsolute(p) && fs.existsSync(p)) {
          rec = artifactRegistry.registerFileArtifact({
            path: p,
            filename: input.filename || path.basename(p),
            kind: kindHint,
            source: String(context.source || 'unknown'),
            channel: String(context.channel || ''),
            sessionId: String(context.sessionId || ''),
            runSessionId: String(context.runSessionId || ''),
            messageId: String(context.messageId || ''),
            chatId: String(context.chatId || ''),
            role: String(context.role || '')
          })
        } else if (!p && input.base64) {
          rec = artifactRegistry.registerBase64Artifact({
            base64: input.base64,
            ext: kindHint === 'image' ? '.png' : '.bin',
            kind: kindHint,
            source: String(context.source || 'unknown'),
            channel: String(context.channel || ''),
            sessionId: String(context.sessionId || ''),
            runSessionId: String(context.runSessionId || ''),
            messageId: String(context.messageId || ''),
            chatId: String(context.chatId || ''),
            role: String(context.role || '')
          })
        }
        if (!rec) return null
        refs.push({
          artifactId: rec.artifactId,
          kind: rec.kind || kindHint,
          path: rec.path,
          name: rec.filename || path.basename(rec.path),
          ts: rec.createdAt || new Date().toISOString()
        })
        return {
          path: rec.path,
          filename: rec.filename || input.filename || path.basename(rec.path),
          artifactId: rec.artifactId
        }
      } catch (e) {
        appLogger?.warn?.('[ArtifactRegistry] register from items failed', { error: e.message || String(e) })
        return null
      }
    }
    for (const img of (Array.isArray(images) ? images : [])) {
      const rec = registerOne(img || {}, 'image')
      if (rec) registeredImages.push(rec)
      else if (img?.path || img?.base64) registeredImages.push(img)
    }
    for (const f of (Array.isArray(files) ? files : [])) {
      const rec = registerOne(f || {}, 'file')
      if (rec) registeredFiles.push(rec)
      else if (f?.path || f?.base64) registeredFiles.push(f)
    }
    return { images: registeredImages, files: registeredFiles, refs }
  }

  function extractFeishuReferenceCandidatesFromText(text = '', options = {}) {
    const src = String(text || '')
    if (!src.trim()) return []
    const docHost = String(options.docHost || '').trim().toLowerCase()
    const hasDocHost = /^[a-z0-9.-]+\.(?:feishu\.cn|larksuite\.com)$/i.test(docHost)
    const buildDocUrl = (id) => (hasDocHost ? `https://${docHost}/docx/${id}` : `feishu://docx/${id}`)
    const out = []
    const seen = new Set()
    const sanitizeUrl = (raw) => {
      let u = String(raw || '').trim()
      while (/[*),.;:!?'"`]+$/.test(u)) u = u.slice(0, -1)
      return u
    }
    const isInvalidFeishuReferenceUrl = (url) => {
      const u = String(url || '')
      if (!u) return true
      if (/applink\.feishu\.cn\/client\/mini_app/i.test(u)) return true
      if (/accounts\.feishu\.cn\/login/i.test(u)) return true
      if (/feishu\.cn\/docs\/?$/i.test(u)) return true
      return false
    }
    const push = (item) => {
      if (!item || !item.url) return
      if (isInvalidFeishuReferenceUrl(item.url)) return
      const key = `${item.kind}|${item.url}|${item.refKey || ''}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(item)
    }

    const urlRe = /https?:\/\/[^\s)\]>"']+/gi
    let m
    while ((m = urlRe.exec(src)) !== null) {
      const url = sanitizeUrl(m[0])
      if (!/(feishu\.cn|larksuite\.com)/i.test(url)) continue
      if (/\/document\/client-docs\/docs\//i.test(url) || /\/docx\//i.test(url)) {
        const id = (url.match(/\/docs\/([A-Za-z0-9]+)/i) || url.match(/\/docx\/([A-Za-z0-9]+)/i) || [])[1] || ''
        push({ kind: 'feishu_doc', url, refKey: id, title: id ? `doc:${id}` : 'feishu_doc' })
        continue
      }
      if (/\/base\//i.test(url)) {
        const token = (url.match(/\/base\/([A-Za-z0-9]+)/i) || [])[1] || ''
        push({ kind: 'feishu_bitable', url, refKey: token, title: token ? `bitable:${token}` : 'feishu_bitable' })
        continue
      }
      if (/\/sheets?\//i.test(url)) {
        const token = (url.match(/\/sheets?\/([A-Za-z0-9]+)/i) || [])[1] || ''
        push({ kind: 'feishu_sheet', url, refKey: token, title: token ? `sheet:${token}` : 'feishu_sheet' })
        continue
      }
      if (/\/wiki\//i.test(url)) {
        const token = (url.match(/\/wiki\/([A-Za-z0-9]+)/i) || [])[1] || ''
        push({ kind: 'feishu_wiki', url, refKey: token, title: token ? `wiki:${token}` : 'feishu_wiki' })
        continue
      }
      push({ kind: 'feishu_link', url, refKey: '', title: 'feishu_link' })
    }

    const docIdRe = /(?:document_id|doc(?:ument)?_id)\s*["':= ]+\s*([A-Za-z0-9]{10,})/gi
    while ((m = docIdRe.exec(src)) !== null) {
      const id = String(m[1] || '').trim()
      if (!id) continue
      push({
        kind: 'feishu_doc',
        url: buildDocUrl(id),
        refKey: id,
        title: `doc:${id}`
      })
    }

    const sheetTokenRe = /spreadsheet_token\s*["':= ]+\s*([A-Za-z0-9]{8,})/gi
    while ((m = sheetTokenRe.exec(src)) !== null) {
      const token = String(m[1] || '').trim()
      if (!token) continue
      push({
        kind: 'feishu_sheet',
        url: `feishu://sheet/${token}`,
        refKey: token,
        title: `sheet:${token}`
      })
    }

    const bitableTokenRe = /app_token\s*["':= ]+\s*([A-Za-z0-9]{8,})/gi
    while ((m = bitableTokenRe.exec(src)) !== null) {
      const token = String(m[1] || '').trim()
      if (!token) continue
      push({
        kind: 'feishu_bitable',
        url: `feishu://bitable/${token}`,
        refKey: token,
        title: `bitable:${token}`
      })
    }

    return out
  }

  function registerReferenceArtifactsFromMessages(messages = [], context = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return []
    const refs = []
    const seen = new Set()
    const push = (rec) => {
      if (!rec || !rec.artifactId) return
      const key = String(rec.artifactId)
      if (seen.has(key)) return
      seen.add(key)
      refs.push(rec)
    }
    const pickText = (content) => {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) return content.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('')
      return ''
    }
    for (const m of messages) {
      if (!m || (m.role !== 'assistant' && m.role !== 'tool')) continue
      const text = m.role === 'assistant' ? getAssistantText(m) : pickText(m.content)
      const candidates = extractFeishuReferenceCandidatesFromText(text, { docHost: context.docHost || '' })
      for (const c of candidates) {
        const rec = artifactRegistry.registerReferenceArtifact({
          kind: c.kind,
          url: c.url,
          refKey: c.refKey || '',
          title: c.title || '',
          source: context.source || 'unknown',
          channel: context.channel || '',
          sessionId: context.sessionId || '',
          runSessionId: context.runSessionId || '',
          messageId: context.messageId || '',
          chatId: context.chatId || '',
          role: context.role || ''
        })
        if (rec) push(rec)
      }
    }
    return refs
  }

  function attachArtifactsToLatestAssistant(messages = [], artifacts = []) {
    if (!Array.isArray(messages) || messages.length === 0) return messages
    if (!Array.isArray(artifacts) || artifacts.length === 0) return messages
    const idx = [...messages].reverse().findIndex((mm) => mm && mm.role === 'assistant')
    if (idx < 0) return messages
    const realIdx = messages.length - 1 - idx
    const target = messages[realIdx] || {}
    const meta = target.metadata && typeof target.metadata === 'object' ? { ...target.metadata } : {}
    const prev = Array.isArray(meta.artifacts) ? meta.artifacts : []
    const dedup = new Map()
    for (const a of [...prev, ...artifacts]) {
      if (!a || !a.path) continue
      const key = a.artifactId ? `id:${a.artifactId}` : `${a.kind || ''}:${a.path}`
      dedup.set(key, a)
    }
    meta.artifacts = [...dedup.values()]
    const next = [...messages]
    next[realIdx] = { ...target, metadata: meta }
    return next
  }

  return {
    rememberSessionArtifacts,
    getRememberedSessionArtifacts,
    normalizeArtifactsFromItems,
    registerArtifactsFromItems,
    extractFeishuReferenceCandidatesFromText,
    registerReferenceArtifactsFromMessages,
    attachArtifactsToLatestAssistant
  }
}

module.exports = { createImChannelArtifactHandlers }
