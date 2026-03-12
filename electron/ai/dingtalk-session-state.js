/**
 * 钉钉会话映射：每个 conversation_id 当前对应的 sessionId（支持 /new 切新会话）
 * 持久化到 <appRoot>/dingtalk-current-sessions.json
 */
const path = require('path')
const fs = require('fs')
const { getAppRootPath } = require('../app-root')

const STATE_PATH = getAppRootPath('dingtalk-current-sessions.json')

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf-8')
      const data = JSON.parse(raw)
      return typeof data === 'object' && data !== null ? data : {}
    }
  } catch (_) {}
  return {}
}

function writeState(state) {
  const dir = path.dirname(STATE_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
}

function getOrCreateCurrentSessionId(conversationId) {
  const state = readState()
  let sessionId = state[conversationId]
  if (sessionId) return sessionId
  sessionId = `dingtalk-${sanitizeId(conversationId)}-${Date.now()}`
  state[conversationId] = sessionId
  writeState(state)
  return sessionId
}

function newSessionForConversation(conversationId) {
  const state = readState()
  const sessionId = `dingtalk-${sanitizeId(conversationId)}-${Date.now()}`
  state[conversationId] = sessionId
  writeState(state)
  return sessionId
}

module.exports = {
  readState,
  getOrCreateCurrentSessionId,
  newSessionForConversation
}

