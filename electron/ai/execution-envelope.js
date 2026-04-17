function normalizeErrorCode(errorText = '') {
  const s = String(errorText || '').toLowerCase()
  if (!s) return 'UNKNOWN'
  if (/cancel|已取消|aborted/.test(s)) return 'CANCELLED'
  if (/invalid request param|invalid receive_id|invalid param|参数无效/.test(s)) return 'INVALID_PARAM'
  if (/timeout|timed out|超时/.test(s)) return 'NETWORK_TIMEOUT'
  if (/auth|token|unauthorized|forbidden|权限|鉴权/.test(s)) return 'AUTH_ERROR'
  if (/rate limit|too many requests|限流/.test(s)) return 'RATE_LIMIT'
  if (/not support|unsupported|不支持|can't recognize image format/.test(s)) return 'UNSUPPORTED_FORMAT'
  if (/render.*not ready|页面渲染未就绪/.test(s)) return 'RENDER_NOT_READY'
  if (/missing|缺少|未提供/.test(s)) return 'MISSING_CONTEXT'
  if (/子.?Agent.?执行超时|run.?timeout|subagent.?timeout/i.test(s)) return 'RUN_TIMEOUT'
  return 'UNKNOWN'
}

/**
 * 运行时退出类别（非模型生成）：用于 Announce 对齐与渠道展示。
 * @param {object} out
 * @param {boolean} out.success
 * @param {string} [out.error]
 * @param {string} [out.exitKind] — 若调用方已设则优先
 */
function computeExitKind(out = {}) {
  if (out && out.exitKind && /^(completed|timeout|aborted|error)$/.test(String(out.exitKind))) {
    return String(out.exitKind)
  }
  if (out && out.success) return 'completed'
  const err = String(out.error || '')
  const code = normalizeErrorCode(err)
  if (code === 'CANCELLED') return 'aborted'
  if (code === 'RUN_TIMEOUT' || code === 'NETWORK_TIMEOUT') return 'timeout'
  return 'error'
}

function buildExecutionEnvelope(out = {}, runtime = 'internal') {
  const success = !!out.success
  const exitKind = computeExitKind(out)
  const result = out.result != null ? String(out.result).trim() : ''
  const stdout = Array.isArray(out.commandLogs)
    ? out.commandLogs.join('\n')
    : (out.stdout != null ? String(out.stdout) : '')
  const errorMessage = out.error != null ? String(out.error) : ''
  const logLines = stdout ? stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
  const logTail = logLines.slice(-20).join('\n')
  /** 子 Agent 常无最终 assistant 文字，但有工具/命令日志；summary 必须对主会话可读 */
  const summary = success
    ? (result || (logTail ? `子 Agent 已结束（无最终说明）。近期执行记录：\n${logTail}` : '子 Agent 已完成（未返回文字说明与执行日志摘要）。'))
    : (errorMessage || '子 Agent 执行失败')

  const envelope = {
    success,
    exitKind,
    summary,
    artifacts: Array.isArray(out.artifacts) ? out.artifacts : [],
    logs: logLines.slice(-80),
    tool_events: Array.isArray(out.toolEvents) ? out.toolEvents : [],
    error: success
      ? null
      : {
          code: normalizeErrorCode(errorMessage),
          message: errorMessage || '执行失败',
          retriable: !/invalid request param|invalid receive_id|参数无效/i.test(errorMessage)
        },
    metrics: {
      elapsed_ms: Number.isFinite(Number(out.elapsedMs)) ? Number(out.elapsedMs) : undefined,
      retries: Math.max(0, (Array.isArray(out.attemptedRuntimes) ? out.attemptedRuntimes.length : 1) - 1),
      runtime: String(out.runtime || runtime || 'internal'),
      parent_run_id: out.parentRunId != null && String(out.parentRunId).trim() ? String(out.parentRunId).trim() : undefined,
      sub_session_id: out.subSessionId != null && String(out.subSessionId).trim() ? String(out.subSessionId).trim() : undefined,
      system_prompt_source: out.systemPromptSource != null && String(out.systemPromptSource).trim()
        ? String(out.systemPromptSource).trim()
        : undefined
    }
  }
  return envelope
}

/**
 * 委派工具返回给主会话的 JSON 不宜把整段 commandLogs 放在 envelope 之前，否则易被 orchestrator 6000 字截断切掉 envelope。
 * 详细日志仍在 envelope.logs（已条数封顶）。
 */
function truncateDelegationStdoutPreview(logs, maxChars = 4000) {
  const raw = Array.isArray(logs) ? logs.join('\n') : String(logs || '')
  if (raw.length <= maxChars) return raw
  const tail = raw.slice(-maxChars)
  return `…(stdout 共 ${raw.length} 字已截断；完整脉络见 envelope.logs 与 message)\n${tail}`
}

module.exports = {
  buildExecutionEnvelope,
  computeExitKind,
  normalizeErrorCode,
  truncateDelegationStdoutPreview
}
