/**
 * 验证某供应商下某模型是否可用（最小 chat / messages / responses 请求）
 */

/** @param {object} deps */
function createVerifyProviderModel(deps) {
  const {
    https,
    http,
    URL,
    getResolvedAIConfig,
    getResolvedAIConfigForProvider
  } = deps

  async function verifyProviderModel(providerKey, modelId) {
    const config = (providerKey != null && String(providerKey).trim() !== '')
      ? getResolvedAIConfigForProvider(String(providerKey).trim())
      : getResolvedAIConfig()
    if (!config || !config.apiKey || !config.apiBaseUrl) {
      return { success: false, error: '未配置该供应商的 API Key 或供应商不存在' }
    }
    const baseUrl = (config.apiBaseUrl || '').replace(/\/$/, '')
    const model = String(modelId || config.defaultModel || '').trim()
    if (!model) return { success: false, error: '未指定模型 ID' }
    const isAnthropic = baseUrl.includes('anthropic.com')
    const anthropicBase = isAnthropic ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl

    const doPost = (url, body, headers) => new Promise((resolve, reject) => {
      const u = new URL(url)
      const isHttps = u.protocol === 'https:'
      const mod = isHttps ? https : http
      const postData = JSON.stringify(body)
      const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...headers }
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: h
      }, (res) => {
        let buf = ''
        res.on('data', c => buf += c)
        res.on('end', () => resolve({ status: res.statusCode, body: buf }))
      })
      req.on('error', reject)
      req.setTimeout(45000, () => { req.destroy(); reject(new Error('请求超时')) })
      req.write(postData)
      req.end()
    })

    try {
      if (isAnthropic) {
        const url = `${anthropicBase}/v1/messages`
        const r = await doPost(url, {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        }, { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' })
        if (r.status === 200) return { success: true }
        let err = r.body
        try { err = JSON.parse(r.body)?.error?.message || r.body } catch { /* ignore */ }
        return { success: false, error: `HTTP ${r.status}: ${(err || '').toString().slice(0, 200)}` }
      }
      const {
        shouldUseOpenAiResponses,
        buildResponsesRequestBody,
        getOpenAiResponsesPostUrl,
        isCodexChatgptResponsesUrl
      } = require('../ai/openai-responses')
      if (shouldUseOpenAiResponses(baseUrl, config.openAiWireMode, config.apiKey)) {
        const urlObj = getOpenAiResponsesPostUrl(baseUrl, config.openAiWireMode, config.apiKey)
        const url = urlObj.href
        const rb = buildResponsesRequestBody(
          [{ role: 'user', content: 'hi' }],
          { model, max_tokens: 16, stream: false, temperature: 0 },
          { codexChatgptBackend: isCodexChatgptResponsesUrl(urlObj) }
        )
        const r = await doPost(url, rb, { Authorization: `Bearer ${config.apiKey}` })
        if (r.status === 200) return { success: true }
        let err = r.body
        try { err = JSON.parse(r.body)?.error?.message || r.body } catch { /* ignore */ }
        const msgStr = `HTTP ${r.status}: ${(err || '').toString().slice(0, 200)}`
        return { success: false, error: msgStr }
      }
      const url = `${baseUrl}/chat/completions`
      const r = await doPost(url, {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      }, { 'Authorization': `Bearer ${config.apiKey}` })
      if (r.status === 200) return { success: true }
      let err = r.body
      try { err = JSON.parse(r.body)?.error?.message || r.body } catch { /* ignore */ }
      return { success: false, error: `HTTP ${r.status}: ${(err || '').toString().slice(0, 200)}` }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return { verifyProviderModel }
}

module.exports = { createVerifyProviderModel }
