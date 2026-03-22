// AI 配置控制工具：主会话 switch_* / set_apikey；另支持读写入站 imCoordinator（get_im_coordinator / set_im_coordinator）。子任务模型用 sessions_spawn 指定。

const { normalizeModelPool, finalizeAiModelFields } = require('../ai-config-normalize')

const definition = {
  description: '修改主会话的 AI 配置（switch_* / set_apikey），或读写入站协调 Agent 的 imCoordinator 开关（get_im_coordinator / set_im_coordinator，写入 openultron.json，需用户确认）。切换供应商/模型前建议先调用 verify_provider_model。为子任务指定模型请用 sessions_spawn，勿用 switch_* 改主会话以免错配。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['switch_provider', 'switch_model', 'set_apikey', 'get_im_coordinator', 'set_im_coordinator'],
        description: 'switch_provider / switch_model / set_apikey：主会话 AI；get_im_coordinator：读取 imCoordinator；set_im_coordinator：设置 include_sessions_spawn（飞书/TG/钉钉入站协调是否暴露 sessions_spawn）'
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
      },
      include_sessions_spawn: {
        type: 'boolean',
        description: 'set_im_coordinator 时必填：是否允许入站协调 Agent 使用 sessions_spawn'
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
    const { action, provider, model, api_key, include_sessions_spawn } = args || {}

    if (action === 'get_im_coordinator') {
      try {
        const oc = require('../../openultron-config')
        return { success: true, ...oc.getImCoordinator() }
      } catch (e) {
        return { success: false, error: e.message || String(e) }
      }
    }

    if (action === 'set_im_coordinator') {
      if (include_sessions_spawn === undefined || include_sessions_spawn === null) {
        return { success: false, error: 'set_im_coordinator 需要参数 include_sessions_spawn（布尔）' }
      }
      try {
        const oc = require('../../openultron-config')
        const on = !!include_sessions_spawn
        oc.setImCoordinator({ include_sessions_spawn: on })
        return {
          success: true,
          message: `已设置 imCoordinator.include_sessions_spawn=${on}`,
          ...oc.getImCoordinator()
        }
      } catch (e) {
        return { success: false, error: e.message || String(e) }
      }
    }

    const legacy = getAIConfig()
    if (!legacy || !legacy.raw || !Array.isArray(legacy.raw.providers)) {
      return { success: false, error: '无法读取当前 AI 配置' }
    }
    const data = { ...legacy.raw }
    data.modelPool = normalizeModelPool(data.modelPool, data.defaultModel)
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
      finalizeAiModelFields(data)
      writeAIConfig(data)
      return { success: true, message: `已切换到 ${p.name}，主模型保持为: ${data.defaultModel}` }
    }

    if (action === 'switch_model') {
      if (!model || !model.trim()) return { success: false, error: '请指定模型 ID' }
      const modelId = model.trim()
      const pool = normalizeModelPool(data.modelPool, data.defaultModel)
      if (pool.length > 0 && !pool.includes(modelId)) {
        return { success: false, error: `模型 "${modelId}" 不在全局模型池中，请先在设置页加入模型池` }
      }
      const baseUrl = data.defaultProvider || (legacy.config && legacy.config.apiBaseUrl) || 'https://api.qnaigc.com/v1'
      if (provider != null && String(provider).trim() !== '') {
        const p = resolveProvider(String(provider).trim())
        if (!p) return { success: false, error: `未找到供应商: ${provider}` }
        data.defaultProvider = p.baseUrl
        data.defaultModel = modelId
        data.providers = providers
        finalizeAiModelFields(data)
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
      data.providers = providers
      finalizeAiModelFields(data)
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
      finalizeAiModelFields(data)
      writeAIConfig(data)
      return { success: true, message: `已为 ${p.name} 设置 API Key` }
    }

    return { success: false, error: `未知 action: ${action}` }
  }

  return { definition, execute }
}

module.exports = { createAIConfigControlTool }
