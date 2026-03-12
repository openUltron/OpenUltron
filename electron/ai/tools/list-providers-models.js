/**
 * 列出已配置的供应商及其可用模型，供 AI 在 sessions_spawn 时选择子 Agent 使用的供应商与模型。
 */

const definition = {
  description: '获取当前可用的 AI 供应商及其「测试过可用」的模型列表。当用户问「有哪些模型可以用」「能使用哪些模型」「配置了哪些供应商/模型」时必须调用本工具并依据返回结果逐项列出，不得只回复需配置 API Key。仅包含：已配置 API Key 且至少有一个已验证模型的供应商。也可用于派生子 Agent（sessions_spawn）时选择 provider 与 model。',
  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
}

function createListProvidersAndModelsTool(store, getAIConfigLegacy) {
  if (typeof getAIConfigLegacy !== 'function') {
    return {
      definition,
      execute: async () => ({ success: false, error: 'list_providers_and_models 未配置' })
    }
  }

  async function execute() {
    try {
      const legacy = getAIConfigLegacy()
      const raw = legacy?.raw
      const providers = raw?.providers
      if (!Array.isArray(providers) || providers.length === 0) {
        return { success: true, providers: [] }
      }
      const providerKeys = legacy.providerKeys || {}
      // 只使用「测试过可用」的模型列表（拉取时做过 chat 验证或逐模型验证的才写入此处）
      const validatedByProvider = (store && typeof store.get === 'function') ? store.get('aiModelsValidatedByProvider', {}) : {}
      const list = []
      const globalDefaultModel = String(raw?.defaultModel || '').trim()
      const globalPool = Array.isArray(raw?.modelPool)
        ? raw.modelPool.map(m => String(m || '').trim()).filter(Boolean)
        : []
      const bindings = raw?.modelBindings && typeof raw.modelBindings === 'object' ? raw.modelBindings : {}
      for (const p of providers) {
        if (!p || !p.baseUrl) continue
        const apiKey = providerKeys[p.baseUrl] || p.apiKey || ''
        if (!apiKey || String(apiKey).trim() === '') continue
        const validated = validatedByProvider[p.baseUrl]
        const validatedModels = Array.isArray(validated) ? validated.map(m => m.id || m.name || '').filter(Boolean) : []
        const selectedInPool = globalPool.filter(m => (bindings[m] || raw?.defaultProvider || '') === p.baseUrl)
        const models = [...new Set([...selectedInPool, ...validatedModels])]
        if (models.length === 0) continue
        list.push({
          name: p.name || p.baseUrl,
          base_url: p.baseUrl,
          default_model: globalDefaultModel,
          global_model_pool: globalPool,
          selected_in_pool: selectedInPool,
          models
        })
      }
      return { success: true, providers: list }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return { definition, execute }
}

module.exports = { definition, createListProvidersAndModelsTool }
