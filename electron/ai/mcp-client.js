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
  try {
    const fnmDir = path.join(home, '.local', 'share', 'fnm')
    if (fs.existsSync(fnmDir)) {
      const vers = fs.readdirSync(fnmDir)
      for (const v of vers) {
        const bin = path.join(fnmDir, v, 'install', 'bin')
        const binPath = fs.existsSync(bin) ? bin : path.join(fnmDir, v, 'bin')
        if (fs.existsSync(binPath)) entries.push({ bin: binPath, version: parseNodeVersion(v) })
      }
    }
  } catch (_) {}
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
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
      const isBareCommand = !path.isAbsolute(this.command) && this.command.indexOf(path.sep) === -1

      // chrome-devtools-mcp 要求 Node 20.19+，仅使用 Node 20+ 的 PATH，若无则直接报错
      const needNode20 = this.name === 'chrome-devtools'
      if (needNode20) {
        const node20Dirs = getNodeManagerPaths(20)
        if (node20Dirs.length === 0) {
          doReject(new Error(
            '未检测到 Node 20+。chrome-devtools-mcp 需要 Node 20.19 LTS 或更高版本。\n' +
            '请安装后重启应用，例如：\n  nvm install 20 && nvm use 20\n  或 fnm install 20 && fnm use 20'
          ))
          return
        }
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
        console.error(`[MCP:${this.name}] 进程错误:`, err.message)
        doReject(err)
      })

      this.process.on('exit', (code, signal) => {
        console.log(`[MCP:${this.name}] 进程退出，code=${code}, signal=${signal}`)
        this.ready = false
        const tail = this.stderrBuf.slice(-15).join('\n').trim()
        if ((code != null && code !== 0) || signal) {
          if (tail) console.error(`[MCP:${this.name}] 退出前 stderr:\n${tail}`)
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
        console.log(`[MCP:${this.name}] 初始化成功, serverInfo:`, result?.serverInfo?.name)
        // 发送 initialized 通知
        this._sendNotification('notifications/initialized', {})
        // 获取工具列表
        try {
          await this._fetchTools()
        } catch (e) {
          console.warn(`[MCP:${this.name}] 获取工具列表失败:`, e.message)
        }
        this.ready = true
        resolve(this)
      }).catch(doReject)
    })
  }

  async _fetchTools() {
    const result = await this._sendRequest('tools/list', {})
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

  async callTool(originalName, args) {
    if (this.name === 'chrome-devtools' && originalName === 'take_screenshot') {
      await this._ensureChromePageReadyForScreenshot()
    }
    const result = await this._sendRequest('tools/call', {
      name: originalName,
      arguments: args || {}
    })
    // MCP tools/call 返回 { content: [...], isError? }；content 可为 text 或 image（base64）
    if (result?.isError) {
      const errText = result.content?.map(c => c.text || '').join('\n') || '工具执行失败'
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
    for (const c of content) {
      if (c.type === 'image' && c.data) {
        out.image_base64 = c.data
        break
      }
    }
    return Object.keys(out).length ? out : { result: text || '(空)' }
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
    for (const c of content) {
      if (c.type === 'image' && c.data) {
        out.image_base64 = c.data
        break
      }
    }
    return Object.keys(out).length ? out : { result: text || '(空)' }
  }

  async _ensureChromePageReadyForScreenshot() {
    const maxWaitMs = 8000
    const start = Date.now()
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
      if (invalidPage) {
        await this._restartChromeSession('invalid_page_before_screenshot')
        const err = new Error(`chrome-devtools 当前页不可截图: ${href || 'about:blank'}。请先导航到目标页面后再截图。`)
        err.code = 'SCREENSHOT_INVALID_PAGE'
        err.nonRetryable = true
        throw err
      }
      const looksReady = (ready === 'complete' || ready === 'interactive') && (textLen > 0 || childCount > 0)
      if (looksReady) return
      await new Promise((r) => setTimeout(r, 300))
    }
    await this._restartChromeSession('page_not_ready_before_screenshot')
    const err = new Error('chrome-devtools 页面渲染未就绪，截图已中止。请先等待页面加载完成后重试。')
    err.code = 'SCREENSHOT_NOT_READY'
    err.nonRetryable = true
    throw err
  }

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

  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId()
      this.pending.set(id, { resolve, reject })
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      try {
        this.process.stdin.write(msg + '\n')
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
      // 超时保护
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP "${this.name}" 请求超时: ${method}`))
        }
      }, 30000)
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

  async callTool(originalName, args) {
    const result = this.sessionId
      ? await this._postRequest('tools/call', { name: originalName, arguments: args || {} })
      : await this._sendRequest('tools/call', { name: originalName, arguments: args || {} })
    if (result?.isError) {
      return { error: result.content?.map(c => c.text || '').join('\n') || '工具执行失败' }
    }
    const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
    try { return JSON.parse(text) } catch { return { result: text } }
  }

  stop() {
    this.ready = false
  }

  // 新版：POST JSON-RPC，读取响应（可能是 JSON 也可能是 SSE stream）
  _postRequest(method, params) {
    return new Promise((resolve, reject) => {
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

      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        ...(isHttps ? { agent: httpsAgent } : {})
      })

      req.on('response', (res) => {
        // 记录 session id
        const sid = res.headers['mcp-session-id']
        if (sid) this.sessionId = sid

        const ct = res.headers['content-type'] || ''

        // 通知类消息不需要等响应
        if (id === undefined) { res.resume(); resolve(null); return }

        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          // 非 2xx 状态码直接报错
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`[MCP:${this.name}] HTTP ${res.statusCode} ${method}: ${data.substring(0, 200)}`)
            return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`))
          }
          try {
            if (ct.includes('text/event-stream')) {
              // 从 SSE 流中提取 data: {...} 行
              const msg = this._parseSseData(data)
              if (!msg) return reject(new Error(`SSE 响应无有效数据: ${data.substring(0, 200)}`))
              if (msg?.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
              else resolve(msg?.result ?? msg)
            } else {
              const msg = JSON.parse(data)
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
              else resolve(msg.result)
            }
          } catch (e) {
            reject(new Error(`响应解析失败 (${res.statusCode}): ${data.substring(0, 300)}`))
          }
        })
      })

      req.on('error', (err) => {
        console.error(`[MCP:${this.name}] HTTP 请求失败:`, err.message)
        reject(err)
      })
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('请求超时')) })
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
  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
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
      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        ...(isHttps ? { agent: httpsAgent } : {})
      })
      req.on('response', (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`[MCP:${this.name}] HTTP ${res.statusCode} ${method}: ${data.substring(0, 200)}`)
            return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`))
          }
          try {
            const msg = JSON.parse(data)
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
            else resolve(msg.result)
          } catch (e) {
            reject(new Error(`响应解析失败 (${res.statusCode}): ${data.substring(0, 200)}`))
          }
        })
      })
      req.on('error', (err) => {
        console.error(`[MCP:${this.name}] HTTP 请求失败:`, err.message)
        reject(err)
      })
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('请求超时')) })
      req.write(body)
      req.end()
    })
  }
}

// 清除 chrome-devtools-mcp 的 Chrome 用户数据目录下的 Singleton 锁，避免「被占用」导致下次无法启动
function clearChromeDevtoolsProfileLock() {
  const home = process.env.HOME || os.homedir()
  if (!home) return
  const profileDir = path.join(home, '.cache', 'chrome-devtools-mcp', 'chrome-profile')
  try {
    if (!fs.existsSync(profileDir)) return
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
  } catch (e) {
    console.warn('[MCP] clearChromeDevtoolsProfileLock:', e.message)
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
  async callTool(toolName, args) {
    const resolved = this.resolveToolName(toolName)
    if (!resolved) {
      return { error: `MCP 工具 "${toolName}" 不可用（server 未连接）` }
    }
    return await resolved.conn.callTool(resolved.originalName, args)
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
