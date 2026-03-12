// AI 配置控制工具：让 AI 可切换模型、修改 API Key、切换供应商（主会话配置；子任务用 sessions_spawn 指定 provider/model）

const definition = {
  description: '修改主会话的 AI 配置：切换供应商、切换模型、或设置某供应商的 API Key。切换前应先调用 verify_provider_model(provider=..., model=...) 确认该组合可用，再调用本工具，否则错配会导致主会话无法对话。为子任务指定模型请用 sessions_spawn，勿用本工具改主会话。switch_provider 会同时切换默认模型；switch_model 可同时传 provider 以连带切换供应商。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['switch_provider', 'switch_model', 'set_apikey'],
        description: 'switch_provider: 切换当前供应商（并同步默认模型）；switch_model: 切换当前模型，可选填 provider 则连带切换供应商；set_apikey: 设置某供应商的 API Key'
      },
      provider: {
        type: 'string',
        description: 'switch_provider 时必填；set_apikey 时必填；switch_model 时可选填，填则先切到该供应商再设模型，避免模型与供应商错配'
      },
      model: {
        type: 'string',
        description: 'switch_model 时必填。仅填 model 时必须是当前供应商下已验证的模型，否则报错；建议与 provider 同填以连带切换'
      },
      api_key: {
        type: 'string',
        description: 'API Key。set_apikey 时必填'
      }
    },
    required: ['action']
  }
}

function createAIConfigControlTool(getAIConfig, writeAIConfig, getValidatedModelsForBaseUrl) {
  if (!getAIConfig || !writeAIConfig) {
    return { definition, execute: async () => ({ success: false, error: '配置服务不可用' }) }
  }

  async function execute(args) {
    const { action, provider, model, api_key } = args || {}
    const legacy = getAIConfig()
    if (!legacy || !legacy.raw || !Array.isArray(legacy.raw.providers)) {
      return { success: false, error: '无法读取当前 AI 配置' }
    }
    const data = { ...legacy.raw }
    const normalizePool = (pool, defaultModel) => {
      const list = Array.isArray(pool) ? pool.map(x => String(x || '').trim()).filter(Boolean) : []
      const uniq = [...new Set(list)]
      const dm = String(defaultModel || '').trim()
      if (dm && !uniq.includes(dm)) uniq.unshift(dm)
      return uniq
    }
    data.modelPool = normalizePool(data.modelPool, data.defaultModel)
    const providers = data.providers.slice()

    const resolveProvider = (nameOrUrl) => {
      const byName = providers.find(p => p.name === nameOrUrl || (p.name && p.name.includes(nameOrUrl)))
      const byUrl = providers.find(p => p.baseUrl === nameOrUrl)
      return byName || byUrl
    }

    if (action === 'switch_provider') {
      if (!provider) return { success: false, error: '请指定要切换到的供应商名称或 baseUrl' }
      const p = resolveProvider(provider.trim())
      if (!p) return { success: false, error: `未找到供应商: ${provider}，可选: ${providers.map(x => x.name).join(', ')}` }
      data.defaultProvider = p.baseUrl
      data.modelPool = normalizePool(data.modelPool, data.defaultModel)
      writeAIConfig(data)
      return { success: true, message: `已切换到 ${p.name}，主模型保持为: ${data.defaultModel}` }
    }

    if (action === 'switch_model') {
      if (!model || !model.trim()) return { success: false, error: '请指定模型 ID' }
      const modelId = model.trim()
      const pool = normalizePool(data.modelPool, data.defaultModel)
      if (pool.length > 0 && !pool.includes(modelId)) {
        return { success: false, error: `模型 "${modelId}" 不在全局模型池中，请先在设置页加入模型池` }
      }
      const baseUrl = data.defaultProvider || (legacy.config && legacy.config.apiBaseUrl) || 'https://api.qnaigc.com/v1'
      if (provider != null && String(provider).trim() !== '') {
        const p = resolveProvider(String(provider).trim())
        if (!p) return { success: false, error: `未找到供应商: ${provider}` }
        data.defaultProvider = p.baseUrl
        data.defaultModel = modelId
        data.modelPool = normalizePool(data.modelPool, data.defaultModel)
        data.providers = providers
        writeAIConfig(data)
        return { success: true, message: `已切换到 ${p.name}，模型: ${modelId}` }
      }
      const validated = typeof getValidatedModelsForBaseUrl === 'function' ? getValidatedModelsForBaseUrl(baseUrl) : []
      const ids = new Set((validated || []).map(m => (m.id || m.name || '').trim()).filter(Boolean))
      if (ids.size > 0 && !ids.has(modelId)) {
        return {
          success: false,
          error: `模型 "${modelId}" 不属于当前供应商。请：1) 同时传 provider 以连带切换供应商再设该模型；或 2) 为子任务使用 sessions_spawn(provider=..., model=...) 指定，勿单独改主会话模型以免错配无法对话。`
        }
      }
      data.defaultModel = modelId
      data.modelPool = normalizePool(data.modelPool, data.defaultModel)
      data.providers = providers
      writeAIConfig(data)
      return { success: true, message: `已切换当前模型为: ${modelId}` }
    }

    if (action === 'set_apikey') {
      if (!provider) return { success: false, error: '请指定要设置 Key 的供应商' }
      if (api_key === undefined || api_key === null) return { success: false, error: '请提供 api_key 参数' }
      const p = resolveProvider(provider.trim())
      if (!p) return { success: false, error: `未找到供应商: ${provider}` }
      p.apiKey = String(api_key).trim()
      data.providers = providers
      writeAIConfig(data)
      return { success: true, message: `已为 ${p.name} 设置 API Key` }
    }

    return { success: false, error: `未知 action: ${action}` }
  }

  return { definition, execute }
}

module.exports = { createAIConfigControlTool }
