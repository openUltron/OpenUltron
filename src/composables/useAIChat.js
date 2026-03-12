// AI 聊天 composable - 管理与后端 AI 服务的通信

import { ref, reactive, onUnmounted } from 'vue'

export function useAIChat() {
  const messages = ref([])
  const isStreaming = ref(false)
  const currentStreamContent = ref('')
  const error = ref('')
  const pendingConfirm = ref(null) // { confirmId, message, severity }

  let currentSessionId = null
  let listenersRegistered = false
  const toolResultPushState = new Map() // toolCallId -> { lastTs, timer, latest }

  // Electron IPC 仅支持可结构化克隆对象；这里统一转为纯 JSON 可序列化对象
  const toSerializable = (val) => {
    try {
      return JSON.parse(JSON.stringify(val))
    } catch (_) {
      return val
    }
  }

  // 生成唯一会话 ID
  const genSessionId = () => `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // 统一按字符串比较 sessionId，避免 IPC 序列化导致类型不一致而丢事件
  const isCurrentSession = (data) =>
    data?.sessionId != null && currentSessionId != null &&
    String(data.sessionId).trim() === String(currentSessionId).trim()

  // 注册 IPC 监听器
  const ensureListeners = () => {
    if (listenersRegistered) return
    listenersRegistered = true

    window.electronAPI.ai.onToken((data) => {
      if (!isCurrentSession(data)) return
      currentStreamContent.value += data.token
      // 更新最后一条 assistant 消息
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant') {
        last.content = currentStreamContent.value
      }
    })

    window.electronAPI.ai.onToolCall((data) => {
      if (!isCurrentSession(data)) return
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant') {
        if (!last.toolCalls) last.toolCalls = []
        last.toolCalls.push({
          id: data.toolCall.id,
          name: data.toolCall.name,
          arguments: data.toolCall.arguments,
          result: null,
          _startedAt: Date.now(),
          _endedAt: null,
          _expanded: false
        })
      }
    })

    window.electronAPI.ai.onToolResult((data) => {
      if (!isCurrentSession(data)) return
      const applyResult = (payload) => {
        for (const msg of messages.value) {
          if (msg.toolCalls) {
            const tc = msg.toolCalls.find(t => t.id === payload.toolCallId)
            if (tc) {
              if (!tc._startedAt) tc._startedAt = Date.now()
              tc.result = payload.result
              let partial = false
              try {
                const obj = typeof payload.result === 'string' ? JSON.parse(payload.result) : payload.result
                partial = !!(obj && typeof obj === 'object' && (obj.partial === true || obj.running === true))
              } catch { /* ignore */ }
              if (!partial) tc._endedAt = Date.now()
              break
            }
          }
        }
      }
      let isPartial = false
      try {
        const obj = typeof data.result === 'string' ? JSON.parse(data.result) : data.result
        isPartial = !!(obj && typeof obj === 'object' && (obj.partial === true || obj.running === true))
      } catch { /* ignore */ }
      if (!isPartial) {
        const state = toolResultPushState.get(data.toolCallId)
        if (state?.timer) clearTimeout(state.timer)
        toolResultPushState.delete(data.toolCallId)
        applyResult(data)
        return
      }
      const now = Date.now()
      const state = toolResultPushState.get(data.toolCallId) || { lastTs: 0, timer: null, latest: null }
      state.latest = data
      const gap = now - state.lastTs
      if (gap >= 300) {
        state.lastTs = now
        if (state.timer) {
          clearTimeout(state.timer)
          state.timer = null
        }
        applyResult(data)
      } else if (!state.timer) {
        state.timer = setTimeout(() => {
          state.lastTs = Date.now()
          state.timer = null
          if (state.latest) applyResult(state.latest)
        }, 300 - gap)
      }
      toolResultPushState.set(data.toolCallId, state)
    })

    window.electronAPI.ai.onComplete((data) => {
      if (!isCurrentSession(data)) return
      isStreaming.value = false
      currentStreamContent.value = ''
      // 若最后一条 assistant 无内容也无工具调用，给个占位，避免“没报错但也没看到任何回复”
      const last = messages.value[messages.value.length - 1]
      if (last?.role === 'assistant' && !last.content?.trim() && !(last.toolCalls?.length)) {
        last.content = '（无回复内容）'
      }
    })

    window.electronAPI.ai.onError((data) => {
      const sid = data.sessionId != null ? String(data.sessionId).trim() : ''
      const cur = currentSessionId != null ? String(currentSessionId).trim() : ''
      if (sid !== cur) return
      error.value = data.error || 'AI 请求失败'
      isStreaming.value = false
      currentStreamContent.value = ''
      // 移除空的 assistant 占位，避免只看到空白气泡而看不到错误
      const last = messages.value[messages.value.length - 1]
      if (last?.role === 'assistant' && !last.content?.trim() && !(last.toolCalls?.length)) {
        messages.value.pop()
      }
    })

    // 用户确认请求
    window.electronAPI.ai.onConfirmRequest((data) => {
      if (!isCurrentSession(data)) return
      pendingConfirm.value = {
        confirmId: data.confirmId,
        message: data.message,
        severity: data.severity || 'warning',
        inputDefault: data.inputDefault || null,  // 有值则显示可编辑输入框
        allowPush: data.allowPush || false         // 是否显示「确认并推送」按钮
      }
    })
  }

  // 响应用户确认，userInput 为用户在输入框中编辑的内容（可选）
  const respondConfirm = async (confirmed, userInput = '', pushAfterCommit = false) => {
    if (!pendingConfirm.value) return
    const { confirmId } = pendingConfirm.value
    pendingConfirm.value = null
    await window.electronAPI.ai.confirmResponse({ confirmId, confirmed, userInput, pushAfterCommit })
  }

  // 发送消息
  const sendMessage = async (content, { model, systemPrompt, projectPath, displayContent, userContentParts, panelId, sessionId: passedSessionId } = {}) => {
    error.value = ''

    // 添加用户消息（展示用 displayContent，发给 AI 用 content）
    messages.value.push({ role: 'user', content: displayContent || content })

    // 构建请求消息列表：含 tool_calls / role:tool，多轮对话时 API 才能正确续写
    const reqMessages = []
    if (systemPrompt) {
      reqMessages.push({ role: 'system', content: systemPrompt })
    }
    for (const msg of messages.value) {
      if (msg.role === 'user') {
        reqMessages.push({ role: 'user', content: msg.content })
        continue
      }
      if (msg.role === 'assistant') {
        const hasContent = msg.content != null && String(msg.content).trim() !== ''
        const hasToolCalls = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
        if (!hasContent && !hasToolCalls) continue
        const apiMsg = { role: 'assistant', content: msg.content ?? '' }
        if (hasToolCalls) {
          apiMsg.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name: tc.name || '', arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) }
          }))
        }
        reqMessages.push(apiMsg)
        if (hasToolCalls) {
          for (const tc of msg.toolCalls) {
            const tid = tc.id || ''
            reqMessages.push({ role: 'tool', tool_call_id: tid, content: tc.result != null ? String(tc.result) : '' })
          }
        }
        continue
      }
    }
    // 最后一条用户消息：优先用多模态 content（例如 image_url）；否则按原文本覆盖
    if (Array.isArray(userContentParts) && userContentParts.length > 0 && reqMessages.length > 0) {
      const last = reqMessages[reqMessages.length - 1]
      if (last.role === 'user') last.content = userContentParts
    } else if (displayContent && reqMessages.length > 0) {
      const last = reqMessages[reqMessages.length - 1]
      if (last.role === 'user') last.content = content
    }

    // 创建空的 assistant 消息占位
    messages.value.push({ role: 'assistant', content: '', toolCalls: [] })

    // 使用传入的 sessionId（URL/已加载会话）或已有 currentSessionId，否则才生成新 id
    if (passedSessionId != null && String(passedSessionId).trim() !== '') {
      currentSessionId = String(passedSessionId).trim()
    } else if (!currentSessionId) {
      currentSessionId = genSessionId()
    }
    currentStreamContent.value = ''
    isStreaming.value = true

    ensureListeners()

    try {
      let tools = []
      try {
        const res = await window.electronAPI.ai.getTools()
        if (res.success) tools = res.tools
      } catch { /* ignore */ }

      // 浏览器模式：走 Gateway WebSocket，流式接收且主进程可同步同会话
      const wsUrl = window.electronAPI?.gatewayWsUrl
      if (window.electronAPI?.isBrowserMode && wsUrl) {
        await sendMessageViaGatewayWs({
          wsUrl,
          sessionId: currentSessionId,
          projectPath: projectPath || '__gateway__',
          messages: reqMessages,
          model,
          tools,
          onToken: (token) => {
            currentStreamContent.value += token
            const last = messages.value[messages.value.length - 1]
            if (last && last.role === 'assistant') last.content = currentStreamContent.value
          },
          onToolCall: (toolCall) => {
            const last = messages.value[messages.value.length - 1]
            if (last && last.role === 'assistant') {
              if (!last.toolCalls) last.toolCalls = []
              last.toolCalls.push({
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                result: null,
                _startedAt: Date.now(),
                _endedAt: null,
                _expanded: false
              })
            }
          },
          onToolResult: (toolCallId, result) => {
            for (const msg of messages.value) {
              if (msg.toolCalls) {
                const tc = msg.toolCalls.find(t => t.id === toolCallId)
                if (tc) { tc.result = result; break }
              }
            }
          },
          onComplete: () => {
            isStreaming.value = false
            currentStreamContent.value = ''
            const last = messages.value[messages.value.length - 1]
            if (last?.role === 'assistant' && !last.content?.trim() && !(last.toolCalls?.length)) {
              last.content = '（无回复内容）'
            }
          },
          onError: (errMsg) => {
            error.value = errMsg || 'AI 出错'
            isStreaming.value = false
            currentStreamContent.value = ''
            const last = messages.value[messages.value.length - 1]
            if (last?.role === 'assistant' && !last.content?.trim() && !last.toolCalls?.length) messages.value.pop()
          }
        })
        return
      }

      // 应用内：IPC 启动对话
      const payload = toSerializable({
        sessionId: currentSessionId,
        messages: reqMessages,
        model,
        tools,
        projectPath: projectPath || '',
        panelId: panelId || undefined
      })
      const result = await window.electronAPI.ai.chatStart(payload)

      if (!result.success) {
        error.value = result.message || result.error || '启动对话失败'
        isStreaming.value = false
        const last = messages.value[messages.value.length - 1]
        if (last?.role === 'assistant' && !last.content?.trim() && !last.toolCalls?.length) messages.value.pop()
        return
      }
      // 浏览器/HTTP 兜底：后端直接返回完整 messages 时补全最后一条 assistant
      if (result.messages && Array.isArray(result.messages) && result.messages.length > 0) {
        const lastBackend = result.messages[result.messages.length - 1]
        if (lastBackend.role === 'assistant') {
          let text = ''
          if (typeof lastBackend.content === 'string') text = lastBackend.content
          else if (Array.isArray(lastBackend.content)) text = (lastBackend.content || []).map(c => (c && c.text) || '').join('')
          const lastLocal = messages.value[messages.value.length - 1]
          if (lastLocal && lastLocal.role === 'assistant') {
            lastLocal.content = text
            if (lastBackend.tool_calls?.length) lastLocal.toolCalls = (lastBackend.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments, result: null }))
          }
        }
        isStreaming.value = false
      }
    } catch (e) {
      error.value = e.message || '发送失败'
      isStreaming.value = false
    }
  }

  /**
   * 浏览器模式：通过 Gateway WebSocket 发聊天，带 sessionId/projectPath 以便主进程同会话同步
   */
  async function sendMessageViaGatewayWs({ wsUrl, sessionId, projectPath, messages: msgList, model, tools, onToken, onToolCall, onToolResult, onComplete, onError }) {
    return new Promise((resolve, reject) => {
      let ws
      let finished = false
      try {
        ws = new WebSocket(wsUrl)
      } catch (e) {
        onError(e.message || 'WebSocket 连接失败')
        reject(e)
        return
      }
      const done = (err) => {
        if (finished) return
        finished = true
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.close() } catch (_) {}
        if (err) onError(err)
        resolve()
      }
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            type: 'chat',
            sessionId,
            projectPath,
            messages: msgList,
            model: model || undefined,
            tools: tools !== false ? (Array.isArray(tools) ? tools : []) : false,
            fromAppWindow: true  // 避免 Gateway 再通知同窗口展示用户消息，防止重复一条
          }))
        } catch (e) {
          done(e.message || '发送失败')
        }
      }
      ws.onmessage = (ev) => {
        let data
        try {
          data = JSON.parse(ev.data)
        } catch (_) {
          return
        }
        if (data.sessionId !== sessionId) return
        switch (data.event) {
          case 'token':
            if (data.token && onToken) onToken(data.token)
            break
          case 'tool_call':
            if (data.toolCall && onToolCall) onToolCall(data.toolCall)
            break
          case 'tool_result':
            if (data.toolResult != null && onToolResult) onToolResult(data.toolResult.toolCallId || data.toolResult.id, data.toolResult.result)
            break
          case 'complete':
            if (onComplete) onComplete()
            done()
            break
          case 'error':
            done(data.error || '未知错误')
            break
          default:
            break
        }
      }
      ws.onerror = () => done('WebSocket 错误')
      ws.onclose = () => { if (!finished && isStreaming.value) done('连接已关闭') }
    })
  }

  // 停止对话
  const stopChat = async () => {
    if (currentSessionId) {
      await window.electronAPI.ai.chatStop({ sessionId: currentSessionId })
    }
    isStreaming.value = false
    pendingConfirm.value = null
    currentStreamContent.value = ''

    // 清理最后一条空的 assistant 消息
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant' && !last.content?.trim() && !last.toolCalls?.length) {
      messages.value.pop()
    }
  }

  // 加载历史消息（用于恢复会话上下文）
  // 后端保存格式：assistant 用 tool_calls（蛇形），tool 结果在单独的 role:'tool' 消息里；需合并为前端格式 toolCalls + result
  const loadMessages = (savedMessages) => {
    if (!savedMessages || savedMessages.length === 0) return
    const raw = savedMessages.map((m) => {
      const list = m.toolCalls || m.tool_calls || []
      const toolCalls = list.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        function: tc.function,
        result: tc.result,
        arguments: tc.function?.arguments
      }))
      return {
        role: m.role,
        content: m.content ?? '',
        tool_call_id: m.tool_call_id,
        toolCalls: toolCalls.length ? toolCalls : []
      }
    })
    // 把紧随 assistant 的 role:'tool' 消息的 content 合并到对应 toolCall.result
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i]
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue
      let j = i + 1
      for (const tc of m.toolCalls) {
        const id = tc.id
        if (j < raw.length && raw[j].role === 'tool' && (raw[j].tool_call_id === id || raw[j].tool_call_id === tc.id)) {
          tc.result = raw[j].content
          j++
        }
      }
    }
    messages.value = raw.filter((m) => m.role !== 'tool')
  }

  // 供飞书会话等外部驱动：绑定当前会话 ID 并添加 assistant 占位，以接收主进程转发的 token/tool 事件
  const setCurrentSessionId = (sessionId) => {
    currentSessionId = sessionId
  }
  const ensureSessionId = (preferredSessionId) => {
    if (preferredSessionId != null && String(preferredSessionId).trim() !== '') {
      currentSessionId = String(preferredSessionId).trim()
    } else if (!currentSessionId) {
      currentSessionId = genSessionId()
    }
    return currentSessionId
  }
  const getCurrentSessionId = () => currentSessionId
  const startStreamingPlaceholder = () => {
    ensureListeners()
    messages.value.push({ role: 'assistant', content: '', toolCalls: [] })
    currentStreamContent.value = ''
    isStreaming.value = true
  }

  // 清空历史
  const clearMessages = () => {
    messages.value = []
    error.value = ''
    currentStreamContent.value = ''
    pendingConfirm.value = null
  }

  // 清理
  const cleanup = () => {
    for (const state of toolResultPushState.values()) {
      if (state?.timer) clearTimeout(state.timer)
    }
    toolResultPushState.clear()
    // 不调用全局 removeAllListeners()，避免影响其他正在运行的 AI 会话
    // 各监听器已按 sessionId 过滤，此实例的监听器不会处理其他会话的事件
    listenersRegistered = false
  }

  onUnmounted(cleanup)

  return {
    messages,
    isStreaming,
    error,
    pendingConfirm,
    sendMessage,
    stopChat,
    clearMessages,
    loadMessages,
    respondConfirm,
    setCurrentSessionId,
    ensureSessionId,
    getCurrentSessionId,
    startStreamingPlaceholder,
    cleanup
  }
}
