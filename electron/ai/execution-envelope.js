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

function buildExecutionEnvelope(out = {}, runtime = 'internal') {
  const success = !!out.success
  const result = out.result != null ? String(out.result) : ''
  const stdout = Array.isArray(out.commandLogs)
    ? out.commandLogs.join('\n')
    : (out.stdout != null ? String(out.stdout) : '')
  const errorMessage = out.error != null ? String(out.error) : ''
  const summary = success
    ? (result || '子 Agent 已完成。')
    : (errorMessage || '子 Agent 执行失败')

  const envelope = {
    success,
    summary,
    artifacts: Array.isArray(out.artifacts) ? out.artifacts : [],
    logs: stdout ? stdout.split('\n').filter(Boolean).slice(-400) : [],
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
      sub_session_id: out.subSessionId != null && String(out.subSessionId).trim() ? String(out.subSessionId).trim() : undefined
    }
  }
  return envelope
}

module.exports = {
  buildExecutionEnvelope,
  normalizeErrorCode
}

