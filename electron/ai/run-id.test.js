const { createChatRunId } = require('./run-id')

describe('run-id', () => {
  it('createChatRunId is unique and includes session hint', () => {
    const a = createChatRunId('sess-1')
    const b = createChatRunId('sess-1')
    expect(a).not.toBe(b)
    expect(a).toContain('sess-1')
    expect(createChatRunId('')).toMatch(/^[a-z0-9]+-session-/)
  })
})
