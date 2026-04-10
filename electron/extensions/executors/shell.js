/**
 * Shell 执行器：/bin/sh -c script
 * 见 EXTENSIBILITY-DESIGN.md 5.1、5.4。
 * 简单只读命令（cat/ls/head/tail/pwd）在主进程内执行，避免 spawn 子进程触发 macOS TCC 弹窗。
 */
const { spawn } = require('child_process')
const { tryInProcess } = require('./shell-inprocess')
const { logger: appLogger } = require('../../app-logger')
const { cleanEnvForChild } = require('./env-utils')

const DEFAULT_TIMEOUT = 600000
const MAX_BUFFER = 1024 * 1024 * 5

/**
 * @param {{ script: string; cwd: string; timeout?: number; env?: Record<string, string>; onStdout?: Function; onStderr?: Function; signal?: AbortSignal }} options
 * @param {{ projectPath?: string; sessionId?: string }} [context]
 * @returns {Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string; timedOut?: boolean; cancelled?: boolean }>}
 */
async function execute(options, context) {
  const { script, cwd, timeout = DEFAULT_TIMEOUT, env, onStdout, onStderr, signal: abortSignal } = options || {}
  if (!script || !cwd) {
    return { success: false, error: '缺少 script 或 cwd' }
  }
  const dangerous = ['rm -rf /', 'mkfs', ':(){:|:&};:', '> /dev/sda']
  if (dangerous.some(d => script.includes(d))) {
    return { success: false, error: '命令被安全策略拦截' }
  }
  if (abortSignal && abortSignal.aborted) {
    return { success: false, error: '已取消', stdout: '', stderr: '', exitCode: 130, timedOut: false, cancelled: true }
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
  const scriptPreview = script.length > 200 ? script.slice(0, 200) + '...' : script
  const hasFfmpegOrSay = /\b(ffmpeg|say|espeak)\b/i.test(script)
  appLogger?.info?.('[ShellExecutor] 开始执行', {
    cwd,
    timeoutSec: Math.floor(timeout / 1000),
    scriptPreview,
    hasFfmpegOrSay
  })

  return new Promise((resolve) => {
    const childEnv = cleanEnvForChild(env || process.env)
    // detached=true 让子进程成为新的进程组 leader，便于超时后杀掉整个进程组（含 ffmpeg/say 等派生子进程）
    const child = spawn('/bin/sh', ['-c', script], {
      cwd,
      shell: false,
      env: childEnv,
      detached: true
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
    let userCancelled = false
    let settled = false

    const killProcessTree = (reason = 'timeout') => {
      try {
        if (!child || !child.pid) return
        const msg = reason === 'abort' ? '[ShellExecutor] 用户取消，终止进程组' : '[ShellExecutor] 超时，终止进程组'
        appLogger?.warn?.(msg, {
          pid: child.pid,
          timeoutSec: Math.floor(timeout / 1000),
          scriptPreview,
          stderrTail: (stderr || '').slice(-800)
        })
        // 先杀进程组（负 pid），保证 bash/sh 派生的子进程也被终止
        try { process.kill(-child.pid, 'SIGTERM') } catch (e) { appLogger?.warn?.('[ShellExecutor] 杀进程组 SIGTERM 失败', { pid: child.pid, err: e.message }) }
        // 兜底：若进程组杀失败，至少杀掉本体
        try { child.kill('SIGTERM') } catch (_) {}
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL') } catch (_) {}
          try { child.kill('SIGKILL') } catch (_) {}
        }, 1200)
      } catch (e) {
        appLogger?.warn?.('[ShellExecutor] killProcessTree 异常', { err: e.message })
      }
    }

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
      killProcessTree('timeout')
    }, timeout)

    const onAbortSignal = () => {
      if (settled) return
      userCancelled = true
      stderr = appendChunk(stderr, '\n已取消')
      killProcessTree('abort')
    }
    if (abortSignal) {
      if (abortSignal.aborted) onAbortSignal()
      else abortSignal.addEventListener('abort', onAbortSignal, { once: true })
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', onAbortSignal)
      resolve({
        success: false,
        error: err.message,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        exitCode: 1,
        timedOut,
        cancelled: userCancelled
      })
    })

    child.on('close', (code, osSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', onAbortSignal)
      const exitCode = timedOut ? -1 : (userCancelled ? 130 : (code ?? (osSignal ? 1 : 0)))
      const success = !timedOut && !userCancelled && exitCode === 0
      if (!success) {
        const stderrTail = (stderr || '').trim().slice(-1200)
        appLogger?.warn?.('[ShellExecutor] 命令未成功结束', {
          exitCode,
          signal: osSignal || null,
          timedOut,
          scriptPreview,
          stderrTail,
          hasFfmpegOrSay
        })
        if (hasFfmpegOrSay) {
          appLogger?.info?.('[ShellExecutor] ffmpeg/say 类命令失败时，常见原因：1) ffmpeg 未安装或不在 PATH；2) say 文本过长导致合成过久；3) 超时被终止；4) 输出路径无写权限。请根据上方 stderrTail 排查。')
        }
      }
      resolve({
        success,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        exitCode,
        timedOut,
        cancelled: userCancelled
      })
    })
  })
}

module.exports = {
  id: 'shell',
  name: 'Shell',
  execute
}
