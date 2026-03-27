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

  it('hasUsefulVisibleResult rejects action-promise text without real results', () => {
    expect(h.hasUsefulVisibleResult('太棒了，收到确认！我现在就按你说的执行：写好 HTML → 浏览器打开 → 截图回你。开始操作中…')).toBe(false)
    expect(h.hasUsefulVisibleResult('收到！马上开始。我先创建文件并执行浏览器截图，然后把产物路径发你。')).toBe(false)
    expect(h.hasUsefulVisibleResult('已完成！下面是可直接用的长图文海报 HTML。你把它保存为 `poster.html`，浏览器打开即可。')).toBe(false)
    expect(h.hasUsefulVisibleResult('还没完成，我这边刚刚被会话抖动打断了。请在你电脑终端执行这两步，保证一次成功。')).toBe(false)
    expect(h.hasUsefulVisibleResult('收到！现在就按这个方案执行：生成 `poster.html` 并导出 `poster.png`，完成后我第一时间把图片路径发你。')).toBe(false)
    expect(h.hasUsefulVisibleResult('你说得对，我现在给你一个稳妥交付方式，你点头我立刻执行。')).toBe(false)
    expect(h.hasUsefulVisibleResult('已完成，产物路径：/Users/hanbaokun/.openultron/workspace/poster.html，截图：/tmp/poster.png')).toBe(true)
  })

  it('looksLikeGenericGreeting detects short greetings', () => {
    expect(h.looksLikeGenericGreeting('你好')).toBe(true)
    expect(h.looksLikeGenericGreeting('您好！')).toBe(true)
    expect(h.looksLikeGenericGreeting('已完成：输出报告见附件')).toBe(false)
  })

  it('compactSpawnResultText collapses whitespace after strip', () => {
    expect(h.compactSpawnResultText('  a\n\nb  ')).toBe('a b')
  })

  it('extractLatestSessionsSpawnResult prefers envelope failure over result text', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sessions_spawn', arguments: '{}' } }]
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: JSON.stringify({
          success: false,
          result: '子任务已完成',
          envelope: {
            success: false,
            summary: '子 Agent 未产出文件',
            error: { code: 'MISSING_CONTEXT', message: '未找到路径' }
          }
        })
      }
    ]
    const t = h.extractLatestSessionsSpawnResult(messages)
    expect(t).toContain('子 Agent 未产出文件')
    expect(t).toContain('MISSING_CONTEXT')
    expect(t).not.toMatch(/^子任务已完成$/)
  })
})
