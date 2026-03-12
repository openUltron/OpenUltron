/**
 * 返回当前全局配置的模型信息（主模型 + 模型池 + 绑定关系），
 * 不按供应商展开，避免回答“可用模型”时掺入无关供应商维度。
 */

const definition = {
  description: '获取当前全局配置的模型信息：主模型(default_model)、模型池(model_pool)、模型与供应商绑定(model_bindings)。当用户问“你现在用什么模型”“你可以使用哪些模型”且未明确要求按供应商展开时，优先调用本工具并严格按返回结果回答。',
  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
}

function createListConfiguredModelsTool(getAIConfigLegacy) {
  if (typeof getAIConfigLegacy !== 'function') {
    return {
      definition,
      execute: async () => ({ success: false, error: 'list_configured_models 未配置' })
    }
  }

  async function execute() {
    try {
      const legacy = getAIConfigLegacy()
      const raw = legacy?.raw || {}
      const providers = Array.isArray(raw.providers) ? raw.providers : []
      const providerMap = new Map(
        providers
          .filter(p => p && p.baseUrl)
          .map(p => [String(p.baseUrl).trim(), p.name || p.baseUrl])
      )
      const defaultModel = String(raw.defaultModel || legacy?.config?.defaultModel || '').trim()
      const modelPool = Array.isArray(raw.modelPool)
        ? [...new Set(raw.modelPool.map(m => String(m || '').trim()).filter(Boolean))]
        : []
      if (defaultModel && !modelPool.includes(defaultModel)) modelPool.unshift(defaultModel)
      const bindings = raw.modelBindings && typeof raw.modelBindings === 'object' ? raw.modelBindings : {}

      const modelBindings = modelPool.map((model) => {
        const baseUrl = String(bindings[model] || raw.defaultProvider || legacy?.config?.apiBaseUrl || '').trim()
        return {
          model,
          provider_base_url: baseUrl,
          provider_name: providerMap.get(baseUrl) || baseUrl || ''
        }
      })

      return {
        success: true,
        default_model: defaultModel,
        model_pool: modelPool,
        model_bindings: modelBindings
      }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return { definition, execute }
}

module.exports = { definition, createListConfiguredModelsTool }

