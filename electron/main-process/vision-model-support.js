/**
 * 多模态（视觉）能力：结合 /models 元数据与 id 启发式
 */
function createVisionModelSupport(deps) {
  const { getAIConfigLegacy, store } = deps

  function isVisionModelId(modelId = '') {
    const m = String(modelId || '').toLowerCase()
    if (!m) return false
    const hits = [
      /gpt-5/,
      /gpt-4o/,
      /gpt-4\.1/,
      /gpt-4\.5/,
      /o1/,
      /o3/,
      /omni/,
      /claude-3/,
      /claude-4/,
      /gemini/,
      /qwen-?vl/,
      /qvq/,
      /vision/,
      /vl-/,
      /pixtral/,
      /llava/
    ]
    return hits.some((re) => re.test(m))
  }

  function modelSupportsVision({ model, providerBaseUrl } = {}) {
    const legacy = getAIConfigLegacy()
    const baseUrl = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
    const byProvider = store.get('aiModelsByProvider', {})
    const models = byProvider[baseUrl] || []
    const modelId = String(model || legacy.config.defaultModel || '').trim()
    const found = models.find((m) => String(m.id || '').trim() === modelId)
    if (found) {
      const inputModalities = found.input_modalities || found.inputModalities || found.modalities || []
      if (Array.isArray(inputModalities)) {
        const modalSet = new Set(inputModalities.map((x) => String(x).toLowerCase()))
        if (modalSet.has('image') || modalSet.has('vision') || modalSet.has('input_image')) return true
      }
    }
    return isVisionModelId(modelId)
  }

  return { isVisionModelId, modelSupportsVision }
}

module.exports = { createVisionModelSupport }
