const { buildExecutionEnvelope, normalizeErrorCode } = require('./execution-envelope')

describe('execution-envelope', () => {
  it('normalizeErrorCode maps known patterns', () => {
    expect(normalizeErrorCode('')).toBe('UNKNOWN')
    expect(normalizeErrorCode('request was cancelled')).toBe('CANCELLED')
    expect(normalizeErrorCode('invalid receive_id')).toBe('INVALID_PARAM')
    expect(normalizeErrorCode('connection timeout')).toBe('NETWORK_TIMEOUT')
    expect(normalizeErrorCode('401 unauthorized')).toBe('AUTH_ERROR')
    expect(normalizeErrorCode('rate limit exceeded')).toBe('RATE_LIMIT')
  })

  it('buildExecutionEnvelope success shape', () => {
    const e = buildExecutionEnvelope({
      success: true,
      result: 'done',
      commandLogs: ['line1', 'line2'],
      artifacts: [{ path: '/tmp/a' }],
      runtime: 'internal'
    }, 'internal')
    expect(e.success).toBe(true)
    expect(e.summary).toBe('done')
    expect(e.artifacts).toEqual([{ path: '/tmp/a' }])
    expect(e.logs).toContain('line1')
    expect(e.error).toBeNull()
    expect(e.metrics.runtime).toBe('internal')
  })

  it('buildExecutionEnvelope failure includes error and retriable', () => {
    const e = buildExecutionEnvelope({
      success: false,
      error: 'invalid receive_id for chat'
    }, 'internal')
    expect(e.success).toBe(false)
    expect(e.error.code).toBe('INVALID_PARAM')
    expect(e.error.retriable).toBe(false)
    expect(e.summary).toMatch(/invalid receive_id/i)
  })

  it('buildExecutionEnvelope metrics carries parent_run_id and sub_session_id', () => {
    const e = buildExecutionEnvelope({
      success: true,
      result: 'ok',
      parentRunId: 'run-abc',
      subSessionId: 'sub-xyz'
    }, 'internal')
    expect(e.metrics.parent_run_id).toBe('run-abc')
    expect(e.metrics.sub_session_id).toBe('sub-xyz')
  })
})
