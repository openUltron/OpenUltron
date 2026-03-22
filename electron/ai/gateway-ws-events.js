/**
 * 将主进程 IPC 通道名 + payload 映射为 Gateway WebSocket 对外 JSON（便于单测与文档对齐）。
 * @param {string} channel
 * @param {object} data
 * @param {{ sessionId: string, requestId?: string }} ctx
 * @returns {object | null} 可 JSON.stringify 发给客户端；未知 channel 返回 null
 */
function mapAiChatChannelToGatewayWsEvent(channel, data, ctx) {
  if (!data || typeof data !== 'object') return null
  const sessionId = String(ctx?.sessionId || '')
  const requestId = ctx?.requestId
  const rid = data.runId != null ? data.runId : undefined
  switch (channel) {
    case 'ai-chat-token':
      return { event: 'token', sessionId, requestId, runId: rid, token: data.token }
    case 'ai-chat-tool-call':
      return { event: 'tool_call', sessionId, requestId, runId: rid, toolCall: data.toolCall }
    case 'ai-chat-tool-result':
      return {
        event: 'tool_result',
        sessionId,
        requestId,
        runId: rid,
        toolCallId: data.toolCallId,
        name: data.name,
        result: data.result
      }
    case 'ai-chat-usage':
      return {
        event: 'usage',
        sessionId,
        requestId,
        runId: rid,
        iteration: data.iteration,
        usage: data.usage
      }
    case 'ai-chat-complete':
      return { event: 'complete', sessionId, requestId, runId: rid, messages: data.messages }
    case 'ai-chat-error':
      return { event: 'error', sessionId, requestId, runId: rid, error: data.error }
    default:
      return null
  }
}

module.exports = { mapAiChatChannelToGatewayWsEvent }
