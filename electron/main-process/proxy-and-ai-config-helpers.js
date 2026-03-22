/**
 * 从 openultron.json 应用系统代理到 process.env；合并 legacy AI 配置片段（contextCompression / toolDefinitions）
 */

/** 合并 openultron.json 中的 ai.contextCompression 与代码默认 */
function mergeContextCompressionFromLegacy(legacy) {
  const { DEFAULT_CONFIG } = require('../ai/context-compressor')
  const raw = legacy && legacy.raw && legacy.raw.contextCompression
  return { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
}

/** 合并 ai.toolDefinitions（发给 LLM 前是否裁剪工具描述/schema） */
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

function applyProxyEnvFromConfig() {
  try {
    const openultronConfig = require('../openultron-config')
    const cfg = openultronConfig.getProxy()
    const keys = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']
    if (!cfg || !cfg.enabled) {
      for (const k of keys) delete process.env[k]
      return { enabled: false }
    }
    const httpProxy = String(cfg.http_proxy || '').trim()
    const httpsProxy = String(cfg.https_proxy || httpProxy).trim()
    const allProxy = String(cfg.all_proxy || '').trim()
    if (!httpProxy && !httpsProxy && !allProxy) {
      for (const k of keys) delete process.env[k]
      return { enabled: true, effective: false, reason: 'no_proxy_url' }
    }
    const noProxy = String(cfg.no_proxy || '127.0.0.1,localhost').trim()
    process.env.http_proxy = httpProxy
    process.env.https_proxy = httpsProxy
    process.env.all_proxy = allProxy
    process.env.HTTP_PROXY = httpProxy
    process.env.HTTPS_PROXY = httpsProxy
    process.env.ALL_PROXY = allProxy
    process.env.no_proxy = noProxy
    process.env.NO_PROXY = noProxy
    return {
      enabled: true,
      http_proxy: httpProxy,
      https_proxy: httpsProxy,
      all_proxy: allProxy,
      no_proxy: noProxy
    }
  } catch (e) {
    console.warn('[Proxy] 应用代理配置失败:', e.message)
    return { enabled: false, error: e.message }
  }
}

module.exports = {
  mergeContextCompressionFromLegacy,
  mergeToolDefinitionsFromLegacy,
  applyProxyEnvFromConfig
}
