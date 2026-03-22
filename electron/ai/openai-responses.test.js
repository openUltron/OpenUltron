const {
  buildResponsesRequestBody,
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

  it('handleResponsesStreamEvent', () => {
    expect(handleResponsesStreamEvent({ type: 'response.output_text.delta', delta: 'x' }).deltaText).toBe('x')
    const done = handleResponsesStreamEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'id1', name: 'n', arguments: '{}' }
    })
    expect(done.toolCalls?.[0]?.function?.name).toBe('n')
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
