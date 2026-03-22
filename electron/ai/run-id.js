/**
 * 单次主会话 LLM 编排 run 的稳定标识（日志 / 前端用量事件关联）。
 */
function createChatRunId(sessionId) {
  const raw = String(sessionId || 'session').trim().slice(0, 64)
  const sid = raw ? raw.replace(/[^\w.-]/g, '_') : 'session'
  return `${Date.now().toString(36)}-${sid}-${Math.random().toString(36).slice(2, 10)}`
}

module.exports = { createChatRunId }
