/**
 * AI 配置中模型池与模型绑定的规范化（与 openultron.json 写入路径一致，避免 main / 工具 / IPC 三处漂移）
 */

/**
 * @param {unknown} pool
 * @param {string} defaultModel
 * @returns {string[]}
 */
function normalizeModelPool (pool, defaultModel) {
  const list = Array.isArray(pool) ? pool.map(x => String(x || '').trim()).filter(Boolean) : []
  const uniq = [...new Set(list)]
  const dm = String(defaultModel || '').trim()
  if (dm && !uniq.includes(dm)) uniq.unshift(dm)
  return uniq
}

/**
 * @param {unknown} bindings
 * @param {Array<{ baseUrl?: string }>} providers
 * @param {string[]} pool
 * @param {string} fallbackProvider
 * @returns {Record<string, string>}
 */
function normalizeModelBindings (bindings, providers, pool, fallbackProvider) {
  const allow = new Set((providers || []).map(p => String(p?.baseUrl || '').trim()).filter(Boolean))
  const out = {}
  const src = bindings && typeof bindings === 'object' ? bindings : {}
  for (const [k, v] of Object.entries(src)) {
    const model = String(k || '').trim()
    const provider = String(v || '').trim()
    if (!model || !provider) continue
    if (allow.size > 0 && !allow.has(provider)) continue
    out[model] = provider
  }
  const fb = String(fallbackProvider || '').trim()
  for (const m of pool || []) {
    const model = String(m || '').trim()
    if (!model) continue
    if (!out[model] && fb) out[model] = fb
  }
  return out
}

/**
 * 写入磁盘前统一刷新 modelPool / modelBindings（与 registerChannel ai-save-config 行为对齐）
 * @param {object} data - 可变配置对象（含 defaultModel、providers 等）
 */
function finalizeAiModelFields (data) {
  if (!data || typeof data !== 'object') return data
  data.modelPool = normalizeModelPool(data.modelPool, data.defaultModel)
  data.modelBindings = normalizeModelBindings(
    data.modelBindings,
    data.providers,
    data.modelPool,
    data.defaultProvider
  )
  return data
}

module.exports = {
  normalizeModelPool,
  normalizeModelBindings,
  finalizeAiModelFields
}
