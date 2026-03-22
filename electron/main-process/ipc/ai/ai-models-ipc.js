/**
 * 拉取 / 缓存模型列表（含 Anthropic 验证逻辑）
 */
function registerAiModelsIpc (deps) {
  const { registerChannel, getAIConfigLegacy, store, https, http } = deps
  registerChannel('ai-fetch-models', async (event, options) => {
    const { forceRefresh, providerBaseUrl } = options || {}
    try {
      const legacy = getAIConfigLegacy()
      const pickedBaseUrl = String(providerBaseUrl || '').trim()
      const baseUrl = pickedBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
      const apiKey = legacy.providerKeys[baseUrl] || legacy.config.apiKey
      if (!apiKey) {
        return { success: false, message: '未配置 API Key' }
      }
  
      // 未强制刷新时优先返回该供应商的缓存（按供应商分别缓存）
      const isQiniu = baseUrl.includes('qnaigc.com')
      if (!forceRefresh) {
        const byProvider = store.get('aiModelsByProvider', {})
        let cached = byProvider[baseUrl]
        if (!cached?.length && store.get('aiModelsProvider', '') === baseUrl) {
          cached = store.get('aiModels', [])
        }
        if (cached?.length) {
          return { success: true, models: cached, fromCache: true }
        }
      }
  
      // 辅助：发起 HTTP 请求
      const doRequest = (reqUrl, method, body, customHeaders) => new Promise((resolve, reject) => {
        const isHttps = reqUrl.protocol === 'https:'
        const httpModule = isHttps ? https : http
        const postData = body ? JSON.stringify(body) : null
        const headers = { ...(customHeaders || {}) }
        if (postData) {
          headers['Content-Type'] = 'application/json'
          headers['Content-Length'] = Buffer.byteLength(postData)
        }
        const req = httpModule.request({
          hostname: reqUrl.hostname,
          port: reqUrl.port || (isHttps ? 443 : 80),
          path: reqUrl.pathname + reqUrl.search,
          method,
          headers
        }, (res) => {
          let resBody = ''
          res.on('data', chunk => resBody += chunk)
          res.on('end', () => resolve({ status: res.statusCode, body: resBody }))
        })
        req.on('error', reject)
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
        if (postData) req.write(postData)
        req.end()
      })
  
      // 1) 获取当前提供商模型列表（OpenAI 兼容用 Bearer；Anthropic 用 x-api-key 在步骤 2 拉取）
      const isAnthropicProvider = baseUrl.includes('anthropic.com')
      let models = []
      if (!isAnthropicProvider) {
        const modelsUrl = new URL(`${baseUrl}/models`)
        const modelsRes = await doRequest(modelsUrl, 'GET', null, { 'Authorization': `Bearer ${apiKey}` })
        if (modelsRes.status === 200) {
          try {
            const data = JSON.parse(modelsRes.body)
            models = (data.data || []).map(m => ({
              id: m.id,
              name: m.id,
              owned_by: m.owned_by || '',
              input_modalities: m.input_modalities || m.modalities || [],
              source: 'provider'
            }))
          } catch { /* ignore */ }
        } else if (modelsRes.status === 401 || modelsRes.status === 403) {
          return { success: false, message: 'API Key 无效，认证失败' }
        }
      }
  
      // 2) 仅 Anthropic 供应商：拉取并验证 Claude 模型；七牛只使用其 /models 接口返回的列表
      let claudeDiag = '' // 诊断信息，返回给前端
      if (isAnthropicProvider) {
        try {
          // 仅七牛使用 24h 缓存；Anthropic 官方每次拉取
          const useClaudeCache = isQiniu && !forceRefresh
          const cachedClaude = useClaudeCache ? store.get('aiClaudeValidated', null) : null
          const claudeCacheTime = useClaudeCache ? store.get('aiClaudeValidatedTime', 0) : 0
          const claudeCacheAge = Date.now() - claudeCacheTime
  
          if (cachedClaude && cachedClaude.length > 0 && claudeCacheAge < 24 * 60 * 60 * 1000) {
            const existingIds = new Set(models.map(m => m.id))
            for (const cm of cachedClaude) {
              if (!existingIds.has(cm.id)) models.unshift(cm)
            }
            claudeDiag = `Claude: ${cachedClaude.length} 个（缓存）`
          } else {
            // 从 Anthropic 兼容端点获取模型列表
            const anthropicBase = baseUrl.replace(/\/v1\/?$/, '')
            const anthropicModelsUrl = new URL(`${anthropicBase}/v1/models`)
            let anthropicRes
            try {
              anthropicRes = await doRequest(anthropicModelsUrl, 'GET', null, {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
              })
            } catch (e) {
              anthropicRes = { status: 0, body: e.message }
            }
  
            let claudeCandidates = []
            if (anthropicRes.status === 200) {
              try {
                const data = JSON.parse(anthropicRes.body)
                claudeCandidates = (data.data || [])
                  .filter(m => m.id && m.id.startsWith('claude-'))
                  .map(m => {
                    const id = m.id
                    const alias = id.replace(/-\d{8}$/, '')
                    return {
                      alias: alias !== id ? alias : null,
                      dated: id,
                      name: m.display_name || alias || id,
                      owned_by: 'anthropic'
                    }
                  })
              } catch { /* ignore */ }
            }
            console.log(`[AI] Anthropic models API status=${anthropicRes.status}, candidates=${claudeCandidates.length}, body=${anthropicRes.body?.substring(0, 200)}`)
  
            // 若 API 列表不可用，回退到已知模型 ID 作为候选
            if (claudeCandidates.length === 0) {
              const knownClaude = [
                { alias: 'claude-opus-4-6', dated: 'claude-opus-4-6-20250603' },
                { alias: 'claude-sonnet-4-6', dated: 'claude-sonnet-4-6-20250603' },
                { alias: 'claude-opus-4', dated: 'claude-opus-4-20250514' },
                { alias: 'claude-sonnet-4', dated: 'claude-sonnet-4-20250514' },
                { alias: 'claude-3-7-sonnet', dated: 'claude-3-7-sonnet-20250219' },
                { alias: 'claude-3-5-sonnet', dated: 'claude-3-5-sonnet-20241022' },
                { alias: 'claude-3-5-haiku', dated: 'claude-3-5-haiku-20241022' },
                { alias: 'claude-3-opus', dated: 'claude-3-opus-20240229' },
                { alias: 'claude-3-haiku', dated: 'claude-3-haiku-20240307' },
              ]
              claudeCandidates = knownClaude.map(m => ({
                alias: m.alias, dated: m.dated, name: m.alias, owned_by: 'anthropic'
              }))
            }
  
            // 并发验证：同时尝试 x-api-key 和 Bearer 两种认证，别名和带日期两种 ID；遇 429 限流即停并保留已验证
            const validated = []
            const diagErrors = []
            let hitRateLimit = false
            const testClaudeModel = async (modelId, authHeader) => {
              const testUrl = new URL(`${anthropicBase}/v1/messages`)
              const r = await doRequest(testUrl, 'POST', {
                model: modelId,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }]
              }, {
                ...authHeader,
                'anthropic-version': '2023-06-01'
              })
              return r
            }
  
            const BATCH = 5
            for (let i = 0; i < claudeCandidates.length && !hitRateLimit; i += BATCH) {
              if (i > 0) await new Promise(r => setTimeout(r, 400))
              const batch = claudeCandidates.slice(i, i + BATCH)
              const results = await Promise.allSettled(batch.map(async (cm) => {
                const idsToTry = [cm.alias, cm.dated].filter(Boolean)
                const authMethods = [
                  { 'x-api-key': apiKey },
                  { 'Authorization': `Bearer ${apiKey}` }
                ]
  
                for (const tryId of idsToTry) {
                  for (const auth of authMethods) {
                    try {
                      const r = await testClaudeModel(tryId, auth)
                      if (r.status === 429) return { rateLimited: true }
                      if (r.status === 200) {
                        const authType = auth['x-api-key'] ? 'x-api-key' : 'Bearer'
                        console.log(`[AI] Claude ✓ ${tryId} (${authType})`)
                        return { id: tryId, name: cm.name || tryId, owned_by: cm.owned_by, input_modalities: ['text', 'image'], source: 'anthropic' }
                      }
                      if (diagErrors.length < 3) {
                        const authType = auth['x-api-key'] ? 'x-api-key' : 'Bearer'
                        let errMsg = ''
                        try { errMsg = JSON.parse(r.body)?.error?.message || r.body.substring(0, 100) } catch { errMsg = r.body?.substring(0, 100) }
                        diagErrors.push(`${tryId}(${authType}):${r.status} ${errMsg}`)
                      }
                    } catch { /* timeout etc */ }
                  }
                }
                return null
              }))
              for (const r of results) {
                if (r.status === 'fulfilled' && r.value) {
                  if (r.value.rateLimited) { hitRateLimit = true; break } else validated.push(r.value)
                }
              }
            }
            if (hitRateLimit) console.log('[AI] Claude 因 API 限流(429)停止，已保留已验证模型')
  
            console.log(`[AI] Claude validated: ${validated.length}/${claudeCandidates.length}`)
            if (diagErrors.length > 0) console.log(`[AI] Claude errors sample:`, diagErrors)
  
            // 仅七牛写入 Claude 缓存，避免覆盖为其他供应商数据
            if (isQiniu) {
              store.set('aiClaudeValidated', validated)
              store.set('aiClaudeValidatedTime', validated.length > 0 ? Date.now() : 0)
            }
  
            const existingIds = new Set(models.map(m => m.id))
            for (const cm of validated) {
              if (!existingIds.has(cm.id)) models.unshift(cm)
            }
  
            claudeDiag = `Claude: ${validated.length}/${claudeCandidates.length} 通过`
            if (hitRateLimit) claudeDiag += '（遇限流已停）'
            if (validated.length === 0 && diagErrors.length > 0) {
              claudeDiag += ` | ${diagErrors[0]}`
            }
          }
        } catch (e) {
          console.error('[AI] Anthropic models fetch error:', e.message)
          claudeDiag = `Claude 获取失败: ${e.message}`
        }
      }
  
      // 3) 验证 Key 对 chat 端点的有效性（用非 Claude 模型测试 OpenAI 格式）
      const nonClaudeModel = models.find(m => !m.id.startsWith('claude-')) || models[0]
      const verifyModelId = nonClaudeModel ? nonClaudeModel.id : 'gpt-3.5-turbo'
      const chatUrl = new URL(`${baseUrl}/chat/completions`)
      const verifyBody = {
        model: verifyModelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      }
      const chatRes = await doRequest(chatUrl, 'POST', verifyBody, { 'Authorization': `Bearer ${apiKey}` })
      let keyValid = true
      let keyWarning = ''
      if (chatRes.status === 401 || chatRes.status === 403) {
        keyValid = false
        try {
          const err = JSON.parse(chatRes.body)
          keyWarning = err.error?.message || 'API Key 认证失败，无法进行对话'
        } catch {
          keyWarning = 'API Key 认证失败，无法进行对话'
        }
      }
  
      // 按供应商缓存到 store
      const byProvider = store.get('aiModelsByProvider', {})
      byProvider[baseUrl] = models
      store.set('aiModelsByProvider', byProvider)
      store.set('aiModels', models)
      store.set('aiModelsProvider', baseUrl)
  
      // 仅将「测试过可用」的模型写入 aiModelsValidatedByProvider，供 list_providers_and_models 等只展示可用模型
      const validatedByProvider = store.get('aiModelsValidatedByProvider', {})
      let validatedList = []
      if (isAnthropicProvider) {
        validatedList = models.filter(m => m.source === 'anthropic')
      } else if (isQiniu) {
        validatedList = keyValid ? models : []
      } else {
        validatedList = keyValid ? models : []
      }
      if (validatedList.length > 0) {
        validatedByProvider[baseUrl] = validatedList
        store.set('aiModelsValidatedByProvider', validatedByProvider)
      }
  
      if (!keyValid) {
        return {
          success: true,
          models,
          keyInvalid: true,
          message: keyWarning
        }
      }
  
      return { success: true, models, claudeDiag }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
  
  // 获取缓存的模型列表（仅返回指定供应商的模型；不传则用当前默认供应商）
  registerChannel('ai-get-models', async (event, providerBaseUrl) => {
    const legacy = getAIConfigLegacy()
    const currentBase = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
    const byProvider = store.get('aiModelsByProvider', {})
    const cached = byProvider[currentBase]
    if (cached?.length) return { success: true, models: cached }
    if (store.get('aiModelsProvider', '') === currentBase) {
      return { success: true, models: store.get('aiModels', []) }
    }
    return { success: true, models: [] }
  })
}

module.exports = { registerAiModelsIpc }
