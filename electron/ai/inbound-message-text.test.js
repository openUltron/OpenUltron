const path = require('path')
const fs = require('fs')
const { createInboundMessageTextHelpers } = require('./inbound-message-text')
const { stripRawToolCallXml } = require('../main-process/ipc/ai/chat-history-helpers')

const h = createInboundMessageTextHelpers({
  path,
  fs,
  getAppRoot: () => path.join(__dirname, '..', '..'),
  getAppRootPath: (...p) => path.join(__dirname, '..', '..', ...p),
  stripRawToolCallXml
})

describe('inbound-message-text', () => {
  it('extractLocalResourceScreenshots resolves screenshot paths', () => {
    const { cleanedText, filePaths } = h.extractLocalResourceScreenshots('see ![x](local-resource://screenshots/a.png)')
    expect(cleanedText).toContain('【截图】')
    expect(filePaths.length).toBe(1)
    expect(filePaths[0]).toContain('screenshots')
    expect(filePaths[0]).toContain('a.png')
  })

  it('getAssistantText strips tool noise from string content', () => {
    const msg = { role: 'assistant', content: 'hello <tool_call>x</tool_call> world' }
    const t = h.getAssistantText(msg)
    expect(t).not.toContain('tool_call')
    expect(t.toLowerCase()).toContain('hello')
  })

  it('hasUsefulVisibleResult rejects placeholder-only text', () => {
    expect(h.hasUsefulVisibleResult('任务已执行完成，但未生成可展示的文本结果')).toBe(false)
    expect(h.hasUsefulVisibleResult('已完成：见 https://example.com/doc')).toBe(true)
  })

  it('looksLikeGenericGreeting detects short greetings', () => {
    expect(h.looksLikeGenericGreeting('你好')).toBe(true)
    expect(h.looksLikeGenericGreeting('您好！')).toBe(true)
    expect(h.looksLikeGenericGreeting('已完成：输出报告见附件')).toBe(false)
  })

  it('compactSpawnResultText collapses whitespace after strip', () => {
    expect(h.compactSpawnResultText('  a\n\nb  ')).toBe('a b')
  })
})
