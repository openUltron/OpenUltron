/**
 * Shell 执行器：/bin/sh -c script
 * 见 EXTENSIBILITY-DESIGN.md 5.1、5.4。
 * 简单只读命令（cat/ls/head/tail/pwd）在主进程内执行，避免 spawn 子进程触发 macOS TCC 弹窗。
 */
const { spawn } = require('child_process')
const { tryInProcess } = require('./shell-inprocess')

const DEFAULT_TIMEOUT = 600000
const MAX_BUFFER = 1024 * 1024 * 5

/**
 * @param {{ script: string; cwd: string; timeout?: number; env?: Record<string, string>; onStdout?: Function; onStderr?: Function }} options
 * @param {{ projectPath?: string; sessionId?: string }} [context]
 * @returns {Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string; timedOut?: boolean }>}
 */
async function execute(options, context) {
  const { script, cwd, timeout = DEFAULT_TIMEOUT, env, onStdout, onStderr } = options || {}
  if (!script || !cwd) {
    return { success: false, error: '缺少 script 或 cwd' }
  }
  const dangerous = ['rm -rf /', 'mkfs', ':(){:|:&};:', '> /dev/sda']
  if (dangerous.some(d => script.includes(d))) {
    return { success: false, error: '命令被安全策略拦截' }
  }
  const inProcess = tryInProcess(script, cwd)
  if (inProcess.handled) {
    const maxLen = 8000
    return {
      success: inProcess.exitCode === 0,
      stdout: (inProcess.stdout || '').length > maxLen ? (inProcess.stdout || '').substring(0, maxLen) + '\n... (输出被截断)' : (inProcess.stdout || ''),
      stderr: (inProcess.stderr || '').length > maxLen ? (inProcess.stderr || '').substring(0, maxLen) + '\n... (输出被截断)' : (inProcess.stderr || ''),
      exitCode: inProcess.exitCode
    }
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', script], {
      cwd,
      shell: false,
      env: env || process.env
    })

    const appendChunk = (prev, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk || '')
      if (!text) return prev
      const merged = prev + text
      if (merged.length <= MAX_BUFFER) return merged
      return merged.slice(merged.length - MAX_BUFFER)
    }

    const trimOutput = (text) => {
      const normalized = (text || '').trim()
      const maxLen = 8000
      return normalized.length > maxLen ? normalized.substring(0, maxLen) + '\n... (输出被截断)' : normalized
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    child.stdout?.on('data', (chunk) => {
      stdout = appendChunk(stdout, chunk)
      try { if (typeof onStdout === 'function') onStdout(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk || '')) } catch (_) {}
    })

    child.stderr?.on('data', (chunk) => {
      stderr = appendChunk(stderr, chunk)
      try { if (typeof onStderr === 'function') onStderr(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk || '')) } catch (_) {}
    })

    const timer = setTimeout(() => {
      timedOut = true
      stderr = appendChunk(stderr, `\n命令执行超时 (${Math.floor(timeout / 1000)}秒)`)
      try { child.kill('SIGKILL') } catch (_) {}
    }, timeout)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        success: false,
        error: err.message,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        exitCode: 1,
        timedOut
      })
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const exitCode = timedOut ? -1 : (code ?? (signal ? 1 : 0))
      resolve({
        success: !timedOut && exitCode === 0,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        exitCode,
        timedOut
      })
    })
  })
}

module.exports = {
  id: 'shell',
  name: 'Shell',
  execute
}
