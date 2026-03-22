'use strict'

function parseToolCallArgs(rawArgs) {
  if (rawArgs == null) return null
  if (typeof rawArgs === 'object') return rawArgs
  if (typeof rawArgs !== 'string') return null
  try {
    return JSON.parse(rawArgs)
  } catch (_) {
    return null
  }
}

function formatCommandFromToolCall(tc) {
  try {
    const name = String(tc?.name || '').trim() || 'unknown'
    const args = parseToolCallArgs(tc?.arguments)
    const readStr = (v) => (typeof v === 'string' ? v.trim() : '')
    if (name === 'execute_command') {
      const cmd = readStr(args?.command || args?.cmd || args?.script)
      return cmd ? `- ${cmd}` : `- 调用 ${name}`
    }
    if (name === 'file_operation') {
      const action = readStr(args?.action) || 'run'
      const target = readStr(args?.path || args?.target || '')
      return target ? `- file_operation ${action} ${target}` : `- file_operation ${action}`
    }
    if (name.startsWith('mcp__')) {
      return `- ${name}`
    }
    if (name === 'sessions_spawn') {
      const runtime = readStr(args?.runtime)
      const role = readStr(args?.role_name)
      if (runtime || role) return `- sessions_spawn${runtime ? ` runtime=${runtime}` : ''}${role ? ` role=${role}` : ''}`
      return '- sessions_spawn'
    }
    return `- ${name}`
  } catch (_) {
    return '- 调用工具'
  }
}

module.exports = { parseToolCallArgs, formatCommandFromToolCall }
