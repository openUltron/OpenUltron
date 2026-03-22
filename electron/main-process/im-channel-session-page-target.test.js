const path = require('path')
const { createSessionPageTargetHelpers } = require('./im-channel-session-page-target')

describe('im-channel-session-page-target', () => {
  it('findRecentPageTarget returns url from assistant markdown link', () => {
    const conversationFile = {
      hashProjectPath: () => 'k',
      loadConversation: () => ({
        messages: [
          { role: 'assistant', content: '打开 [demo](https://example.com/page) 查看' }
        ]
      })
    }
    const { findRecentPageTarget } = createSessionPageTargetHelpers({
      conversationFile,
      path,
      fs: require('fs'),
      getWorkspaceRoot: () => '/tmp',
      getAssistantText: (m) => (typeof m.content === 'string' ? m.content : ''),
      extractLocalFilesFromText: () => []
    })
    const t = findRecentPageTarget('/proj', 'sid')
    expect(t.kind).toBe('url')
    expect(t.value).toBe('https://example.com/page')
  })
})
