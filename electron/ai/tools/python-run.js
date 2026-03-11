// AI 工具：在白名单目录下执行 Python 脚本（专用沙箱）
// 白名单：<appRoot>/scripts/、当前会话项目路径（若存在）
// 依赖本机 python3 或 uv，不捆绑解释器

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { getAppRootPath, getWorkspacePath } = require('../../app-root')

const SCRIPTS_DIR = getWorkspacePath('scripts')
const LEGACY_SCRIPTS_DIR = getAppRootPath('scripts')
const DEFAULT_TIMEOUT_MS = 60000
const MAX_STDOUT_LEN = 32 * 1024
const MAX_STDERR_LEN = 8 * 1024

function getAllowedBases(projectPath) {
  const bases = [SCRIPTS_DIR]
  if (fs.existsSync(LEGACY_SCRIPTS_DIR)) {
    bases.push(LEGACY_SCRIPTS_DIR)
  }
  if (projectPath && path.isAbsolute(projectPath) && fs.existsSync(projectPath)) {
    bases.push(path.resolve(projectPath))
  }
  return bases
}

function isPathUnderAllowed(absolutePath, allowedBases) {
  const normalized = path.resolve(absolutePath)
  return allowedBases.some(base => {
    const b = path.resolve(base)
    return normalized === b || normalized.startsWith(b + path.sep)
  })
}

function findPythonCommand() {
  const candidates = ['python3', 'python']
  for (const cmd of candidates) {
    try {
      const { execSync } = require('child_process')
      execSync(`${cmd} --version`, { stdio: 'pipe' })
      return cmd
    } catch (_) {}
  }
  return null
}

function runPython(scriptPath, scriptArgs, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const pythonCmd = findPythonCommand()
    if (!pythonCmd) {
      resolve({
        success: false,
        error: '未检测到 python3 或 python，请在本机安装后重试',
        exitCode: -1,
        stdout: '',
        stderr: ''
      })
      return
    }

    const args = [scriptPath, ...(scriptArgs || [])]
    const child = spawn(pythonCmd, args, {
      cwd: cwd || path.dirname(scriptPath),
      shell: false,
      env: process.env
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (_) {}
      resolve({
        success: false,
        timedOut: true,
        exitCode: -1,
        stdout: stdout.slice(0, MAX_STDOUT_LEN) + (stdout.length > MAX_STDOUT_LEN ? '\n...(截断)' : ''),
        stderr: (stderr + '\n[运行超时被终止]').slice(0, MAX_STDERR_LEN) + (stderr.length > MAX_STDERR_LEN ? '\n...(截断)' : '')
      })
    }, timeoutMs)

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        success: code === 0,
        timedOut: false,
        exitCode: code ?? (signal ? -1 : 0),
        stdout: stdout.slice(0, MAX_STDOUT_LEN) + (stdout.length > MAX_STDOUT_LEN ? '\n...(截断)' : ''),
        stderr: stderr.slice(0, MAX_STDERR_LEN) + (stderr.length > MAX_STDERR_LEN ? '\n...(截断)' : '')
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const definition = {
  description: '在安全白名单目录下执行 Python 脚本并返回输出。白名单：<appRoot>/scripts/ 与当前项目根目录。用于数据分析、本地自动化脚本等；脚本需已存在于上述目录。若需临时写代码执行请用 run_script。',
  parameters: {
    type: 'object',
    properties: {
      script_path: {
        type: 'string',
        description: '脚本路径：相对白名单目录的路径（如 script.py 或 sub/main.py）或绝对路径（必须在白名单内）'
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '传给脚本的命令行参数（可选）'
      },
      cwd: {
        type: 'string',
        description: '工作目录（可选），需在白名单内；不传则使用脚本所在目录'
      },
      timeout: {
        type: 'number',
        description: '超时毫秒数，默认 60000'
      }
    },
    required: ['script_path']
  }
}

async function execute(args, { projectPath = '' } = {}) {
  const { script_path, args: scriptArgs, timeout = DEFAULT_TIMEOUT_MS } = args

  if (!script_path || typeof script_path !== 'string') {
    return { success: false, error: '缺少 script_path 参数' }
  }

  try {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
  } catch (_) {}

  const allowedBases = getAllowedBases(projectPath)
  let scriptAbsolute = path.isAbsolute(script_path)
    ? path.resolve(script_path)
    : path.resolve(SCRIPTS_DIR, script_path)

  if (!isPathUnderAllowed(scriptAbsolute, allowedBases)) {
    return {
      success: false,
      error: `脚本路径不在白名单内。允许的根目录：${allowedBases.join('、')}`
    }
  }

  if (!fs.existsSync(scriptAbsolute) || !fs.statSync(scriptAbsolute).isFile()) {
    return { success: false, error: `脚本不存在或不是文件: ${scriptAbsolute}` }
  }

  const timeoutMs = Math.min(Math.max(5000, timeout), 300000)

  const cwd = args.cwd && path.isAbsolute(args.cwd)
    ? args.cwd
    : (args.cwd ? path.resolve(path.dirname(scriptAbsolute), args.cwd) : path.dirname(scriptAbsolute))
  if (cwd && !isPathUnderAllowed(cwd, allowedBases)) {
    return { success: false, error: 'cwd 不在白名单内' }
  }

  try {
    const result = await runPython(scriptAbsolute, scriptArgs, cwd, timeoutMs)
    return {
      ...result,
      script_path: scriptAbsolute
    }
  } catch (e) {
    return {
      success: false,
      error: e.message || String(e),
      script_path: scriptAbsolute,
      exitCode: -1,
      stdout: '',
      stderr: ''
    }
  }
}

module.exports = { definition, execute }
