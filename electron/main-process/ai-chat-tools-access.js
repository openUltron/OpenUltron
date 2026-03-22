'use strict'

/**
 * 主进程对话工具列表：builtin + MCP，Web App 工具按需合并；协调 Agent 系统提示。
 */
function createAiChatToolsAccess(deps) {
  const { aiToolRegistry, aiMcpManager, store, appLogger } = deps

  const CHROME_DEVTOOLS_TOOL_PREFIX_REGEX = /^mcp__chrome[-_]devtools__/
  const CHANNEL_SEND_TOOL_REGEX = /^(feishu_send_message|telegram_send_message|dingtalk_send_message)$/
  let _loggedNoChromeDevtoolsOnce = false

  function coordinatorIncludesSessionsSpawn() {
    try {
      const oc = require('../openultron-config')
      return oc.getImCoordinator().include_sessions_spawn === true
    } catch (_) {
      return false
    }
  }

  /** @param {{ excludeChannelSend?: boolean, projectPath?: string }} [opts] */
  function getToolsForChat(opts = {}) {
    const builtinTools = aiToolRegistry.getToolDefinitions()
    const mcpTools = aiMcpManager.getAllToolDefinitions()
    let all = [...builtinTools, ...mcpTools]
    const pp = String(opts.projectPath || '').trim()
    if (pp && !pp.startsWith('__')) {
      try {
        const { shouldMergeWebAppTools, buildWebAppToolDefinitions } = require('../web-apps/ai-tools')
        if (shouldMergeWebAppTools(pp, () => store)) {
          const wa = buildWebAppToolDefinitions(pp)
          if (wa.length) all = [...all, ...wa]
        }
      } catch (e) {
        console.warn('[web-apps] buildWebAppToolDefinitions:', e.message)
      }
    }
    if (opts.excludeChannelSend) {
      all = all.filter((t) => !CHANNEL_SEND_TOOL_REGEX.test(String(t.function?.name || '').trim()))
    }
    const chromeDevtools = all.filter((t) => CHROME_DEVTOOLS_TOOL_PREFIX_REGEX.test(t.function?.name || ''))
    const rest = all.filter((t) => !CHROME_DEVTOOLS_TOOL_PREFIX_REGEX.test(t.function?.name || ''))
    if (chromeDevtools.length === 0 && !_loggedNoChromeDevtoolsOnce) {
      _loggedNoChromeDevtoolsOnce = true
      appLogger?.info?.('[MCP] getToolsForChat: chrome-devtools 未提供工具（可能未就绪或启动失败），浏览器自动化将不可用，请确保 chrome-devtools MCP 已启用。可查看上方 [MCP] 启动日志。')
    }
    return [...chromeDevtools, ...rest]
  }

  async function getToolsForChatWithWait(opts = {}) {
    let tools = getToolsForChat(opts)
    const chromeCount = tools.filter((t) => CHROME_DEVTOOLS_TOOL_PREFIX_REGEX.test(t.function?.name || '')).length
    if (chromeCount === 0) {
      await new Promise((r) => setTimeout(r, 2500))
      tools = getToolsForChat(opts)
    }
    return tools
  }

  function getToolsForSubChat() {
    return getToolsForChat().filter((t) => {
      const name = String(t?.function?.name || '').trim()
      if (CHANNEL_SEND_TOOL_REGEX.test(name)) return false
      if (name === 'sessions_spawn') return false
      return true
    })
  }

  function getToolsForCoordinatorChat() {
    if (coordinatorIncludesSessionsSpawn()) {
      return getToolsForChat().filter((t) => {
        const name = String(t?.function?.name || '').trim()
        return !CHANNEL_SEND_TOOL_REGEX.test(name)
      })
    }
    return getToolsForSubChat()
  }

  function getCoordinatorSystemPrompt(channel = '') {
    const channelName = channel === 'feishu'
      ? '飞书'
      : (channel === 'telegram' ? 'Telegram' : (channel === 'dingtalk' ? '钉钉' : '当前渠道'))
    const spawnOn = coordinatorIncludesSessionsSpawn()
    const head = [
      '[协调 Agent 模式]',
      `你是 ${channelName} 的入口协调 Agent。每次收到用户消息时，当前会话实例就是“主协调者”（不是全局唯一主控）。`,
      '你负责：接收消息、决定是否派发、管理任务状态、向用户汇报结果。'
    ]
    const spawnLines = spawnOn
      ? [
          '你应优先直接调用可用工具完成用户任务；仅当任务较复杂、耗时较长、需要并行或需要隔离执行上下文时，再调用 sessions_spawn 派发子 Agent。',
          '默认使用 sessions_spawn(runtime="auto")，其默认走 internal。仅当用户明确指定外部子 Agent（如“用 codex”“用 claude”）时，才使用 external:<name>。',
          '若用户明确指定某子 Agent（如“用 codex”“用 claude”），必须把 runtime 设为 external:<name>（例如 external:codex）；若不可用再按系统回退链执行，并在回复里说明已回退。',
          '仅允许一级派发：子 Agent 不得再派发子 Agent。',
          '当用户要求飞书文档编写/改写/追加时，优先直接使用文档能力工具（如 feishu_doc_capability 或 lark docx 相关工具）执行；仅在明显需要长流程/并行时再派发子 Agent。'
        ]
      : [
          '当前配置下你**没有** sessions_spawn 工具：必须在当前会话内用已有工具直接完成任务，不得假设可以派生子 Agent，也不得声称“已派发子 Agent”。',
          '复杂或耗时任务仍须在本会话内顺序执行并汇报进度；若用户明确要求子 Agent 能力，可说明需在「消息通知」中开启「协调 Agent 允许 sessions_spawn」。',
          '当用户要求飞书文档编写/改写/追加时，优先直接使用文档能力工具（如 feishu_doc_capability 或 lark docx 相关工具）执行。'
        ]
    const tail = [
      '可使用 stop_previous_task / wait_for_previous_run 管理当前会话任务池中的其他运行任务。',
      '当用户要求飞书电子表格或多维表格操作时，优先直接使用内置能力工具：feishu_sheets_capability / feishu_bitable_capability。禁止只回复操作步骤而不执行。',
      '禁止只回复“已派发/处理中”而不执行。若未实际调用工具产出结果，必须由主 Agent 直接执行并返回结果。',
      '用户提到附近/周边/当地等需要地域信息时：应用无内置定位，可请用户提供城市/区域后再 web_search；勿编造位置。',
      spawnOn ? '收到子 Agent 结果后，简洁向用户回复结论与必要说明。' : '',
      '用户可在消息首行发送「/model <模型ID>」或「/模型 <模型ID>」切换全局主模型（与 App 内设置一致）；首行之后可接正常提问。也可使用 ai_config_control 的 switch_model 修改主会话模型。'
    ].filter(Boolean)
    return [...head, ...spawnLines, ...tail].join('\n')
  }

  return {
    getToolsForChat,
    getToolsForChatWithWait,
    getToolsForSubChat,
    getToolsForCoordinatorChat,
    getCoordinatorSystemPrompt
  }
}

module.exports = { createAiChatToolsAccess }
