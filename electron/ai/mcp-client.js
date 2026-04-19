/**
 * MCP Client - 管理本地 MCP server 进程，提供工具列表和工具调用能力
 *
 * 支持两种传输方式：
 *   - stdio: 启动本地子进程（command + args），通过 stdin/stdout 通信
 *   - sse:   连接远程 HTTP SSE 端点（url）
 */

const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const { logger: appLogger } = require('../app-logger')

// 从目录名解析 Node 版本号（如 v18.20.8 -> [18,20,8]），用于排序
const parseNodeVersion = (dirName) => {
  const m = String(dirName).match(/v?(\d+)\.?(\d*)\.?(\d*)/)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 10), parseInt(m[2] || 0, 10), parseInt(m[3] || 0, 10)]
}

// 扫描常见 Node 版本目录（nvm/fnm 等），按版本降序返回
// minMajor: 可选，只返回主版本 >= minMajor 的目录（如 20 表示仅 Node 20+）
const getNodeManagerPaths = (minMajor) => {
  const home = process.env.HOME || os.homedir()
  if (!home) return []
  const entries = [] // { bin, version }
  try {
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmVersions)) {
      const vers = fs.readdirSync(nvmVersions)
      for (const v of vers) {
        const bin = path.join(nvmVersions, v, 'bin')
        if (fs.existsSync(bin)) entries.push({ bin, version: parseNodeVersion(v) })
      }
    }
  } catch (_) {}
  // fnm: macOS 常用 ~/.fnm 或 ~/Library/Application Support/fnm，Linux 常用 ~/.local/share/fnm
  const fnmDirs = [
    path.join(home, '.fnm'),
    path.join(home, 'Library', 'Application Support', 'fnm'),
    path.join(home, '.local', 'share', 'fnm')
  ]
  for (const fnmDir of fnmDirs) {
    try {
      if (!fs.existsSync(fnmDir)) continue
      const vers = fs.readdirSync(fnmDir)
      for (const v of vers) {
        const installBin = path.join(fnmDir, v, 'install', 'bin')
        const plainBin = path.join(fnmDir, v, 'bin')
        const binPath = fs.existsSync(installBin) ? installBin : plainBin
        if (fs.existsSync(binPath)) entries.push({ bin: binPath, version: parseNodeVersion(v) })
      }
      break
    } catch (_) {}
  }
  try {
    const nDir = path.join(home, 'n', 'bin')
    if (fs.existsSync(nDir)) entries.push({ bin: nDir, version: [999, 0, 0] })
  } catch (_) {}
  let filtered = entries
  if (minMajor != null && minMajor > 0) {
    filtered = entries.filter(e => e.version[0] >= minMajor)
  }
  filtered.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (b.version[i] !== a.version[i]) return b.version[i] - a.version[i]
    }
    return 0
  })
  return filtered.map(e => e.bin)
}

// 用户本机常见可执行目录（uv/uvx、pip --user 等）
const getUserBinPaths = () => {
  const home = process.env.HOME || os.homedir()
  if (!home) return []
  const dirs = []
  for (const sub of ['.local/bin', '.cargo/bin']) {
    const d = path.join(home, sub)
    try { if (fs.existsSync(d)) dirs.push(d) } catch (_) {}
  }
  // macOS: ~/Library/Python/*/bin（pip install --user 安装 uvx/uv 等工具的位置）
  if (process.platform === 'darwin') {
    try {
      const pyLibDir = path.join(home, 'Library', 'Python')
      if (fs.existsSync(pyLibDir)) {
        for (const ver of fs.readdirSync(pyLibDir)) {
          const bin = path.join(pyLibDir, ver, 'bin')
          try { if (fs.existsSync(bin)) dirs.push(bin) } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return dirs
}

// 过滤掉会干扰子进程（npx/uvx 等）的 Electron 内部环境变量
const cleanEnvForChild = (env) => {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (key.startsWith('ELECTRON_') || key === 'CHROME_DESKTOP' || key === 'ORIGINAL_XDG_CURRENT_DESKTOP') {
      delete result[key]
    }
  }
  return result
}

const DEFAULT_PYPI_SIMPLE = 'https://pypi.org/simple'

/**
 * uvx 会从父进程继承 UV_INDEX_URL / pip 镜像；部分国内源对个别包返回 403，uv 会报「包不存在」。
 * 对 uvx 子进程：未配置或配置为已知易出问题的镜像时，改用官方 PyPI（仍可在 mcp.json 的 env 里显式写 UV_INDEX_URL 覆盖）。
 */
function fixUvPyPiIndexForMcpStdio(env, command) {
  const cmd = String(command || '').trim()
  if (!cmd) return
  const base = path.basename(cmd).toLowerCase()
  if (cmd !== 'uvx' && base !== 'uvx') return
  const badMirror = (url) =>
    /pypi\.tsinghua\.edu\.cn|mirrors\.tuna\.|tsinghua|mirrors\.aliyun\.com\/pypi|pypi\.douban\.com|mirrors\.cloud\.tencent\.com\/pypi/i.test(
      String(url || '')
    )
  const defIdx = String(env.UV_DEFAULT_INDEX || '').trim()
  const idxUrl = String(env.UV_INDEX_URL || env.UV_DEFAULT_INDEX_URL || '').trim()
  // uv 0.4+ 默认索引用 UV_DEFAULT_INDEX；仅设 UV_INDEX_URL 时仍可能走全局配置里的清华源
  if (!defIdx || badMirror(defIdx)) env.UV_DEFAULT_INDEX = DEFAULT_PYPI_SIMPLE
  if (!idxUrl || badMirror(idxUrl)) env.UV_INDEX_URL = DEFAULT_PYPI_SIMPLE
  delete env.UV_DEFAULT_INDEX_URL
  const pipIdx = String(env.PIP_INDEX_URL || '')
  if (pipIdx && badMirror(pipIdx)) delete env.PIP_INDEX_URL
}

// 正式包下扩展 PATH，确保含 npx/node/uvx 等常见路径（Finder 启动时 process.env.PATH 很精简）
// 顺序：先加系统路径（作为后备），再加 userBins、nodeDirs，这样 nvm/fnm 的 Node 会优先于系统 Node
// minNodeMajor: 可选，若为 20 则只把 Node >= 20 的目录加入前面（用于 chrome-devtools-mcp）
const extendPath = (currentPath, minNodeMajor) => {
  let pathVal = (currentPath || '').trim()
  if (process.platform === 'darwin') {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    for (const p of extra) {
      if (pathVal.indexOf(p) === -1) pathVal = pathVal ? `${p}:${pathVal}` : p
    }
  } else if (process.platform === 'linux') {
    const extra = ['/usr/local/bin', '/usr/bin', '/bin']
    for (const p of extra) {
      if (pathVal.indexOf(p) === -1) pathVal = pathVal ? `${p}:${pathVal}` : extra.join(':')
    }
  }
  for (const d of getUserBinPaths()) {
    if (pathVal.indexOf(d) === -1) pathVal = pathVal ? `${d}:${pathVal}` : d
  }
  const nodeDirs = getNodeManagerPaths(minNodeMajor)
  for (const d of nodeDirs) {
    if (pathVal.indexOf(d) === -1) pathVal = pathVal ? `${d}:${pathVal}` : d
  }
  return pathVal
}

// 正式包下是否用登录 shell 启动 stdio（继承终端 PATH，解决 uvx/npx 等找不到）
const isPackaged = () => {
  try {
    const { app } = require('electron')
    return !!(app && app.isPackaged)
  } catch (_) { return false }
}

const toShArg = (a) => "'" + String(a).replace(/'/g, "'\"'\"'") + "'"

// 若 command 为裸命令名（无路径），在 PATH 中解析为绝对路径，避免正式包 spawn ENOENT
const resolveCommand = (command, pathVal) => {
  if (!command || path.isAbsolute(command) || command.includes(path.sep)) return command
  const sep = process.platform === 'win32' ? ';' : ':'
  const dirs = pathVal ? pathVal.split(sep) : []
  const ext = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const e of ext) {
      const full = path.join(dir, command + e)
      try {
        if (fs.existsSync(full)) return full
      } catch (_) {}
    }
  }
  return command
}

// 正式包或内网环境下，系统/Node 证书链可能与开发机不同，远端 HTTPS 易报证书错误；使用不校验服务端证书的 agent
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

// JSON-RPC id 自增
let _rpcId = 1
const nextId = () => _rpcId++

// 将 MCP server/tool name 转为合法的 function name（只保留 a-z A-Z 0-9 _ -）
const sanitizeName = (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_')

function mcpAbortError() {
  const e = new Error('已取消')
  e.code = 'ABORT_ERR'
  return e
}

// 确保 inputSchema 是合法的 OpenAI function parameters 格式
const sanitizeSchema = (schema) => {
  if (schema && typeof schema === 'object' && schema.type === 'object') return schema
  return {
    type: 'object',
    properties: (schema && typeof schema === 'object') ? (schema.properties || {}) : {},
    required: (schema && typeof schema === 'object') ? (schema.required || []) : []
  }
}

// ──────────────────────────────────────────────
// StdioMcpConnection: 管理单个 stdio MCP server
// ──────────────────────────────────────────────
class StdioMcpConnection {
  constructor(config) {
    this.name = config.name
    this.command = config.command
    this.args = config.args || []
    this.env = config.env || {}
    this.process = null
    this.buffer = ''
    this.stderrBuf = [] // 进程退出时若有 stderr 可帮助排查（如 uvx/mysql 配置错误）
    this.pending = new Map() // id -> { resolve, reject }
    this.tools = []
    this.ready = false
    this._restarting = false
    this._chromeLastNavigatedUrl = ''
    this._chromeRecoverAttempted = false
    this._chromeFallbackNavigateAttempted = false
    this._chromeFallbackNewPageAttempted = false
  }

  async start() {
    return new Promise((resolve, reject) => {
      let rejected = false
      const doReject = (err) => {
        if (rejected) return
        rejected = true
        reject(err)
      }
      // 过滤 Electron 内部变量，避免干扰 npx/node/uvx 等子进程
      const env = cleanEnvForChild({ ...process.env, ...this.env })
      fixUvPyPiIndexForMcpStdio(env, this.command)
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
      const isBareCommand = !path.isAbsolute(this.command) && this.command.indexOf(path.sep) === -1

      // chrome-devtools-mcp 要求 Node 20.19+，仅使用 Node 20+ 的 PATH，若无则直接报错
      const needNode20 = this.name === 'chrome-devtools'
      if (needNode20) {
        const node20Dirs = getNodeManagerPaths(20)
        const allNodeDirs = getNodeManagerPaths(0)
        if (node20Dirs.length === 0) {
          const hint = allNodeDirs.length
            ? `当前检测到 ${allNodeDirs.length} 个 Node 目录但均非 20+（chrome-devtools-mcp 需 Node 20.19+）。请安装 Node 20 并重启应用，例如: nvm install 20 或 fnm install 20`
            : '未检测到 nvm/fnm 下的 Node。chrome-devtools-mcp 需要 Node 20.19+。请先安装 nvm 或 fnm，再执行 nvm install 20 / fnm install 20，并重启应用'
          appLogger?.warn?.(`[MCP:${this.name}] ${hint}`)
          doReject(new Error(hint))
          return
        }
        appLogger?.info?.(`[MCP:${this.name}] 已检测到 Node 20+ 路径，共 ${node20Dirs.length} 个`, { first: node20Dirs[0] })
      }

      let pathVal = env[pathKey] || env.PATH || ''
      pathVal = extendPath(pathVal, needNode20 ? 20 : undefined)
      env[pathKey] = pathVal

      // 先按 PATH 解析为绝对路径，能解析则直接 spawn，不破坏已能用的 npx/uvx
      let commandToRun = resolveCommand(this.command, pathVal)
      if (commandToRun === this.command && process.platform !== 'win32') {
        try {
          const whichPath = execSync(`which ${this.command}`, { encoding: 'utf8', env: { ...env, [pathKey]: pathVal }, timeout: 2000 }).trim()
          if (whichPath && fs.existsSync(whichPath)) commandToRun = whichPath
        } catch (_) {}
      }

      // 正式包下 bare command（uvx/npx 等）用登录 shell 启动；若已解析到绝对路径则直接用绝对路径，
      // 避免 zsh -l 只读 .zprofile 而遗漏 .zshrc 里设置的 PATH（如 ~/Library/Python/*/bin）
      const useLoginShell = process.platform !== 'win32' && isPackaged() && isBareCommand

      const spawnOpts = { env, stdio: ['pipe', 'pipe', 'pipe'] }
      if (useLoginShell) {
        const shell = process.env.SHELL || '/bin/zsh'
        const cmdName = commandToRun !== this.command ? commandToRun : this.command
        let cmdLine = [cmdName, ...this.args].map(toShArg).join(' ')
        // 登录 shell 会 source .zprofile 等并可能覆盖 PATH（导致用到系统 Node 18 而非 nvm 的 20+）
        // 显式注入当前扩展后的 PATH，保证 npx 等用到正确 Node 版本
        const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
        const safePath = (pathVal || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')
        cmdLine = `env ${pathKey}="${safePath}" ${cmdLine}`
        this.process = spawn(shell, ['-l', '-c', cmdLine], spawnOpts)
      } else if (commandToRun !== this.command) {
        this.process = spawn(commandToRun, this.args, spawnOpts)
      } else {
        const cmdLine = [this.command, ...this.args].map(toShArg).join(' ')
        this.process = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', this.command, ...this.args] : ['-c', cmdLine], spawnOpts)
      }

      this.process.stdout.setEncoding('utf-8')
      this.process.stdout.on('data', (chunk) => {
        this.buffer += chunk
        this._processBuffer()
      })

      this.process.stderr.on('data', (data) => {
        const s = data.toString().trim()
        if (s) this.stderrBuf.push(s)
        console.log(`[MCP:${this.name}] stderr:`, s)
      })

      this.process.on('error', (err) => {
        appLogger?.warn?.(`[MCP:${this.name}] 进程错误: ${err.message}`)
        doReject(err)
      })

      this.process.on('exit', (code, signal) => {
        this.ready = false
        const tail = this.stderrBuf.slice(-15).join('\n').trim()
        if ((code != null && code !== 0) || signal) {
          appLogger?.warn?.(`[MCP:${this.name}] 进程退出 code=${code} signal=${signal}`, tail ? { stderrTail: tail } : {})
        }
        const exitMsg = tail
          ? `MCP server "${this.name}" 已退出\n${tail}`
          : `MCP server "${this.name}" 已退出（code=${code}, signal=${signal}）`
        for (const [, { reject: rej }] of this.pending) {
          rej(new Error(exitMsg))
        }
        this.pending.clear()
        doReject(new Error(exitMsg))
      })

      // 发送 initialize 握手
      this._sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'git-manager', version: '1.0.0' }
      }).then(async (result) => {
        appLogger?.info?.(`[MCP:${this.name}] 初始化成功`, { serverInfo: result?.serverInfo?.name })
        // 发送 initialized 通知
        this._sendNotification('notifications/initialized', {})
        // 获取工具列表（chrome-devtools 首次可能未就绪，多等几秒并重试）
        try {
          await this._fetchToolsWithRetry()
        } catch (e) {
          console.warn(`[MCP:${this.name}] 获取工具列表失败:`, e.message)
        }
        this.ready = true
        resolve(this)
      }).catch((err) => {
        appLogger?.warn?.(`[MCP:${this.name}] 启动失败: ${err?.message || err}`)
        doReject(err)
      })
    })
  }

  async _fetchToolsWithRetry() {
    const isChrome = this.name === 'chrome-devtools'
    const maxAttempts = isChrome ? 5 : 1
    const delayMs = isChrome ? 4000 : 0
    const listTimeoutMs = isChrome ? 45000 : 30000
    this.tools = []
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this._fetchTools(listTimeoutMs)
      } catch (e) {
        appLogger?.warn?.(`[MCP:${this.name}] 拉取工具列表失败 (${attempt}/${maxAttempts}): ${e?.message || e}`)
        if (attempt === maxAttempts) return
        if (delayMs > 0) {
          appLogger?.info?.(`[MCP:${this.name}] ${delayMs / 1000}s 后重试…`)
          await new Promise((r) => setTimeout(r, delayMs))
        }
        continue
      }
      if (this.tools && this.tools.length > 0) return
      if (attempt < maxAttempts && delayMs > 0) {
        appLogger?.info?.(`[MCP:${this.name}] 工具列表为空，${delayMs / 1000}s 后重试 (${attempt}/${maxAttempts})`)
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    if (isChrome && (!this.tools || this.tools.length === 0)) {
      appLogger?.warn?.(`[MCP:${this.name}] 多次拉取后仍无工具，请查看上方 [MCP:chrome-devtools] stderr 或稍后重试`)
    }
  }

  async _fetchTools(timeoutMs = 30000) {
    const result = await this._sendRequest('tools/list', {}, timeoutMs)
    this.tools = (result?.tools || []).map(t => {
      const raw = t.inputSchema
      const sanitized = sanitizeSchema(raw)
      if (JSON.stringify(raw) !== JSON.stringify(sanitized)) {
        console.warn(`[MCP:${this.name}] 修复 schema: ${t.name}, 原始:`, JSON.stringify(raw))
      }
      // 打印所有工具的完整 schema 供调试
      console.log(`[MCP:${this.name}] tool schema: ${t.name} =`, JSON.stringify(sanitized))
      return {
        type: 'function',
        function: {
          name: `mcp__${sanitizeName(this.name)}__${sanitizeName(t.name)}`,
          description: `[MCP:${this.name}] ${t.description || t.name}`,
          parameters: sanitized
        },
        _mcpName: this.name,
        _originalName: t.name
      }
    })
    console.log(`[MCP:${this.name}] 加载了 ${this.tools.length} 个工具: ${this.tools.map(t => t._originalName).join(', ')}`)
  }

  async callTool(originalName, args, options = {}) {
    const signal = options?.signal
    if (signal?.aborted) return { error: '已取消' }
    if (this.name === 'chrome-devtools') {
      if ((originalName === 'navigate_page' || originalName === 'new_page') && args && typeof args.url === 'string') {
        const nextUrl = String(args.url || '').trim()
        if (nextUrl && nextUrl !== 'about:blank' && !nextUrl.startsWith('chrome-error://')) {
          this._chromeLastNavigatedUrl = nextUrl
        }
      }
      if (originalName !== 'take_screenshot') {
        this._chromeRecoverAttempted = false
        this._chromeFallbackNavigateAttempted = false
        this._chromeFallbackNewPageAttempted = false
      }
    }
    if (this.name === 'chrome-devtools' && originalName === 'take_screenshot') {
      await this._ensureChromePageReadyForScreenshot()
    }
    // 截图、页面打开/加载等可能较慢（尤其首次打开），使用更长超时；其余 30s
    const longTimeoutTools = ['take_screenshot', 'wait_for_load', 'wait_for', 'new_page', 'navigate_page']
    const longTimeoutMs = 120000 // 120s，避免首次打开或慢网下超时
    const timeoutMs = (this.name === 'chrome-devtools' && longTimeoutTools.includes(originalName)) ? longTimeoutMs : 30000
    let result
    try {
      result = await this._sendRequest('tools/call', {
        name: originalName,
        arguments: args || {}
      }, timeoutMs, signal)
    } catch (e) {
      if (e && (e.code === 'ABORT_ERR' || e.message === '已取消')) {
        return { error: '已取消' }
      }
      const isTimeout = /超时|timeout/i.test(String(e?.message || ''))
      appLogger?.warn?.(`[MCP] ${this.name} 工具 ${originalName} 执行失败${isTimeout ? '（超时）' : ''}: ${e?.message || e}`)
      if (isTimeout && this.name === 'chrome-devtools' && longTimeoutTools.includes(originalName)) {
        appLogger?.warn?.(`[MCP] chrome-devtools ${originalName} 已超时（${timeoutMs / 1000}s），可能原因：首次打开较慢、页面加载过慢、Chrome 未就绪或 CDP 无响应。请查看本日志上方 [MCP:chrome-devtools] 的 stderr 输出。`)
      }
      throw e
    }
    // MCP tools/call 返回 { content: [...], isError? }；content 可为 text 或 image（base64）
    if (result?.isError) {
      const errText = result.content?.map(c => c.text || '').join('\n') || '工具执行失败'
      console.warn(`[MCP:${this.name}] 工具 ${originalName} 失败:`, errText.slice(0, 200))
      return { error: errText }
    }
    const content = result?.content || []
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    let out
    try {
      out = text ? JSON.parse(text) : {}
    } catch {
      out = text ? { result: text } : {}
    }
    // 若有 image 部分（如 chrome-devtools take_screenshot 返回的 base64），并入同一对象供飞书发图等使用
    const imageBase64 = this._extractImageBase64FromContent(content)
    if (imageBase64) out.image_base64 = imageBase64
    // 截图工具成功返回但无 base64 时：若有 filePath/file_path 则视为成功（由主进程复制并生成 file_url 展示），仅当两者都没有时才报错
    if (this.name === 'chrome-devtools' && originalName === 'take_screenshot' && !imageBase64) {
      const hasFilePath = out.filePath || out.file_path || out.path
      if (!hasFilePath) {
        console.warn(`[MCP:${this.name}] take_screenshot 返回成功但无 image 内容，可能 CDP 超时或页面异常`)
        return {
          error: 'chrome-devtools 截图未返回图片数据（可能页面过大或 CDP 超时）。可尝试：1) 先 navigate_page 到目标页再截图；2) 使用 filePath 参数将截图保存到本地文件。',
          ...out
        }
      }
    }
    return Object.keys(out).length ? out : { result: text || '(空)' }
  }

  /** 从 MCP content 数组中提取第一张图片的 base64（支持 data URL 或纯 base64） */
  _extractImageBase64FromContent(content) {
    for (const c of content || []) {
      if (c.type !== 'image') continue
      let raw = c.data || c.source || ''
      if (typeof raw !== 'string' || !raw.length) continue
      // 兼容 data URL：data:image/png;base64,xxx
      const dataUrlMatch = raw.match(/^data:([^;,]+(;[^;,]+)?);base64,(.+)$/i)
      if (dataUrlMatch) raw = dataUrlMatch[3]
      if (raw.length > 0) return raw
    }
    return null
  }

  async _callToolAndParse(originalName, args) {
    const result = await this._sendRequest('tools/call', {
      name: originalName,
      arguments: args || {}
    })
    if (result?.isError) {
      const errText = result.content?.map(c => c.text || '').join('\n') || '工具执行失败'
      throw new Error(errText)
    }
    const content = result?.content || []
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    let out
    try {
      out = text ? JSON.parse(text) : {}
    } catch {
      out = text ? { result: text } : {}
    }
    const imageBase64 = this._extractImageBase64FromContent(content)
    if (imageBase64) out.image_base64 = imageBase64
    return Object.keys(out).length ? out : { result: text || '(空)' }
  }

  async _ensureChromePageReadyForScreenshot() {
    const maxWaitMs = 20000
    const start = Date.now()
    /** 已通过 select_page 切到目标页签（list_pages 中有非空白页），避免再调 new_page 多开标签 */
    let didSelectNonBlankTab = false
    // 导航后给页面一个最小稳定窗口，避免刚完成导航就截图导致空白
    await new Promise((r) => setTimeout(r, 900))
    while (Date.now() - start < maxWaitMs) {
      let state = null
      try {
        state = await this._callToolAndParse('evaluate_script', {
          function: '() => ({ href: location.href, ready: document.readyState, textLen: (document.body && document.body.innerText ? document.body.innerText.trim().length : 0), childCount: (document.body && document.body.children ? document.body.children.length : 0) })'
        })
      } catch (_) {
        state = null
      }
      const href = String((state && state.href) || '').trim()
      const ready = String((state && state.ready) || '').trim().toLowerCase()
      const textLen = Number((state && state.textLen) || 0)
      const childCount = Number((state && state.childCount) || 0)
      const invalidPage = !href || href === 'about:blank' || href.startsWith('chrome-error://')
      if (!invalidPage && href && href !== 'about:blank' && !href.startsWith('chrome-error://')) {
        this._chromeLastNavigatedUrl = href
      }
      if (invalidPage) {
        const preferredUrl = String(this._chromeLastNavigatedUrl || '').trim()
        appLogger?.info?.(`[MCP:${this.name}] 截图前检查: 当前页=${href || 'about:blank'}, preferredUrl=${preferredUrl ? preferredUrl.slice(0, 80) : '(空，需先调用 navigate_page/new_page)'}`)
        if (preferredUrl) {
          console.warn(`[MCP:${this.name}] 当前页为 ${href || 'about:blank'}，将尝试切换到最近导航页: ${preferredUrl.slice(0, 80)}`)
        }
        if (!this._chromeRecoverAttempted) {
          this._chromeRecoverAttempted = true
          try {
            const switched = await this._trySelectNonBlankPage(preferredUrl || undefined)
            if (switched) didSelectNonBlankTab = true
            appLogger?.info?.(`[MCP:${this.name}] 尝试切换页签: switched=${!!switched}`)
            if (switched) {
              // select_page 后 MCP 的「当前页」可能延迟更新，多等一会并多轮再检查，避免误判后去 navigate/new_page
              await new Promise((r) => setTimeout(r, 1200))
              continue
            }
          } catch (e) {
            console.warn(`[MCP:${this.name}] 切换页签失败:`, e.message || String(e))
          }
        }
        // 已通过 select_page 切到目标页签时，不再对「当前页」做 navigate_page（可能作用在错误 tab），也不 new_page（会多开标签）
        if (didSelectNonBlankTab) {
          appLogger?.info?.(`[MCP:${this.name}] 已切换到目标页签，MCP 当前页仍显示 about:blank，直接尝试截图（不 new_page）`)
          return
        }
        if (!this._chromeFallbackNavigateAttempted && preferredUrl && preferredUrl !== 'about:blank' && !preferredUrl.startsWith('chrome-error://')) {
          this._chromeFallbackNavigateAttempted = true
          try {
            appLogger?.info?.(`[MCP:${this.name}] 当前页 about:blank，尝试 navigate_page: ${preferredUrl.slice(0, 60)}`)
            await this._callToolAndParse('navigate_page', { type: 'url', url: preferredUrl, timeout: 15000 })
            await new Promise((r) => setTimeout(r, 900))
            continue
          } catch (e) {
            appLogger?.warn?.(`[MCP:${this.name}] navigate_page 失败:`, e?.message || e)
            console.warn(`[MCP:${this.name}] 无法从 about:blank 恢复到最近页面:`, e.message || String(e))
          }
        }
        // 仅当 list_pages 里没有目标页时再 new_page，避免已有目标页签时多开新标签
        if (!this._chromeFallbackNewPageAttempted && preferredUrl && preferredUrl !== 'about:blank' && !preferredUrl.startsWith('chrome-error://')) {
          this._chromeFallbackNewPageAttempted = true
          try {
            appLogger?.info?.(`[MCP:${this.name}] 当前页仍为 about:blank，尝试 new_page 新标签打开: ${preferredUrl.slice(0, 60)}`)
            await this._callToolAndParse('new_page', { url: preferredUrl })
            await new Promise((r) => setTimeout(r, 1200))
            appLogger?.info?.(`[MCP:${this.name}] new_page 已调用，继续检查页面`)
            continue
          } catch (e) {
            appLogger?.warn?.(`[MCP:${this.name}] new_page 失败: ${e?.message || e}`)
            console.warn(`[MCP:${this.name}] 新标签打开目标页失败:`, e.message || String(e))
          }
        }
        // 再试一次：可能 list_pages 刚返回时目标页还未列出来，此时再切一次
        try {
          const switched = await this._trySelectNonBlankPage(preferredUrl || undefined)
          if (switched) {
            didSelectNonBlankTab = true
            await new Promise((r) => setTimeout(r, 1200))
            continue
          }
        } catch (_) {}
        if (didSelectNonBlankTab) {
          appLogger?.info?.(`[MCP:${this.name}] 已切换到目标页签，直接尝试截图（不 new_page）`)
          return
        }
        if (!preferredUrl) {
          appLogger?.warn?.(`[MCP:${this.name}] 截图前无目标 URL（_chromeLastNavigatedUrl 为空），未执行 new_page。请先让模型调用 navigate_page 或 new_page 再截图。`)
        }
        const err = new Error(`chrome-devtools 当前页不可截图: ${href || 'about:blank'}。请先使用 navigate_page 或 new_page 打开目标页面后再截图。`)
        err.code = 'SCREENSHOT_INVALID_PAGE'
        err.nonRetryable = true
        throw err
      }
      const hasDomSignal = textLen > 0 || childCount > 0
      const looksReady = (ready === 'complete' || ready === 'interactive') && (hasDomSignal || ready === 'complete')
      if (looksReady) return
      await new Promise((r) => setTimeout(r, 300))
    }
    // 页面可能是重前端应用（canvas/异步渲染），就绪信号不稳定；此时不重启会话，放行一次截图尝试
    console.warn(`[MCP:${this.name}] 页面就绪检查超时，放行截图尝试（不重启会话）`)
    return
  }

  /**
   * 仅用于严重异常时恢复（如 CDP 完全断开）。平时不调用，以保持 Chrome 与 MCP 进程常驻，供用户后续继续使用。
   */
  async _restartChromeSession(reason = 'unknown') {
    if (this._restarting) return
    this._restarting = true
    try {
      console.warn(`[MCP:${this.name}] 检测到异常页面状态，重启会话: ${reason}`)
      this.stop()
      await this.start()
    } catch (e) {
      console.error(`[MCP:${this.name}] 重启会话失败:`, e.message || String(e))
    } finally {
      this._restarting = false
    }
  }

  /**
   * 从 list_pages 的文本中解析出页签列表。格式示例：
   *   "## Pages\n1: https://example.com/ [selected]\n2: about:blank"
   */
  _parseListPagesRaw(raw) {
    const entries = []
    const lines = String(raw || '').split('\n')
    for (const line of lines) {
      const m = line.match(/^\s*(\d+):\s*(.+)$/)
      if (!m) continue
      const pageId = Number(m[1])
      let desc = String(m[2] || '').trim()
      if (!Number.isFinite(pageId)) continue
      // 去掉 [selected] 后缀，得到 URL 或 "URL title"
      const url = desc.replace(/\s*\[selected\]\s*$/i, '').trim().split(/\s+/)[0].trim()
      entries.push({ pageId, url, desc })
    }
    return entries
  }

  /**
   * 尝试切换到非空白页。若传入 preferredUrl（最近导航的 URL），优先切换到包含该 URL 的页签。
   * @param {string} [preferredUrl] - 优先匹配的 URL（如小红书），用于在多个 tab 时选对页
   */
  async _trySelectNonBlankPage(preferredUrl) {
    const pages = await this._callToolAndParse('list_pages', {})
    const raw = String((pages && (pages.result || pages.text || pages.content)) || '')
    if (!raw) {
      console.warn(`[MCP:${this.name}] list_pages 返回为空`)
      return false
    }
    const entries = this._parseListPagesRaw(raw)
    if (entries.length === 0) {
      console.warn(`[MCP:${this.name}] list_pages 无法解析，原始:`, raw.slice(0, 200))
      return false
    }
    const preferred = (preferredUrl || '').trim()
    let preferDomain = ''
    try {
      if (preferred && (preferred.startsWith('http://') || preferred.startsWith('https://'))) {
        preferDomain = new URL(preferred).hostname.replace(/^www\./, '')
      }
    } catch (_) {}
    // 优先选择 URL 与 preferredUrl 匹配的页（同一域名或 URL 包含）
    if (preferDomain) {
      for (const { pageId, url, desc } of entries) {
        if (!url || url === 'about:blank' || url.startsWith('chrome-error://')) continue
        try {
          const pageHost = new URL(url).hostname.replace(/^www\./, '')
          if (pageHost === preferDomain || url === preferred || url.indexOf(preferred) !== -1 || preferred.indexOf(url) !== -1) {
            await this._callToolAndParse('select_page', { pageId, bringToFront: true })
            this._chromeLastNavigatedUrl = url
            console.warn(`[MCP:${this.name}] 截图前已切换到目标页签: ${desc}`)
            return true
          }
        } catch (_) { /* url 可能不合法 */ }
      }
    }
    // 否则选第一个非空白页
    for (const { pageId, url, desc } of entries) {
      const lower = (url || '').toLowerCase()
      if (lower.startsWith('about:blank') || lower.startsWith('chrome-error://')) continue
      await this._callToolAndParse('select_page', { pageId, bringToFront: true })
      if (url && url !== 'about:blank' && !url.startsWith('chrome-error://')) {
        this._chromeLastNavigatedUrl = url
      }
      console.warn(`[MCP:${this.name}] 截图前已切换到可用页签: ${desc}`)
      return true
    }
    return false
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.ready = false
  }

  _processBuffer() {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() // 最后一行可能不完整
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        this._handleMessage(msg)
      } catch {
        // 忽略非 JSON 行（可能是日志）
      }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      } else {
        resolve(msg.result)
      }
    }
    // 忽略通知（notifications）
  }

  _sendRequest(method, params, timeoutMs = 30000, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(mcpAbortError())
        return
      }
      const id = nextId()
      let settled = false
      let abortHandler = null
      const clearAbort = () => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
      }
      const finalize = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearAbort()
        if (this.pending.has(id)) this.pending.delete(id)
        fn(arg)
      }
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        const errMsg = `MCP "${this.name}" 请求超时: ${method}`
        appLogger?.warn?.('[MCP]', errMsg)
        finalize(reject, new Error(errMsg))
      }, timeoutMs)
      if (signal) {
        abortHandler = () => {
          if (!this.pending.has(id)) return
          finalize(reject, mcpAbortError())
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }
      this.pending.set(id, {
        resolve: (v) => finalize(resolve, v),
        reject: (e) => finalize(reject, e)
      })
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      try {
        this.process.stdin.write(msg + '\n')
      } catch (e) {
        finalize(reject, e)
      }
    })
  }

  _sendNotification(method, params) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
    try {
      this.process.stdin.write(msg + '\n')
    } catch { /* ignore */ }
  }
}

// ──────────────────────────────────────────────
// SseMcpConnection: 连接远程 HTTP/Streamable-HTTP MCP server
// 兼容两种协议：
//   1. 老版 SSE (GET /sse + POST /message)
//   2. 新版 Streamable HTTP (POST /mcp, 带 Mcp-Session-Id)
// ──────────────────────────────────────────────
class SseMcpConnection {
  constructor(config) {
    // config: { name, url, headers }
    this.name = config.name
    this.url = config.url
    this.extraHeaders = config.headers || {}
    this.tools = []
    this.ready = false
    this.sessionId = null   // Streamable HTTP session
  }

  async start() {
    try {
      await this._initStreamable()
    } catch (e) {
      console.warn(`[MCP:${this.name}] Streamable HTTP 失败，降级简单 POST:`, e.message)
      this.sessionId = null
      try {
        await this._fetchToolsSimple()
      } catch (e2) {
        console.error(`[MCP:${this.name}] 远端连接失败:`, e2.message)
        throw e2
      }
    }
    this.ready = true
    return this
  }

  // 新版 Streamable HTTP: POST initialize → 拿 session → POST tools/list
  async _initStreamable() {
    const initResult = await this._postRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'git-manager', version: '1.0.0' }
    })
    console.log(`[MCP:${this.name}] (HTTP) 初始化成功:`, initResult?.serverInfo?.name)
    // 发送 initialized 通知（fire-and-forget）
    this._postRequest('notifications/initialized', {}).catch(() => {})
    await this._fetchTools()
  }

  async _fetchTools() {
    const result = await this._postRequest('tools/list', {})
    this._applyTools(result?.tools || [])
  }

  async _fetchToolsSimple() {
    const result = await this._sendRequest('tools/list', {})
    this._applyTools(result?.tools || [])
  }

  _applyTools(tools) {
    this.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: `mcp__${sanitizeName(this.name)}__${sanitizeName(t.name)}`,
        description: `[MCP:${this.name}] ${t.description || t.name}`,
        parameters: sanitizeSchema(t.inputSchema)
      },
      _mcpName: this.name,
      _originalName: t.name
    }))
    console.log(`[MCP:${this.name}] 加载了 ${this.tools.length} 个工具`)
  }

  async callTool(originalName, args, options = {}) {
    const signal = options?.signal
    if (signal?.aborted) return { error: '已取消' }
    const toolCallExtra = { signal, timeoutMs: 120000 }
    let result
    try {
      result = this.sessionId
        ? await this._postRequest('tools/call', { name: originalName, arguments: args || {} }, toolCallExtra)
        : await this._sendRequest('tools/call', { name: originalName, arguments: args || {} }, toolCallExtra)
    } catch (e) {
      if (e && (e.code === 'ABORT_ERR' || e.message === '已取消')) return { error: '已取消' }
      throw e
    }
    if (result?.isError) {
      return { error: result.content?.map(c => c.text || '').join('\n') || '工具执行失败' }
    }
    const content = result?.content || []
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    let out
    try { out = text ? JSON.parse(text) : {} } catch { out = text ? { result: text } : {} }
    const imageBase64 = this._extractImageBase64FromContent(content)
    if (imageBase64) out.image_base64 = imageBase64
    return Object.keys(out).length ? out : { result: text || '(空)' }
  }

  _extractImageBase64FromContent(content) {
    for (const c of content || []) {
      if (c.type !== 'image') continue
      let raw = c.data || c.source || ''
      if (typeof raw !== 'string' || !raw.length) continue
      const dataUrlMatch = raw.match(/^data:([^;,]+(;[^;,]+)?);base64,(.+)$/i)
      if (dataUrlMatch) raw = dataUrlMatch[3]
      if (raw.length > 0) return raw
    }
    return null
  }

  stop() {
    this.ready = false
  }

  // 新版：POST JSON-RPC，读取响应（可能是 JSON 也可能是 SSE stream）
  _postRequest(method, params, extra = {}) {
    const { signal, timeoutMs = 30000 } = extra
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(mcpAbortError())
        return
      }
      const id = method.startsWith('notifications/') ? undefined : nextId()
      const body = JSON.stringify({
        jsonrpc: '2.0',
        ...(id !== undefined ? { id } : {}),
        method,
        params
      })
      const url = new URL(this.url)
      const isHttps = url.protocol === 'https:'
      const mod = isHttps ? https : http
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...this.extraHeaders
      }
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

      let settled = false
      let abortHandler = null
      let timeoutTimer = null
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
        fn(arg)
      }

      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        ...(isHttps ? { agent: httpsAgent } : {})
      })

      if (signal) {
        abortHandler = () => {
          try { req.destroy() } catch (_) { /* ignore */ }
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      timeoutTimer = setTimeout(() => {
        try { req.destroy() } catch (_) { /* ignore */ }
        finish(reject, new Error('请求超时'))
      }, timeoutMs)

      req.on('response', (res) => {
        // 记录 session id
        const sid = res.headers['mcp-session-id']
        if (sid) this.sessionId = sid

        const ct = res.headers['content-type'] || ''

        // 通知类消息不需要等响应
        if (id === undefined) {
          res.resume()
          finish(resolve, null)
          return
        }

        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          // 非 2xx 状态码直接报错
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`[MCP:${this.name}] HTTP ${res.statusCode} ${method}: ${data.substring(0, 200)}`)
            return finish(reject, new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`))
          }
          try {
            if (ct.includes('text/event-stream')) {
              // 从 SSE 流中提取 data: {...} 行
              const msg = this._parseSseData(data)
              if (!msg) return finish(reject, new Error(`SSE 响应无有效数据: ${data.substring(0, 200)}`))
              if (msg?.error) finish(reject, new Error(msg.error.message || JSON.stringify(msg.error)))
              else finish(resolve, msg?.result ?? msg)
            } else {
              const msg = JSON.parse(data)
              if (msg.error) finish(reject, new Error(msg.error.message || JSON.stringify(msg.error)))
              else finish(resolve, msg.result)
            }
          } catch (e) {
            finish(reject, new Error(`响应解析失败 (${res.statusCode}): ${data.substring(0, 300)}`))
          }
        })
      })

      req.on('error', (err) => {
        if (!settled) {
          console.error(`[MCP:${this.name}] HTTP 请求失败:`, err.message)
          finish(reject, signal?.aborted ? mcpAbortError() : err)
        }
      })
      req.write(body)
      req.end()
    })
  }

  // 解析 SSE data 行，找到 id 匹配的响应
  _parseSseData(raw) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        try { return JSON.parse(line.slice(5).trim()) } catch { /* skip */ }
      }
    }
    return null
  }

  // 老版简单 POST（无握手，直接发）
  _sendRequest(method, params, extra = {}) {
    const { signal, timeoutMs = 30000 } = extra
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(mcpAbortError())
        return
      }
      const id = nextId()
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      const url = new URL(this.url)
      const isHttps = url.protocol === 'https:'
      const mod = isHttps ? https : http
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...this.extraHeaders
      }
      let settled = false
      let abortHandler = null
      let timeoutTimer = null
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
        fn(arg)
      }

      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        ...(isHttps ? { agent: httpsAgent } : {})
      })

      if (signal) {
        abortHandler = () => {
          try { req.destroy() } catch (_) { /* ignore */ }
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      timeoutTimer = setTimeout(() => {
        try { req.destroy() } catch (_) { /* ignore */ }
        finish(reject, new Error('请求超时'))
      }, timeoutMs)

      req.on('response', (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`[MCP:${this.name}] HTTP ${res.statusCode} ${method}: ${data.substring(0, 200)}`)
            return finish(reject, new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`))
          }
          try {
            const msg = JSON.parse(data)
            if (msg.error) finish(reject, new Error(msg.error.message || JSON.stringify(msg.error)))
            else finish(resolve, msg.result)
          } catch (e) {
            finish(reject, new Error(`响应解析失败 (${res.statusCode}): ${data.substring(0, 200)}`))
          }
        })
      })
      req.on('error', (err) => {
        if (!settled) {
          console.error(`[MCP:${this.name}] HTTP 请求失败:`, err.message)
          finish(reject, signal?.aborted ? mcpAbortError() : err)
        }
      })
      req.write(body)
      req.end()
    })
  }
}

// 清除 chrome-devtools-mcp 的 Chrome 用户数据目录下的 Singleton 锁，避免「被占用」导致下次无法启动
function clearChromeDevtoolsProfileLock() {
  const home = process.env.HOME || os.homedir()
  if (!home) return
  const profileDirs = [
    path.join(home, '.openultron', 'chrome-devtools-profile'),
    path.join(home, '.cache', 'chrome-devtools-mcp', 'chrome-profile') // 兼容旧路径
  ]
  try {
    for (const profileDir of profileDirs) {
      if (!fs.existsSync(profileDir)) continue
      const names = fs.readdirSync(profileDir)
      for (const n of names) {
        if (n.startsWith('Singleton')) {
          const fp = path.join(profileDir, n)
          try {
            fs.unlinkSync(fp)
            console.log('[MCP] 已清除 chrome-devtools 锁文件:', fp)
          } catch (e) {
            console.warn('[MCP] 清除锁文件失败:', fp, e.message)
          }
        }
      }
    }
  } catch (e) {
    console.warn('[MCP] clearChromeDevtoolsProfileLock:', e.message)
  }
}

// 清理遗留的 chrome-devtools-mcp 关联 Chrome 进程（仅匹配专用 profile 路径，避免误杀用户浏览器）
function cleanupChromeDevtoolsOrphans() {
  if (process.platform === 'win32') return
  const home = process.env.HOME || os.homedir()
  if (!home) return
  const markers = [
    path.join(home, '.openultron', 'chrome-devtools-profile'),
    path.join(home, '.cache', 'chrome-devtools-mcp', 'chrome-profile') // 兼容旧路径
  ]
  try {
    const out = execSync('ps -axo pid=,command=', { encoding: 'utf8', timeout: 2500 })
    const lines = String(out || '').split('\n')
    let killed = 0
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = Number(m[1])
      const cmd = String(m[2] || '')
      if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue
      if (!markers.some((marker) => cmd.includes(marker))) continue
      if (!/(chrome|chromium|headless)/i.test(cmd)) continue
      try {
        process.kill(pid, 'SIGKILL')
        killed++
      } catch (_) {}
    }
    if (killed > 0) console.warn(`[MCP] 已清理 chrome-devtools 遗留浏览器进程: ${killed}`)
  } catch (e) {
    console.warn('[MCP] cleanupChromeDevtoolsOrphans:', e.message)
  }
}

// ──────────────────────────────────────────────
// McpManager: 统一管理所有 MCP server 实例
// ──────────────────────────────────────────────
class McpManager {
  constructor() {
    // name -> StdioMcpConnection | SseMcpConnection
    this.connections = new Map()
    // name -> error message (for failed connections)
    this.errors = new Map()
  }

  /**
   * 从 store 的 mcpServers 配置启动所有 server
   * mcpServers: [{ name, type:'stdio'|'sse', command?, args?, env?, url?, headers?, enabled }]
   */
  async startAll(mcpServers = []) {
    const enabled = mcpServers.filter(s => s.enabled !== false)
    const results = await Promise.allSettled(
      enabled.map(cfg => this.startServer({ ...cfg }))
    )
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[MCP] 启动 "${enabled[i].name}" 失败:`, r.reason?.message)
        this.errors.set(enabled[i].name, r.reason?.message || '未知错误')
      }
    })
  }

  async startServer(cfg) {
    // 如果已存在则先停止
    if (this.connections.has(cfg.name)) {
      this.stopServer(cfg.name)
    }
    this.errors.delete(cfg.name)
    // chrome-devtools-mcp 常因上次进程未正常退出留下 Singleton 锁，导致「被占用」无法启动；启动前清除锁
    if (cfg.name === 'chrome-devtools') {
      try {
        appLogger?.info?.('[MCP] chrome-devtools 启动参数', { command: cfg.command, args: Array.isArray(cfg.args) ? cfg.args : [] })
      } catch (_) {}
      cleanupChromeDevtoolsOrphans()
      clearChromeDevtoolsProfileLock()
    }
    const conn = cfg.type === 'sse'
      ? new SseMcpConnection(cfg)
      : new StdioMcpConnection(cfg)
    await conn.start()
    this.connections.set(cfg.name, conn)
    return conn
  }

  stopServer(name) {
    const conn = this.connections.get(name)
    if (conn) {
      conn.stop()
      this.connections.delete(name)
    }
    this.errors.delete(name)
  }

  stopAll() {
    for (const [name] of this.connections) {
      this.stopServer(name)
    }
    this.errors.clear()
  }

  /**
   * 获取所有 MCP server 的工具定义（OpenAI function calling 格式）
   */
  getAllToolDefinitions() {
    const tools = []
    for (const conn of this.connections.values()) {
      if (conn.ready) {
        tools.push(...conn.tools)
      }
    }
    return tools
  }

  /**
   * 根据工具名（mcp__sanitizedServer__sanitizedTool）找到对应的 connection 和原始名
   * 工具名中 server/tool name 已经过 sanitize，需要反查原始连接
   */
  resolveToolName(toolName) {
    // 遍历所有连接，在各自的 tools 里找匹配的 function name
    for (const conn of this.connections.values()) {
      if (!conn.ready) continue
      const tool = conn.tools.find(t => t.function?.name === toolName)
      if (tool) return { conn, originalName: tool._originalName }
    }
    return null
  }

  /**
   * 执行 MCP 工具
   */
  async callTool(toolName, args, options) {
    const resolved = this.resolveToolName(toolName)
    if (!resolved) {
      return { error: `MCP 工具 "${toolName}" 不可用（server 未连接）` }
    }
    return await resolved.conn.callTool(resolved.originalName, args, options)
  }

  /**
   * 获取各 server 的状态（用于前端展示）
   */
  getStatus() {
    const status = {}
    for (const [name, conn] of this.connections) {
      status[name] = {
        ready: conn.ready,
        toolCount: conn.tools.length,
        tools: conn.tools.map(t => ({
          name: t._originalName,
          description: t.function?.description?.replace(`[MCP:${name}] `, '') || ''
        }))
      }
    }
    // 包含连接失败的 server（让前端可以显示错误状态）
    for (const [name, errMsg] of this.errors) {
      if (!status[name]) {
        status[name] = { ready: false, toolCount: 0, tools: [], error: errMsg }
      }
    }
    return status
  }
}

module.exports = { McpManager }
