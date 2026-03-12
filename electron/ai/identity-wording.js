function sanitizeAssistantIdentityWording(text, agentName) {
  if (!text || typeof text !== 'string') return text
  const safeName = (agentName && typeof agentName === 'string' && agentName.trim()) ? agentName.trim() : null
  const fallbackSelfIntro = '我是Ultron，你的AI助手'
  const fallbackRoleName = 'Ultron，你的AI助手'
  let out = text
  out = out.replace(/我是\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,16})\s*[，,]?\s*OpenUltron\s*的\s*AI\s*助手/gi, '我是$1')
  out = out.replace(/我是\s*OpenUltron\s*的\s*AI\s*助手/gi, safeName ? `我是${safeName}` : fallbackSelfIntro)
  out = out.replace(/OpenUltron\s*的\s*AI\s*助手/gi, safeName || fallbackRoleName)
  out = out.replace(/我是\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,16})\s*[，,]\s*\1/g, '我是$1')
  out = out.replace(/随时为您服务[。！!]?/g, '')
  out = out.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return out
}

function sanitizeAssistantModelIdentity(text, currentModel) {
  if (!text || typeof text !== 'string') return text
  const model = String(currentModel || '').trim()
  if (!model) return text
  let out = text
  const introRegex = /(我是\s*(?:\*\*)?)([^，。\n*]{2,80}?)(?:\*\*)?\s*模型/
  const m = out.match(introRegex)
  if (m) {
    const claimed = String(m[2] || '').trim()
    if (claimed && claimed !== model) {
      out = out.replace(introRegex, `$1${model} 模型`)
    }
  }
  return out
}

module.exports = {
  sanitizeAssistantIdentityWording,
  sanitizeAssistantModelIdentity
}
