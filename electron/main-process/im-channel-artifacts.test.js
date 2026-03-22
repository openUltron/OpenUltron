const path = require('path')
const { createImChannelArtifactHandlers } = require('./im-channel-artifacts')

const noopArtifactRegistry = {
  registerFileArtifact: () => null,
  registerBase64Artifact: () => null,
  registerReferenceArtifact: () => null
}

function makeHandlers() {
  return createImChannelArtifactHandlers({
    path,
    fs: require('fs'),
    artifactRegistry: noopArtifactRegistry,
    appLogger: {},
    getAssistantText: (m) => (m && typeof m.content === 'string' ? m.content : '')
  })
}

describe('im-channel-artifacts', () => {
  it('extractFeishuReferenceCandidatesFromText finds docx url', () => {
    const { extractFeishuReferenceCandidatesFromText } = makeHandlers()
    const text = 'see https://xxx.feishu.cn/docx/AbCdEfGhIj'
    const c = extractFeishuReferenceCandidatesFromText(text)
    expect(c.length).toBeGreaterThan(0)
    expect(c[0].kind).toBe('feishu_doc')
    expect(c[0].url).toContain('feishu.cn')
  })
})
