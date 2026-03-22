const { mapAiChatChannelToGatewayWsEvent } = require('./gateway-ws-events')

describe('gateway-ws-events', () => {
  const ctx = { sessionId: 's1', requestId: 'req-1' }

  it('maps tool_result with flat fields', () => {
    const ev = mapAiChatChannelToGatewayWsEvent(
      'ai-chat-tool-result',
      { toolCallId: 'c1', name: 'x', result: '{"ok":1}', runId: 'r9' },
      ctx
    )
    expect(ev.event).toBe('tool_result')
    expect(ev.toolCallId).toBe('c1')
    expect(ev.result).toBe('{"ok":1}')
    expect(ev.runId).toBe('r9')
  })

  it('maps usage and token', () => {
    const u = mapAiChatChannelToGatewayWsEvent(
      'ai-chat-usage',
      { iteration: 2, usage: { dialog: 1 }, runId: 'r1' },
      ctx
    )
    expect(u.event).toBe('usage')
    expect(u.iteration).toBe(2)
    const t = mapAiChatChannelToGatewayWsEvent('ai-chat-token', { token: 'hi' }, ctx)
    expect(t.token).toBe('hi')
  })

  it('returns null for unknown channel', () => {
    expect(mapAiChatChannelToGatewayWsEvent('other', {}, ctx)).toBeNull()
  })
})
