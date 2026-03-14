/**
 * 列出已配置的供应商及其可用模型，供 AI 在 sessions_spawn 时选择子 Agent 使用的供应商与模型。
 */

const definition = {
  description: '获取当前可用的 AI 供应商及其「测试过可用」的模型列表。用户问可用模型、供应商/模型配置时，可调用本工具并依据返回结果回答。仅包含：已配置 API Key 且至少有一个已验证模型的供应商。也可用于派生子 Agent（sessions_spawn）时选择 provider 与 model。',
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

  function inferModelTags(modelId) {
    const id = String(modelId || '').toLowerCase()
    const tags = []
    if (/\br1\b|o1[-\s]|o3[-\s]|thinking|reasoner|\breason\b|qwq|marco-o1/.test(id)) tags.push('reasoning')
    if (/vision|vl\b|visual|image|multimodal/.test(id)) tags.push('vision')
    if (/flash|mini|lite|tiny|fast|turbo|haiku|nano/.test(id)) tags.push('fast')
    if ((/plus|pro\b|max\b|large|opus|claude-3-5|claude-3-7/.test(id) || /gpt-4/.test(id) && !/mini/.test(id) || /sonnet/.test(id) && !/haiku/.test(id))) tags.push('powerful')
    if (/coder|code|dev|instruct(?=.*code)/.test(id)) tags.push('coding')
    if (tags.length === 0) tags.push('general')
    return tags
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
          models: models.map(m => ({
            id: m,
            tags: inferModelTags(m),
            is_default: m === globalDefaultModel,
            in_pool: globalPool.includes(m)
          }))
        })
      }
      return {
        success: true,
        providers: list,
        model_selection_guide: '根据任务选择模型：reasoning 适合复杂推理/数学/代码调试；fast 适合简单问答/格式转换/摘要；powerful 适合长文本/创作/复杂指令；coding 适合代码生成；vision 适合图片理解；general 为通用模型。优先选 in_pool:true 的模型，这些是经过验证的全局可用模型。'
      }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return { definition, execute }
}

module.exports = { definition, createListProvidersAndModelsTool }
