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

/** 身份 / 模型 / 版本类短答：易低于 60 字阈值，但应对用户可见（如飞书问「你是什么模型」） */
function hasConversationalIdentityOrMetaSignal(text = '') {
  const t = String(text || '').trim()
  if (!t || t.length > 120) return false
  if (/\b(I(?:'| a|')?m (?:an |the )?(?:AI|assistant|language model)|powered by|based on)\b/i.test(t)) return true
  if (/(?:当前对话|本对话|本助手|本应用|本会话)/.test(t) && /(模型|Model|provider)/i.test(t)) return true
  const hasModelOrVendor =
    /(模型|大语言|LLM|language model|assistant|Qwen|GPT|Claude|Gemini|OpenAI|Anthropic|DeepSeek|通义|OpenRouter|ultron)/i.test(t)
  const hasStrongIdentity =
    /(?:^|[\s，。])(我是|我是由|本助手为|我是基于|当前(?:对话)?(?:使用|基于|运行于))/.test(t)
  if (hasModelOrVendor && hasStrongIdentity) return true
  return false
}

function isLowInformationReply(text = '') {
  const t = normalizeVisibleReplyText(text)
  if (!t) return true
  if (/[?？]\s*$/.test(t)) return false
  if (hasResultSignals(t)) return false
  if (hasConversationalIdentityOrMetaSignal(t)) return false
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
  const mentionsImmediateExecution =
    /(我|咱|马上|立刻|这就|先|现在)[^。！\n]{0,24}(开始|执行|处理|做|落地|搞定)/.test(t)
  const promisesLaterDelivery =
    /(完成后|做好后|结束后|随后|再|等会儿)[^。！\n]{0,24}(给你|发你|回你|返回)[^。！\n]{0,24}(路径|图片|截图|结果|文件)/.test(t)
  if (mentionsImmediateExecution && promisesLaterDelivery) return true
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

function looksLikeToolActionRequest(userText = '') {
  const t = normalizeVisibleReplyText(userText).toLowerCase()
  if (!t) return false
  const hasActionVerb =
    /(打开|访问|截图|检查|查询|搜索|执行|运行|调用|读取|编辑|修改|创建|删除|提交|安装|部署|发布|发送|回复|整理|清理|归档|配置|启动|停止|open|visit|screenshot|check|query|search|run|execute|call|read|edit|modify|create|delete|commit|install|deploy|publish|send|reply|clean|archive|config|start|stop)/i
  const hasToolObject =
    /(浏览器|页面|网页|网站|文件|目录|日志|终端|命令|工具|mcp|飞书|telegram|dingtalk|webapp|数据库|db|sql|git|api|script|脚本)/i
  return hasActionVerb.test(t) && hasToolObject.test(t)
}

function shouldForceExecutionContinuation(text = '', userText = '') {
  const t = normalizeVisibleReplyText(text)
  if (!t) return true
  if (looksLikeNoResultPlaceholderText(t) || looksLikeExecutionPromiseWithoutResult(t)) return true

  // 用户明确在请求“执行动作”，但助手只回了非结果性短文本（且非明确拒绝/受限说明）时，强制再走一轮。
  if (looksLikeToolActionRequest(userText)) {
    if (hasConcreteArtifactSignal(t) || hasResultSignals(t)) return false
    if (/(无法|不能|不可以|做不到|无权限|没权限|受限|未登录|需要你先|请你先|请先)/.test(t)) return false
    if (t.length <= 140) return true
  }
  return false
}

function hasUsefulVisibleResult(text = '') {
  const t = String(text || '').trim()
  if (!t) return false
  if (shouldForceExecutionContinuation(t)) return false
  if (isLowInformationReply(t)) return false
  return true
}

/**
 * 飞书 / Telegram / 钉钉 外发：在「占位句、空承诺」仍拦截的前提下，比 hasUsefulVisibleResult 更宽松，
 * 避免正常中短句（含身份/闲聊）被误判后只发兜底文案。
 */
function hasOutboundVisibleResult(text = '') {
  const t = String(text || '').trim()
  if (!t) return false
  if (shouldForceExecutionContinuation(t)) return false
  if (hasUsefulVisibleResult(t)) return true
  if (t.length >= 12) return true
  return false
}

module.exports = {
  normalizeVisibleReplyText,
  hasConcreteArtifactSignal,
  hasResultSignals,
  hasConversationalIdentityOrMetaSignal,
  isLowInformationReply,
  looksLikeNoResultPlaceholderText,
  looksLikeExecutionPromiseWithoutResult,
  shouldForceExecutionContinuation,
  hasUsefulVisibleResult,
  hasOutboundVisibleResult
}
