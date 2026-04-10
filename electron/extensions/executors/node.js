/**
 * Node.js 执行器：在指定 cwd 下执行 Node 脚本内容。
 * 与 Python 执行器接口一致，供 run_script(runtime: node) 使用。
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { cleanEnvForChild, resolveCommand } = require('./env-utils')

const SCRIPT_FILENAME = '_exec.js'
const MAX_STDOUT_LEN = 60 * 1024
const MAX_STDERR_LEN = 20 * 1024

/**
 * @param {{ script: string; cwd: string; timeout?: number; env?: Record<string, string> }} options
 * @param {{ projectPath?: string; sessionId?: string }} [context]
 * @returns {Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string; timedOut?: boolean }>}
 */
async function execute(options, context) {
  const { script, cwd, timeout = 90000, env } = options || {}
  if (!script || !cwd) {
    return { success: false, error: '缺少 script 或 cwd' }
  }
  const scriptPath = path.join(cwd, SCRIPT_FILENAME)
  try {
    fs.mkdirSync(cwd, { recursive: true })
    fs.writeFileSync(scriptPath, script.trimEnd(), 'utf-8')
  } catch (e) {
    return { success: false, error: `写入脚本失败: ${e.message}` }
  }
  return new Promise((resolve) => {
    const childEnv = cleanEnvForChild(env || process.env)
    const nodeCmd = resolveCommand('node', childEnv)
    const child = spawn(nodeCmd, [SCRIPT_FILENAME], {
      cwd,
      shell: false,
      env: childEnv
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    const t = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (_) {}
      resolve({
        success: false,
        stdout: stdout.slice(0, MAX_STDOUT_LEN) + (stdout.length > MAX_STDOUT_LEN ? '\n...(截断)' : ''),
        stderr: (stderr + '\n[运行超时被终止]').slice(0, MAX_STDERR_LEN) + (stderr.length > MAX_STDERR_LEN ? '\n...(截断)' : ''),
        exitCode: -1,
        timedOut: true
      })
    }, timeout)
    child.on('close', (code, signal) => {
      clearTimeout(t)
      resolve({
        success: code === 0,
        stdout: stdout.slice(0, MAX_STDOUT_LEN) + (stdout.length > MAX_STDOUT_LEN ? '\n...(截断)' : ''),
        stderr: stderr.slice(0, MAX_STDERR_LEN) + (stderr.length > MAX_STDERR_LEN ? '\n...(截断)' : ''),
        exitCode: code ?? (signal ? -1 : 0),
        timedOut: false
      })
    })
    child.on('error', (err) => {
      clearTimeout(t)
      resolve({ success: false, error: err.message })
    })
  })
}

module.exports = {
  id: 'node',
  name: 'Node.js',
  execute
}
