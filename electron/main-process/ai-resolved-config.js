/**
 * 默认路由下的解析后 AI 配置（模型池、fallback、openAiWireMode 等）及按供应商解析
 */
const { getResolvedAIConfigForProvider: getResolvedAIConfigForProviderFromModule } = require('../ai/resolve-provider-config')

/** @param {object} deps */
function createAiResolvedConfig(deps) {
  const {
    getAIConfigLegacy,
    store,
    mergeContextCompressionFromLegacy,
    mergeToolDefinitionsFromLegacy
  } = deps

  function getProviderOpenAiWireMode(legacy, baseUrl) {
    const p = legacy?.raw?.providers?.find((x) => x && x.baseUrl === baseUrl)
    const v = p?.openAiWireMode
    if (v === 'auto') return ''
    if (v === 'responses' || v === 'chat' || v === 'codex') return v
    return ''
  }

  function getResolvedAIConfig() {
    const legacy = getAIConfigLegacy()
    const configuredBaseUrl = (legacy.config && legacy.config.apiBaseUrl) || 'https://api.qnaigc.com/v1'
    const bindings = legacy.raw?.modelBindings && typeof legacy.raw.modelBindings === 'object' ? legacy.raw.modelBindings : {}
    let defaultModel = (legacy.raw && legacy.raw.defaultModel) || (legacy.config && legacy.config.defaultModel) || 'deepseek-v3'
    const baseUrl = String(bindings[defaultModel] || configuredBaseUrl).trim() || configuredBaseUrl
    const globalPool = Array.isArray(legacy.raw?.modelPool)
      ? legacy.raw.modelPool.map(x => String(x || '').trim()).filter(Boolean)
      : []
    const validatedByProvider = store.get('aiModelsValidatedByProvider', {})
    const validated = validatedByProvider[baseUrl]
    let fallbackModels = [...new Set(globalPool.filter(id => id !== defaultModel))]
    if (Array.isArray(validated) && validated.length > 0) {
      const ids = validated
        .map(m => (m.id || m.name || '').trim())
        .filter(Boolean)
      if (!defaultModel && ids.length > 0) defaultModel = ids[0]
      const extra = ids.filter(id => id !== defaultModel && !fallbackModels.includes(id))
      fallbackModels = [...fallbackModels, ...extra]
    }
    const providerMap = new Map((legacy.raw?.providers || []).filter(p => p && p.baseUrl).map(p => [p.baseUrl, p]))
    const providerKeys = legacy.providerKeys || {}
    const routeModels = [defaultModel, ...fallbackModels].filter(Boolean)
    const fallbackRoutes = []
    for (const m of routeModels) {
      const routeProvider = String(bindings[m] || baseUrl || configuredBaseUrl).trim()
      const p = providerMap.get(routeProvider)
      const key = String((providerKeys[routeProvider] || p?.apiKey || '')).trim()
      if (!key) continue
      const route = {
        model: m,
        config: {
          apiKey: key,
          apiBaseUrl: routeProvider,
          defaultModel: m,
          openAiWireMode: getProviderOpenAiWireMode(legacy, routeProvider),
          temperature: (legacy.config && legacy.config.temperature) ?? 0,
          maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
          maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0,
          contextCompression: mergeContextCompressionFromLegacy(legacy),
          toolDefinitions: mergeToolDefinitionsFromLegacy(legacy)
        }
      }
      if (m !== defaultModel) fallbackRoutes.push(route)
    }
    const primaryApiKey = String(((legacy.providerKeys && legacy.providerKeys[baseUrl]) || providerMap.get(baseUrl)?.apiKey || '')).trim()
    const primary = routeModels.length > 0
      ? {
          model: defaultModel,
          config: fallbackRoutes.find(r => r.model === defaultModel)?.config || {
            apiKey: primaryApiKey || ((legacy.providerKeys && legacy.config && legacy.providerKeys[configuredBaseUrl]) || (legacy.config && legacy.config.apiKey) || ''),
            apiBaseUrl: baseUrl,
            defaultModel,
            openAiWireMode: getProviderOpenAiWireMode(legacy, baseUrl),
            temperature: (legacy.config && legacy.config.temperature) ?? 0,
            maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
            maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0,
            contextCompression: mergeContextCompressionFromLegacy(legacy),
            toolDefinitions: mergeToolDefinitionsFromLegacy(legacy)
          }
        }
      : null
    return {
      apiKey: primary?.config?.apiKey || ((legacy.providerKeys && legacy.config && legacy.providerKeys[legacy.config.apiBaseUrl]) || (legacy.config && legacy.config.apiKey) || ''),
      apiBaseUrl: baseUrl,
      defaultModel,
      openAiWireMode: getProviderOpenAiWireMode(legacy, baseUrl),
      modelPool: [defaultModel, ...fallbackModels].filter(Boolean),
      fallbackModels,
      fallbackRoutes,
      modelBindings: bindings,
      temperature: (legacy.config && legacy.config.temperature) ?? 0,
      maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
      maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0,
      contextCompression: mergeContextCompressionFromLegacy(legacy),
      toolDefinitions: mergeToolDefinitionsFromLegacy(legacy)
    }
  }

  function getResolvedAIConfigForProvider(providerKey) {
    return getResolvedAIConfigForProviderFromModule(providerKey, { legacy: getAIConfigLegacy(), store })
  }

  return {
    getResolvedAIConfig,
    getResolvedAIConfigForProvider
  }
}

module.exports = { createAiResolvedConfig }
