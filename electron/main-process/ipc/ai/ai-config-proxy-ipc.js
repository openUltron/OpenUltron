/**
 * AI 配置、代理、Onboarding、备份前置、用量/账单、保存配置；七牛侧 commit message（Orchestrator）
 */
const { buildCozeCommitPrompt } = require('../../../coze/commit-message')

function registerAiConfigProxyIpc (deps) {
  const {
    registerChannel,
    app,
    store,
    BrowserWindow,
    aiConfigFile,
    getAIConfigLegacy,
    applyProxyEnvFromConfig,
    finalizeAiModelFields,
    path,
    fs,
    os,
    aiOrchestrator
  } = deps

  registerChannel('ai-generate-commit-message', async (event, { diff }) => {
    try {
      const config = aiOrchestrator.getConfig()
      if (!config.apiKey) return { success: false, message: '请先配置 AI API Key' }
      const prompt = buildCozeCommitPrompt(diff)
      const commitMessage = await aiOrchestrator.generateText({ prompt })
      return { success: true, commitMessage }
    } catch (error) {
      console.error('[AI] generate commit message failed:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-get-config', async () => {
    try {
      const data = aiConfigFile.readAIConfig(app, store)
      const legacy = aiConfigFile.toLegacyConfig(data)
      return {
        success: true,
        config: { ...legacy.config, modelPool: Array.isArray(data.modelPool) ? data.modelPool : [] },
        providerKeys: legacy.providerKeys,
        raw: legacy.raw
      }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-load-codex-openai-key', async () => {
    try {
      const {
        extractCredentialFromCodexAuthJson,
        extractCodexAccountId
      } = require('../../../ai/codex-auth-loader')
      const authPath = path.join(os.homedir(), '.codex', 'auth.json')
      if (!fs.existsSync(authPath)) {
        return {
          success: false,
          message:
            '未找到 ~/.codex/auth.json。请先在终端运行 Codex CLI 完成登录（浏览器会打开 auth.openai.com，回调由本机 localhost:1455 上的 Codex 接收并写入该文件）；OpenUltron 不会打开该授权页。'
        }
      }
      let parsed = null
      try {
        parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8'))
      } catch (e) {
        return { success: false, message: `Codex 授权文件解析失败: ${e.message || String(e)}` }
      }
      const { credential, credentialType: extractedType } = extractCredentialFromCodexAuthJson(parsed)
      if (!credential) {
        return {
          success: false,
          message:
            'auth.json 中未找到可用凭证（如 OPENAI_API_KEY 或 tokens.access_token）。若浏览器已授权但文件仍为空：请保持运行「codex login」的终端、确认 1455 端口未被占用，或重新执行一次 Codex 登录。'
        }
      }
      const accountId = extractCodexAccountId(parsed)
      const maskedAccountId = accountId
        ? `${accountId.slice(0, 4)}***${accountId.slice(-2)}`
        : ''
      const credentialType = extractedType || 'openai_api_key'
      return {
        success: true,
        apiKey: credential,
        credentialType,
        authMode: String(parsed?.auth_mode || '').trim(),
        accountId: maskedAccountId
      }
    } catch (error) {
      return { success: false, message: error.message || String(error) }
    }
  })

  registerChannel('proxy-get-config', async () => {
    try {
      const openultronConfig = require('../../../openultron-config')
      const data = openultronConfig.getProxy()
      return { success: true, data }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('proxy-save-config', async (event, payload) => {
    try {
      const openultronConfig = require('../../../openultron-config')
      openultronConfig.setProxy(payload || {})
      const applied = applyProxyEnvFromConfig()
      BrowserWindow.getAllWindows().forEach(win => {
        if (win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send('ai-config-updated')
        }
      })
      return { success: true, data: applied }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('ai-get-onboarding-status', async () => {
    try {
      const legacy = getAIConfigLegacy()
      const hasApiKey = (legacy.providerKeys && Object.values(legacy.providerKeys).some(k => k && String(k).trim())) ||
        (legacy.config && legacy.config.apiKey && String(legacy.config.apiKey).trim())
      const openultronConfig = require('../../../openultron-config')
      const feishu = openultronConfig.getFeishu()
      const hasFeishu = !!(feishu && feishu.app_id && String(feishu.app_id).trim())
      return { needsApiConfig: !hasApiKey, needsFeishuConfig: !hasFeishu }
    } catch (e) {
      return { needsApiConfig: true, needsFeishuConfig: true }
    }
  })

  registerChannel('ai-get-config-for-backup', async () => {
    try {
      const data = aiConfigFile.readAIConfig(app, store)
      return { success: true, data }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-restore-config-from-backup', async (event, payload) => {
    try {
      let raw
      if (payload && payload.config !== undefined && payload.providerKeys !== undefined) {
        raw = aiConfigFile.fromLegacyBackup(payload)
      } else if (payload && Array.isArray(payload.providers)) {
        raw = {
          defaultProvider: payload.defaultProvider,
          defaultModel: payload.defaultModel,
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          maxToolIterations: payload.maxToolIterations,
          providers: payload.providers
        }
      } else {
        return { success: false, message: '无效的 AI 配置备份数据' }
      }
      aiConfigFile.writeAIConfig(app, raw)
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-get-usage', async (event, { granularity, start, end, baseUrl: providerBaseUrl }) => {
    try {
      const legacy = getAIConfigLegacy()
      const baseUrl = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
      const apiKey = legacy.providerKeys[baseUrl] || legacy.config.apiKey || ''
      if (!apiKey) return { success: false, message: '未配置该提供商的 API Key' }
      if (!baseUrl.includes('qnaigc.com')) {
        return { success: false, message: '该提供商暂不支持用量查询', unsupported: true }
      }

      const params = new URLSearchParams({ granularity, start, end })
      const result = await new Promise((resolve, reject) => {
        const req = require('https').request({
          hostname: 'api.qnaigc.com',
          path: `/v2/stat/usage?${params}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` }
        }, (res) => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => {
            try { resolve({ status: res.statusCode, json: JSON.parse(data) }) }
            catch (e) { reject(e) }
          })
        })
        req.on('error', reject)
        req.end()
      })
      if (result.status !== 200) return { success: false, message: result.json?.message || '查询失败' }
      return { success: true, data: result.json.data || [] }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('ai-get-billing', async (event, { type, baseUrl: providerBaseUrl }) => {
    try {
      const legacy = getAIConfigLegacy()
      const baseUrl = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
      const apiKey = legacy.providerKeys[baseUrl] || legacy.config.apiKey || ''
      if (!apiKey) return { success: false, message: '未配置该提供商的 API Key' }
      if (!baseUrl.includes('qnaigc.com')) {
        return { success: false, message: '该提供商暂不支持预估账单', unsupported: true }
      }

      const result = await new Promise((resolve, reject) => {
        const req = require('https').request({
          hostname: 'api.qnaigc.com',
          path: `/v2/stat/usage/apikey/cost?type=${type}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` }
        }, (res) => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => {
            try { resolve({ status: res.statusCode, json: JSON.parse(data) }) }
            catch (e) { reject(e) }
          })
        })
        req.on('error', reject)
        req.end()
      })
      if (result.status !== 200) return { success: false, message: result.json?.message || '查询失败' }
      return { success: true, data: result.json.data || {} }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('ai-save-config', async (event, payload) => {
    try {
      const data = aiConfigFile.readAIConfig(app, store)
      if (payload.raw !== undefined) {
        const raw = payload.raw
        if (raw.defaultProvider !== undefined && String(raw.defaultProvider).trim() !== '') {
          data.defaultProvider = String(raw.defaultProvider).trim()
        }
        if (raw.defaultModel !== undefined) data.defaultModel = raw.defaultModel ?? data.defaultModel
        if (Array.isArray(raw.modelPool)) data.modelPool = raw.modelPool
        if (raw.modelBindings && typeof raw.modelBindings === 'object') data.modelBindings = raw.modelBindings
        if (raw.temperature !== undefined) data.temperature = raw.temperature ?? data.temperature
        if (raw.maxTokens !== undefined) data.maxTokens = raw.maxTokens ?? data.maxTokens
        if (raw.maxToolIterations !== undefined) data.maxToolIterations = raw.maxToolIterations ?? data.maxToolIterations
        if (Array.isArray(raw.providers)) data.providers = raw.providers
      } else {
        const config = payload
        data.defaultProvider = config.apiBaseUrl || data.defaultProvider
        data.defaultModel = config.defaultModel ?? data.defaultModel
        if (Array.isArray(config.modelPool)) data.modelPool = config.modelPool
        if (config.modelBindings && typeof config.modelBindings === 'object') data.modelBindings = config.modelBindings
        data.temperature = config.temperature ?? data.temperature
        data.maxTokens = config.maxTokens ?? data.maxTokens
        data.maxToolIterations = config.maxToolIterations ?? data.maxToolIterations
        const provider = data.providers.find(p => p.baseUrl === (config.apiBaseUrl || data.defaultProvider))
        if (provider) {
          if (config.apiKey !== undefined) provider.apiKey = config.apiKey || ''
        }
      }
      finalizeAiModelFields(data)
      aiConfigFile.writeAIConfig(app, data)
      const verify = aiConfigFile.readAIConfig(app, store)
      if (verify.defaultProvider !== data.defaultProvider) {
        console.error('[AI] 配置写入后校验失败: defaultProvider 未持久化', { expected: data.defaultProvider, got: verify.defaultProvider })
        return { success: false, message: '配置未正确写入，请检查应用数据目录权限' }
      }
      BrowserWindow.getAllWindows().forEach((win) => {
        if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('ai-config-updated')
      })
      return { success: true }
    } catch (error) {
      console.error('[AI] 保存配置失败:', error.message)
      return { success: false, message: error.message }
    }
  })
}

module.exports = { registerAiConfigProxyIpc }
