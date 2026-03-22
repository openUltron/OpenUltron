const {
  buildResponsesRequestBody,
  createResponsesStreamToolState,
  flushResponsesStreamToolState,
  handleResponsesStreamEvent,
  getOpenAiResponsesPostUrl,
  shouldUseOpenAiResponses,
  normalizeTextContent,
  extractResponsesOutputText,
  isCodexChatgptResponsesUrl,
  OPENAI_CODEX_CHATGPT_RESPONSES_URL
} = require('./openai-responses')

describe('openai-responses', () => {
  it('normalizeTextContent flattens parts', () => {
    expect(normalizeTextContent('a')).toBe('a')
    expect(normalizeTextContent([{ type: 'text', text: 'x' }, { type: 'output_text', text: 'y' }])).toBe('xy')
  })

  it('buildResponsesRequestBody maps user/system and omits temperature for codex', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]
    const body = { model: 'gpt-5', temperature: 0.7, max_tokens: 100 }
    const platform = buildResponsesRequestBody(messages, body, {})
    expect(platform.instructions).toContain('sys')
    expect(platform.temperature).toBe(0.7)
    expect(platform.max_output_tokens).toBe(100)
    expect(platform.input[0].role).toBe('user')

    const codex = buildResponsesRequestBody(messages, body, { codexChatgptBackend: true })
    expect(codex.store).toBe(false)
    expect(codex.temperature).toBeUndefined()
    expect(codex.max_output_tokens).toBeUndefined()
    expect(codex.instructions).toBeTruthy()
  })

  it('buildResponsesRequestBody omits parallel_tool_calls on Codex when tools present', () => {
    const body = {
      model: 'gpt-5.2-codex',
      tools: [{ type: 'function', function: { name: 'fn', description: 'd', parameters: { type: 'object', properties: {} } } }]
    }
    const codex = buildResponsesRequestBody([{ role: 'user', content: 'hi' }], body, { codexChatgptBackend: true })
    expect(codex.tools).toHaveLength(1)
    expect(codex.parallel_tool_calls).toBeUndefined()
    const platform = buildResponsesRequestBody([{ role: 'user', content: 'hi' }], body, {})
    expect(platform.parallel_tool_calls).toBe(true)
  })

  it('buildResponsesRequestBody maps assistant tool_calls to function_call items', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{"a":1}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' }
    ]
    const req = buildResponsesRequestBody(messages, { model: 'm' }, {})
    const asstMsgs = req.input.filter((x) => x.type === 'message' && x.role === 'assistant')
    expect(asstMsgs.length).toBeGreaterThanOrEqual(1)
    const fc = req.input.find((x) => x.type === 'function_call')
    const fo = req.input.find((x) => x.type === 'function_call_output')
    expect(fc?.name).toBe('fn')
    expect(fo?.call_id).toBe('c1')
  })

  it('getOpenAiResponsesPostUrl codex vs platform vs jwt routing', () => {
    expect(getOpenAiResponsesPostUrl('https://api.openai.com', 'codex', 'sk').href).toBe(OPENAI_CODEX_CHATGPT_RESPONSES_URL)
    expect(getOpenAiResponsesPostUrl('https://api.openai.com', 'responses', 'sk').href).toBe('https://api.openai.com/responses')
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.x.y'
    expect(getOpenAiResponsesPostUrl('https://api.openai.com', '', jwt).href).toBe(OPENAI_CODEX_CHATGPT_RESPONSES_URL)
  })

  it('getOpenAiResponsesPostUrl throws for chat mode', () => {
    expect(() => getOpenAiResponsesPostUrl('https://api.openai.com', 'chat', 'sk')).toThrow(/chat/)
  })

  it('shouldUseOpenAiResponses', () => {
    expect(shouldUseOpenAiResponses('https://api.openai.com', 'chat', 'sk')).toBe(false)
    expect(shouldUseOpenAiResponses('https://api.openai.com', 'responses', 'sk')).toBe(true)
    expect(shouldUseOpenAiResponses('https://api.openai.com', '', 'eyJx')).toBe(true)
    expect(shouldUseOpenAiResponses('https://other.com', '', 'eyJx')).toBe(false)
  })

  it('handleResponsesStreamEvent accumulates function_call_arguments.delta', () => {
    const st = createResponsesStreamToolState()
    handleResponsesStreamEvent(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', name: 'do_x', call_id: 'call_abc', arguments: '' }
      },
      st
    )
    handleResponsesStreamEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"k":' }, st)
    handleResponsesStreamEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' }, st)
    const seen = new Set()
    const flushed = flushResponsesStreamToolState(st, seen)
    expect(flushed).toHaveLength(1)
    expect(flushed[0].id).toBe('call_abc')
    expect(flushed[0].function.name).toBe('do_x')
    expect(flushed[0].function.arguments).toBe('{"k":1}')
  })

  it('handleResponsesStreamEvent', () => {
    expect(handleResponsesStreamEvent({ type: 'response.output_text.delta', delta: 'x' }).deltaText).toBe('x')
    const done = handleResponsesStreamEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'id1', name: 'n', arguments: '{}' }
    })
    expect(done.toolCalls?.[0]?.function?.name).toBe('n')
    const fcDoneItem = handleResponsesStreamEvent({
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item: { type: 'function_call', call_id: 'call_doc', name: 'from_item', arguments: '{"a":2}' }
    })
    expect(fcDoneItem.toolCalls?.[0]?.id).toBe('call_doc')
    expect(fcDoneItem.toolCalls?.[0]?.function?.name).toBe('from_item')
    const fcDone = handleResponsesStreamEvent({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_item_1',
      name: 'web_search',
      arguments: '{"q":"hi"}'
    })
    expect(fcDone.toolCalls?.[0]?.id).toBe('fc_item_1')
    expect(fcDone.toolCalls?.[0]?.function?.name).toBe('web_search')
    expect(fcDone.toolCalls?.[0]?.function?.arguments).toBe('{"q":"hi"}')
  })

  it('extractResponsesOutputText', () => {
    expect(extractResponsesOutputText({ output_text: '  hi  ' })).toBe('hi')
    expect(
      extractResponsesOutputText({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }]
      })
    ).toBe('a\nb')
  })

  it('isCodexChatgptResponsesUrl', () => {
    expect(isCodexChatgptResponsesUrl(OPENAI_CODEX_CHATGPT_RESPONSES_URL)).toBe(true)
    expect(isCodexChatgptResponsesUrl('https://api.openai.com/responses')).toBe(false)
  })
})
