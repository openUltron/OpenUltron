/**
 * LLM 流式调用：从 Orchestrator 拆出，便于与 verify / 其它入口复用同一套语义。
 */

const { SSEParser } = require('./stream-parser')
const {
  buildResponsesRequestBody,
  createResponsesStreamToolState,
  flushResponsesStreamToolState,
  handleResponsesStreamEvent,
  getOpenAiResponsesPostUrl,
  isCodexChatgptResponsesUrl
} = require('./openai-responses')
const {
  OPENROUTER_DEFAULT_MAX_TOKENS,
  OPENROUTER_MAX_TOKENS_CAP,
  isOpenRouterBaseUrl
} = require('./openrouter-chat-constants')

function canSend(sender) {
  if (!sender) return false
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return false
  return true
}

/**
 * @param {object} deps
 * @param {(config: any) => { maxRetries: number, baseDelayMs: number, maxDelayMs: number }} deps.getRetryConfig
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} deps.sleep
 * @param {(err: any, attempt: number, maxRetries: number) => boolean} deps.shouldRetryError
 * @param {(attempt: number, baseDelayMs: number, maxDelayMs: number) => number} deps.getRetryDelayMs
 * @param {(url: URL, method: string, headers: Record<string, string>, signal: AbortSignal) => import('http').ClientRequest} deps.makeRequest
 * @param {(res: import('http').IncomingMessage, url: URL, cb: (err: Error) => void) => void} deps.readErrorBody
 * @param {(raw: string) => string} deps.normalizeToolArguments
 */
function streamOpenAiChatCompletions(deps, body, config, sender, sessionId, signal) {
  const { getRetryConfig, sleep, shouldRetryError, getRetryDelayMs, makeRequest, readErrorBody, normalizeToolArguments } = deps
  const { maxRetries, baseDelayMs, maxDelayMs } = getRetryConfig(config)

  const parseOpenRouterAffordMaxTokens = (message) => {
    const m = String(message || '').match(/can only afford\s+(\d+)/i)
    if (m && m[1]) {
      const afford = Number(m[1])
      if (Number.isFinite(afford) && afford > 0) return afford
    }
    return null
  }

  let openrouterCreditRetryUsed = false
  let openrouterMaxTokensForced = null

  const attemptOnce = (attempt) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('已取消')); return }

    const url = new URL(`${config.apiBaseUrl}/chat/completions`)
    const reqBody = { ...body, stream: true }
    if (isOpenRouterBaseUrl(config.apiBaseUrl)) {
      if (openrouterMaxTokensForced != null && openrouterMaxTokensForced > 0) {
        reqBody.max_tokens = Math.max(256, Math.min(openrouterMaxTokensForced, OPENROUTER_MAX_TOKENS_CAP))
      } else {
        const userCap = Number(config.maxTokens) || 0
        let mt = Number(reqBody.max_tokens) || 0
        if (userCap > 0) {
          mt = Math.min(userCap, OPENROUTER_MAX_TOKENS_CAP)
        } else if (!mt || mt <= 0) {
          mt = OPENROUTER_DEFAULT_MAX_TOKENS
        } else {
          mt = Math.min(mt, OPENROUTER_MAX_TOKENS_CAP)
        }
        reqBody.max_tokens = Math.max(256, mt)
      }
    } else {
      if (!reqBody.max_tokens) delete reqBody.max_tokens
    }
    if (Array.isArray(reqBody.tools) && reqBody.tools.length > 0) {
      if (reqBody.tool_choice === undefined) reqBody.tool_choice = 'auto'
      console.log('[AI] 请求带工具', reqBody.tools.length, '个, tool_choice:', reqBody.tool_choice)
    }
    const postData = JSON.stringify(reqBody)

    const onError = (err) => {
      if (!openrouterCreditRetryUsed &&
        isOpenRouterBaseUrl(config.apiBaseUrl) &&
        Number(err?.httpStatus) === 402
      ) {
        const afford = parseOpenRouterAffordMaxTokens(err?.message)
        if (afford != null) {
          openrouterCreditRetryUsed = true
          const reduced = Math.max(256, Math.floor(afford - 512))
          openrouterMaxTokensForced = reduced > 0 ? reduced : OPENROUTER_DEFAULT_MAX_TOKENS
          console.warn('[AI] OpenRouter 402 credits/max_tokens，自动重试（max_tokens 降低为）', openrouterMaxTokensForced)
          sleep(300, signal)
            .then(() => attemptOnce(attempt + 1).then(resolve).catch(reject))
            .catch(() => reject(err))
          return
        }
      }

      if (shouldRetryError(err, attempt, maxRetries)) {
        const delay = getRetryDelayMs(attempt, baseDelayMs, maxDelayMs)
        const target = `${url.hostname}${url.pathname}`
        const code = err?.code ? ` code=${String(err.code)}` : ''
        console.warn(`[AI] API 调用失败，将在 ${delay}ms 后重试 (${attempt + 1}/${maxRetries}) [${target}]${code}：`, err.message)
        sleep(delay, signal)
          .then(() => attemptOnce(attempt + 1).then(resolve, reject))
          .catch(() => reject(err))
        return
      }
      reject(err)
    }

    const req = makeRequest(url, 'POST', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Length': Buffer.byteLength(postData)
    }, signal)
    const STREAM_TIMEOUT_MS = 120000
    req.setTimeout(STREAM_TIMEOUT_MS, () => {
      if (!req.destroyed) req.destroy(new Error(`请求超时（${STREAM_TIMEOUT_MS / 1000} 秒内无响应）`))
    })

    const parser = new SSEParser()
    let fullContent = ''
    let toolCalls = []
    const toolCallBuffers = {}

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        readErrorBody(res, url, onError)
        return
      }
      res.setEncoding('utf-8')
      res.on('data', (chunk) => {
        if (signal.aborted) { req.destroy(); return }
        const events = parser.parse(chunk)
        for (const event of events) {
          if (signal.aborted) { req.destroy(); return }
          if (event.type === 'done' || event.type !== 'data') continue
          const choice = event.data.choices?.[0]
          if (!choice?.delta) continue

          if (choice.delta.content) {
            fullContent += choice.delta.content
            if (canSend(sender)) sender.send('ai-chat-token', { sessionId, token: choice.delta.content })
          }

          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallBuffers[idx]) {
                toolCallBuffers[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' }
              }
              if (tc.id) toolCallBuffers[idx].id = tc.id
              if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name
              if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments
            }
          }

          if (choice.finish_reason) {
            toolCalls = Object.values(toolCallBuffers).map((tc, idx) => ({
              id: (tc.id && String(tc.id).trim()) || `call_${idx}_${Date.now()}`,
              type: 'function',
              function: { name: tc.name || '', arguments: normalizeToolArguments(tc.arguments) }
            }))
          }
        }
      })
      res.on('end', () => {
        if (signal.aborted) {
          reject(new Error('已取消'))
          return
        }
        if (toolCalls.length === 0 && Object.keys(toolCallBuffers).length > 0) {
          toolCalls = Object.values(toolCallBuffers).map((tc, idx) => ({
            id: (tc.id && String(tc.id).trim()) || `call_${idx}_${Date.now()}`,
            type: 'function',
            function: { name: tc.name || '', arguments: normalizeToolArguments(tc.arguments) }
          }))
        }
        resolve({ content: fullContent, toolCalls })
      })
      res.on('error', onError)
    })

    req.on('error', onError)
    req.write(postData)
    req.end()
  })

  return attemptOnce(0)
}

function streamOpenAiResponses(deps, body, config, sender, sessionId, signal) {
  const { getRetryConfig, sleep, shouldRetryError, getRetryDelayMs, makeRequest, readErrorBody } = deps
  const { maxRetries, baseDelayMs, maxDelayMs } = getRetryConfig(config)
  const responsesPostUrl = getOpenAiResponsesPostUrl(config.apiBaseUrl, config.openAiWireMode, config.apiKey)

  const attemptOnce = (attempt) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('已取消')); return }

    const url = responsesPostUrl
    const reqBody = buildResponsesRequestBody(body.messages, body, {
      codexChatgptBackend: isCodexChatgptResponsesUrl(responsesPostUrl)
    })
    if (Array.isArray(reqBody.tools) && reqBody.tools.length > 0) {
      if (reqBody.tool_choice === undefined) reqBody.tool_choice = 'auto'
      console.log('[AI] Responses 请求带工具', reqBody.tools.length, '个, tool_choice:', reqBody.tool_choice)
    }
    const postData = JSON.stringify(reqBody)

    const onError = (err) => {
      if (shouldRetryError(err, attempt, maxRetries)) {
        const delay = getRetryDelayMs(attempt, baseDelayMs, maxDelayMs)
        const target = `${url.hostname}${url.pathname}`
        const code = err?.code ? ` code=${String(err.code)}` : ''
        console.warn(`[AI] Responses API 调用失败，将在 ${delay}ms 后重试 (${attempt + 1}/${maxRetries}) [${target}]${code}：`, err.message)
        sleep(delay, signal)
          .then(() => attemptOnce(attempt + 1).then(resolve, reject))
          .catch(() => reject(err))
        return
      }
      reject(err)
    }

    const req = makeRequest(url, 'POST', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Length': Buffer.byteLength(postData)
    }, signal)
    const STREAM_TIMEOUT_MS = 120000
    req.setTimeout(STREAM_TIMEOUT_MS, () => {
      if (!req.destroyed) req.destroy(new Error(`请求超时（${STREAM_TIMEOUT_MS / 1000} 秒内无响应）`))
    })

    const parser = new SSEParser()
    let fullContent = ''
    let toolCalls = []
    const seenToolIds = new Set()
    const responsesToolState = createResponsesStreamToolState()

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        readErrorBody(res, url, onError)
        return
      }
      res.setEncoding('utf-8')
      res.on('data', (chunk) => {
        if (signal.aborted) { req.destroy(); return }
        const events = parser.parse(chunk)
        for (const event of events) {
          if (signal.aborted) { req.destroy(); return }
          if (event.type === 'done') continue
          if (event.type !== 'data') continue
          const parsed = event.data
          if (!parsed || typeof parsed !== 'object') continue
          const h = handleResponsesStreamEvent(parsed, responsesToolState)
          if (h.deltaText) {
            fullContent += h.deltaText
            if (canSend(sender)) sender.send('ai-chat-token', { sessionId, token: h.deltaText })
          }
          if (h.toolCalls && h.toolCalls.length) {
            for (const tc of h.toolCalls) {
              const id = (tc.id != null && String(tc.id).trim())
                ? String(tc.id).trim()
                : `call_${toolCalls.length}_${Date.now()}`
              if (!seenToolIds.has(id)) {
                seenToolIds.add(id)
                toolCalls.push({ ...tc, id })
              }
            }
          }
        }
      })
      res.on('end', () => {
        if (signal.aborted) {
          reject(new Error('已取消'))
          return
        }
        for (const tc of flushResponsesStreamToolState(responsesToolState, seenToolIds)) {
          toolCalls.push(tc)
        }
        resolve({ content: fullContent, toolCalls })
      })
      res.on('error', onError)
    })

    req.on('error', onError)
    req.write(postData)
    req.end()
  })

  return attemptOnce(0)
}

/**
 * @param {object} converters
 * @param {(msgs: any[]) => { system: string, messages: any[] }} converters.toAnthropicMessages
 * @param {(tools: any[]) => any[]} converters.toAnthropicTools
 */
function streamAnthropicMessages(deps, converters, body, config, sender, sessionId, signal) {
  const { makeRequest, readErrorBody } = deps
  const { toAnthropicMessages, toAnthropicTools } = converters
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('已取消')); return }

    const baseUrl = config.apiBaseUrl.replace(/\/v1\/?$/, '')
    const url = new URL(`${baseUrl}/v1/messages`)

    const { system, messages: anthropicMessages } = toAnthropicMessages(body.messages)
    const anthropicTools = body.tools ? toAnthropicTools(body.tools) : undefined

    const reqBody = {
      model: body.model,
      max_tokens: body.max_tokens || 16384,
      temperature: body.temperature,
      stream: true,
      messages: anthropicMessages
    }
    if (system) reqBody.system = system
    if (anthropicTools && anthropicTools.length > 0) reqBody.tools = anthropicTools

    const postData = JSON.stringify(reqBody)

    const req = makeRequest(url, 'POST', {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(postData)
    }, signal)
    const STREAM_TIMEOUT_MS = 120000
    req.setTimeout(STREAM_TIMEOUT_MS, () => {
      if (!req.destroyed) req.destroy(new Error(`请求超时（${STREAM_TIMEOUT_MS / 1000} 秒内无响应）`))
    })

    const parser = new SSEParser()
    let fullContent = ''
    let toolCalls = []
    const contentBlocks = {}

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        readErrorBody(res, url, reject)
        return
      }
      res.setEncoding('utf-8')
      res.on('data', (chunk) => {
        if (signal.aborted) { req.destroy(); return }
        const events = parser.parse(chunk)
        for (const event of events) {
          if (signal.aborted) { req.destroy(); return }
          if (event.type !== 'data') continue
          const d = event.data
          if (!d || !d.type) continue

          switch (d.type) {
            case 'content_block_start': {
              const idx = d.index
              const block = d.content_block || {}
              contentBlocks[idx] = {
                type: block.type,
                id: block.id || '',
                name: block.name || '',
                text: block.text || '',
                input: ''
              }
              break
            }
            case 'content_block_delta': {
              const idx = d.index
              const delta = d.delta || {}
              const block = contentBlocks[idx]
              if (!block) break
              if (delta.type === 'text_delta' && delta.text) {
                block.text += delta.text
                fullContent += delta.text
                if (canSend(sender)) sender.send('ai-chat-token', { sessionId, token: delta.text })
              } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                block.input += delta.partial_json
              }
              break
            }
            case 'message_delta': {
              const stopReason = d.delta?.stop_reason
              if (stopReason === 'tool_use' || stopReason === 'end_turn') {
                for (const [, block] of Object.entries(contentBlocks)) {
                  if (block.type === 'tool_use') {
                    toolCalls.push({
                      id: block.id,
                      type: 'function',
                      function: {
                        name: block.name,
                        arguments: block.input
                      }
                    })
                  }
                }
              }
              break
            }
          }
        }
      })
      res.on('end', () => {
        if (signal.aborted) {
          reject(new Error('已取消'))
          return
        }
        if (toolCalls.length === 0) {
          for (const [, block] of Object.entries(contentBlocks)) {
            if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: block.input }
              })
            }
          }
        }
        resolve({ content: fullContent, toolCalls })
      })
      res.on('error', reject)
    })

    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

module.exports = {
  streamOpenAiChatCompletions,
  streamOpenAiResponses,
  streamAnthropicMessages
}
