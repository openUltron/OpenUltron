const { MAIN_CHAT_PROJECT, SESSION_SOURCES } = require('./session-constants')

/**
 * 会话历史落库、摘要、进化、列表（依赖 main 注入的 Orchestrator / conversationFile 等）
 */
function registerAiHistoryIpc (deps) {
  const {
    registerChannel,
    conversationFile,
    persistToolArtifactsToRegistry,
    stripToolExecutionFromMessages,
    memoryStore,
    commandExecutionLog,
    getResolvedAIConfig,
    aiOrchestrator,
    appLogger,
    getWorkspaceRoot,
    filterSessionsList
  } = deps

  function compactSummaryText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim()
  }
  
  function extractMessageTextForSummary(msg) {
    if (!msg || typeof msg !== 'object') return ''
    const c = msg.content
    if (typeof c === 'string') return compactSummaryText(c)
    if (Array.isArray(c)) {
      return compactSummaryText(c.map((x) => {
        if (!x) return ''
        if (typeof x === 'string') return x
        if (typeof x.text === 'string') return x.text
        return ''
      }).join(' '))
    }
    return ''
  }
  
  function buildSessionSummaryFallback(messages = []) {
    const list = (messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, text: extractMessageTextForSummary(m) }))
      .filter((m) => m.text)
    if (!list.length) return ''
  
    const recent = list.slice(-24)
    const userPoints = []
    const assistantPoints = []
    for (const item of recent) {
      if (item.role === 'user') {
        if (userPoints.length < 6) userPoints.push(item.text.slice(0, 120))
      } else if (item.role === 'assistant') {
        if (assistantPoints.length < 6) assistantPoints.push(item.text.slice(0, 140))
      }
    }
  
    const lines = []
    lines.push(`会话压缩摘要（${new Date().toLocaleString('zh-CN', { hour12: false })}）`)
    if (userPoints.length) {
      lines.push('用户关注点：')
      for (const p of userPoints) lines.push(`- ${p}`)
    }
    if (assistantPoints.length) {
      lines.push('已完成/已回复：')
      for (const p of assistantPoints) lines.push(`- ${p}`)
    }
    return lines.join('\n')
  }
  
  async function buildSessionSummaryByAI({ projectPath, sessionId, messages, fallbackSummary = '' } = {}) {
    try {
      const config = getResolvedAIConfig()
      if (!config?.apiKey?.trim()) return ''
  
      const dialogList = (messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => {
          const text = extractMessageTextForSummary(m)
          return text ? `[${m.role}]: ${text.slice(0, 900)}` : ''
        })
        .filter(Boolean)
        .slice(-40)
      if (!dialogList.length) return ''
      const dialogText = dialogList.join('\n\n').slice(0, 16000)
  
      const cmdSummary = commandExecutionLog.getExecutionSummary(projectPath || '')
      const cmdViewed = commandExecutionLog.getViewedPaths(projectPath || '')
      const { entries: recentEntries } = commandExecutionLog.getRecentEntries(projectPath || '', 50, sessionId)
      const recentCommandsText = recentEntries.length
        ? recentEntries
            .map((e) => {
              const status = e.success ? '成功' : '失败'
              const cwd = e.cwd ? ` (cwd: ${e.cwd})` : ''
              const code = !e.success && e.exitCode != null ? ` exit=${e.exitCode}` : ''
              return `- [${status}]${cwd} ${(e.command || '').trim().slice(0, 200)}${code}`
            })
            .join('\n')
        : '无'
      const recentSuccessful = recentEntries.filter((e) => e.success).slice(0, 40)
      const recentSuccessfulText = recentSuccessful.length
        ? recentSuccessful
            .map((e) => {
              const cwd = e.cwd ? ` (cwd: ${e.cwd})` : ''
              return `- ${cwd} ${(e.command || '').trim().slice(0, 200)}`
            })
            .join('\n')
        : '无'
      const byToolText = (() => {
        const byTool = cmdSummary?.byTool && typeof cmdSummary.byTool === 'object' ? cmdSummary.byTool : {}
        const rows = Object.entries(byTool)
          .slice(0, 8)
          .map(([k, v]) => `${k}: total=${v?.total || 0}, ok=${v?.success || 0}, fail=${v?.failed || 0}`)
        return rows.join(' | ') || '无'
      })()
      const viewedDirs = Array.isArray(cmdViewed?.directories) ? cmdViewed.directories.slice(0, 30) : []
      const viewedFiles = Array.isArray(cmdViewed?.files) ? cmdViewed.files.slice(0, 30) : []
  
      const workspaceRoot = getWorkspaceRoot()
      const systemPrompt = '你是会话归档摘要助手。输出高质量中文摘要，必须基于真实对话与命令执行日志，禁止编造。输出纯文本，不要 JSON，不要 markdown 代码块。'
      const prompt = [
        `项目：${projectPath || MAIN_CHAT_PROJECT}`,
        `会话：${sessionId || ''}`,
        `workspace 根目录：${workspaceRoot}`,
        `命令统计：总数=${Number(cmdSummary?.total || 0)}，成功=${Number(cmdSummary?.success || 0)}，失败=${Number(cmdSummary?.failed || 0)}`,
        `按工具统计：${byToolText}`,
        `最近查看目录（去重，最多30）：${viewedDirs.length ? viewedDirs.join(', ') : '无'}`,
        `最近查看文件（去重，最多30）：${viewedFiles.length ? viewedFiles.join(', ') : '无'}`,
        '',
        '请生成“会话压缩摘要”，结构固定为：',
        '1) 用户目标与背景（3-6条）',
        '2) 已完成事项与结果（3-6条，注明关键路径/命令）',
        '3) 未完成与风险（2-4条）',
        '4) 命令与安装复盘（必须结合“命令执行日志”：列出安装了哪些、哪些命令成功/失败、后续应复用哪些；并指出哪些“已成功过”下次不要重复安装/重复跑）',
        '5) Workspace 目录整理与约束（必须给出可执行规则）',
        '',
        '其中第 5 部分必须包含以下约束：',
        `- 每周至少一次清理 ${workspaceRoot} 下临时文件（tmp、临时脚本、过期产物）`,
        `- scripts 固定放在 ${workspaceRoot}/scripts，项目固定放在 ${workspaceRoot}/projects`,
        '- 产物按类型分目录（如 presentations、exports、artifacts），禁止散落在根目录',
        '- 新建文件必须有可读命名（日期_用途_版本），并删除无效 v1/v2 草稿',
        '- 对长期不用的安装命令，先查历史成功命令，避免重复安装',
        '',
        '命令执行日志（本会话最近执行，含成功/失败）：',
        recentCommandsText,
        '',
        '命令执行日志（本会话最近成功，供判断“已安装/已验证”）：',
        recentSuccessfulText,
        '',
        '对话内容：',
        dialogText,
        fallbackSummary ? `\n参考（旧版压缩摘要，可纠偏）：\n${fallbackSummary.slice(0, 2000)}` : ''
      ].filter(Boolean).join('\n')
  
      const out = await aiOrchestrator.generateText({
        prompt,
        systemPrompt,
        config,
        model: config.defaultModel || 'deepseek-v3'
      })
      const text = String(out || '')
        .replace(/^```(?:text|markdown)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim()
      return text.slice(0, 8000)
    } catch (e) {
      try { appLogger?.warn?.('[AI] buildSessionSummaryByAI failed', { error: e.message || String(e) }) } catch (_) {}
      return ''
    }
  }
  
  registerChannel('ai-save-chat-history', async (event, { projectPath, messages, sessionId, model, apiBaseUrl }) => {
    try {
      const projectKey = conversationFile.hashProjectPath(projectPath)
      const id = sessionId || `proj-${Date.now()}`
      persistToolArtifactsToRegistry(messages, id)
      const toSave = stripToolExecutionFromMessages(messages)
      conversationFile.saveConversation(projectKey, { id, messages: toSave, projectPath, model, apiBaseUrl })
      return { success: true, sessionId: id }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
  
  registerChannel('ai-save-session-summary', async (event, { projectPath, sessionId, messages }) => {
    try {
      const proj = String(projectPath || MAIN_CHAT_PROJECT).trim() || MAIN_CHAT_PROJECT
      const sid = String(sessionId || '').trim()
      if (!sid || !Array.isArray(messages) || messages.length === 0) {
        return { success: false, message: 'invalid args' }
      }
      const fallbackSummary = buildSessionSummaryFallback(messages)
      let summary = await buildSessionSummaryByAI({
        projectPath: proj,
        sessionId: sid,
        messages,
        fallbackSummary
      })
      let summarySource = 'ai'
      if (!summary) {
        summary = fallbackSummary
        summarySource = 'fallback'
      }
      const { entries: recentEntries } = commandExecutionLog.getRecentEntries(proj, 20, sid)
      if (summarySource !== 'ai' && recentEntries.length > 0) {
        const successCount = recentEntries.filter((e) => e.success).length
        const failCount = recentEntries.length - successCount
        const lines = recentEntries.slice(0, 10).map((e) => {
          const status = e.success ? '✓' : '✗'
          const cmd = (e.command || '').trim().slice(0, 80)
          return `  ${status} ${cmd}`
        })
        summary = [summary, '', '命令执行情况：', `成功 ${successCount} 次，失败 ${failCount} 次。最近执行：`, ...lines].join('\n')
      }
      if (!summary) return { success: true, summary: '' }
      memoryStore.saveMemory({
        content: summary,
        tags: ['session-summary', `project:${proj}`, `session:${sid}`],
        projectPath: proj,
        source: 'auto'
      })
      return { success: true, summary, summary_source: summarySource }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })
  
  registerChannel('ai-list-session-summaries', async (event, { projectPath, limit }) => {
    try {
      const proj = String(projectPath || MAIN_CHAT_PROJECT).trim() || MAIN_CHAT_PROJECT
      const lim = Math.min(Math.max(Number(limit) || 5, 1), 20)
      const rows = memoryStore.listMemoriesByTags(['session-summary', `project:${proj}`], proj, lim)
      return {
        success: true,
        summaries: (rows || []).map((m) => ({
          id: m.id,
          content: m.content || '',
          createdAt: m.createdAt || null,
          updatedAt: m.updatedAt || null,
          tags: m.tags || []
        }))
      }
    } catch (e) {
      return { success: false, summaries: [], message: e.message }
    }
  })
  
  registerChannel('ai-load-chat-history', async (event, { projectPath, sessionId }) => {
    try {
      const projectKey = conversationFile.hashProjectPath(projectPath)
      const session = sessionId
        ? conversationFile.loadConversation(projectKey, sessionId)
        : conversationFile.loadLatestConversation(projectKey)
      if (!session) return { success: true, messages: [], sessionId: null }
      return {
        success: true,
        messages: session.messages || [],
        sessionId: session.id,
        apiBaseUrl: session.apiBaseUrl || null
      }
    } catch (error) {
      return { success: false, messages: [], sessionId: null }
    }
  })
  
  registerChannel('ai-clear-chat-history', async (event, { projectPath, sessionId }) => {
    try {
      if (sessionId) {
        const projectKey = conversationFile.hashProjectPath(projectPath)
        conversationFile.deleteConversation(projectKey, sessionId)
      }
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
  
  const EVOLVE_MIN_INTERVAL_MS = 3 * 60 * 1000
  const EVOLVE_MIN_DIALOG_MESSAGES = 6
  const EVOLVE_MIN_NEW_MESSAGES = 4
  const evolveSessionState = new Map() // key => { lastTs, lastDialogCount, running }
  
  function getDialogMessagesForEvolve(conv) {
    const msgs = Array.isArray(conv?.messages) ? conv.messages : []
    return msgs.filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
  }
  
  function getEvolveStateKey(projectPath, sessionId) {
    return `${String(projectPath || '').trim()}::${String(sessionId || '').trim()}`
  }
  
  function shouldRunSessionEvolve({ projectPath, sessionId, dialogCount, force = false }) {
    if (!projectPath || !sessionId) return { ok: false, reason: 'missing_params' }
    if (dialogCount < EVOLVE_MIN_DIALOG_MESSAGES) return { ok: false, reason: 'too_few_messages' }
    const key = getEvolveStateKey(projectPath, sessionId)
    const state = evolveSessionState.get(key) || {}
    if (state.running) return { ok: false, reason: 'already_running' }
    if (!force) {
      const now = Date.now()
      const elapsed = now - Number(state.lastTs || 0)
      if (elapsed < EVOLVE_MIN_INTERVAL_MS) return { ok: false, reason: 'cooldown' }
      if (Number(state.lastDialogCount || 0) > 0 && (dialogCount - Number(state.lastDialogCount || 0)) < EVOLVE_MIN_NEW_MESSAGES) {
        return { ok: false, reason: 'delta_too_small' }
      }
    }
    return { ok: true, reason: 'ready' }
  }
  
  async function evolveFromSessionInternal({ projectPath, sessionId, force = false, reason = 'manual' } = {}) {
    if (!projectPath || !sessionId) return { success: true, skipped: true, reason: 'missing_params' }
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const conv = conversationFile.loadConversation(projectKey, sessionId)
    const dialogMsgs = getDialogMessagesForEvolve(conv)
    const gate = shouldRunSessionEvolve({ projectPath, sessionId, dialogCount: dialogMsgs.length, force })
    if (!gate.ok) return { success: true, skipped: true, reason: gate.reason }
  
    const stateKey = getEvolveStateKey(projectPath, sessionId)
    const prev = evolveSessionState.get(stateKey) || {}
    evolveSessionState.set(stateKey, { ...prev, running: true })
    try {
      const dialogText = dialogMsgs
        .map((m) => {
          const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? (m.content.map(c => c?.text || '').join('')) : '')
          return `[${m.role}]: ${text.slice(0, 1500)}${text.length > 1500 ? '...' : ''}`
        })
        .join('\n\n')
        .slice(0, 9000)
      if (!dialogText.trim()) return { success: true, skipped: true, reason: 'empty_dialog' }
  
      const config = getResolvedAIConfig()
      if (!config?.apiKey?.trim()) return { success: true, skipped: true, reason: 'missing_api_key' }
  
      const cmdSummary = commandExecutionLog.getExecutionSummary(projectPath || '')
      const cmdViewed = commandExecutionLog.getViewedPaths(projectPath || '')
      const cmdBrief = [
        `命令总数=${Number(cmdSummary?.total || 0)}`,
        `成功=${Number(cmdSummary?.success || 0)}`,
        `失败=${Number(cmdSummary?.failed || 0)}`,
        `最近查看目录数=${Array.isArray(cmdViewed?.directories) ? cmdViewed.directories.length : 0}`,
        `最近查看文件数=${Array.isArray(cmdViewed?.files) ? cmdViewed.files.length : 0}`
      ].join('，')
      const cmdByTool = (() => {
        const byTool = cmdSummary?.byTool && typeof cmdSummary.byTool === 'object' ? cmdSummary.byTool : {}
        const rows = Object.entries(byTool)
          .slice(0, 6)
          .map(([k, v]) => `${k}:total=${v?.total || 0},ok=${v?.success || 0},fail=${v?.failed || 0}`)
        return rows.join(' | ')
      })()
  
      const { entries: recentEntries } = commandExecutionLog.getRecentEntries(projectPath || '', 50, sessionId)
      const recentCommandsText = recentEntries.length
        ? recentEntries
            .map((e) => {
              const status = e.success ? '成功' : '失败'
              const cwd = e.cwd ? ` (cwd: ${e.cwd})` : ''
              const code = !e.success && e.exitCode != null ? ` exit=${e.exitCode}` : ''
              return `- [${status}]${cwd} ${(e.command || '').trim().slice(0, 200)}${code}`
            })
            .join('\n')
        : ''
  
      const systemPrompt = '你负责从对话与命令执行记录中提炼经验教训。只输出一个 JSON 数组，格式为 [{"content":"...", "category":"..."}]。每条 content 必须详细（80～400字）：包含具体场景、失败原因或成功做法、可复用的命令/路径/步骤；须结合「最近执行命令」判断安装了哪些、哪些成功/失败。category 只能从 通用/git/部署/调试/命令/飞书/MCP/自动化 中选。若无值得提炼内容则输出 []。禁止 markdown 代码块，禁止额外解释。'
      const prompt = [
        `触发来源：${reason}`,
        `项目：${projectPath}`,
        `会话：${sessionId}`,
        `命令执行摘要：${cmdBrief}`,
        cmdByTool ? `按工具统计：${cmdByTool}` : '',
        recentCommandsText ? ['', '最近执行命令（本会话，供提炼「安装了哪些、哪些成功/失败」参考）：', recentCommandsText].join('\n') : '',
        '',
        '请根据以上「对话」与「最近执行命令」提炼 1～5 条经验教训：',
        dialogText
      ].filter(Boolean).join('\n')
  
      const result = await aiOrchestrator.generateText({
        prompt,
        systemPrompt,
        config,
        model: config.defaultModel || 'deepseek-v3'
      })
      const raw = (result && typeof result === 'string') ? result.trim() : ''
      const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      let arr
      try {
        arr = JSON.parse(jsonStr)
      } catch (_) {
        return { success: true, skipped: true, reason: 'invalid_json' }
      }
      if (!Array.isArray(arr) || arr.length === 0) {
        evolveSessionState.set(stateKey, { lastTs: Date.now(), lastDialogCount: dialogMsgs.length, running: false })
        return { success: true, skipped: true, reason: 'empty_lessons' }
      }
      let saved = 0
      for (const item of arr.slice(0, 5)) {
        const content = item && (item.content || item.text)
        const category = (item && item.category) ? String(item.category).trim() : '通用'
        if (!content || !String(content).trim()) continue
        try {
          memoryStore.appendLesson(String(content).trim(), category)
          saved++
        } catch (e) {
          console.warn('[AI] evolve appendLesson failed:', e.message)
        }
      }
      evolveSessionState.set(stateKey, { lastTs: Date.now(), lastDialogCount: dialogMsgs.length, running: false })
      try {
        appLogger?.info?.('[AI] evolve-from-session done', {
          projectPath,
          sessionId,
          reason,
          dialogCount: dialogMsgs.length,
          saved
        })
      } catch (_) {}
      return { success: true, saved }
    } catch (e) {
      console.warn('[AI] evolve-from-session failed:', e.message)
      return { success: true, skipped: true, reason: 'error', message: e.message }
    } finally {
      const s = evolveSessionState.get(stateKey) || {}
      evolveSessionState.set(stateKey, { ...s, running: false })
    }
  }
  
  function triggerAutoEvolveFromSession(payload = {}) {
    evolveFromSessionInternal(payload).catch((e) => {
      console.warn('[AI] auto evolve trigger failed:', e.message)
    })
  }
  
  // 开启新会话时主动自我进化：根据上一会话记录提炼经验并写入知识库（后台执行，不阻塞 UI）
  registerChannel('ai-evolve-from-session', async (event, { projectPath, sessionId, force }) => {
    const out = await evolveFromSessionInternal({
      projectPath,
      sessionId,
      force: force === true,
      reason: 'manual_channel'
    })
    return out && typeof out === 'object' ? out : { success: true }
  })
  
  // 列出项目所有历史对话（用于对话列表 UI）
  registerChannel('ai-list-conversations', async (event, { projectPath }) => {
    try {
      const projectKey = conversationFile.hashProjectPath(projectPath)
      const list = conversationFile.listConversations(projectKey)
      return { success: true, conversations: list }
    } catch (error) {
      return { success: false, conversations: [] }
    }
  })
  
  // 可扩展的会话来源：主会话、飞书、Gateway（浏览器/WebSocket 客户端）
  
  // 统一会话列表（主会话 + 飞书 + 后续扩展）；主会话只展示一条（最新），新会话 id 仍关联主会话
  registerChannel('ai-list-all-sessions', async () => {
    try {
      const sessions = filterSessionsList(conversationFile.listAllSessions(SESSION_SOURCES))
      return { success: true, sessions }
    } catch (error) {
      return { success: false, sessions: [], message: error.message }
    }
  })
  
  // 更新某会话的统计（副标题等），不重写消息体
  registerChannel('ai-update-session-stats', async (event, { projectPath, sessionId, lastMessage }) => {
    try {
      const projectKey = conversationFile.hashProjectPath(projectPath)
      const meta = {}
      if (lastMessage !== undefined) meta.lastMessage = lastMessage
      if (Object.keys(meta).length === 0) return { success: true }
      conversationFile.updateConversationMeta(projectKey, sessionId, meta)
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
  
  registerChannel('ai-rename-conversation', async (event, { projectPath, sessionId, title }) => {
    try {
      const projectKey = conversationFile.hashProjectPath(projectPath)
      conversationFile.updateConversationMeta(projectKey, sessionId, { title })
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
  
  // ---- 统一会话列表（主会话 + 飞书 + 可扩展） ----
  
  registerChannel('ai-get-sessions', async () => {
    try {
      const sessions = filterSessionsList(conversationFile.listAllSessions(SESSION_SOURCES))
      return { success: true, sessions }
    } catch (error) {
      return { success: false, sessions: [], message: error.message }
    }
  })
  
  registerChannel('ai-save-session', async (event, { projectPath, id, title, updatedAt }) => {
    try {
      const proj = projectPath || MAIN_CHAT_PROJECT
      const projectKey = conversationFile.hashProjectPath(proj)
      conversationFile.updateConversationMeta(projectKey, id, { title, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString() })
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
  
  registerChannel('ai-delete-session', async (event, { projectPath, id }) => {
    try {
      const proj = projectPath || MAIN_CHAT_PROJECT
      if (proj === MAIN_CHAT_PROJECT) {
        return { success: false, message: '主会话不可删除' }
      }
      const projectKey = conversationFile.hashProjectPath(proj)
      conversationFile.deleteConversation(projectKey, id)
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  return { triggerAutoEvolveFromSession }
}

module.exports = { registerAiHistoryIpc }
