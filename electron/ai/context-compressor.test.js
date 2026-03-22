const { alignCompressionSplitIndex } = require('./context-compressor')

describe('context-compressor alignCompressionSplitIndex', () => {
  it('moves split back when recent would start with tool', () => {
    const dialog = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: '{}' },
      { role: 'user', content: 'b' }
    ]
    // naive recent last 2 would be [tool, user] starting at index 2
    expect(alignCompressionSplitIndex(dialog, 2)).toBe(1)
  })

  it('moves split back when assistant(tool_calls)+tools would be split across boundary', () => {
    const dialog = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: 'next' }
    ]
    // naive split at 3 gives recent [user next] but prev index 2 is tool — step 2 pulls in assistant at 1
    expect(alignCompressionSplitIndex(dialog, 3)).toBe(1)
  })

  it('leaves split when already safe', () => {
    const dialog = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'hi' }
    ]
    expect(alignCompressionSplitIndex(dialog, 1)).toBe(1)
  })
})
