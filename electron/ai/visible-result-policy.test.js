const {
  looksLikeExecutionPromiseWithoutResult,
  shouldForceExecutionContinuation,
  hasUsefulVisibleResult
} = require('./visible-result-policy')

describe('visible-result-policy', () => {
  it('detects execution-promise text without concrete artifacts', () => {
    expect(looksLikeExecutionPromiseWithoutResult('收到！现在就按这个方案执行：生成 `poster.html` 并导出 `poster.png`，完成后我第一时间把图片路径发你。')).toBe(true)
    expect(looksLikeExecutionPromiseWithoutResult('还没完成，我这边刚刚被会话抖动打断了。请在你电脑终端执行这两步，保证一次成功。')).toBe(true)
    expect(looksLikeExecutionPromiseWithoutResult('你说得对，我现在给你一个稳妥交付方式，你点头我立刻执行。')).toBe(true)
  })

  it('does not treat real artifact paths as execution promises', () => {
    expect(looksLikeExecutionPromiseWithoutResult('已完成，产物路径：/Users/hanbaokun/.openultron/workspace/poster.html，截图：/tmp/poster.png')).toBe(false)
    expect(shouldForceExecutionContinuation('已完成，产物路径：/Users/hanbaokun/.openultron/workspace/poster.html，截图：/tmp/poster.png')).toBe(false)
    expect(hasUsefulVisibleResult('已完成，产物路径：/Users/hanbaokun/.openultron/workspace/poster.html，截图：/tmp/poster.png')).toBe(true)
  })

  it('forces continuation for placeholders or empty replies', () => {
    expect(shouldForceExecutionContinuation('')).toBe(true)
    expect(shouldForceExecutionContinuation('任务已执行完成，但未生成可展示的文本结果')).toBe(true)
    expect(shouldForceExecutionContinuation('收到！马上开始。我先创建文件并执行浏览器截图，然后把产物路径发你。')).toBe(true)
    expect(hasUsefulVisibleResult('收到！马上开始。我先创建文件并执行浏览器截图，然后把产物路径发你。')).toBe(false)
  })
})
