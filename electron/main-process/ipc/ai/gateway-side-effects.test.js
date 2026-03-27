const { createGatewaySideEffectHandlers } = require('./gateway-side-effects')
const { FEISHU_PROJECT } = require('./session-constants')

describe('gateway-side-effects', () => {
  it('does not invoke LLM rescue for empty delegated results when sending feishu fallback payload', async () => {
    const emitted = []
    let rescueCalls = 0
    const eventBus = {
      emitAsync: async (_ev, payload) => { emitted.push(payload) }
    }
    const conversationFile = {
      hashProjectPath: () => 'feishu-key',
      loadConversation: () => ({
        feishuChatId: 'oc_test_chat',
        messages: [{ role: 'user', content: '帮我生成海报并截图' }]
      }),
      saveConversation: () => {}
    }

    const handlers = createGatewaySideEffectHandlers({
      BrowserWindow: {
        getFocusedWindow: () => null,
        getAllWindows: () => []
      },
      eventBus,
      conversationFile,
      parseScreenshotFromToolResult: () => [],
      extractLocalResourceScreenshots: (text) => ({ cleanedText: String(text || ''), filePaths: [] }),
      extractLatestSessionsSpawnResult: () => '',
      extractLatestVisibleText: () => '',
      stripFeishuScreenshotMisfireText: (text) => String(text || ''),
      extractLocalFilesFromText: () => [],
      isImageFilePath: () => false,
      getWorkspaceRoot: () => process.cwd(),
      registerReferenceArtifactsFromMessages: () => [],
      stripToolProtocolAndJsonNoise: (text) => String(text || '').trim(),
      hasUsefulVisibleResult: () => false,
      rescueReplyByMasterAgent: async () => {
        rescueCalls++
        return 'rescued text'
      },
      stripFalseDeliveredClaims: (text) => String(text || ''),
      normalizeArtifactsFromItems: () => [],
      stripToolExecutionFromMessages: (messages) => messages,
      getMainWindow: () => null,
      appLogger: {},
      redactSensitiveText: (text) => text,
      persistToolArtifactsToRegistry: () => {},
      mergeCompactedConversationMessages: (_projectPath, _sessionId, messages) => messages,
      isRunSessionId: () => false
    })

    await handlers.onChatCompleteAny(
      'session-1',
      FEISHU_PROJECT,
      {
        messages: [
          {
            role: 'assistant',
            content: '收到！现在就按这个方案执行：生成 `poster.html` 并导出 `poster.png`，完成后我第一时间把图片路径发你。',
            tool_calls: [{ id: 'c1', function: { name: 'sessions_spawn', arguments: '{}' } }]
          }
        ]
      },
      true
    )

    expect(rescueCalls).toBe(0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].payload.text).toBe('任务已执行完成，但未生成可展示的文本结果。')
  })
})
