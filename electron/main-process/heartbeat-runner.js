/**
 * HEARTBEAT.md 定时巡检：读检查清单并触发 Gateway 静默执行
 */
function createHeartbeatRunner(deps) {
  const { getAppRootPath, fs, getAIConfigLegacy, aiGateway, getToolsForChat, getWorkspaceRoot } = deps

  const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟
  const HEARTBEAT_PATH = getAppRootPath('HEARTBEAT.md')

  function startHeartbeat() {
    // 延迟 5 分钟后才开始第一次，避免影响启动体验
    setTimeout(() => {
      runHeartbeat()
      setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS)
    }, 5 * 60 * 1000)
  }

  async function runHeartbeat() {
    try {
      if (!fs.existsSync(HEARTBEAT_PATH)) return
      const content = fs.readFileSync(HEARTBEAT_PATH, 'utf-8').trim()
      // 检查是否有实际检查项（排除注释和空内容）
      const hasItems = content.split('\n').some((l) => l.trim().startsWith('-') && !l.trim().startsWith('<!-- '))
      if (!hasItems) return // 无检查项，跳过

      const sessionId = `heartbeat-${Date.now()}`
      const fakeSender = { send: () => {} }
      const config = getAIConfigLegacy()
      if (!config?.config?.apiKey) return

      const messages = [
        {
          role: 'system',
          content: '你是一个后台巡检助手，静默执行检查清单，结果简洁记录，不需要向用户汇报。'
        },
        {
          role: 'user',
          content: `执行以下检查清单，对需要处理的项目调用工具完成，将发现写入今日日记（memory_save 或 execute_command 追加到应用数据目录 memory/$(date +%Y-%m-%d).md）：\n\n${content}`
        }
      ]

      await aiGateway.runChat(
        { sessionId, messages, model: undefined, tools: getToolsForChat(), projectPath: getWorkspaceRoot() },
        fakeSender
      )
      console.log('[Heartbeat] 巡检完成')
    } catch (e) {
      console.warn('[Heartbeat] 执行失败:', e.message)
    }
  }

  return { startHeartbeat, runHeartbeat, HEARTBEAT_INTERVAL_MS }
}

module.exports = { createHeartbeatRunner }
