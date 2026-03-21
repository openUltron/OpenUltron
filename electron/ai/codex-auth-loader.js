/**
 * 从 Codex CLI 写入的 ~/.codex/auth.json 提取可供 OpenAI 兼容 API 使用的凭证。
 * Codex 各版本字段可能不同，此处做多路径兼容。
 */

function trimStr(v) {
  return String(v == null ? '' : v).trim()
}

/**
 * @param {unknown} parsed
 * @returns {{ credential: string, credentialType: 'openai_api_key' | 'chatgpt_access_token' | '' }}
 */
function extractCredentialFromCodexAuthJson(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { credential: '', credentialType: '' }
  }

  const apiKey = trimStr(
    parsed.OPENAI_API_KEY ?? parsed.openai_api_key ?? parsed.openaiApiKey
  )
  if (apiKey) {
    return { credential: apiKey, credentialType: 'openai_api_key' }
  }

  const genericKey = trimStr(parsed.api_key ?? parsed.apiKey)
  if (genericKey && /^sk-/i.test(genericKey)) {
    return { credential: genericKey, credentialType: 'openai_api_key' }
  }

  const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {}
  const accessFromTokens = trimStr(tokens.access_token ?? tokens.accessToken)
  if (accessFromTokens) {
    return { credential: accessFromTokens, credentialType: 'chatgpt_access_token' }
  }

  const session = parsed.session && typeof parsed.session === 'object' ? parsed.session : {}
  const accessFromSession = trimStr(session.access_token ?? session.accessToken)
  if (accessFromSession) {
    return { credential: accessFromSession, credentialType: 'chatgpt_access_token' }
  }

  const credentials =
    parsed.credentials && typeof parsed.credentials === 'object' ? parsed.credentials : {}
  const accessFromCreds = trimStr(credentials.access_token ?? credentials.accessToken)
  if (accessFromCreds) {
    return { credential: accessFromCreds, credentialType: 'chatgpt_access_token' }
  }

  const topAccess = trimStr(parsed.access_token ?? parsed.accessToken)
  if (topAccess) {
    return { credential: topAccess, credentialType: 'chatgpt_access_token' }
  }

  return { credential: '', credentialType: '' }
}

/**
 * @param {unknown} parsed
 * @returns {string}
 */
function extractCodexAccountId(parsed) {
  if (!parsed || typeof parsed !== 'object') return ''
  const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {}
  return trimStr(tokens.account_id ?? tokens.accountId)
}

module.exports = {
  extractCredentialFromCodexAuthJson,
  extractCodexAccountId
}
