// 会话历史文件存储：<appRoot>/conversations/{projectKey}/{sessionId}.json
// 主会话默认读一个会话；上下文超限时按块拆成多个文件，加载时合并，主会话内可见完整历史
const path = require('path')
const fs = require('fs')
const { getAppRootPath } = require('../app-root')

/** 单文件最多消息条数，超过则新建下一块会话文件（同一主会话下） */
const MAX_MESSAGES_PER_CHUNK = 150

function getConversationsDir() {
  return getAppRootPath('conversations')
}

// 将项目路径转为安全的目录名（简单 hash）
function hashProjectPath(projectPath) {
  if (!projectPath) return '__general__'
  let h = 0
  for (let i = 0; i < projectPath.length; i++) {
    h = (Math.imul(31, h) + projectPath.charCodeAt(i)) | 0
  }
  const hex = Math.abs(h).toString(16).padStart(8, '0')
  // 取路径最后一段作为前缀，方便人工识别目录
  const basename = path.basename(projectPath).replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 20)
  return `${basename}_${hex}`
}

function getProjectDir(projectKey) {
  return path.join(getConversationsDir(), projectKey)
}

function getIndexPath(projectKey) {
  return path.join(getProjectDir(projectKey), 'index.json')
}

function getSessionPath(projectKey, sessionId) {
  return path.join(getProjectDir(projectKey), `${sessionId}.json`)
}

function readIndex(projectKey) {
  try {
    const p = getIndexPath(projectKey)
    if (!fs.existsSync(p)) return []
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch { return [] }
}

function writeIndex(projectKey, index) {
  const dir = getProjectDir(projectKey)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getIndexPath(projectKey), JSON.stringify(index, null, 2), 'utf-8')
}

/** 列出某项目所有会话（仅根会话，按 updatedAt 降序；保证每条有 updatedAt、sessionType） */
function listConversations(projectKey) {
  const index = readIndex(projectKey)
  const roots = index.filter(s => !s.id.includes('@')).map(s => ({
    ...s,
    updatedAt: s.updatedAt || s.createdAt || new Date().toISOString(),
    sessionType: s.sessionType === 'group' ? 'group' : 'main'
  }))
  return roots.sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

/** 读单个文件（不合并链） */
function loadConversationFile(projectKey, sessionId) {
  const p = getSessionPath(projectKey, sessionId)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch { return null }
}

/**
 * 加载指定会话（同一主会话的多块会合并为一条消息列表，主会话内可见完整历史）
 * 若 sessionId 为块 id（含 @），会解析出根 id 再加载整链
 */
function loadConversation(projectKey, sessionId) {
  const first = loadConversationFile(projectKey, sessionId)
  if (!first) return null
  const rootId = first.continuationOf || sessionId
  const root = sessionId === rootId ? first : loadConversationFile(projectKey, rootId)
  if (!root) return null
  let messages = [...(root.messages || [])]
  let current = root
  while (current.nextChunkId) {
    current = loadConversationFile(projectKey, current.nextChunkId)
    if (!current) break
    messages = messages.concat(current.messages || [])
  }
  return {
    id: rootId,
    title: root.title,
    projectPath: root.projectPath,
    apiBaseUrl: root.apiBaseUrl,
    feishuChatId: root.feishuChatId,
    sessionType: root.sessionType === 'group' ? 'group' : 'main',
    createdAt: root.createdAt,
    updatedAt: current.updatedAt || root.updatedAt,
    messages
  }
}

/** 加载最新一条会话（按 index 中 updatedAt 排序取第一条，合并多块） */
function loadLatestConversation(projectKey) {
  const list = listConversations(projectKey)
  if (!list.length) return null
  return loadConversation(projectKey, list[0].id)
}

/**
 * 保存会话（新建或更新）
 * 消息过多时按块拆成多文件（nextChunkId / continuationOf），主会话加载时合并显示。
 * 会话不保存 model；仅保留 apiBaseUrl 用于恢复供应商。
 * @param {string} projectKey  - hashProjectPath 结果
 * @param {{ id, title, messages, projectPath, apiBaseUrl, createdAt }} session
 */
function saveConversation(projectKey, session) {
  const now = new Date().toISOString()
  const rootId = (session.id && !String(session.id).includes('@')) ? session.id : session.id
  const { messages = [], projectPath = '', apiBaseUrl } = session
  const firstUserMsg = messages.find(m => m.role === 'user')
  const autoTitle = firstUserMsg
    ? (typeof firstUserMsg.content === 'string'
      ? firstUserMsg.content.slice(0, 40)
      : '新对话')
    : '新对话'
  const title = session.title || autoTitle

  const dir = getProjectDir(projectKey)
  fs.mkdirSync(dir, { recursive: true })

  let existingRoot = loadConversationFile(projectKey, rootId) || {}
  const existingChunkIds = []
  let cur = existingRoot
  while (cur && cur.nextChunkId) {
    existingChunkIds.push(cur.nextChunkId)
    cur = loadConversationFile(projectKey, cur.nextChunkId)
  }

  const chunks = []
  for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_CHUNK) {
    chunks.push(messages.slice(i, i + MAX_MESSAGES_PER_CHUNK))
  }
  if (chunks.length === 0) chunks.push([])

  const writtenChunkIds = []
  for (let k = 0; k < chunks.length; k++) {
    const chunkId = k === 0 ? rootId : `${rootId}@${k}`
    writtenChunkIds.push(chunkId)
    const payload = k === 0
      ? {
          id: rootId,
          title,
          projectPath,
          apiBaseUrl: apiBaseUrl || existingRoot.apiBaseUrl || undefined,
          feishuChatId: session.feishuChatId ?? existingRoot.feishuChatId,
          feishuTenantKey: session.feishuTenantKey ?? existingRoot.feishuTenantKey,
          feishuDocHost: session.feishuDocHost ?? existingRoot.feishuDocHost,
          createdAt: session.createdAt || existingRoot.createdAt || now,
          updatedAt: now,
          messages: chunks[k],
          nextChunkId: chunks.length > 1 ? `${rootId}@1` : undefined
        }
      : {
          id: chunkId,
          continuationOf: rootId,
          messages: chunks[k],
          updatedAt: now,
          nextChunkId: k < chunks.length - 1 ? `${rootId}@${k + 1}` : undefined
        }
    fs.writeFileSync(getSessionPath(projectKey, chunkId), JSON.stringify(payload, null, 2), 'utf-8')
  }

  for (const oldId of existingChunkIds) {
    if (!writtenChunkIds.includes(oldId)) {
      const oldPath = getSessionPath(projectKey, oldId)
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
    }
  }

  let lastMessagePreview = ''
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && lastMsg.content !== undefined) {
      const raw = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : Array.isArray(lastMsg.content)
          ? (lastMsg.content.map(c => c && c.text).filter(Boolean).join(''))
          : ''
      lastMessagePreview = String(raw).slice(0, 120).trim()
    }
  }
  const rootPayload = chunks.length ? (loadConversationFile(projectKey, rootId) || {}) : { apiBaseUrl: apiBaseUrl || existingRoot.apiBaseUrl, createdAt: session.createdAt || existingRoot.createdAt || now }
  const index = readIndex(projectKey)
  const withoutChunks = index.filter(s => s.id === rootId || !String(s.id).startsWith(rootId + '@'))
  const idx = withoutChunks.findIndex(s => s.id === rootId)
  const entry = {
    id: rootId,
    title,
    updatedAt: now,
    messageCount: messages.length,
    apiBaseUrl: rootPayload.apiBaseUrl,
    lastMessage: lastMessagePreview
  }
  if (idx >= 0) {
    withoutChunks[idx] = { ...withoutChunks[idx], ...entry }
  } else {
    withoutChunks.unshift({ ...entry, createdAt: rootPayload.createdAt || now })
  }
  writeIndex(projectKey, withoutChunks)

  return { id: rootId, title, projectPath, apiBaseUrl: rootPayload.apiBaseUrl, createdAt: rootPayload.createdAt || now, updatedAt: now, messages }
}

/** 删除会话（根 + 所有续块）并从 index 中移除 */
function deleteConversation(projectKey, sessionId) {
  const rootId = sessionId.includes('@') ? String(sessionId).split('@')[0] : sessionId
  let cur = loadConversationFile(projectKey, rootId)
  while (cur) {
    const p = getSessionPath(projectKey, cur.id)
    if (fs.existsSync(p)) fs.unlinkSync(p)
    cur = cur.nextChunkId ? loadConversationFile(projectKey, cur.nextChunkId) : null
  }
  const index = readIndex(projectKey)
  writeIndex(projectKey, index.filter(s => s.id !== rootId && !String(s.id).startsWith(rootId + '@')))
}

/**
 * 统一会话列表：从多个 project 合并，带 source，按 updatedAt 降序
 * @param {Array<{ projectPath: string, source: string }>} sources - 如 [{ projectPath: '__main_chat__', source: 'main' }, { projectPath: '__feishu__', source: 'feishu' }]
 */
function listAllSessions(sources) {
  const merged = []
  for (const { projectPath, source } of sources) {
    const projectKey = hashProjectPath(projectPath)
    const list = listConversations(projectKey)
    for (const item of list) {
      merged.push({ ...item, source, projectPath })
    }
  }
  return merged.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
}

/** 更新或新建 index 中某条会话的 meta（title / lastMessage 等，不重写 messages 文件） */
function updateConversationMeta(projectKey, sessionId, meta) {
  const now = new Date().toISOString()
  const index = readIndex(projectKey)
  const idx = index.findIndex(s => s.id === sessionId)
  if (idx >= 0) {
    index[idx] = { ...index[idx], ...meta, updatedAt: now }
  } else {
    // 新建条目（如 AIAgent 创建新会话时）；sessionType 默认 main，后续可设为 group
    index.unshift({
      id: sessionId,
      sessionType: meta.sessionType === 'group' ? 'group' : 'main',
      ...meta,
      createdAt: meta.updatedAt || now,
      updatedAt: now,
      messageCount: 0
    })
  }
  writeIndex(projectKey, index)
  // 同步更新 session 文件中的 title/model（如文件存在）
  const p = getSessionPath(projectKey, sessionId)
  if (fs.existsSync(p)) {
    try {
      const sess = JSON.parse(fs.readFileSync(p, 'utf-8'))
      fs.writeFileSync(p, JSON.stringify({ ...sess, ...meta, updatedAt: now }, null, 2), 'utf-8')
    } catch { /* ignore */ }
  }
}

module.exports = {
  hashProjectPath,
  listConversations,
  loadConversation,
  loadLatestConversation,
  saveConversation,
  deleteConversation,
  updateConversationMeta,
  getProjectDir,
  listAllSessions
}
