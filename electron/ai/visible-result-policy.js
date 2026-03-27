'use strict'

function normalizeVisibleReplyText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function hasConcreteArtifactSignal(text = '') {
  const t = String(text || '').trim()
  if (!t) return false
  if (/(https?:\/\/|local-resource:\/\/|file:\/\/|[A-Za-z]:\\|\/Users\/|\/tmp\/|\/var\/)/i.test(t)) return true
  if (/(?:产物|截图|文件|输出|下载|报告|日志)(?:路径|链接)\s*[:：]/i.test(t)) return true
  if (/(?:已(?:保存|写入|生成)|保存(?:到|至)|写入(?:到|至)|输出(?:到|至))[^。\n]{0,24}(?:\/|[A-Za-z]:\\|local-resource:\/\/|file:\/\/)/i.test(t)) return true
  if (/(?:^|[\s`"'(])(?:\.{1,2}\/[^\s`"'()]+\.(?:html|md|png|jpg|jpeg|webp|pdf|zip|json|txt|csv))/i.test(t)) return true
  if (/(见附件|见链接|下载链接)/i.test(t)) return true
  return false
}

function hasResultSignals(text = '') {
  const t = String(text || '').trim()
  if (!t) return false
  if (t.length >= 90) return true
  if (hasConcreteArtifactSignal(t)) return true
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean)
  if (lines.length >= 3) return true
  const listLike = lines.filter((x) => /^[-*]\s+/.test(x) || /^\d+\.\s+/.test(x)).length
  if (listLike >= 2) return true
  if (/^#{1,3}\s+/.test(t)) return true
  return false
}

function isLowInformationReply(text = '') {
  const t = normalizeVisibleReplyText(text)
  if (!t) return true
  if (/[?？]\s*$/.test(t)) return false
  if (hasResultSignals(t)) return false
  return t.length <= 60
}

function looksLikeNoResultPlaceholderText(text = '') {
  const t = normalizeVisibleReplyText(text)
  if (!t) return false
  const patterns = [
    /任务已执行完成，但未生成可展示的文本结果/,
    /未生成可展示的文本结果/,
    /未生成可展示结果/,
    /无回复内容/,
    /无可展示结果/
  ]
  return patterns.some((re) => re.test(t))
}

function looksLikeExecutionPromiseWithoutResult(text = '') {
  const t = normalizeVisibleReplyText(text)
  if (!t) return false
  if (hasConcreteArtifactSignal(t)) return false
  const patterns = [
    /我现在就按你说的执行/,
    /现在就按这个方案执行/,
    /开始操作中/,
    /收到.?马上开始/,
    /我先创建文件并执行浏览器截图/,
    /然后把产物路径发你/,
    /完成后我第一时间把图片路径发你/,
    /请在你电脑终端执行/,
    /你点头我立刻执行/,
    /给你一个稳妥交付方式/,
    /我这边刚刚被会话抖动打断了/,
    /还没完成/,
    /你把它保存为\s*`[^`]+\.(?:html|md|js|ts|json|txt)`[^。]*浏览器打开即可/i,
    /生成\s*`[^`]+\.(?:html|md|js|ts|json|txt)`\s*并导出\s*`[^`]+\.(?:png|jpg|jpeg|webp|pdf)/i
  ]
  return patterns.some((re) => re.test(t))
}

function shouldForceExecutionContinuation(text = '') {
  const t = normalizeVisibleReplyText(text)
  if (!t) return true
  return looksLikeNoResultPlaceholderText(t) || looksLikeExecutionPromiseWithoutResult(t)
}

function hasUsefulVisibleResult(text = '') {
  const t = String(text || '').trim()
  if (!t) return false
  if (shouldForceExecutionContinuation(t)) return false
  if (isLowInformationReply(t)) return false
  return true
}

module.exports = {
  normalizeVisibleReplyText,
  hasConcreteArtifactSignal,
  hasResultSignals,
  isLowInformationReply,
  looksLikeNoResultPlaceholderText,
  looksLikeExecutionPromiseWithoutResult,
  shouldForceExecutionContinuation,
  hasUsefulVisibleResult
}
