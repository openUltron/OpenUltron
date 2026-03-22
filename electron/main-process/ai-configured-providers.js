/**
 * 模型验证 IPC：已配置 API Key 的供应商列表、按模型 ID 排序
 */

/** @param {{ getAIConfigLegacy: () => object }} deps */
function createConfiguredProviderHelpers(deps) {
  const { getAIConfigLegacy } = deps

  function getConfiguredProvidersWithKey() {
    const legacy = getAIConfigLegacy()
    const providers = Array.isArray(legacy?.raw?.providers) ? legacy.raw.providers : []
    const providerKeys = legacy?.providerKeys || {}
    return providers
      .filter(p => p && p.baseUrl)
      .map(p => ({
        name: p.name || p.baseUrl,
        baseUrl: p.baseUrl,
        apiKey: String(providerKeys[p.baseUrl] || p.apiKey || '').trim()
      }))
      .filter(p => !!p.apiKey)
  }

  function orderProvidersForModel(modelId, providers) {
    const id = String(modelId || '').toLowerCase()
    const rank = (p) => {
      const url = String(p.baseUrl || '').toLowerCase()
      const name = String(p.name || '').toLowerCase()
      if (id.startsWith('claude-')) {
        if (url.includes('anthropic.com') || name.includes('anthropic') || name.includes('claude')) return 0
      }
      if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3')) {
        if (url.includes('openai.com') || name.includes('openai')) return 0
      }
      return 10
    }
    return [...providers].sort((a, b) => rank(a) - rank(b))
  }

  return { getConfiguredProvidersWithKey, orderProvidersForModel }
}

module.exports = { createConfiguredProviderHelpers }
