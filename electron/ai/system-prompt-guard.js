/**
 * 子会话 system_prompt 输入清洗。
 * 目标：限制长度、去噪、阻断常见越权注入短语，并追加来源签名。
 */

const MAX_SYSTEM_PROMPT_LENGTH = 5000

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|override|bypass)\b\s+.*\b(previous|prior|earlier|above|all|everything)\b\s+.*\b(instruction|instructions|rule|rules|constraint|constraints|prompt|directive)\b/i,
  /(你|您|请)?\s*(必须|应该|请)?\s*(忽略|无视|绕过|跳过)\s+(上面|之前|前面|先前|原有|既有)\s*(的?)\s*(所有|全部|既有)?\s*(约束|规则|指令|提示|系统)\b/i,
  /(ignore|ignore all|bypass|override)\s*[:：]?\s*(previous|prior|above|earlier|existing)\s+(instructions?|constraints?|rules?)/i
]

function sanitizeSource(source) {
  const raw = String(source || '').trim()
  if (!raw) return 'unknown-source'
  return raw.replace(/[^a-z0-9._:-]/gi, '_').slice(0, 80)
}

function looksLikeInjectedPrompt(text) {
  const target = String(text || '').replace(/\r/g, '').trim()
  for (const p of INJECTION_PATTERNS) {
    if (p.test(target)) return true
  }
  return false
}

function sanitizeSystemPrompt(text) {
  return String(text || '').
    replace(/\r/g, '').
    replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').
    trim()
}

/**
 * @param {unknown} text 原始 system prompt
 * @param {object} opts
 * @param {string} [opts.source]
 * @param {number} [opts.maxLength=MAX_SYSTEM_PROMPT_LENGTH]
 * @returns {{ ok: boolean, value?: string, error?: string, truncated?: boolean }}
 */
function sanitizeInjectedSystemPrompt(text, opts = {}) {
  const maxLength = Number.isFinite(Number(opts.maxLength)) && Number(opts.maxLength) > 0 ? Number(opts.maxLength) : MAX_SYSTEM_PROMPT_LENGTH
  const source = sanitizeSource(opts.source)
  if (text == null) return { ok: true }
  if (typeof text !== 'string') {
    return { ok: false, error: 'system_prompt 必须是字符串' }
  }
  let normalized = sanitizeSystemPrompt(text)
  if (!normalized) return { ok: true }

  if (looksLikeInjectedPrompt(normalized)) {
    return {
      ok: false,
      error: 'system_prompt 中检测到潜在越权短语（如“忽略既有规则”“override previous instructions”），已拦截。请移除这类词句后重试。'
    }
  }

  let truncated = false
  if (normalized.length > maxLength) {
    normalized = `${normalized.slice(0, maxLength)}\n\n[已截断：系统提示过长，超过上限 ${maxLength} 字]`
    truncated = true
  }

  const stamped = `[子系统注入提示][source=${source}]\n${normalized}`
  return { ok: true, value: stamped, truncated }
}

module.exports = {
  sanitizeInjectedSystemPrompt,
  MAX_SYSTEM_PROMPT_LENGTH
}
