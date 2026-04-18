/**
 * 会话消息落库前：产物提取、工具执行剥离、压缩合并（供 Gateway onChatComplete 与 IPC 共用）
 */

function stripRawToolCallXml (text) {
  if (!text || typeof text !== 'string') return text
  let s = text
  s = s.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '')
  s = s.replace(/<function=[^>]+>[\s\S]*?<\/function>/gi, '')
  s = s.replace(/<\/?tool_call\b[^>]*>/gi, '')
  s = s.replace(/<function=[^>]+>/gi, '')
  s = s.replace(/<\/function>/gi, '')
  s = s.replace(/<parameter=[^>]+>/gi, '')
  s = s.replace(/<\/parameter>/gi, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * @param {object} deps
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {() => string} deps.getAppRoot
 * @param {(...p: string[]) => string} deps.getAppRootPath
 * @param {object} deps.artifactRegistry
 * @param {object} deps.conversationFile
 */
function createChatHistoryHelpers (deps) {
  const { path, fs, getAppRoot, getAppRootPath, artifactRegistry, conversationFile } = deps

  function persistToolArtifactsToRegistry (messages, sessionId) {
    if (!Array.isArray(messages) || !sessionId) return
    const appRoot = getAppRoot()
    const toLocalResourceUrl = (fullPath) => {
      if (!fullPath || !path.isAbsolute(fullPath)) return null
      const rel = path.relative(appRoot, fullPath)
      if (rel.startsWith('..')) return null
      return 'local-resource://' + rel.split(path.sep).join('/')
    }
    const inferKindFromPath = (p) => {
      const ext = path.extname(String(p || '')).toLowerCase()
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image'
      if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac'].includes(ext)) return 'audio'
      if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) return 'video'
      if (['.pdf'].includes(ext)) return 'file'
      return 'file'
    }
    let lastAssistantIdx = -1
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (!m) continue
      if (m.role === 'assistant') lastAssistantIdx = i
      if (m.role !== 'tool' || lastAssistantIdx < 0) continue
      let raw = m.content
      if (raw == null) continue
      if (typeof raw !== 'object') raw = typeof raw === 'string' ? raw : String(raw)
      const str = typeof raw === 'string' ? raw : JSON.stringify(raw)
      let obj = null
      try {
        obj = typeof raw === 'object' ? raw : JSON.parse(str)
      } catch (_) {}
      if (!obj || typeof obj !== 'object') continue
      const artifactsToAdd = []
      const fileUrl = obj.file_url || obj.fileUrl
      if (fileUrl && typeof fileUrl === 'string') {
        if (fileUrl.startsWith('local-resource://screenshots/') || fileUrl.startsWith('local-resource://artifacts/')) {
          artifactsToAdd.push({ path: fileUrl, kind: 'image', name: path.basename(fileUrl.replace(/^[^?]+/, '')) })
        }
      }
      const imageBase64 = obj.image_base64 || obj.imageBase64
      if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 100) {
        const rec = artifactRegistry.registerBase64Artifact({
          base64: imageBase64,
          ext: '.png',
          kind: 'image',
          source: 'chat_tool',
          sessionId: String(sessionId)
        })
        if (rec && rec.path) {
          const url = toLocalResourceUrl(rec.path)
          if (url) artifactsToAdd.push({ path: url, kind: rec.kind || 'image', artifactId: rec.artifactId, name: rec.filename })
        }
      }
      const filePath = obj.file_path || obj.filePath || obj.output_path || obj.outputPath || obj.path
      if (filePath && typeof filePath === 'string') {
        const full = path.isAbsolute(filePath) ? filePath : getAppRootPath('screenshots', path.basename(filePath))
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          const rec = artifactRegistry.registerFileArtifact({
            path: full,
            kind: inferKindFromPath(full),
            source: 'chat_tool',
            sessionId: String(sessionId)
          })
          if (rec && rec.path) {
            const url = toLocalResourceUrl(rec.path)
            if (url) artifactsToAdd.push({ path: url, kind: rec.kind || 'file', artifactId: rec.artifactId, name: rec.filename })
          }
        } else if (filePath.startsWith('local-resource://')) {
          artifactsToAdd.push({ path: filePath, kind: inferKindFromPath(filePath), name: path.basename(filePath) })
        }
      }
      const audioBase64 = obj.audio_base64 || obj.audioBase64
      if (audioBase64 && typeof audioBase64 === 'string' && audioBase64.length > 100) {
        const rec = artifactRegistry.registerBase64Artifact({
          base64: audioBase64,
          ext: '.m4a',
          kind: 'audio',
          source: 'chat_tool',
          sessionId: String(sessionId)
        })
        if (rec && rec.path) {
          const url = toLocalResourceUrl(rec.path)
          if (url) artifactsToAdd.push({ path: url, kind: 'audio', artifactId: rec.artifactId, name: rec.filename })
        }
      }
      if (artifactsToAdd.length === 0) continue
      const assistant = messages[lastAssistantIdx]
      if (!assistant.metadata) assistant.metadata = {}
      if (!Array.isArray(assistant.metadata.artifacts)) assistant.metadata.artifacts = []
      assistant.metadata.artifacts.push(...artifactsToAdd)
    }
  }

  function stripToolExecutionFromMessages (messages) {
    if (!Array.isArray(messages)) return messages
    const sessionSpawnCallIds = new Set()
    const out = []
    const normalizeForDedupe = (content) =>
      String(content || '')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    const mergeArtifactsMeta = (baseMsg, dupMsg) => {
      const baseMeta = (baseMsg && typeof baseMsg.metadata === 'object' && baseMsg.metadata) ? baseMsg.metadata : {}
      const dupMeta = (dupMsg && typeof dupMsg.metadata === 'object' && dupMsg.metadata) ? dupMsg.metadata : {}
      const baseArtifacts = Array.isArray(baseMeta.artifacts) ? baseMeta.artifacts : []
      const dupArtifacts = Array.isArray(dupMeta.artifacts) ? dupMeta.artifacts : []
      if (dupArtifacts.length === 0) return baseMsg
      const merged = new Map()
      for (const a of [...baseArtifacts, ...dupArtifacts]) {
        if (!a) continue
        const key = a.artifactId ? `id:${a.artifactId}` : `${a.kind || ''}:${a.path || ''}:${a.name || ''}`
        merged.set(key, a)
      }
      return {
        ...baseMsg,
        metadata: {
          ...baseMeta,
          artifacts: [...merged.values()]
        }
      }
    }
    const toText = (content) => {
      if (typeof content === 'string') return stripRawToolCallXml(content).trim()
      if (Array.isArray(content)) return stripRawToolCallXml(content.map(x => (x && x.text) || '').join('')).trim()
      return ''
    }
    const parseSpawnResult = (content) => {
      const text = String(content || '').trim()
      if (!text) return ''
      try {
        const obj = JSON.parse(text)
        if (obj && typeof obj === 'object') {
          if (obj.result != null && String(obj.result).trim()) return stripRawToolCallXml(String(obj.result)).trim()
          if (obj.error != null && String(obj.error).trim()) return `子 Agent 执行失败：${String(obj.error).trim()}`
        }
      } catch (_) {}
      return ''
    }
    for (const m of messages) {
      if (!m) continue
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc && tc.function ? tc.function.name : ''
          const id = tc && tc.id ? String(tc.id) : ''
          if ((fn === 'sessions_spawn' || fn === 'webapp_studio_invoke') && id) sessionSpawnCallIds.add(id)
        }
      }
      if (m.role === 'tool') {
        const toolCallId = String(m.tool_call_id || '')
        if (toolCallId && sessionSpawnCallIds.has(toolCallId)) {
          const spawnText = parseSpawnResult(m.content)
          if (spawnText) out.push({ role: 'assistant', content: spawnText })
        }
        continue
      }
      const item = { ...m }
      if (item.toolCalls !== undefined) delete item.toolCalls
      if (item.tool_calls !== undefined) delete item.tool_calls
      if (item.role === 'assistant') {
        const txt = toText(item.content)
        if (!txt) continue
        const prev = out[out.length - 1]
        if (prev && prev.role === 'assistant') {
          const prevNorm = normalizeForDedupe(toText(prev.content))
          const currNorm = normalizeForDedupe(txt)
          if (prevNorm && currNorm && prevNorm === currNorm) {
            out[out.length - 1] = mergeArtifactsMeta(prev, item)
            continue
          }
        }
      }
      out.push(item)
    }
    return out
  }

  function extractMessageTextForSummary (msg) {
    if (!msg || typeof msg !== 'object') return ''
    const c = msg.content
    if (typeof c === 'string') return compactSummaryText(c)
    if (Array.isArray(c)) {
      return compactSummaryText(c.map((x) => {
        if (!x) return ''
        if (typeof x === 'string') return x
        if (typeof x.text === 'string') return x.text
        return ''
      }).join(' '))
    }
    return ''
  }

  function compactSummaryText (s) {
    return String(s || '').replace(/\s+/g, ' ').trim()
  }

  function isCompactedSummaryMessage (msg) {
    if (!msg || msg.role !== 'system') return false
    const text = extractMessageTextForSummary(msg)
    if (!text) return false
    return text.includes('对话摘要') || text.includes('早期消息已压缩')
  }

  function toComparableEntries (messages) {
    return (messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ key: `${m.role}:${extractMessageTextForSummary(m)}`, msg: m }))
      .filter((x) => x.key && x.key !== 'user:' && x.key !== 'assistant:')
  }

  function findTailPrefixOverlap (baseKeys, nextKeys) {
    const max = Math.min(baseKeys.length, nextKeys.length)
    for (let k = max; k > 0; k--) {
      let ok = true
      for (let i = 0; i < k; i++) {
        if (baseKeys[baseKeys.length - k + i] !== nextKeys[i]) {
          ok = false
          break
        }
      }
      if (ok) return k
    }
    return 0
  }

  function mergeCompactedConversationMessages (projectPath, sessionId, incomingMessages) {
    const incoming = stripToolExecutionFromMessages(incomingMessages)
    if (!incoming || incoming.length === 0) return []

    const hasCompactedMarker = incoming.some(isCompactedSummaryMessage)
    if (!hasCompactedMarker) return incoming

    const projectKey = conversationFile.hashProjectPath(projectPath)
    const existingConv = conversationFile.loadConversation(projectKey, sessionId)
    const existing = stripToolExecutionFromMessages(existingConv?.messages || [])
    if (!existing.length) return incoming

    const baseEntries = toComparableEntries(existing)
    const nextEntries = toComparableEntries(incoming)
    if (!nextEntries.length) return existing

    const overlap = findTailPrefixOverlap(
      baseEntries.map((x) => x.key),
      nextEntries.map((x) => x.key)
    )
    const appended = nextEntries.slice(overlap).map((x) => x.msg)
    if (!appended.length) return existing

    return [...existing, ...appended]
  }

  return {
    persistToolArtifactsToRegistry,
    stripToolExecutionFromMessages,
    mergeCompactedConversationMessages
  }
}

module.exports = {
  stripRawToolCallXml,
  createChatHistoryHelpers
}
