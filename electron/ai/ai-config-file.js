// AI 配置来自 <appRoot>/openultron.json 的 ai 字段（与 feishu 合并存储）

const openultronConfig = require('../openultron-config')
const DEFAULT_PROVIDERS = JSON.parse(JSON.stringify(openultronConfig.DEFAULT_AI.providers))

function getConfigPath(app) {
  return openultronConfig.getPath()
}

function getDefaultConfig() {
  return { ...openultronConfig.DEFAULT_AI, providers: openultronConfig.DEFAULT_AI.providers.map(p => ({ ...p })) }
}

function ensureAIConfigFile(app, store) {
  openultronConfig.getAI()
}

function readAIConfig(app, store) {
  return openultronConfig.getAI()
}

function writeAIConfig(app, data) {
  openultronConfig.writeAI(data)
}

function toLegacyConfig(data) {
  const baseUrl = data.defaultProvider || 'https://api.qnaigc.com/v1'
  const provider = data.providers?.find(p => p.baseUrl === baseUrl)
  const apiKey = provider?.apiKey || ''
  const defaultModel = data.defaultModel || 'deepseek-v3'
  const providerKeys = {}
  for (const p of data.providers || []) {
    if (p.baseUrl && p.apiKey) providerKeys[p.baseUrl] = p.apiKey
  }
  return {
    config: {
      apiKey,
      apiBaseUrl: baseUrl,
      defaultModel,
      temperature: data.temperature ?? 0,
      maxTokens: data.maxTokens ?? 0,
      maxToolIterations: data.maxToolIterations ?? 0,
    },
    providerKeys,
    raw: { ...data },
  }
}

function fromLegacyBackup(legacy) {
  const config = legacy.config || {}
  const providerKeys = legacy.providerKeys || {}
  const baseUrl = config.apiBaseUrl || 'https://api.qnaigc.com/v1'
  const providers = DEFAULT_PROVIDERS.map(p => ({ ...p }))
  for (const p of providers) {
    if (providerKeys[p.baseUrl] !== undefined) p.apiKey = providerKeys[p.baseUrl] || ''
    else if (p.baseUrl === baseUrl && config.apiKey) p.apiKey = config.apiKey
  }
  return {
    defaultProvider: baseUrl,
    defaultModel: config.defaultModel || 'deepseek-v3',
    modelPool: [config.defaultModel || 'deepseek-v3'],
    modelBindings: {},
    temperature: config.temperature ?? 0,
    maxTokens: config.maxTokens ?? 0,
    maxToolIterations: config.maxToolIterations ?? 0,
    providers,
  }
}

module.exports = {
  getConfigPath,
  getDefaultConfig,
  DEFAULT_PROVIDERS,
  ensureAIConfigFile,
  readAIConfig,
  writeAIConfig,
  toLegacyConfig,
  fromLegacyBackup,
}
