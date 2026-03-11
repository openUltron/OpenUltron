// AI 工具：在临时工作空间编写并运行脚本（如 Python），用于爬虫、读 Excel/PDF/Word 等
// 工作目录：<workspace>/temp/<task_id>/，脚本可沉淀为技能（install_skill，type: script）供备份与复用

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const { getWorkspacePath } = require('../../app-root')
const executorRegistry = require('../../extensions/executor-registry')

const TEMP_BASE = getWorkspacePath('temp')
const DEFAULT_SCRIPT_TIMEOUT_MS = 90 * 1000
const DEFAULT_PIP_TIMEOUT_MS = 120 * 1000

function ensureTempBase() {
  fs.mkdirSync(TEMP_BASE, { recursive: true })
}

function getTaskDir(taskId) {
  const safe = (taskId || randomUUID()).replace(/[^a-zA-Z0-9_\-]/g, '_')
  return path.join(TEMP_BASE, safe)
}

function runPipInstall(workDir, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('pip3', ['install', '-r', 'requirements.txt', '--target', workDir, '-q'], {
      cwd: workDir,
      shell: false,
      env: process.env
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    const t = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (_) {}
      resolve({ exitCode: -1, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(t)
      resolve({ exitCode: code ?? (signal ? -1 : 0), stdout, stderr, timedOut: false })
    })
    child.on('error', (err) => resolve({ exitCode: -1, stdout: '', stderr: err.message, timedOut: false }))
  })
}

const definition = {
  description: [
    '在临时工作空间（<workspace>/temp/<task_id>/）中编写并运行脚本。',
    '支持 runtime: python（默认）/ node / shell（Bash）。',
    'Python：可传 requirements 自动 pip 安装依赖（如 requests、openpyxl、PyPDF2）。',
    'Node：执行一段 Node.js 脚本（如读写文件、http 请求、数据处理）。',
    'Shell：执行一段 Bash 脚本。',
    '典型场景：爬虫、读 Excel/PDF/Word、数据处理。可复用则用 install_skill 保存为 type: script 技能。'
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的脚本内容（Python/Node/Shell）' },
      runtime: { type: 'string', description: '可选。python | node | shell，默认 python' },
      task_id: { type: 'string', description: '可选。同一任务多次运行可复用同一目录（如写入文件后再次运行）；不传则每次新建' },
      requirements: { type: 'string', description: '可选。仅 Python。requirements.txt 内容，如 "requests\\nopenpyxl"；会先 pip install 再运行脚本' },
      timeout_sec: { type: 'number', description: '脚本运行超时秒数，默认 90' }
    },
    required: ['code']
  }
}

async function execute(args) {
  const { code, runtime = 'python', task_id, requirements, timeout_sec = 90 } = args

  if (!code || typeof code !== 'string') {
    return { success: false, error: '缺少 code 参数' }
  }

  const executor = executorRegistry.get(runtime)
  if (!executor || !executor.execute) {
    return { success: false, error: `未找到执行器: ${runtime}` }
  }

  ensureTempBase()
  const workDir = getTaskDir(task_id)
  fs.mkdirSync(workDir, { recursive: true })

  if (runtime === 'python' && requirements && requirements.trim()) {
    const reqPath = path.join(workDir, 'requirements.txt')
    fs.writeFileSync(reqPath, requirements.trim(), 'utf-8')
    const pipResult = await runPipInstall(workDir, DEFAULT_PIP_TIMEOUT_MS)
    if (pipResult.exitCode !== 0 && pipResult.exitCode !== -1) {
      return {
        success: false,
        error: 'pip 安装依赖失败',
        workDir,
        pip_stdout: pipResult.stdout,
        pip_stderr: pipResult.stderr
      }
    }
  }

  const timeoutMs = Math.min(Math.max(10, timeout_sec) * 1000, 300 * 1000)
  const scriptEnv = { ...process.env }
  if (runtime === 'python' && requirements && requirements.trim()) {
    scriptEnv.PYTHONPATH = workDir
  }
  const result = await executor.execute(
    { script: code.trimEnd(), cwd: workDir, timeout: timeoutMs, env: scriptEnv },
    {}
  )
  return {
    success: result.success && !result.timedOut,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    workDir,
    timedOut: result.timedOut || false,
    ...(result.error ? { error: result.error } : {})
  }
}

module.exports = { definition, execute }
