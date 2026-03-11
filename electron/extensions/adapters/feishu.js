/**
 * 飞书聊天渠道适配器：接收消息时 emit chat.message.received，回发时由 send(binding, payload) 完成。
 * 见 EXTENSIBILITY-DESIGN.md 第三节。
 */
const path = require('path')
const fs = require('fs')
const { getAppRootPath } = require('../../app-root')
const { logger: appLogger } = require('../../app-logger')
const feishuWsReceive = require('../../ai/feishu-ws-receive')
const feishuSessionState = require('../../ai/feishu-session-state')
const conversationFile = require('../../ai/conversation-file')
const feishuNotify = require('../../ai/feishu-notify')
const memoryStore = require('../../ai/memory-store')
const { createInboundMessage, createSessionBinding } = require('../../core/message-model')

const FEISHU_PROJECT = '__feishu__'
const FEISHU_DEDUP_MAX = 500
const feishuRepliedMessageIds = new Set()
const HISTORY_CMD_RE = /^\s*\/(history|memory)\s*$/i

function compactText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function extractMessageText(msg) {
  if (!msg || typeof msg !== 'object') return ''
  if (typeof msg.content === 'string') return compactText(msg.content)
  if (Array.isArray(msg.content)) {
    return compactText(
      msg.content
        .map((x) => {
          if (!x) return ''
          if (typeof x === 'string') return x
          if (typeof x.text === 'string') return x.text
          return ''
        })
        .join(' ')
    )
  }
  return ''
}

function buildConversationSummary(messages = []) {
  const list = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, text: extractMessageText(m) }))
    .filter((m) => m.text)

  if (!list.length) return ''
  const recent = list.slice(-24)
  const userPoints = []
  const assistantPoints = []
  for (const item of recent) {
    if (item.role === 'user') {
      if (userPoints.length < 6) userPoints.push(item.text.slice(0, 120))
    } else if (item.role === 'assistant') {
      if (assistantPoints.length < 6) assistantPoints.push(item.text.slice(0, 140))
    }
  }

  const lines = []
  lines.push(`会话压缩摘要（${new Date().toLocaleString('zh-CN', { hour12: false })}）`)
  if (userPoints.length) {
    lines.push('用户关注点：')
    for (const p of userPoints) lines.push(`- ${p}`)
  }
  if (assistantPoints.length) {
    lines.push('已完成/已回复：')
    for (const p of assistantPoints) lines.push(`- ${p}`)
  }
  return lines.join('\n')
}

function listChatSummaries(chatId, limit = 5) {
  const keyTag = `chat:${chatId}`
  const rows = memoryStore.searchMemories(keyTag, FEISHU_PROJECT, 50) || []
  return rows
    .filter((m) => Array.isArray(m.tags) && m.tags.includes('session-summary') && m.tags.includes(keyTag))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, limit)
}

/**
 * allowFrom：'*' 或 undefined/空 = 全部允许；数组 = 仅允许列表中的 chat_id/用户 ID
 */
function isAllowed(allowFrom, remoteId) {
  if (allowFrom == null || allowFrom === '*') return true
  if (!Array.isArray(allowFrom)) return true
  const id = String(remoteId || '').trim()
  if (!id) return false
  return allowFrom.some(a => String(a).trim() === id)
}

/**
 * @param {import('../../core/events')} eventBus - 需在 main 中创建的 createEventBus() 单例
 * @param {(key: string) => any} [getChannelConfig] - 按 configKey 取配置，用于 allowFrom 校验
 * @returns {{ id: string; configKey: string; start: Function; stop: Function; isRunning: Function; send: Function }}
 */
function createFeishuAdapter(eventBus, getChannelConfig) {
  async function handleIncomingMessage(chatId, text, messageId) {
    if (messageId) {
      const sizeBefore = feishuRepliedMessageIds.size
      feishuRepliedMessageIds.add(messageId)
      if (feishuRepliedMessageIds.size === sizeBefore) return
      if (feishuRepliedMessageIds.size > FEISHU_DEDUP_MAX) {
        const arr = [...feishuRepliedMessageIds]
        arr.slice(0, FEISHU_DEDUP_MAX / 2).forEach(id => feishuRepliedMessageIds.delete(id))
      }
    }

    if (getChannelConfig) {
      const config = getChannelConfig('feishu')
      if (config && !isAllowed(config.allowFrom, chatId)) return
    }

    if (HISTORY_CMD_RE.test(text || '')) {
      const summaries = listChatSummaries(chatId, 6)
      if (!summaries.length) {
        await feishuNotify.sendMessage({ chat_id: chatId, text: '暂无历史记忆摘要。你可以先正常对话，或发送 /new 归档当前会话。' })
        return
      }
      const out = ['最近历史记忆摘要：']
      for (const s of summaries) {
        const t = (s.updatedAt || s.createdAt || '').replace('T', ' ').replace('Z', '')
        const oneLine = compactText(String(s.content || '')).slice(0, 140)
        out.push(`- [${t}] ${oneLine}`)
      }
      await feishuNotify.sendMessage({ chat_id: chatId, text: out.join('\n') })
      return
    }

    const feishuProjectKey = conversationFile.hashProjectPath(FEISHU_PROJECT)
    const isNew = /^\s*\/new\s*(\s|$)/.test(text) || text.trim() === '/new'
    let sessionId
    if (isNew) {
      const state = feishuSessionState.readState()
      const oldSessionId = state[chatId]
      if (oldSessionId) {
        const conv = conversationFile.loadConversation(feishuProjectKey, oldSessionId)
        let archivedSummary = ''
        if (conv && conv.messages) {
          archivedSummary = buildConversationSummary(conv.messages)
          if (archivedSummary) {
            try {
              memoryStore.saveMemory({
                content: archivedSummary,
                tags: ['feishu', 'session-summary', `chat:${chatId}`, `session:${oldSessionId}`],
                projectPath: FEISHU_PROJECT,
                source: 'auto'
              })
            } catch (_) {}
          }
          const updated = [...conv.messages, { role: 'user', content: '/new' }, { role: 'assistant', content: '已开启新会话' }]
          conversationFile.saveConversation(feishuProjectKey, { id: oldSessionId, messages: updated, projectPath: FEISHU_PROJECT })
        }
        }
      sessionId = feishuSessionState.newSessionForChat(chatId)
      const now = new Date().toISOString()
      conversationFile.updateConversationMeta(feishuProjectKey, sessionId, {
        title: `飞书: ${String(chatId).slice(0, 20)}`,
        updatedAt: now,
        createdAt: now,
        messageCount: 0
      })
      const latest = listChatSummaries(chatId, 1)[0]
      if (latest && latest.content) {
        const initMsgs = [{
          role: 'system',
          content: `你正在继续同一用户的新会话。请继承以下历史记忆摘要，后续回答保持连续性：\n\n${latest.content}`
        }]
        conversationFile.saveConversation(feishuProjectKey, { id: sessionId, messages: initMsgs, projectPath: FEISHU_PROJECT })
      }
      await feishuNotify.sendMessage({ chat_id: chatId, text: '已归档当前会话并创建新会话。历史记忆已继承；发送 /history 可查看最近摘要。' })
      return
    }
    sessionId = feishuSessionState.getOrCreateCurrentSessionId(chatId)
    const conv = conversationFile.loadConversation(feishuProjectKey, sessionId)
    if (!conv) {
      const now = new Date().toISOString()
      conversationFile.updateConversationMeta(feishuProjectKey, sessionId, {
        title: `飞书: ${String(chatId).slice(0, 20)}`,
        updatedAt: now,
        createdAt: now,
        messageCount: 0
      })
    }
    const message = createInboundMessage('feishu', chatId, text, messageId)
    const binding = createSessionBinding(sessionId, FEISHU_PROJECT, 'feishu', chatId, chatId)
    eventBus.emit('chat.message.received', { message, binding })
  }

  return {
    id: 'feishu',
    configKey: 'feishu',
    async start(config) {
      const cfg = config || {}
      if (!cfg.app_id || !cfg.app_secret) {
        throw new Error('请先填写并保存 App ID、App Secret')
      }
      await feishuWsReceive.start(handleIncomingMessage)
    },
    async stop() {
      feishuWsReceive.stop()
    },
    isRunning() {
      return feishuWsReceive.isRunning()
    },
    /**
     * @param {{ channel: string; remoteId: string }} binding
     * @param {{ text?: string; images?: Array<{ path?: string; base64?: string; filename?: string }> }} payload
     */
    async send(binding, payload) {
      const chatId = binding.remoteId
      const FEISHU_IMAGE_MAX_BYTES = 4 * 1024 * 1024
      if (payload.images && payload.images.length > 0) {
        for (const img of payload.images) {
          let imageBase64 = null
          let imageFilename = img.filename || 'screenshot.png'
          if (img.base64 && typeof img.base64 === 'string' && img.base64.length > 0) {
            imageBase64 = img.base64
          } else if (img.path) {
            // 相对路径统一解析到应用 screenshots 目录，避免读到主进程 cwd 下的空文件
            const resolvedPath = path.isAbsolute(img.path)
              ? img.path
              : path.join(getAppRootPath('screenshots'), path.basename(img.path))
            if (!fs.existsSync(resolvedPath)) continue
            const buf = fs.readFileSync(resolvedPath)
            if (buf.length === 0) {
              appLogger?.warn?.('[Feishu] 截图文件为空，跳过发送', { path: resolvedPath, bytes: 0 })
              continue
            }
            if (buf.length > FEISHU_IMAGE_MAX_BYTES) {
              await feishuNotify.sendMessage({ chat_id: chatId, text: `截图过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），未发送。` }).catch(() => {})
              continue
            }
            imageBase64 = buf.toString('base64')
            imageFilename = img.filename || path.basename(resolvedPath)
          }
          if (!imageBase64 || imageBase64.length === 0) continue
          const result = await feishuNotify.sendMessage({
            chat_id: chatId,
            image_base64: imageBase64,
            image_filename: imageFilename
          })
          if (!result || !result.success) {
            await feishuNotify.sendMessage({ chat_id: chatId, text: `截图发送失败：${(result && result.message) || '未知'}` }).catch(() => {})
          }
        }
      }
      const text = (payload.text && payload.text.trim()) ? payload.text.trim() : '（无回复内容）'
      await feishuNotify.sendMessage({ chat_id: chatId, text })
    }
  }
}

module.exports = { createFeishuAdapter }
