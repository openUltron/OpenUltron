/**
 * 外部 CLI 子 Agent：which/version 扫描、spawn 执行、日志归一与 Codex 代理环境变体
 */

const EXTERNAL_SUBAGENT_SPECS = [
  {
    id: 'codex',
    command: 'codex',
    versionArgs: ['--version'],
    runArgBuilders: [
      (prompt) => ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt]
    ]
  },
  {
    id: 'claude',
    command: 'claude',
    versionArgs: ['--version'],
    runArgBuilders: [
      (prompt) => ['-p', prompt],
      (prompt) => ['--print', prompt]
    ]
  },
  {
    id: 'gateway_cli',
    command: String(process.env.OPENULTRON_GATEWAY_CLI || 'claw').trim() || 'claw',
    versionArgs: ['--version'],
    runArgBuilders: [
      (prompt) => ['agent', '--local', '--json', '--message', prompt],
      (prompt) => ['agent', '--json', '--message', prompt],
      (prompt) => ['run', prompt],
      (prompt) => ['exec', prompt]
    ]
  },
  {
    id: 'opencode',
    command: 'opencode',
    versionArgs: ['--version'],
    runArgBuilders: [
      (prompt) => ['run', prompt],
      (prompt) => ['exec', prompt]
    ]
  }
]

const EXTERNAL_AGENT_SCAN_TTL = 60 * 1000
const EXTERNAL_AGENT_FAIL_RETRY_TTL = 5 * 60 * 1000

/** 子进程「走代理」变体：仅使用当前 process.env（用户保存的全局代理），不写死地址 */
function getCodexProxyPresetEnv() {
  const http = String(process.env.http_proxy || process.env.HTTP_PROXY || '').trim()
  const https = String(process.env.https_proxy || process.env.HTTPS_PROXY || '').trim() || http
  const all = String(process.env.all_proxy || process.env.ALL_PROXY || '').trim()
  return {
    http_proxy: http,
    https_proxy: https,
    all_proxy: all,
    HTTP_PROXY: http,
    HTTPS_PROXY: https,
    ALL_PROXY: all
  }
}

function createEnvWithoutProxy(baseEnv = process.env) {
  const env = { ...(baseEnv || process.env) }
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy
  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.ALL_PROXY
  return env
}

function getExternalEnvVariants(specId = '') {
  if (specId === 'codex') {
    return [
      { mode: 'proxy-on', env: { ...process.env, ...getCodexProxyPresetEnv() } },
      { mode: 'proxy-off', env: createEnvWithoutProxy(process.env) }
    ]
  }
  return [{ mode: 'default', env: process.env }]
}

/** @param {{ spawn: Function, getWorkspaceRoot: () => string, appLogger?: object }} deps */
function createExternalSubagentCli(deps) {
  const { spawn, getWorkspaceRoot, appLogger } = deps
  let externalAgentScanCache = { ts: 0, agents: [] }
  const externalAgentFailureMemory = new Map()

  async function runCliCommand(command, args = [], options = {}) {
    const { cwd, timeoutMs = 90000, env, onStdout, onStderr, shouldAbort } = options
    return await new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let done = false
      let timedOut = false
      let abortedByPattern = false
      const finish = (payload) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(payload)
      }
      const child = spawn(command, args, {
        cwd: cwd || getWorkspaceRoot(),
        shell: false,
        env: env || process.env
      })
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch (_) {}
        finish({
          success: false,
          exitCode: -1,
          stdout,
          stderr,
          error: `命令执行超时 (${Math.floor(timeoutMs / 1000)}秒)`,
          timedOut: true
        })
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk || '')
        stdout += text
        try { if (typeof onStdout === 'function') onStdout(text) } catch (_) {}
      })
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk || '')
        stderr += text
        try { if (typeof onStderr === 'function') onStderr(text) } catch (_) {}
        try {
          if (!done && typeof shouldAbort === 'function' && shouldAbort(text, { stdout, stderr })) {
            abortedByPattern = true
            try { child.kill('SIGKILL') } catch (_) {}
            finish({
              success: false,
              exitCode: -1,
              stdout,
              stderr,
              error: '命中快速失败条件，已提前终止',
              timedOut: false
            })
          }
        } catch (_) {}
      })
      child.on('error', (err) => {
        finish({ success: false, exitCode: -1, stdout, stderr, error: err.message, timedOut: false })
      })
      child.on('close', (code) => {
        finish({
          success: !timedOut && !abortedByPattern && code === 0,
          exitCode: timedOut ? -1 : (code ?? 0),
          stdout,
          stderr,
          error: timedOut
            ? `命令执行超时 (${Math.floor(timeoutMs / 1000)}秒)`
            : (abortedByPattern ? '命中快速失败条件，已提前终止' : ''),
          timedOut
        })
      })
    })
  }

  function normalizeExternalLogChunk(text, maxLen = 400) {
    const s = String(text || '').replace(/\r/g, '').replace(/\n+/g, ' ').trim()
    if (!s) return ''
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
  }

  function isExternalNetworkTimeoutChunk(text) {
    const s = String(text || '').toLowerCase()
    if (!s) return false
    return s.includes('failed to connect to websocket') ||
      s.includes('operation timed out') ||
      s.includes('os error 60') ||
      s.includes('error sending request for url') ||
      s.includes('stream disconnected before completion')
  }

  async function scanExternalSubAgents(force = false) {
    const now = Date.now()
    if (!force && externalAgentScanCache.ts > 0 && now - externalAgentScanCache.ts < EXTERNAL_AGENT_SCAN_TTL) {
      return externalAgentScanCache.agents
    }
    const list = []
    for (const spec of EXTERNAL_SUBAGENT_SPECS) {
      const failState = externalAgentFailureMemory.get(spec.id)
      if (!force && failState && failState.nextRetryAt > now) {
        list.push({
          id: spec.id,
          command: spec.command,
          available: false,
          reason: `cooldown:${failState.reason}`
        })
        continue
      }
      const found = await runCliCommand('which', [spec.command], { timeoutMs: 2500 })
      if (!found.success) {
        list.push({ id: spec.id, command: spec.command, available: false, reason: 'not_found' })
        externalAgentFailureMemory.set(spec.id, {
          nextRetryAt: now + EXTERNAL_AGENT_FAIL_RETRY_TTL,
          reason: 'not_found'
        })
        continue
      }
      const version = await runCliCommand(spec.command, spec.versionArgs || ['--version'], { timeoutMs: 4000 })
      const verText = String(version.stdout || version.stderr || '').trim().split('\n')[0] || ''
      if (version.success) {
        externalAgentFailureMemory.delete(spec.id)
      } else {
        externalAgentFailureMemory.set(spec.id, {
          nextRetryAt: now + EXTERNAL_AGENT_FAIL_RETRY_TTL,
          reason: version.error || 'version_check_failed'
        })
      }
      list.push({
        id: spec.id,
        command: spec.command,
        available: !!version.success,
        path: String(found.stdout || '').trim(),
        version: verText,
        reason: version.success ? '' : (version.error || 'version_check_failed')
      })
    }
    externalAgentScanCache = { ts: now, agents: list }
    try {
      const summaryText = list
        .map(x => `${x.id}:${x.available ? 'ok' : 'missing'}${x.version ? `@${x.version}` : ''}`)
        .join(', ')
      appLogger?.info?.('[SubAgentScan] 外部子Agent扫描完成', {
        force: !!force,
        total: list.length,
        available: list.filter(x => x.available).map(x => x.id),
        details: list.map(x => ({
          id: x.id,
          available: !!x.available,
          version: x.version || '',
          path: x.path || '',
          reason: x.reason || ''
        }))
      })
      appLogger?.info?.(`[SubAgentScan] 可用性摘要 ${summaryText}`)
    } catch (_) {}
    return list
  }

  return {
    runCliCommand,
    scanExternalSubAgents,
    normalizeExternalLogChunk,
    isExternalNetworkTimeoutChunk
  }
}

module.exports = {
  EXTERNAL_SUBAGENT_SPECS,
  EXTERNAL_AGENT_SCAN_TTL,
  createExternalSubagentCli,
  getCodexProxyPresetEnv,
  createEnvWithoutProxy,
  getExternalEnvVariants
}
