'use strict'

const path = require('path')
const { getWebAppsRoot } = require('../web-apps/registry')
const { filterToolsByProfile } = require('../ai/agent-profile')

/**
 * 应用工作室侧栏：会话已绑定某沙箱应用根目录。
 * @param {string} pp projectPath
 */
function isWebAppStudioChatProject(pp) {
  const raw = String(pp || '').trim()
  if (!raw || raw.startsWith('__')) return false
  try {
    const root = path.resolve(getWebAppsRoot())
    const abs = path.resolve(raw)
    return abs === root || abs.startsWith(root + path.sep)
  } catch (_) {
    return false
  }
}

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

  /** @param {{ projectPath?: string, profile?: object | null }} [opts] 传入应用根路径时合并 webapp__* 等；profile 时按 allow/deny 裁剪 */
  function getToolsForSubChat(opts = {}) {
    const pr = opts.profile || null
    const isCoordinator = pr && String(pr.id || '').trim() === 'coordinator'
    const isStudioProject = isWebAppStudioChatProject(opts.projectPath)
    const base = getToolsForChat(opts).filter((t) => {
      const name = String(t?.function?.name || '').trim()
      if (CHANNEL_SEND_TOOL_REGEX.test(name)) return false
      if (isStudioProject) return true
      if (name === 'sessions_spawn') return isCoordinator
      if (name === 'webapp_studio_invoke') return false
      if (name === 'web_apps_create') return false
      return true
    })
    return filterToolsByProfile(base, pr)
  }

  function getToolsForCoordinatorChat() {
    const noChannelSend = (t) => {
      const name = String(t?.function?.name || '').trim()
      return !CHANNEL_SEND_TOOL_REGEX.test(name)
    }
    if (coordinatorIncludesSessionsSpawn()) {
      return getToolsForChat().filter(noChannelSend)
    }
    // 与 getToolsForSubChat 一致但保留 webapp_studio_invoke，便于飞书等协调会话委派应用工作室（无需开启 sessions_spawn）
    return getToolsForChat().filter((t) => {
      const name = String(t?.function?.name || '').trim()
      if (CHANNEL_SEND_TOOL_REGEX.test(name)) return false
      if (name === 'sessions_spawn') return false
      return true
    })
  }

  function getCoordinatorSystemPrompt(channel = '') {
    const channelName = channel === 'feishu'
      ? '飞书'
      : (channel === 'telegram' ? 'Telegram' : (channel === 'dingtalk' ? '钉钉' : '当前渠道'))
    const spawnOn = coordinatorIncludesSessionsSpawn()
    const lines = [
      '[协调 Agent 执行契约]',
      `你是 ${channelName} 入口协调 Agent。`,
      '目标：直接完成用户需求；禁止只回复“已派发/处理中”。',
      '规则：只有真实调用工具并获得结果后，才能说“已完成”；否则继续执行或返回明确错误。'
    ]
    if (spawnOn) {
      lines.push('可在复杂/并行任务时调用 sessions_spawn；默认 runtime="auto"，按可用外部子 Agent 动态选择（默认以最近成功运行时的顺序为优先），未命中时自动 fallback 到 internal；可选 external:codex / external:claude / external:gateway / external:opencode，或 runtime: "external:xxx"；本机未安装则会自动跳过。')
    } else {
      lines.push('当前不允许 sessions_spawn，必须在本会话内完成，不得声称已派发子 Agent。')
    }
    lines.push('侧栏应用沙箱必须用 webapp_studio_invoke（先 web_apps_list）；不要在本会话直接写 web-apps 目录。')
    lines.push('飞书文档优先 feishu_doc_capability；表格优先 feishu_sheets_capability / feishu_bitable_capability。')
    lines.push('用户可用首行 /model <模型ID> 切换模型。')
    return lines.join('\n')
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
