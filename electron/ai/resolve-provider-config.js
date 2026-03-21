/**
 * 按供应商解析完整 AI 配置（与子 Agent / 模型绑定一致），供主会话按「所选模型」切换供应商。
 */
const { DEFAULT_CONFIG } = require('./context-compressor')

function mergeContextCompressionFromLegacy(legacy) {
  const raw = legacy && legacy.raw && legacy.raw.contextCompression
  return { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
}

function mergeToolDefinitionsFromLegacy(legacy) {
  const defaults = {
    slimMode: 'always',
    maxDescriptionChars: 240,
    stripSchemaExamples: true,
    maxPropertyDescriptionChars: 60
  }
  const raw = legacy && legacy.raw && legacy.raw.toolDefinitions
  return raw && typeof raw === 'object' ? { ...defaults, ...raw } : defaults
}

function getProviderOpenAiWireMode(legacy, baseUrl) {
  const p = legacy?.raw?.providers?.find((x) => x && x.baseUrl === baseUrl)
  const v = p?.openAiWireMode
  if (v === 'auto') return ''
  if (v === 'responses' || v === 'chat' || v === 'codex') return v
  return ''
}

/**
 * @param {string} providerKey - providers[].baseUrl 或 name
 * @param {{ legacy: object, store?: { get: (k: string, d?: object) => object } | null }} ctx
 */
function getResolvedAIConfigForProvider(providerKey, ctx) {
  if (!providerKey || String(providerKey).trim() === '') return null
  const key = String(providerKey).trim()
  const legacy = ctx && ctx.legacy
  if (!legacy) return null
  const raw = legacy?.raw
  const providers = raw?.providers
  if (!Array.isArray(providers) || providers.length === 0) return null
  const byUrl = new Map(providers.filter(p => p && p.baseUrl).map(p => [p.baseUrl, p]))
  const byName = new Map(providers.filter(p => p && p.name).map(p => [String(p.name).trim().toLowerCase(), p]))
  const p = byUrl.get(key) || byName.get(key.toLowerCase()) || null
  if (!p || !p.baseUrl) return null
  const apiKey = (legacy.providerKeys && legacy.providerKeys[p.baseUrl]) || p.apiKey || ''
  if (!apiKey || !String(apiKey).trim()) return null
  const bindings = legacy.raw?.modelBindings && typeof legacy.raw.modelBindings === 'object' ? legacy.raw.modelBindings : {}
  const globalPool = Array.isArray(legacy.raw?.modelPool)
    ? legacy.raw.modelPool.map(x => String(x || '').trim()).filter(Boolean)
    : []
  const globalDefaultModel = String((legacy.raw && legacy.raw.defaultModel) || (legacy.config && legacy.config.defaultModel) || '').trim()
  const defaultProvider = String(legacy.raw?.defaultProvider || '').trim()
  const providerPool = [...new Set(
    globalPool.filter((m) => {
      const bound = String(bindings[m] || defaultProvider).trim()
      return bound === p.baseUrl
    })
  )]
  const store = ctx && ctx.store
  const validatedByProvider = (store && typeof store.get === 'function')
    ? store.get('aiModelsValidatedByProvider', {})
    : {}
  const validated = validatedByProvider[p.baseUrl]
  let defaultModel = providerPool[0] || ''
  let fallbackModels = [...providerPool.slice(1)]
  if (Array.isArray(validated) && validated.length > 0) {
    const ids = validated
      .map(m => (m.id || m.name || '').trim())
      .filter(Boolean)
    if (!defaultModel && ids.length > 0) defaultModel = ids[0]
    const extra = ids.filter(id => id !== defaultModel && !fallbackModels.includes(id))
    fallbackModels = [...fallbackModels, ...extra]
  }
  if (!defaultModel) {
    const dmProvider = String(bindings[globalDefaultModel] || defaultProvider).trim()
    if (globalDefaultModel && dmProvider === p.baseUrl) defaultModel = globalDefaultModel
  }
  if (!defaultModel) defaultModel = globalDefaultModel || 'deepseek-v3'
  return {
    apiKey: String(apiKey).trim(),
    apiBaseUrl: p.baseUrl,
    defaultModel,
    openAiWireMode: getProviderOpenAiWireMode(legacy, p.baseUrl),
    modelPool: [defaultModel, ...fallbackModels].filter(Boolean),
    fallbackModels,
    modelBindings: bindings,
    temperature: (legacy.config && legacy.config.temperature) ?? 0,
    maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
    maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0,
    contextCompression: mergeContextCompressionFromLegacy(legacy),
    toolDefinitions: mergeToolDefinitionsFromLegacy(legacy)
  }
}

/**
 * 主会话：用户所选模型若与默认不同，合并该模型在 fallbackRoutes 中的供应商配置，或按 modelBindings 解析供应商（与 gateway IPC 传入的 getResolvedAIConfig 配套）。
 * @param {object} config - getResolvedAIConfig() 返回值
 * @param {string} requestedModel
 * @param {() => object} getLegacy - getAIConfigLegacy
 * @param {import('electron-store') | null} store
 */
function mergeModelSelectionIntoConfig(config, requestedModel, getLegacy, store) {
  const pick = requestedModel && String(requestedModel).trim()
  if (!pick || !config) return config
  if (pick === config.defaultModel) return config

  const legacy = typeof getLegacy === 'function' ? getLegacy() : null
  const bindings = config.modelBindings != null && typeof config.modelBindings === 'object'
    ? config.modelBindings
    : (legacy?.raw?.modelBindings && typeof legacy.raw.modelBindings === 'object' ? legacy.raw.modelBindings : {})

  const fr = Array.isArray(config.fallbackRoutes) ? config.fallbackRoutes : []
  const route = fr.find(r => r && r.model === pick)
  if (route && route.config) {
    return {
      ...config,
      ...route.config,
      defaultModel: pick,
      modelPool: config.modelPool,
      modelBindings: bindings,
      fallbackRoutes: config.fallbackRoutes,
      fallbackModels: config.fallbackModels,
    }
  }

  if (!bindings[pick] || !legacy) return config
  const byProvider = getResolvedAIConfigForProvider(bindings[pick], { legacy, store })
  if (!byProvider) return config
  return {
    ...config,
    ...byProvider,
    defaultModel: pick,
    modelPool: config.modelPool,
    modelBindings: bindings,
    fallbackRoutes: config.fallbackRoutes,
    fallbackModels: config.fallbackModels,
  }
}

module.exports = {
  getResolvedAIConfigForProvider,
  mergeModelSelectionIntoConfig,
  getProviderOpenAiWireMode,
  mergeContextCompressionFromLegacy,
  mergeToolDefinitionsFromLegacy
}
