/**
 * OpenAI Responses API（/v1/responses）与 Chat Completions 的请求体/流式事件差异。
 * @see https://platform.openai.com/docs/api-reference/responses/create
 */

function normalizeTextContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p || typeof p !== 'object') return ''
        if (p.type === 'text') return p.text || ''
        if (p.type === 'input_text' || p.type === 'output_text') return p.text || ''
        return ''
      })
      .join('')
  }
  return String(content)
}

/**
 * 将 Chat Completions 风格 messages 转为 Responses 的 instructions + input 列表。
 * @param {Array<{role:string,content?:*,tool_calls?:*,tool_call_id?:string}>} messages
 * @param {{ model: string, temperature?: number, max_tokens?: number, tools?: Array }} body
 * @param {{ codexChatgptBackend?: boolean }} [options] ChatGPT `…/codex/responses` 要求 `store: false`，否则会 400。
 */
/**
 * Platform `api.openai.com`：user/assistant 文本块均用 `input_text`。
 * ChatGPT `…/codex/responses`：按角色区分 —— **user** 仅允许 `input_text` / `input_image` 等；**assistant** 为 `output_text` / `refusal`。
 */
function textContentPart(text, options, role) {
  const t = String(text || '')
  const codex = !!options.codexChatgptBackend
  if (codex && role === 'assistant') {
    return { type: 'output_text', text: t }
  }
  return { type: 'input_text', text: t }
}

function buildResponsesRequestBody(messages, body, options = {}) {
  const sys = []
  const items = []
  for (const m of messages || []) {
    if (!m || !m.role) continue
    if (m.role === 'system') {
      sys.push(normalizeTextContent(m.content))
      continue
    }
    if (m.role === 'user') {
      items.push({
        type: 'message',
        role: 'user',
        content: [textContentPart(normalizeTextContent(m.content), options, 'user')]
      })
      continue
    }
    if (m.role === 'assistant') {
      const text = normalizeTextContent(m.content)
      if (m.tool_calls && m.tool_calls.length) {
        if (text && String(text).trim()) {
          items.push({
            type: 'message',
            role: 'assistant',
            content: [textContentPart(text, options, 'assistant')]
          })
        } else {
          // 多轮工具：仅 tool_calls、无正文时仍要有 assistant 消息块，再跟 function_call（部分 Responses 后端否则与后续 function_call_output 配对不稳）
          items.push({
            type: 'message',
            role: 'assistant',
            content: [textContentPart('', options, 'assistant')]
          })
        }
        for (const tc of m.tool_calls) {
          const fn = tc.function || {}
          items.push({
            type: 'function_call',
            call_id: String(tc.id || '').trim() || `call_${Date.now()}`,
            name: String(fn.name || ''),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
          })
        }
      } else {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [textContentPart(text || '', options, 'assistant')]
        })
      }
      continue
    }
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: String(m.tool_call_id || '').trim() || 'unknown',
        output: normalizeTextContent(m.content)
      })
    }
  }

  const req = {
    model: body.model,
    stream: body.stream !== undefined ? !!body.stream : true,
    input: items.length
      ? items
      : [{ type: 'message', role: 'user', content: [textContentPart('', options, 'user')] }]
  }
  const ins = sys.filter(Boolean).join('\n\n')
  if (ins) req.instructions = ins
  // ChatGPT Codex `/codex/responses` 不接受 `temperature`（会 400 Unsupported parameter）
  if (body.temperature != null && !options.codexChatgptBackend) {
    req.temperature = body.temperature
  }
  // Codex 后端同样不接受 `max_output_tokens`（会 400 Unsupported parameter）
  const mt = Number(body.max_tokens) || 0
  if (mt > 0 && !options.codexChatgptBackend) {
    req.max_output_tokens = mt
  }
  if (body.tools && body.tools.length) {
    req.tools = body.tools.map((t) => {
      const fn = t.function || t
      return {
        type: 'function',
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} }
      }
    })
    req.tool_choice = body.tool_choice ?? 'auto'
    // ChatGPT Codex 后端对 parallel_tool_calls 支持不稳定；省略以避免工具被静默忽略或 400
    if (!options.codexChatgptBackend) {
      req.parallel_tool_calls = true
    }
  }
  if (options.codexChatgptBackend) {
    req.store = false
    // 无 system 消息时 ins 为空，Codex 仍要求必填 instructions，否则 400「Instructions are required」
    if (req.instructions == null || !String(req.instructions).trim()) {
      req.instructions = 'Follow the user message and complete the task.'
    }
  }
  return req
}

/**
 * 跨 SSE 事件累积 function_call.arguments（与 openai-node ResponseStream 一致）。
 * @returns {{ byOutputIndex: Record<number, { name: string, call_id: string, arguments: string }> }}
 */
function createResponsesStreamToolState() {
  return { byOutputIndex: Object.create(null), byItemId: Object.create(null) }
}

/**
 * 流结束时补全：仅加入尚未在 seenCallIds 中出现过的 call_id（与上层 seenToolIds 配合）。
 * @param {{ byOutputIndex: Record<number, object> }} state
 * @param {Set<string>} [seenCallIds]
 * @returns {Array<{id:string,type:string,function:{name:string,arguments:string}}>}
 */
function flushResponsesStreamToolState(state, seenCallIds) {
  const list = []
  if (!state || !state.byOutputIndex) return list
  const emitted = new Set()
  for (const k of Object.keys(state.byOutputIndex)) {
    const e = state.byOutputIndex[k]
    if (!e || !e.name) continue
    const id = String(e.call_id || e.id || '').trim() || `call_flush_${k}_${Date.now()}`
    if (emitted.has(id)) continue
    emitted.add(id)
    if (seenCallIds && seenCallIds.has(id)) continue
    if (seenCallIds) seenCallIds.add(id)
    const args = e.arguments != null && String(e.arguments).length ? String(e.arguments) : '{}'
    list.push({
      id,
      type: 'function',
      function: { name: String(e.name), arguments: args }
    })
  }
  return list
}

/**
 * 解析 Responses SSE 中 data JSON，更新文本增量与工具调用。
 * @param {object} parsed
 * @param {ReturnType<typeof createResponsesStreamToolState>} [toolState] 传入时处理 output_item.added / function_call_arguments.delta
 * @returns {{ deltaText?: string, toolCalls?: Array<{id:string,type:string,function:{name:string,arguments:string}}>, done?: boolean }}
 */
function handleResponsesStreamEvent(parsed, toolState) {
  const out = {}
  if (!parsed || typeof parsed !== 'object') return out
  const t = parsed.type
  if (t === 'response.output_text.delta' && parsed.delta) {
    out.deltaText = String(parsed.delta)
    return out
  }
  // 与官方流一致：先 added 登记 output 槽位，再 delta 拼接 arguments
  if (toolState && t === 'response.output_item.added' && parsed.item) {
    const idx = parsed.output_index
    const it = parsed.item
    if (typeof idx === 'number' && it && it.type === 'function_call') {
      const cid = String(it.call_id || it.id || '').trim()
      const slot = {
        name: String(it.name || ''),
        call_id: cid,
        id: String(it.id || it.call_id || '').trim(),
        arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {})
      }
      toolState.byOutputIndex[idx] = slot
      const rowId = String(it.id || '').trim()
      if (rowId) toolState.byItemId[rowId] = slot
    }
    return out
  }
  if (toolState && t === 'response.function_call_arguments.delta') {
    const idx = parsed.output_index
    const delta = parsed.delta != null ? String(parsed.delta) : ''
    const itemRowId = String(parsed.item_id || '').trim()
    if (!delta) return out
    let slot = typeof idx === 'number' ? toolState.byOutputIndex[idx] : null
    if (!slot && itemRowId) slot = toolState.byItemId[itemRowId]
    if (!slot && itemRowId) {
      slot = { name: '', call_id: '', id: itemRowId, arguments: '' }
      toolState.byItemId[itemRowId] = slot
      if (typeof idx === 'number') toolState.byOutputIndex[idx] = slot
    }
    if (slot) slot.arguments = (slot.arguments || '') + delta
    return out
  }
  // 新版 Responses 流：工具调用常以该事件结束（未必再发带完整 item 的 output_item.done）
  if (t === 'response.function_call_arguments.done') {
    // 文档形态：整包在 `item` 内；部分线路仍可能发扁平字段（name / arguments / item_id）
    const it = parsed.item && typeof parsed.item === 'object' ? parsed.item : null
    if (it && it.type === 'function_call') {
      const args = typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {})
      out.toolCalls = [
        {
          id: String(it.call_id || it.id || '').trim() || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: String(it.name || ''),
            arguments: args || '{}'
          }
        }
      ]
      return out
    }
    const itemId = String(parsed.item_id || '').trim()
    const name = String(parsed.name || '')
    const args = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments ?? {})
    if (name) {
      out.toolCalls = [
        {
          id: itemId || `call_${Date.now()}`,
          type: 'function',
          function: { name, arguments: args || '{}' }
        }
      ]
    }
    return out
  }
  if (t === 'response.output_item.done' && parsed.item) {
    const it = parsed.item
    if (it.type === 'function_call') {
      const idx = parsed.output_index
      let args = typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {})
      if (
        toolState &&
        typeof idx === 'number' &&
        toolState.byOutputIndex[idx] &&
        (!args || args === '{}' || args === 'null')
      ) {
        const acc = toolState.byOutputIndex[idx].arguments
        if (acc && String(acc).trim()) args = String(acc)
      }
      out.toolCalls = [
        {
          id: String(it.call_id || it.id || '').trim() || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: String(it.name || ''),
            arguments: args || '{}'
          }
        }
      ]
    }
    return out
  }
  if (t === 'response.completed' && parsed.response && Array.isArray(parsed.response.output)) {
    const tc = []
    for (const o of parsed.response.output) {
      if (o && o.type === 'function_call') {
        tc.push({
          id: String(o.call_id || o.id || '').trim() || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: String(o.name || ''),
            arguments: typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments || {})
          }
        })
      }
    }
    if (tc.length) out.toolCalls = tc
    out.done = true
  }
  return out
}

/**
 * Codex / ChatGPT 订阅额度：走 ChatGPT 后端（与 OpenClaw `openai-codex` 一致），非 api.openai.com Platform。
 * @see https://github.com/openclaw/openclaw/blob/main/extensions/openai/openai-codex-provider.ts
 */
const OPENAI_CODEX_CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/**
 * 实际发起 Responses 形态请求的 URL（stream / 非流式共用）。
 * - **自动 + JWT + api.openai.com**：使用 ChatGPT Codex 后端（订阅额度），避免误打 Platform `/v1/responses`（缺 scope）再回退 chat 导致 429。
 * - **codex**：始终 ChatGPT Codex 后端。
 * - **responses**：显式 Platform：`{apiBaseUrl}/responses`。
 * @param {string} apiBaseUrl
 * @param {string} openAiWireMode - '' | 'auto' | 'chat' | 'responses' | 'codex'
 * @param {string} apiKey
 * @returns {URL}
 */
function getOpenAiResponsesPostUrl(apiBaseUrl, openAiWireMode, apiKey) {
  const mode = String(openAiWireMode || '').trim().toLowerCase()
  const key = String(apiKey || '')
  const base = String(apiBaseUrl || '').replace(/\/$/, '')
  const isJwt = key.startsWith('eyJ')
  const isOpenAiCom = /api\.openai\.com/i.test(base)

  if (mode === 'codex') {
    return new URL(OPENAI_CODEX_CHATGPT_RESPONSES_URL)
  }
  if (mode === 'responses') {
    if (!base) throw new Error('OpenAI Responses：需要配置 API Base URL')
    return new URL(`${base}/responses`)
  }
  if (mode === 'chat') {
    throw new Error('internal: getOpenAiResponsesPostUrl 不应在 chat 模式下调用')
  }
  // 自动：JWT + 官方 Platform 域名 → Codex 订阅后端（与 OpenClaw 行为对齐）
  if (isJwt && isOpenAiCom) {
    return new URL(OPENAI_CODEX_CHATGPT_RESPONSES_URL)
  }
  if (!base) throw new Error('OpenAI Responses：需要配置 API Base URL')
  return new URL(`${base}/responses`)
}

function isCodexChatgptResponsesUrl(urlLike) {
  const s = urlLike && typeof urlLike === 'object' && urlLike.href ? urlLike.href : String(urlLike || '')
  return /chatgpt\.com/i.test(s) && /\/codex\/responses/i.test(s)
}

/**
 * @param {string} apiBaseUrl
 * @param {string} openAiWireMode - '' | 'chat' | 'responses' | 'codex'
 * @param {string} apiKey
 */
function shouldUseOpenAiResponses(apiBaseUrl, openAiWireMode, apiKey) {
  const mode = String(openAiWireMode || '').trim().toLowerCase()
  if (mode === 'responses') return true
  if (mode === 'codex') return true
  if (mode === 'chat') return false
  const base = String(apiBaseUrl || '')
  const key = String(apiKey || '')
  if (!/api\.openai\.com/i.test(base)) return false
  return key.startsWith('eyJ')
}

/** 非流式 Responses 返回 JSON 中抽取助手文本 */
function extractResponsesOutputText(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.output_text === 'string') return data.output_text.trim()
  const out = data.output
  if (Array.isArray(out)) {
    const parts = []
    for (const item of out) {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && c.type === 'output_text' && c.text) parts.push(c.text)
        }
      }
    }
    if (parts.length) return parts.join('\n').trim()
  }
  return ''
}

module.exports = {
  buildResponsesRequestBody,
  createResponsesStreamToolState,
  flushResponsesStreamToolState,
  handleResponsesStreamEvent,
  getOpenAiResponsesPostUrl,
  isCodexChatgptResponsesUrl,
  OPENAI_CODEX_CHATGPT_RESPONSES_URL,
  shouldUseOpenAiResponses,
  normalizeTextContent,
  extractResponsesOutputText
}
