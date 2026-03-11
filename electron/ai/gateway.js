/**
 * OpenClaw-style Gateway：中央 WebSocket 入口，单实例。
 * 端口默认 28790（与前端 UI 端口 28789 分离，避免 EADDRINUSE），客户端连接后发送 JSON 消息，AI 事件通过 WebSocket 回传。
 *
 * 协议（JSON）：
 * - 客户端 -> 服务端: { type: 'chat', id?, sessionId?, messages, model?, tools?, projectPath? }
 *                     { type: 'ping' }
 *                     { type: 'config' } | { type: 'cron' } | { type: 'presence' }  // 查询配置/定时任务/在线状态
 * - 服务端 -> 客户端: { event: 'token'|'tool_call'|'tool_result'|'complete'|'error', sessionId, ...data }
 *                     { event: 'config'|'cron'|'presence', data } | { event: 'pong' }
 */

const http = require('http')
const WebSocket = require('ws')
const { getWorkspaceRoot } = require('../app-root')

const DEFAULT_PORT = 28790

/**
 * @param {object} opts
 * @param {number} [opts.port] - 监听端口，默认 28790
 * @param {() => object} opts.getOrchestrator - 返回 aiOrchestrator 实例
 * @param {() => object} opts.getResolvedConfig - 返回 resolved config
 * @param {() => object} [opts.getToolDefinitions] - 返回工具列表
 * @param {(sessionId: string, messages: object[], projectPath: string) => void} [opts.onChatComplete] - 完成时保存历史
 * @param {() => { projectPath: string, sessionId: string } | null} [opts.getCurrentOpenSession] - 当前应用内打开的会话，用于同会话时同步消息与 loading
 * @param {(sessionId: string, projectPath: string, channel: string, data: object) => void} [opts.forwardToMainWindow] - 当 Gateway 会话与当前打开相同时，转发 token/complete 等到窗口
 * @param {(sessionId: string, projectPath: string, userContent: string) => void} [opts.onRemoteUserMessage] - 同会话时在发请求前通知窗口展示用户消息并进入 loading
 * @param {(sessionId: string, data: object) => void} [opts.onToolResult] - 每次 tool 结果时回调（供主进程收集截图等）
 * @param {(sessionId: string, projectPath: string, data: object, fromAppWindow: boolean) => void} [opts.onChatCompleteAny] - 每次会话完成时回调（含应用内发起的，供飞书会话回发）
 * @param {() => object} [opts.getConfigForGateway] - 供 WS type:config 查询，返回脱敏配置（不含 apiKey）
 * @param {() => object} [opts.getCronStatus] - 供 WS type:cron 查询，返回定时任务列表或状态
 * @returns {{ start: () => Promise<void>, stop: () => void, port: number }}
 */
function createGateway(opts) {
  const port = opts.port ?? DEFAULT_PORT
  const getOrchestrator = opts.getOrchestrator
  const getResolvedConfig = opts.getResolvedConfig
  const getToolDefinitions = opts.getToolDefinitions
  const onChatComplete = opts.onChatComplete
  const getCurrentOpenSession = opts.getCurrentOpenSession
  const forwardToMainWindow = opts.forwardToMainWindow
  const onRemoteUserMessage = opts.onRemoteUserMessage
  const onToolResult = opts.onToolResult
  const onChatCompleteAny = opts.onChatCompleteAny
  const getConfigForGateway = opts.getConfigForGateway
  const getCronStatus = opts.getCronStatus

  let httpServer = null
  let wss = null

  function start() {
    return new Promise((resolve, reject) => {
      if (httpServer) {
        resolve()
        return
      }
      httpServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OpenUltron Gateway (WebSocket only). Connect via ws://127.0.0.1:' + port)
      })

      wss = new WebSocket.Server({ server: httpServer })

      wss.on('connection', (ws, req) => {
        const clientId = `${req.socket.remoteAddress}:${Date.now()}`
        console.log('[Gateway] client connected:', clientId)

        ws.on('message', (raw) => {
          let msg
          try {
            msg = JSON.parse(raw.toString())
          } catch (_) {
            send(ws, { event: 'error', error: 'Invalid JSON' })
            return
          }
          if (msg.type === 'chat') {
            handleChat(ws, msg)
          } else if (msg.type === 'ping') {
            send(ws, { event: 'pong' })
          } else if (msg.type === 'config') {
            try {
              const data = typeof getConfigForGateway === 'function' ? getConfigForGateway() : null
              send(ws, data != null ? { event: 'config', data } : { event: 'error', error: 'config not available' })
            } catch (e) {
              send(ws, { event: 'error', error: e.message || 'config failed' })
            }
          } else if (msg.type === 'cron') {
            try {
              const data = typeof getCronStatus === 'function' ? getCronStatus() : null
              send(ws, data != null ? { event: 'cron', data } : { event: 'error', error: 'cron not available' })
            } catch (e) {
              send(ws, { event: 'error', error: e.message || 'cron failed' })
            }
          } else if (msg.type === 'presence') {
            const clientCount = wss && wss.clients ? wss.clients.size : 0
            send(ws, { event: 'presence', data: { gateway: true, port, clientCount } })
          } else {
            send(ws, { event: 'error', error: 'Unknown type: ' + (msg.type || '') })
          }
        })

        ws.on('close', () => {
          console.log('[Gateway] client disconnected:', clientId)
        })

        ws.on('error', (err) => {
          console.warn('[Gateway] ws error:', err.message)
        })
      })

      httpServer.listen(port, '127.0.0.1', () => {
        console.log(`[Gateway] WebSocket server: ws://127.0.0.1:${port}`)
        resolve()
      })
      httpServer.on('error', (err) => {
        console.warn('[Gateway] listen error:', err.message)
        reject(err)
      })
    })
  }

  function send(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(obj))
    } catch (e) {
      console.warn('[Gateway] send error:', e.message)
    }
  }

  /**
   * 统一聊天入口：WebSocket、IPC、HTTP、飞书、Heartbeat 都走这里，便于后续接入不同 API 供应商。
   * @param {object} params - sessionId, projectPath, messages, model, tools, panelId?, feishuChatId?
   * @param {object} sender - { send(channel, data) } 如 IPC 的 event.sender 或 WebSocket 包装
   * @returns {Promise<{ messages?: object[] }>}
   */
  function runChat(params, sender) {
    const { sessionId, projectPath, messages: rawMessages, model, tools, panelId, feishuChatId, fromAppWindow } = params
    const orchestrator = getOrchestrator()
    const resolvedConfig = getResolvedConfig()
    const toolDefs = typeof getToolDefinitions === 'function' ? getToolDefinitions() : []
    const openSession = typeof getCurrentOpenSession === 'function' ? getCurrentOpenSession() : null
    const isSameSession = openSession && openSession.sessionId === sessionId && openSession.projectPath === projectPath

    const wrappedSender = {
      send: (channel, data) => {
        if (sender && typeof sender.send === 'function') sender.send(channel, data)
        if (channel === 'ai-chat-tool-result' && typeof onToolResult === 'function' && data && data.sessionId) {
          try {
            onToolResult(data.sessionId, data)
          } catch (e) {
            console.warn('[Gateway] onToolResult error:', e.message)
          }
        }
        if (channel === 'ai-chat-complete') {
          if (typeof onChatCompleteAny === 'function') {
            try {
              onChatCompleteAny(sessionId, projectPath, data, fromAppWindow)
            } catch (e) {
              console.warn('[Gateway] onChatCompleteAny error:', e.message)
            }
          }
          // 完成时一律由主进程写盘，避免用户切换页面后前端未收到 complete 导致只保存了流式半截内容
          if (typeof onChatComplete === 'function' && data.messages && Array.isArray(data.messages)) {
            try {
              onChatComplete(sessionId, data.messages, projectPath)
            } catch (e) {
              console.warn('[Gateway] onChatComplete error:', e.message)
            }
          }
        }
        // 来自应用窗口的请求已通过 sender 直接推给该窗口，不再转发，避免 token/complete 被送达两次导致回复内容重复或闪烁
        if (isSameSession && !fromAppWindow && typeof forwardToMainWindow === 'function') {
          forwardToMainWindow(sessionId, projectPath, channel, { ...data, sessionId })
        }
      }
    }

    const msgList = Array.isArray(rawMessages) ? rawMessages : [{ role: 'user', content: String(rawMessages || '') }]
    const userMessages = msgList.filter(m => m && m.role === 'user')
    const lastUser = userMessages.length ? userMessages[userMessages.length - 1] : null
    const userContent = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : '') : ''
    // 仅当请求来自「非应用窗口」（如浏览器/远程）时通知窗口展示用户消息，避免应用内发消息时重复一条
    if (isSameSession && userContent && typeof onRemoteUserMessage === 'function' && !fromAppWindow) {
      try {
        onRemoteUserMessage(sessionId, projectPath, userContent)
      } catch (e) {
        console.warn('[Gateway] onRemoteUserMessage error:', e.message)
      }
    }

    const useTools = tools === false ? [] : (Array.isArray(tools) && tools.length > 0 ? tools : toolDefs)
    return orchestrator.startChat({
      sessionId,
      messages: msgList,
      model: model || undefined,
      tools: useTools,
      sender: wrappedSender,
      config: resolvedConfig,
      projectPath: projectPath || getWorkspaceRoot(),
      panelId: panelId || undefined,
      feishuChatId: feishuChatId || undefined
    }).then(() => ({}))
  }

  /** 统一停止会话入口，便于后续按 session 路由到不同供应商 */
  function stopChat(sessionId) {
    const orchestrator = getOrchestrator()
    if (orchestrator && typeof orchestrator.stopChat === 'function') {
      orchestrator.stopChat(sessionId)
    }
  }

  function handleChat(ws, msg) {
    const { id, sessionId: sid, messages, model, tools, projectPath: msgProjectPath, fromAppWindow } = msg
    const sessionId = sid != null && String(sid).trim() !== '' ? String(sid).trim() : `gateway-${Date.now()}`
    const projectPath = msgProjectPath != null && String(msgProjectPath).trim() !== '' ? String(msgProjectPath).trim() : '__gateway__'
    const wsSender = {
      send: (channel, data) => {
        if (channel === 'ai-chat-token') send(ws, { event: 'token', sessionId, token: data.token })
        else if (channel === 'ai-chat-tool-call') send(ws, { event: 'tool_call', sessionId, toolCall: data.toolCall })
        else if (channel === 'ai-chat-tool-result') send(ws, { event: 'tool_result', sessionId, toolResult: data.toolResult })
        else if (channel === 'ai-chat-complete') send(ws, { event: 'complete', sessionId, messages: data.messages, requestId: id })
        else if (channel === 'ai-chat-error') send(ws, { event: 'error', sessionId, error: data.error, requestId: id })
      }
    }
    runChat({ sessionId, projectPath, messages, model, tools, fromAppWindow }, wsSender).catch((e) => {
      send(ws, { event: 'error', sessionId, error: e.message || 'startChat failed', requestId: id })
    })
  }

  function stop() {
    if (wss) {
      wss.close()
      wss = null
    }
    if (httpServer) {
      httpServer.close()
      httpServer = null
    }
    console.log('[Gateway] stopped')
  }

  /** 是否已在监听（供健康检查用） */
  function isRunning() {
    return !!(httpServer && httpServer.listening)
  }

  return { start, stop, port, runChat, stopChat, isRunning }
}

module.exports = { createGateway, DEFAULT_PORT }
