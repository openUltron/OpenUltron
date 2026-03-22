const { shouldUseOpenAiResponses } = require('./openai-responses')

const LLM_TRANSPORT = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI_RESPONSES: 'openai-responses',
  OPENAI_CHAT: 'openai-chat'
})

/**
 * 流式/摘要等「选哪条 HTTP 线路」的统一判定（与 verify-provider-model 对齐）
 * @param {{ apiBaseUrl?: string, openAiWireMode?: string, apiKey?: string }} config
 * @param {boolean} isAnthropicModel
 */
function resolveLlmTransport(config, isAnthropicModel) {
  if (isAnthropicModel) return LLM_TRANSPORT.ANTHROPIC
  if (shouldUseOpenAiResponses(config.apiBaseUrl, config.openAiWireMode, config.apiKey)) {
    return LLM_TRANSPORT.OPENAI_RESPONSES
  }
  return LLM_TRANSPORT.OPENAI_CHAT
}

module.exports = { LLM_TRANSPORT, resolveLlmTransport }
