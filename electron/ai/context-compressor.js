// 上下文压缩：当消息 token 超过阈值时，对早期消息生成摘要以节省 token
// 算法：保留 system + 最近 keepRecent 条原文，将中间消息压缩为一条 summary system message
// 降低触发频次，避免频繁压缩导致摘要质量差、丢失细节、多轮工具调用中误压缩

const DEFAULT_CONFIG = {
  enabled: true,
  /** 仅统计「对话消息」（user/assistant/tool，不含 system）的估算 tokens；不把注入的大段 system 算进去，避免首轮就误触发 */
  threshold: 24000,
  /** 保留最近 N 条对话原文；工具多轮会迅速占满条数，宜略大以减少「同一轮用户请求内」过早压缩 */
  keepRecent: 20,
  summaryMaxTokens: 420,
  /** 首轮压缩后仍超阈值时，第二轮保留的最近对话条数（更小 = 更激进） */
  aggressiveKeepRecent: 10,
  /**
   * OpenRouter：与 threshold 取 min，作为「对话部分」的触发上限（仍为粗估 char/3）。
   * 默认与 threshold 对齐，避免过早压缩导致模型误以为任务已结束；若账号 prompt 上限较紧可在 openultron.json 单独调低。
   */
  openRouterSoftBudget: 24000,
  /**
   * 估算节省的 tokens 低于此值则放弃本次压缩（避免摘要比原文还长、白耗一次模型调用）。
   */
  minCompressSavingsTokens: 800,
  /**
   * 成功压缩后，若干轮 LLM 调用内不再压缩（除非对话体量远超阈值×1.4），减轻工具循环里反复压缩。
   */
  compressCooldownIterations: 2,
  /**
   * 压缩前是否发起「记忆刷新」LLM（编排层未接 executeTool 时多为无效额外请求，默认关闭）
   */
  flushMemoryBeforeCompress: false,
  /** 最多保留几条「对话摘要」system 消息，多轮压缩时丢弃更早的摘要以控制体积 */
  maxCompressionSummaryStack: 1
}

const COMPRESSION_SUMMARY_MARKER = '[对话摘要（早期消息已压缩）]'
/** 附在摘要后，降低模型在压缩后提前收尾的概率 */
const COMPRESSION_CONTINUATION_HINT =
  '\n\n（系统：上文为摘要，请继续完成用户尚未完成的目标与操作；不要仅因摘要而结束任务。）'

/**
 * 压缩切分不得落在「工具轮」中间，否则 recent 会以 tool 开头、或丢掉 assistant(tool_calls) 与 tool 的配对，导致下一轮 Responses/Chat 请求非法。
 * @param {Array<{role:string,tool_calls?:*,toolCalls?:*}>} dialogMsgs
 * @param {number} splitIdx - `recent = dialogMsgs.slice(splitIdx)` 的起始下标
 */
function alignCompressionSplitIndex(dialogMsgs, splitIdx) {
  const n = dialogMsgs.length
  let i = Math.max(0, Math.min(splitIdx, n))
  // 1) recent 不得以 tool 开头：回退到本轮带 tool_calls 的 assistant
  if (i < n && dialogMsgs[i].role === 'tool') {
    let k = i
    while (k > 0 && dialogMsgs[k - 1].role === 'tool') k--
    const j = k - 1
    if (j >= 0 && dialogMsgs[j].role === 'assistant') {
      const tc = dialogMsgs[j].tool_calls || dialogMsgs[j].toolCalls
      if (tc && tc.length) i = j
    }
  }
  // 2) 若 split 紧挨在一段 tool 结果之上，且再往前是 assistant(tool_calls)，必须把整块并入 recent（不能把 tool 留在摘要里、assistant 留在 recent）
  if (i > 0) {
    let j = i - 1
    while (j >= 0 && dialogMsgs[j].role === 'tool') j--
    if (j >= 0) {
      const m = dialogMsgs[j]
      const tc = m.tool_calls || m.toolCalls
      if (m.role === 'assistant' && tc && tc.length) i = j
    }
  }
  return i
}

/** 限制堆叠的「对话摘要」system 条数，避免反复压缩越压 system 越大 */
function capCompressionSystemMessages(systemMsgs, maxKeep = 2) {
  const list = Array.isArray(systemMsgs) ? systemMsgs : []
  const compressionIdx = []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (m && m.role === 'system' && String(m.content || '').startsWith(COMPRESSION_SUMMARY_MARKER)) {
      compressionIdx.push(i)
    }
  }
  if (compressionIdx.length <= maxKeep) return list
  const drop = compressionIdx.slice(0, compressionIdx.length - maxKeep)
  const dropSet = new Set(drop)
  return list.filter((_, i) => !dropSet.has(i))
}

function getCompressionSummaryContent(message) {
  let text = String(message?.content || '')
  if (text.startsWith(COMPRESSION_SUMMARY_MARKER)) {
    text = text.slice(COMPRESSION_SUMMARY_MARKER.length)
  }
  if (text.startsWith('\n')) text = text.slice(1)
  if (text.endsWith(COMPRESSION_CONTINUATION_HINT)) {
    text = text.slice(0, -COMPRESSION_CONTINUATION_HINT.length)
  }
  return text.trim()
}

function clipSummaryDialogBody(text, maxChars) {
  const s = String(text || '')
  const lim = Number(maxChars) || 0
  if (!s || lim <= 0 || s.length <= lim) return s
  const head = Math.min(12000, Math.max(4000, Math.floor(lim * 0.4)))
  const tail = Math.max(4000, lim - head)
  const omitted = Math.max(0, s.length - head - tail)
  return `${s.slice(0, head)}\n\n...(中间 ${omitted} 字已省略)\n\n${s.slice(-tail)}`
}

/** 供摘要模型阅读的对话行（含 tool 的极短摘录，避免大段 JSON 进 prompt） */
function dialogMessageForSummaryLine(m, sliceLen) {
  if (!m) return ''
  if (m.role === 'user' || m.role === 'assistant') {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return `[${m.role}]: ${text.slice(0, sliceLen)}`
  }
  if (m.role === 'tool') {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    return `[tool]: ${c.slice(0, Math.min(sliceLen, 520))}`
  }
  return `[${m.role}]: ${String(m.content || '').slice(0, sliceLen)}`
}

/**
 * 粗估消息列表的 token 数（中英文混合场景，误差 ±20% 可接受）
 */
function estimateTokens(messages) {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content)
        ? m.content.map(c => (typeof c === 'string' ? c : c.text || JSON.stringify(c))).join('')
        : JSON.stringify(m.content || ''))
    // 工具调用也估算进去（兼容 toolCalls / tool_calls）
    const toolCalls = m.toolCalls || m.tool_calls
    const toolStr = toolCalls ? JSON.stringify(toolCalls) : ''
    return sum + Math.ceil((content.length + toolStr.length) / 3)
  }, 0)
}

/**
 * 判断是否需要压缩（只看对话体量：system 注入再大也不单独触发，与 compressMessages 可裁剪范围一致）
 */
function shouldCompress(messages, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  if (!cfg.enabled) return false
  const dialogMsgs = (messages || []).filter(m => m && m.role !== 'system')
  if (dialogMsgs.length <= cfg.keepRecent) return false
  const dialogTok = estimateTokens(dialogMsgs)
  return dialogTok > cfg.threshold
}

/**
 * 压缩前记忆刷新：让 AI 在上下文被截断前主动保存重要信息
 * @param {Function} callLLM       - async (messages, maxTokens) => string
 * @param {Function} executeTool   - async (name, args) => result（可选，用于执行 memory_save）
 */
async function flushMemoryBeforeCompaction(messages, callLLM, executeTool) {
  if (typeof executeTool !== 'function') return
  const dialogMsgs = messages.filter(m => m.role !== 'system').slice(-30)
  if (dialogMsgs.length < 4) return  // 对话太短，无需刷新

  const flushPrompt = [
    '对话即将被压缩，早期内容将丢失。请现在检查对话，将值得长期保留的关键信息（用户偏好、项目配置、重要结论、解决方案等）写入记忆。',
    '- 如果有需要保存的，调用 memory_save 工具（每条不超过 100 字，最多保存 3 条）',
    '- 如果没有值得保存的，直接回复 NO_REPLY',
    '只做记忆保存，不要回答其他问题。'
  ].join('\n')

  try {
    const text = await callLLM([{ role: 'user', content: flushPrompt }], 500)
    // 如果 AI 直接返回 JSON memory_save 调用，尝试解析执行
    if (executeTool && text && text !== 'NO_REPLY' && text.includes('memory_save')) {
      console.log('[ContextCompressor] 压缩前记忆刷新完成:', text.slice(0, 100))
    }
  } catch (e) {
    console.warn('[ContextCompressor] 压缩前记忆刷新失败:', e.message)
  }
}

/**
 * 压缩上下文
 * @param {Array} messages       - 完整消息列表（含 system）
 * @param {object} config        - 压缩配置（threshold/keepRecent/summaryMaxTokens）
 * @param {Function} callLLM     - async (messages, maxTokens) => string（摘要文本）
 * @returns {Promise<Array>}     - 压缩后的消息列表
 */
async function compressMessages(messages, config = {}, callLLM) {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // 分离 system messages 和对话消息
  const systemMsgs = messages.filter(m => m.role === 'system')
  const dialogMsgs = messages.filter(m => m.role !== 'system')
  const previousSummaryMsgs = systemMsgs.filter(
    m => m && m.role === 'system' && String(m.content || '').startsWith(COMPRESSION_SUMMARY_MARKER)
  )
  const plainSystemMsgs = systemMsgs.filter(
    m => !(m && m.role === 'system' && String(m.content || '').startsWith(COMPRESSION_SUMMARY_MARKER))
  )

  // 保留最近 keepRecent 条原文，其余的送去压缩
  if (dialogMsgs.length <= cfg.keepRecent) {
    return messages  // 不需要压缩
  }

  let splitIdx = alignCompressionSplitIndex(dialogMsgs, dialogMsgs.length - cfg.keepRecent)
  const toCompress = dialogMsgs.slice(0, splitIdx)
  const recentMsgs = dialogMsgs.slice(splitIdx)

  const sliceLen = 1800
  let dialogBody = toCompress.map(m => dialogMessageForSummaryLine(m, sliceLen)).filter(Boolean).join('\n\n')
  const MAX_SUMMARY_INPUT_CHARS = 30000
  dialogBody = clipSummaryDialogBody(dialogBody, MAX_SUMMARY_INPUT_CHARS)
  const previousSummaryText = previousSummaryMsgs
    .map(m => getCompressionSummaryContent(m))
    .filter(Boolean)
    .join('\n\n')
  // 构造摘要请求（含 tool 的短摘录，避免仅 user/assistant 时丢失「执行过什么工具」的语义）
  const summaryPrompt = [
    '请将以下对话历史压缩为简洁摘要（不超过 ' + cfg.summaryMaxTokens + ' 字），保留：',
    '- 用户的核心需求和目标',
    '- 已完成的关键操作和重要结论',
    '- 重要的文件路径、变量名、配置值',
    '- 未完成的任务和待确认事项',
    '- 若存在此前摘要，请与本次对话合并为一份新的完整摘要',
    '直接输出摘要内容，不需要其他说明。',
    '',
    previousSummaryText ? '此前压缩摘要：\n' + previousSummaryText : '',
    '对话内容：',
    dialogBody
  ].join('\n')

  let summaryText = ''
  try {
    summaryText = await callLLM(
      [{ role: 'user', content: summaryPrompt }],
      cfg.summaryMaxTokens + 200
    )
  } catch (err) {
    console.warn('[ContextCompressor] 摘要生成失败，跳过压缩:', err.message)
    return messages  // 失败时回退原消息
  }

  const maxSummaryChars = Math.min(
    9000,
    Math.max(250, (Number(cfg.summaryMaxTokens) || 600) * 7)
  )
  summaryText = String(summaryText || '').trim().slice(0, maxSummaryChars)

  const summaryMessage = {
    role: 'system',
    content: `${COMPRESSION_SUMMARY_MARKER}\n` + summaryText + COMPRESSION_CONTINUATION_HINT
  }

  const compressed = [...plainSystemMsgs, summaryMessage, ...recentMsgs]
  const before = estimateTokens(messages)
  const after = estimateTokens(compressed)
  const saved = before - after
  const minSave = Number(cfg.minCompressSavingsTokens) || 1200
  if (saved < minSave) {
    console.warn(
      `[ContextCompressor] 压缩效果不足（${before} → ${after}，节省 ${saved}，门槛 ${minSave}），保留原消息`
    )
    return messages
  }
  console.log(`[ContextCompressor] 压缩完成：${before} → ${after} tokens，节省 ${saved}`)

  return compressed
}

module.exports = {
  estimateTokens,
  shouldCompress,
  compressMessages,
  flushMemoryBeforeCompaction,
  alignCompressionSplitIndex,
  DEFAULT_CONFIG,
  COMPRESSION_SUMMARY_MARKER
}
