/**
 * 列出当前可用的会话（主会话、飞书、Gateway），供 AI 发现其他会话并配合 sessions_history / sessions_send 使用。
 */
const conversationFile = require('../conversation-file')

const SESSION_SOURCES = [
  { projectPath: '__main_chat__', source: 'main', label: '主会话' },
  { projectPath: '__feishu__', source: 'feishu', label: '飞书' },
  { projectPath: '__gateway__', source: 'gateway', label: 'Gateway' },
  { projectPath: '__telegram__', source: 'telegram', label: 'Telegram' }
]

const definition = {
  description: '列出当前可用的会话列表（主会话、飞书、Gateway 等），返回 sessionId、projectPath、source、sessionType、title、updatedAt；飞书会话会带 feishuChatId（可作为发飞书消息的 chat_id）。任意会话都可用 sessions_history(projectPath, sessionId) 读取，无隔离限制。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '可选。按来源过滤：main | feishu | gateway' },
      projectPath: { type: 'string', description: '可选。按项目路径过滤，如 __feishu__' },
      limit: { type: 'number', description: '可选。最多返回条数', default: 50 }
    }
  }
}

async function execute(args, context = {}) {
  const { channel, projectPath, limit = 50 } = args || {}
  try {
    let sources = SESSION_SOURCES
    if (channel) {
      sources = sources.filter(s => s.source === channel)
    }
    if (projectPath) {
      sources = sources.filter(s => s.projectPath === projectPath)
    }
    const raw = conversationFile.listAllSessions(sources)
    const list = raw.slice(0, Math.min(limit, 100)).map(s => ({
      sessionId: s.id,
      projectPath: s.projectPath,
      source: s.source,
      sessionType: s.sessionType === 'group' ? 'group' : 'main',
      label: SESSION_SOURCES.find(x => x.source === s.source)?.label || s.source,
      title: s.title || '',
      updatedAt: s.updatedAt || s.createdAt || '',
      ...(s.feishuChatId && { feishuChatId: String(s.feishuChatId) }),
      ...(s.remoteId && { remoteId: String(s.remoteId) })
    }))
    return { success: true, sessions: list, total: raw.length }
  } catch (e) {
    return { success: false, error: e.message || String(e), sessions: [] }
  }
}

module.exports = { definition, execute }
