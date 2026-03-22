/** OpenRouter：若未显式限制 max_tokens，网关可能按模型默认/估算预留额度，易触发 credits 不足 */
const OPENROUTER_DEFAULT_MAX_TOKENS = 2048
/** 即使用户在设置里填得很大，也对 OpenRouter 封顶，避免误预留天文数字 */
const OPENROUTER_MAX_TOKENS_CAP = 16384

function isOpenRouterBaseUrl(apiBaseUrl) {
  return /openrouter\.ai/i.test(String(apiBaseUrl || ''))
}

/** 非流式 chat/completions：与流式路径一致的 OpenRouter max_tokens 策略 */
function applyNonStreamOpenAiChatMaxTokens(reqBody, apiBaseUrl, configMaxTokens) {
  if (isOpenRouterBaseUrl(apiBaseUrl)) {
    const userCap = Number(configMaxTokens) || 0
    const mt = userCap > 0 ? Math.min(userCap, OPENROUTER_MAX_TOKENS_CAP) : OPENROUTER_DEFAULT_MAX_TOKENS
    reqBody.max_tokens = Math.max(256, mt)
  } else if (configMaxTokens) {
    reqBody.max_tokens = configMaxTokens
  }
}

module.exports = {
  OPENROUTER_DEFAULT_MAX_TOKENS,
  OPENROUTER_MAX_TOKENS_CAP,
  isOpenRouterBaseUrl,
  applyNonStreamOpenAiChatMaxTokens
}
