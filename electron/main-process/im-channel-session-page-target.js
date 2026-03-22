'use strict'

/**
 * 从主会话消息中推断「最近网页」：优先本地 HTML 路径，否则 assistant 文本中的首个 http(s) URL。
 * 供子 Agent 委派任务拼接上下文（`buildDelegatedTaskWithParentContext`）。
 */
function createSessionPageTargetHelpers(deps) {
  const { conversationFile, path, fs, getWorkspaceRoot, getAssistantText, extractLocalFilesFromText } = deps

  function findRecentHtmlArtifact(projectPath, sessionId) {
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const conv = conversationFile.loadConversation(projectKey, sessionId)
    const messages = Array.isArray(conv?.messages) ? conv.messages : []
    const recentAssistants = [...messages].filter((m) => m && m.role === 'assistant').slice(-40).reverse()
    for (const m of recentAssistants) {
      const artifacts = Array.isArray(m?.metadata?.artifacts) ? m.metadata.artifacts : []
      for (const a of artifacts) {
        const p = String(a?.path || '').trim()
        if (!p || !path.isAbsolute(p) || !fs.existsSync(p)) continue
        const ext = path.extname(p).toLowerCase()
        if (ext === '.html' || ext === '.htm') return p
      }
      const txt = getAssistantText(m)
      const fileResolveBase = (projectPath && path.isAbsolute(projectPath)) ? projectPath : getWorkspaceRoot()
      for (const p of extractLocalFilesFromText(txt, fileResolveBase)) {
        const ext = path.extname(String(p || '')).toLowerCase()
        if ((ext === '.html' || ext === '.htm') && fs.existsSync(p)) return p
      }
    }
    return ''
  }

  function extractFirstHttpUrl(text) {
    const s = String(text || '')
    if (!s) return ''
    const md = s.match(/\]\((https?:\/\/[^)\s]+)\)/i)
    if (md && md[1]) return String(md[1]).trim()
    const plain = s.match(/https?:\/\/[^\s<>"')]+/i)
    if (plain && plain[0]) return String(plain[0]).trim()
    return ''
  }

  function findRecentPageTarget(projectPath, sessionId) {
    const htmlPath = findRecentHtmlArtifact(projectPath, sessionId)
    if (htmlPath) return { kind: 'file', value: htmlPath }
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const conv = conversationFile.loadConversation(projectKey, sessionId)
    const messages = Array.isArray(conv?.messages) ? conv.messages : []
    const recentAssistants = [...messages].filter((m) => m && m.role === 'assistant').slice(-40).reverse()
    for (const m of recentAssistants) {
      const url = extractFirstHttpUrl(getAssistantText(m))
      if (url) return { kind: 'url', value: url }
    }
    return { kind: '', value: '' }
  }

  return { findRecentHtmlArtifact, findRecentPageTarget }
}

module.exports = { createSessionPageTargetHelpers }
