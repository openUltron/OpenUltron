const { extractFileChanges, buildCozeCommitPrompt } = require('./commit-message.js')

describe('coze commit-message', () => {
  it('extractFileChanges parses structured diff sections', () => {
    const diff = `[修改文件] src/a.ts
+const x = 1
`
    const files = extractFileChanges(diff)
    expect(files.length).toBe(1)
    expect(files[0].path).toBe('src/a.ts')
    expect(files[0].type).toBe('修改文件')
    expect(files[0].changes.some((c) => c.includes('const x'))).toBe(true)
  })

  it('buildCozeCommitPrompt includes file path in output', () => {
    const prompt = buildCozeCommitPrompt('[文件] lib/x.js\n+hello\n')
    expect(prompt).toContain('lib/x.js')
    expect(prompt).toContain('资深开发者')
  })
})
