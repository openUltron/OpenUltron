/**
 * 设置页 / 模型池：校验模型在供应商下是否可用
 */
function registerAiVerifyModelIpc (deps) {
  const {
    registerChannel,
    verifyProviderModel,
    orderProvidersForModel,
    getConfiguredProvidersWithKey
  } = deps

  registerChannel('ai-verify-model', async (event, { model, provider } = {}) => {
    const modelId = String(model || '').trim()
    if (!modelId) return { success: false, error: '未指定模型 ID' }
    if (provider != null && String(provider).trim() !== '') {
      const r = await verifyProviderModel(provider, modelId)
      return { ...r, provider: String(provider).trim() }
    }
    const all = orderProvidersForModel(modelId, getConfiguredProvidersWithKey())
    if (all.length === 0) return { success: false, error: '未配置任何可用供应商 API Key' }
    let lastErr = ''
    for (const p of all) {
      // eslint-disable-next-line no-await-in-loop
      const r = await verifyProviderModel(p.baseUrl, modelId)
      if (r?.success) return { success: true, provider: p.baseUrl, providerName: p.name, model: modelId }
      lastErr = r?.error || ''
    }
    return { success: false, error: lastErr || `模型 ${modelId} 在已配置供应商中不可用` }
  })
}

module.exports = { registerAiVerifyModelIpc }
