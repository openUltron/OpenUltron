const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session, protocol, net } = require('electron')
const path = require('path')
const { exec } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const https = require('https')
const http = require('http')
const { URL, pathToFileURL } = require('url')
const os = require('os')
const Store = (require('electron-store')).default || require('electron-store')
const pty = require('node-pty')
const invokeRegistry = require('./api/invokeRegistry')
const { registerConfigHandlers } = require('./api/registerConfigHandlers')
const { createApiServer, DEFAULT_PORT: API_DEFAULT_PORT } = require('./api/server')
const { getAppRoot, getAppRootPath, getWorkspaceRoot, getWorkspacePath, ensureWorkspaceDirs } = require('./app-root')
const { ingestRoundAttachments } = require('./ai/attachment-ingest')
const { getLogPath, readTail, getForAi, logger: appLogger, patchConsole } = require('./app-logger')
const { filterSessionsList, isRunSessionId } = require('./ai/sessions-list-filter')

// 将主进程 console 同时写入 ~/.openultron/logs/app.log，便于全局排查与 AI 分析
patchConsole()

/** 统一注册：同一 handler 同时供 IPC（应用内）与 HTTP /api/invoke（浏览器/Node）调用，数据源一致 */
function registerChannel(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => handler(event, ...args))
  invokeRegistry.register(channel, (args) => handler(null, ...(Array.isArray(args) ? args : [args])))
}

// 注册自定义协议（必须在 app ready 之前调用）
// local-resource:// 用于安全地向渲染进程提供应用数据根目录下的本地文件
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-resource', privileges: { secure: true, standard: true, supportFetchAPI: true, bypassCSP: false } }
])

// PTY 终端进程管理
const ptyProcesses = new Map()

// 运行中的命令进程管理（用于支持取消操作）
const _runningProcesses = new Map()
let _processIdCounter = 0

const execAsync = promisify(exec)

// ============ 性能优化：git fetch 去重 ============
// 同一仓库短时间内只执行一次 git fetch，避免重复网络请求
const _fetchLocks = new Map() // key: repoPath, value: Promise
const _fetchTimestamps = new Map() // key: repoPath, value: timestamp
const FETCH_DEDUP_INTERVAL = 30 * 1000 // 30秒内不重复 fetch
const FETCH_CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 分钟清理一次过期条目

// 定期清理过期的 fetch 缓存条目，防止内存泄漏
setInterval(() => {
  const now = Date.now()
  for (const [key, timestamp] of _fetchTimestamps) {
    if (now - timestamp > FETCH_CACHE_CLEANUP_INTERVAL) {
      _fetchTimestamps.delete(key)
      _fetchLocks.delete(key)
    }
  }
}, FETCH_CACHE_CLEANUP_INTERVAL)

// ============ 性能优化：git status 短期缓存 ============
// 同一仓库 2 秒内复用上次 status 结果，避免同一刷新周期内重复调用
const _statusCache = new Map() // key: repoPath, value: { result, timestamp }
const STATUS_CACHE_TTL = 2000 // 2 秒

async function cachedGitStatus(repoPath) {
  const cached = _statusCache.get(repoPath)
  if (cached && Date.now() - cached.timestamp < STATUS_CACHE_TTL) {
    return cached.result
  }
  const result = await executeGitCommand('git status --porcelain', repoPath)
  _statusCache.set(repoPath, { result, timestamp: Date.now() })
  return result
}

async function deduplicatedFetch(repoPath) {
  const now = Date.now()
  const lastFetch = _fetchTimestamps.get(repoPath) || 0

  // 如果 30 秒内已经 fetch 过，直接跳过
  if (now - lastFetch < FETCH_DEDUP_INTERVAL) {
    return { success: true, stdout: '', stderr: '', skipped: true }
  }

  // 如果有正在进行的 fetch，复用同一个 Promise
  if (_fetchLocks.has(repoPath)) {
    return _fetchLocks.get(repoPath)
  }

  const fetchPromise = executeGitCommand('git fetch origin --quiet', repoPath)
    .then(result => {
      _fetchTimestamps.set(repoPath, Date.now())
      _fetchLocks.delete(repoPath)
      return result
    })
    .catch(err => {
      _fetchLocks.delete(repoPath)
      return { success: false, error: err.message, stdout: '', stderr: '' }
    })

  _fetchLocks.set(repoPath, fetchPromise)
  return fetchPromise
}

// ============ 性能优化：带并发限制的批量执行 ============
async function promiseAllWithLimit(tasks, limit = 5) {
  const results = []
  let index = 0

  async function runNext() {
    const i = index++
    if (i >= tasks.length) return
    results[i] = await tasks[i]()
    await runNext()
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext())
  await Promise.all(workers)
  return results
}

// ============ 工具函数：判断是否是 Git 写入命令 ============
function isGitWriteCommand(command) {
  if (!command) return false
  return (
    command.includes('git add') || command.includes('git commit') ||
    command.includes('git push') || command.includes('git pull') ||
    command.includes('git merge') || command.includes('git rebase') ||
    command.includes('git checkout') || command.includes('git reset') ||
    command.includes('git stash') || command.includes('git cherry-pick')
  )
}

// ============ 性能优化：GitLab projectId 缓存 ============
const _projectIdCache = new Map() // key: "url|projectPath", value: { id, timestamp }
const PROJECT_ID_CACHE_TTL = 10 * 60 * 1000 // 10 分钟过期

async function getGitlabProjectId(cleanUrl, token, projectPath) {
  const cacheKey = `${cleanUrl}|${projectPath}`
  const cached = _projectIdCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < PROJECT_ID_CACHE_TTL) {
    return { success: true, projectId: cached.id }
  }

  const encodedProjectPath = projectPath.replace(/\//g, '%2F')
  const projectApiUrl = `${cleanUrl}/api/v4/projects/${encodedProjectPath}`

  const projectResponse = await fetch(projectApiUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Git-Project-Viewer/1.0'
    }
  })

  if (!projectResponse.ok) {
    const errorText = await projectResponse.text()
    console.log('❌ 获取项目信息失败:', projectResponse.status, errorText)
    return {
      success: false,
      message: `获取项目信息失败: ${projectResponse.status} ${projectResponse.statusText}`
    }
  }

  const project = await projectResponse.json()
  _projectIdCache.set(cacheKey, { id: project.id, timestamp: Date.now() })
  return { success: true, projectId: project.id }
}

// 创建 fetch 函数（带超时支持）
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const client = isHttps ? https : http
    const timeoutMs = options.timeout || 30000 // 默认 30 秒超时

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: timeoutMs
    }

    const req = client.request(requestOptions, (res) => {
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })

      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data)
        })
      })
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`请求超时 (${timeoutMs / 1000}秒): ${url}`))
    })

    req.on('error', (error) => {
      reject(error)
    })

    if (options.body) {
      req.write(options.body)
    }

    req.end()
  })
}

// 安全的日志函数，避免 EPIPE 错误
const safeLog = (...args) => {
  try {
    if (process.stdout && !process.stdout.destroyed) {
      console.log(...args)
    }
  } catch (e) {
    // 忽略 EPIPE 等输出错误
  }
}

const safeError = (...args) => {
  try {
    if (process.stderr && !process.stderr.destroyed) {
      console.error(...args)
    }
  } catch (e) {
    // 忽略 EPIPE 等输出错误
  }
}

safeLog('🔧 自定义 fetch 函数已设置:', typeof fetch)

// 保持对窗口对象的全局引用
let mainWindow

// 初始化 electron-store
const store = new Store({
  defaults: {
    gitlabConfig: {},
    gitlabHistory: [],
    savedConfigs: [],
    browserFavorites: [],
    browserPasswords: []
  }
})

// 统一数据源：注册到 invokeRegistry，供 IPC 与 HTTP API 共用（Node 直连 + 浏览器访问）
registerConfigHandlers(store)

// 开发环境判断
const isDev = process.env.NODE_ENV === 'development'

// 正式包 UI 端口 28789；开发环境 Vite 用 28791，与正式包同机不冲突
const APP_UI_PORT = 28789
const DEV_UI_PORT = 28791
let appUiServer = null

function startAppUiServer() {
  return new Promise((resolve, reject) => {
    if (appUiServer) return resolve(`http://127.0.0.1:${APP_UI_PORT}`)
    const distPath = path.join(__dirname, '../dist')
    if (!fs.existsSync(distPath)) return reject(new Error('dist 目录不存在'))
    const express = require('express')
    const app = express()
    app.use(express.static(distPath, { index: false }))
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')))
    appUiServer = app.listen(APP_UI_PORT, '127.0.0.1', () => {
      safeLog('App UI server:', `http://127.0.0.1:${APP_UI_PORT}`)
      resolve(`http://127.0.0.1:${APP_UI_PORT}`)
    })
    appUiServer.on('error', reject)
  })
}

function createWindow(productionAppUrl) {
  // 防止重复创建窗口
  if (mainWindow) {
    safeLog('窗口已存在，聚焦到现有窗口')
    mainWindow.focus()
    return
  }
  
  safeLog('Creating window...')
  // 创建浏览器窗口
          mainWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            minWidth: 1200,
            minHeight: 800,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              enableRemoteModule: false,
              preload: path.join(__dirname, 'preload.js'),
              webviewTag: true
            },
            titleBarStyle: 'hidden',
            trafficLightPosition: { x: 8, y: 8 },
            show: false
          })

  if (isDev) {
    // 开发模式：加载 Vite 开发服务器（端口 28791）
    safeLog('Loading development server...')
    mainWindow.loadURL('http://localhost:' + DEV_UI_PORT)
    mainWindow.webContents.openDevTools()
  } else {
    // 生产模式：通过本地 HTTP 服务加载（支持 History 模式 /chat 等无 #）
    const url = productionAppUrl || `http://127.0.0.1:${APP_UI_PORT}`
    safeLog('Loading production build from', url)
    mainWindow.loadURL(url)
  }

  // 当窗口准备好显示时显示
  mainWindow.once('ready-to-show', () => {
    safeLog('Window ready to show, showing window...')
    mainWindow.show()
  })

  // 监听页面加载完成（冷启动时在此再试一次飞书连接，确保窗口就绪后能连上）
  mainWindow.webContents.on('did-finish-load', () => {
    safeLog('Page finished loading')
    if (typeof startFeishuReceive === 'function') {
      startFeishuReceive().catch(e => console.warn('[Feishu] 窗口加载后启动接收失败:', e.message))
    }
  })

  // 监听页面加载失败
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    safeError('Page failed to load:', errorCode, errorDescription, validatedURL)
    // 在开发模式下，如果加载失败，尝试重新加载
    if (isDev) {
      safeLog('Retrying to load...')
      setTimeout(() => {
        mainWindow.loadURL('http://localhost:' + DEV_UI_PORT)
      }, 1000)
    }
  })

  // 开发模式下，监听 Vite HMR 更新，自动刷新窗口
  if (isDev) {
    // Vite 的 HMR 会自动处理大部分更新，但我们也可以监听文件变化
    // 注意：Vite 已经通过 websocket 处理 HMR，这里主要是备用方案
    mainWindow.webContents.on('dom-ready', () => {
      safeLog('DOM ready in development mode')
    })
  }

  // 当用户点击关闭按钮时，隐藏窗口到应用图标而不是关闭
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault()
      mainWindow.hide()
      safeLog('📱 窗口已隐藏到应用图标')
    }
  })

  // 当窗口确实被关闭时（如强制退出）
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 当窗口从后台切换到前台时，主动刷新待定文件检查
  mainWindow.on('focus', () => {
    console.log('🔄 窗口获得焦点，主动刷新待定文件检查')
    // 发送消息到渲染进程，触发刷新
    if (mainWindow.webContents) {
      mainWindow.webContents.send('refresh-on-focus')
      console.log('📡 [主进程] 已发送 refresh-on-focus 事件到前端')
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 在应用内打开新窗口而不是外部浏览器
             const newWindow = new BrowserWindow({
               width: 1400,
               height: 900,
               minWidth: 1200,
               minHeight: 800,
               webPreferences: {
                 nodeIntegration: false,
                 contextIsolation: true,
                 enableRemoteModule: false,
                 preload: path.join(__dirname, 'preload.js')
               },
               titleBarStyle: 'hidden',
               trafficLightPosition: { x: 8, y: 8 },
               show: false
             })

    newWindow.loadURL(url)
    newWindow.once('ready-to-show', () => {
      newWindow.show()
    })

    // 为新窗口也添加隐藏行为
    newWindow.on('close', (event) => {
      if (!app.isQuiting) {
        event.preventDefault()
        newWindow.hide()
        console.log('📱 新窗口已隐藏到应用图标')
      }
    })

    newWindow.on('closed', () => {
      // 窗口关闭时清理引用
    })

    return { action: 'allow' }
  })

  createMenu()
}

// Git 操作函数
async function executeGitCommand(command, cwd) {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd })
    return { success: true, stdout: stdout || '', stderr: stderr || '' }
  } catch (error) {
    return { 
      success: false, 
      error: error.message, 
      stdout: error.stdout || '', 
      stderr: error.stderr || '' 
    }
  }
}

// 检查并修正Git仓库的remote地址
async function checkAndFixRemoteUrl(repoPath, correctUrl, projectName) {
  if (!correctUrl || !correctUrl.includes('git@')) {
    return { success: true, message: '', fixed: false }
  }
  
  try {
    console.log(`🔍 检查项目 ${projectName} 的remote地址`)
    
    // 获取当前remote地址
    const remoteResult = await executeGitCommand('git remote get-url origin', repoPath)
    
    if (remoteResult.success && remoteResult.stdout) {
      const currentUrl = remoteResult.stdout.trim()
      console.log(`📋 当前remote地址: ${currentUrl}`)
      console.log(`🎯 正确的remote地址: ${correctUrl}`)
      
      if (currentUrl === correctUrl) {
        console.log(`✅ 远程地址正确: ${projectName}`)
        return { success: true, message: '', fixed: false }
      } else {
        console.log(`🔧 需要修正remote地址: ${projectName}`)
        
        // 修正remote地址
        const fixResult = await executeGitCommand(`git remote set-url origin "${correctUrl}"`, repoPath)
        
        if (fixResult.success) {
          console.log(`✅ remote地址修正成功: ${projectName}`)
          return { success: true, message: `已修正remote地址: ${correctUrl}`, fixed: true }
        } else {
          console.log(`❌ remote地址修正失败: ${projectName}`)
          return { success: false, message: `修正remote地址失败: ${fixResult.stderr}`, fixed: false }
        }
      }
    } else {
      // 如果没有origin remote，创建它
      console.log(`🔧 创建origin remote: ${projectName}`)
      const addRemoteResult = await executeGitCommand(`git remote add origin "${correctUrl}"`, repoPath)
      
      if (addRemoteResult.success) {
        console.log(`✅ origin remote创建成功: ${projectName}`)
        return { success: true, message: `已创建origin remote: ${correctUrl}`, fixed: true }
      } else {
        console.log(`❌ origin remote创建失败: ${projectName}`)
        return { success: false, message: `创建origin remote失败: ${addRemoteResult.stderr}`, fixed: false }
      }
    }
  } catch (error) {
    console.error(`❌ 检查remote地址失败 ${projectName}:`, error.message)
    return { success: false, message: `检查remote地址失败: ${error.message}`, fixed: false }
  }
}

// 带实时输出的Git命令执行
async function executeGitCommandWithOutput(command, cwd, processCallback = null) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process')
    
    console.log(`📡 执行命令: ${command.join(' ')}`)
    console.log(`📍 工作目录: ${cwd}`)
    
    // 找到主窗口发送实时事件
    const windows = BrowserWindow.getAllWindows()
    // 开发环境找 localhost:28791，生产环境找 127.0.0.1:28789
    const mainWindow = windows.find(w => {
      const u = w.webContents.getURL()
      return u.includes('localhost:' + DEV_UI_PORT) || u.includes('127.0.0.1:' + APP_UI_PORT)
    }) || windows[0]

    console.log(`🔍 当前窗口数量: ${windows.length}`)
    console.log(`🔍 找到的窗口URL: ${mainWindow ? mainWindow.webContents.getURL() : 'null'}`)
    
    if (mainWindow) {
      console.log(`🎯 发送实时事件到前端: ${JSON.stringify({
        projectName: 'unknown',
        output: `开始执行: ${command.join(' ')}`,
        type: 'stdout'
      })}`)
      console.log(`🎯 发送到窗口URL: ${mainWindow.webContents.getURL()}`)
    }
    
    const child = spawn(command[0], command.slice(1), {
      cwd: cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    let stdoutData = ''
    let stderrData = ''
    
    child.stdout.on('data', (data) => {
      const output = data.toString()
      stdoutData += output
      console.log('📋 stdout:', output.trim())
      
      // 发送实时事件到前端
      if (mainWindow) {
        console.log(`📡 发送实时事件到前端: ${JSON}`)
        mainWindow.webContents.send('git-output-update', {
          projectName: 'unknown',
          output: output.trim(),
          type: 'stdout'
        })
        console.log(`🎯 发送到窗口URL: ${mainWindow.webContents.getURL()}`)
      }
      
      if (processCallback) {
        processCallback(output.trim(), 'stdout')
      }
    })
    
    child.stderr.on('data', (data) => {
      const output = data.toString()
      stderrData += output
      console.log('📋 stderr:', output.trim())
      
      // 发送实时事件到前端
      if (mainWindow) {
        console.log(`📡 发送实时事件到前端: ${JSON.stringify({
          projectName: 'unknown',
          output: output.trim(),
          type: 'stderr'
        })}`)
        mainWindow.webContents.send('git-output-update', {
          projectName: 'unknown',
          output: output.trim(),
          type: 'stderr'
        })
        console.log(`🎯 发送到窗口URL: ${mainWindow.webContents.getURL()}`)
      }
      
      if (processCallback) {
        processCallback(output.trim(), 'stderr')
      }
    })
    
    child.on('close', (code) => {
      console.log(`📋 命令执行完成，退出码: ${code}`)
      console.log(`📋 克隆结果: ${command.includes('clone') ? '成功' : '未知'} - ${code === 0 ? '成功' : '失败'}`)
      resolve({
        success: code === 0,
        code: code,
        stdout: stdoutData,
        stderr: stderrData
      })
    })
    
    child.on('error', (error) => {
      console.error(`❌ 命令执行错误: ${error.message}`)
      resolve({
        success: false,
        error: error.message,
        stdout: stdoutData,
        stderr: stderrData
      })
    })
  })
}

function createMenu() {
  const template = [
    {
      label: '应用',
      submenu: [
        { label: '关于', role: 'about' },
        { type: 'separator' },
        { label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'Command+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+Command+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'Command+X', role: 'cut' },
        { label: '复制', accelerator: 'Command+C', role: 'copy' },
        { label: '粘贴', accelerator: 'Command+V', role: 'paste' },
        { label: '全选', accelerator: 'Command+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { 
          label: '重新加载当前标签页', 
          accelerator: 'Command+R', 
          click: () => {
            console.log('⌨️ Command+R 快捷键被触发')
            // 向渲染进程发送刷新当前标签页的消息
            if (mainWindow && mainWindow.webContents) {
              console.log('📡 发送 refresh-current-tab 消息到渲染进程')
              mainWindow.webContents.send('refresh-current-tab')
            } else {
              console.log('❌ mainWindow 或 webContents 不可用')
            }
          }
        },
        { label: '强制重新加载', accelerator: 'Command+Shift+R', role: 'forceReload' },
        { label: '切换开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { 
          label: '打开 Webview 开发者工具', 
          accelerator: 'Command+Option+I',
          click: () => {
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('open-webview-devtools')
            }
          }
        },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'Command+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'Command+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'Command+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', accelerator: 'Ctrl+Command+F', role: 'togglefullscreen' }
      ]
    },
    {
      label: '收藏',
      submenu: [
        {
          label: '导出收藏',
          click: () => {
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('export-favorites')
            }
          }
        },
        {
          label: '导入收藏',
          click: () => {
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('import-favorites')
            }
          }
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'Command+M', role: 'minimize' },
        { label: '关闭', accelerator: 'Command+W', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '了解更多',
          click: () => {
            shell.openExternal('https://github.com/your-repo/git-manager')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// 当 Electron 完成初始化并准备创建浏览器窗口时调用此方法
console.log('Electron app starting...')

// 前端调试日志处理器
registerChannel('log-to-frontend', async (event, message) => {
  console.log(`🔍 前台调试: ${message}`)
  return true
})

// 日志页：路径、tail、供 AI 分析
registerChannel('logs-get-path', () => getLogPath())
registerChannel('logs-read-tail', (event, lines) => readTail(lines == null ? 2000 : lines))
registerChannel('logs-get-for-ai', (event, lines) => getForAi(lines == null ? 500 : lines))

// 窗口操作（用于自定义标题栏：Mac 预留红绿灯空间 + 拖拽，Windows 提供 min/max/close）
function getMainOrFocusedWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
}
registerChannel('window-minimize', async () => {
  const window = getMainOrFocusedWindow()
  if (window) window.minimize()
  return { success: !!window }
})
registerChannel('window-close', async () => {
  const window = getMainOrFocusedWindow()
  if (window) window.close()
  return { success: !!window }
})
registerChannel('toggle-maximize', async (event) => {
  try {
    const window = getMainOrFocusedWindow()
    if (!window) {
      return { success: false, error: 'No window found' }
    }
    if (window.isMaximized()) {
      window.unmaximize()
      return { success: true, maximized: false }
    } else {
      window.maximize()
      return { success: true, maximized: true }
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// Store 已在文件顶部声明

// 刷新相关处理器
registerChannel('send-refresh-on-focus', async (event) => {
  try {
    // 发送刷新事件到渲染进程（用于地址栏刷新按钮或 Command+R）
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('refresh-on-focus')
      console.log('📡 [主进程] 手动触发 refresh-on-focus 事件')
    }
    return true
  } catch (error) {
    console.error('❌ 发送刷新事件失败:', error.message)
    return false
  }
})

registerChannel('notify-refresh-complete', async (event) => {
  try {
    // 通知刷新完成
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('refresh-complete')
      console.log('📡 [主进程] 发送 refresh-complete 事件')
    }
    return true
  } catch (error) {
    console.error('❌ 发送刷新完成事件失败:', error.message)
    return false
  }
})

// 配置存储：仅 IPC 转发到 invokeRegistry（实现已在 registerConfigHandlers 中注册，HTTP 直连 invokeRegistry）
// get-api-base-url 也进 registry，便于浏览器查询 API 地址
registerChannel('get-api-base-url', () => ({
  url: apiServerPort ? `http://127.0.0.1:${apiServerPort}` : null,
  port: apiServerPort || null
}))

ipcMain.handle('get-config', (event, key) => invokeRegistry.invoke('get-config', [key]))
ipcMain.handle('set-config', (event, key, value) => invokeRegistry.invoke('set-config', [key, value]))
ipcMain.handle('get-all-configs', () => invokeRegistry.invoke('get-all-configs', []))
ipcMain.handle('save-config', (event, payload) => invokeRegistry.invoke('save-config', [payload]))
ipcMain.handle('save-saved-configs', (event, data) => invokeRegistry.invoke('save-saved-configs', [data]))
ipcMain.handle('get-saved-configs', () => invokeRegistry.invoke('get-saved-configs', []))

registerChannel('delete-saved-config', async (event, index) => {
  try {
    const savedConfigs = store.get('savedConfigs', [])
    if (index >= 0 && index < savedConfigs.length) {
      const deletedConfig = savedConfigs[index]
      savedConfigs.splice(index, 1)
      store.set('savedConfigs', savedConfigs)
      console.log(`✅ 已删除保存配置: ${deletedConfig.path}`)
      return { success: true, message: '删除成功' }
    } else {
      console.error('❌ 无效的保存配置索引:', index)
      return { success: false, message: '无效的索引' }
    }
  } catch (error) {
    console.error('❌ 删除保存配置失败:', error.message)
    return { success: false, message: `删除失败: ${error.message}` }
  }
})

registerChannel('get-current-config', async (event, data) => {
  try {
    const configKey = data && data.path ? data.path : 'default'
    const currentConfig = store.get(`current-config-${configKey}`, null)
    console.log(`📖 获取当前配置${configKey}:`, currentConfig ? '已存在' : 'null')
    return { success: true, config: currentConfig }
  } catch (error) {
    console.error(`❌ 获取当前配置失败:`, error.message)
    return { success: false, message: `获取失败: ${error.message}`, config: null }
  }
})

registerChannel('set-current-config', async (event, data) => {
  try {
    const configKey = data.path || 'default'
    store.set(`current-config-${configKey}`, data.config)
    console.log(`💾 保存当前配置${configKey}:`, data.config)
    return { success: true }
  } catch (error) {
    console.error(`❌ 保存当前配置失败:`, error.message)
    return { success: false, message: `保存失败: ${error.message}` }
  }
})

// 文件系统操作处理器
registerChannel('show-open-dialog', async (event, options) => {
  try {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(mainWindow, options)
    console.log(`📁 打开对话框:`, result.canceled ? '已取消' : `${result.filePaths.length}个路径`)
    return result
  } catch (error) {
    console.error(`❌ 打开对话框失败:`, error.message)
    return { canceled: true, filePaths: [] }
  }
})

// 读取图片文件并返回 base64
registerChannel('read-image-as-base64', async (event, filePath) => {
  try {
    const fs = require('fs')
    const path = require('path')
    
    // 获取文件扩展名来确定 MIME 类型
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }
    const mimeType = mimeTypes[ext] || 'image/jpeg'
    
    // 读取文件并转换为 base64
    const imageBuffer = fs.readFileSync(filePath)
    const base64 = imageBuffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`
    
    console.log(`🖼️ 读取图片成功: ${filePath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`)
    return { success: true, dataUrl }
  } catch (error) {
    console.error(`❌ 读取图片失败:`, error.message)
    return { success: false, error: error.message }
  }
})

// 显示保存对话框
registerChannel('show-save-dialog', async (event, options) => {
  const { dialog } = require('electron')
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath,
      filters: options.filters || [{ name: '所有文件', extensions: ['*'] }]
    })
    return result
  } catch (error) {
    console.error('显示保存对话框失败:', error)
    return { canceled: true, error: error.message }
  }
})

// 保存文件
registerChannel('save-file', async (event, data) => {
  const fs = require('fs')
  try {
    fs.writeFileSync(data.filePath, data.content, 'utf-8')
    console.log(`💾 文件保存成功: ${data.filePath}`)
    return { success: true }
  } catch (error) {
    console.error('保存文件失败:', error)
    return { success: false, error: error.message }
  }
})

// 读取文件
registerChannel('read-file', async (event, filePath) => {
  const fs = require('fs')
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    console.log(`📖 文件读取成功: ${filePath}`)
    return content
  } catch (error) {
    console.error('读取文件失败:', error)
    throw error
  }
})

// 检查并处理 Git 锁文件
async function checkAndRemoveGitLock(cwd) {
  try {
    const lockPath = path.join(cwd, '.git', 'index.lock')
    
    // 检查锁文件是否存在
    if (!fs.existsSync(lockPath)) {
      return { removed: false, reason: 'no_lock' }
    }
    
    console.log('⚠️ 检测到 Git 锁文件:', lockPath)
    
    // 检查锁文件的修改时间（如果超过1分钟，认为是僵尸锁文件）
    const stats = fs.statSync(lockPath)
    const ageSeconds = (Date.now() - stats.mtime.getTime()) / 1000
    
    // 如果锁文件超过1分钟，直接删除（Git 操作通常很快，超过1分钟很可能是僵尸锁）
    if (ageSeconds > 60) {
      console.log(`🔓 锁文件已存在 ${ageSeconds.toFixed(1)} 秒，认为是僵尸锁文件，自动删除`)
      fs.unlinkSync(lockPath)
      return { removed: true, reason: 'stale_lock', age: ageSeconds }
    }
    
    // 如果锁文件较新（小于1分钟），尝试检查是否有 Git 进程
    try {
      const { execSync } = require('child_process')
      // 使用 lsof 检查是否有进程正在使用锁文件（更准确）
      try {
        const lsofResult = execSync(`lsof "${lockPath}" 2>/dev/null || true`, { encoding: 'utf-8', timeout: 1000 })
        if (lsofResult.trim()) {
          console.log('⏳ 检测到有进程正在使用锁文件，等待...')
          return { removed: false, reason: 'file_in_use' }
        }
      } catch (lsofError) {
        // lsof 可能不可用，使用备用方法
        console.log('⚠️ lsof 不可用，使用备用检测方法')
      }
      
      // 备用方法：检查是否有 Git 进程在运行（检查所有 Git 进程，不限制路径）
      const gitProcesses = execSync(`ps aux | grep -E "[g]it|git-|git " | head -5 || true`, { encoding: 'utf-8', timeout: 1000 })
      
      if (!gitProcesses.trim()) {
        console.log('🔓 没有检测到活跃的 Git 进程，删除锁文件')
        fs.unlinkSync(lockPath)
        return { removed: true, reason: 'no_process' }
      } else {
        // 即使有 Git 进程，如果锁文件超过30秒也删除（可能是并发冲突）
        if (ageSeconds > 30) {
          console.log(`🔓 锁文件已存在 ${ageSeconds.toFixed(1)} 秒，即使有 Git 进程也删除（可能是并发冲突）`)
          fs.unlinkSync(lockPath)
          return { removed: true, reason: 'concurrent_conflict', age: ageSeconds }
        }
        console.log('⏳ 检测到活跃的 Git 进程且锁文件较新，等待...')
        return { removed: false, reason: 'active_process' }
      }
    } catch (error) {
      // 如果检查进程失败，保守处理：如果锁文件超过10秒就删除
      if (ageSeconds > 10) {
        console.log(`⚠️ 检查进程失败，但锁文件已存在 ${ageSeconds.toFixed(1)} 秒，删除锁文件:`, error.message)
        fs.unlinkSync(lockPath)
        return { removed: true, reason: 'check_failed', age: ageSeconds }
      }
      console.log('⚠️ 检查进程失败，但锁文件较新，保留:', error.message)
      return { removed: false, reason: 'check_failed_recent' }
    }
  } catch (error) {
    console.error('❌ 处理 Git 锁文件失败:', error.message)
    return { removed: false, reason: 'error', error: error.message }
  }
}

registerChannel('execute-command', async (event, data) => {
  try {
    const cwd = data.cwd || data.path || process.cwd()
    console.log(`⚡ 执行命令: ${data.command} 在 ${cwd}`)

    // 如果是 Git 写入命令，先检查并处理锁文件（读取命令跳过以提升性能）
    if (isGitWriteCommand(data.command)) {
      const lockResult = await checkAndRemoveGitLock(cwd)
      if (lockResult.removed) {
        console.log(`✅ Git 锁文件已处理: ${lockResult.reason}`)
      }
    }
    
    const { spawn } = require('child_process')
    const processId = ++_processIdCounter

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', data.command], {
        cwd: cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      // 注册进程以支持取消
      _runningProcesses.set(processId, child)
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send('command-process-id', { processId })
      }

      let stdout = ''
      let stderr = ''
      let resolved = false

      const cleanup = () => {
        _runningProcesses.delete(processId)
      }

      // 超时保护：默认 120 秒，网络命令 (push/pull/fetch/clone) 给 300 秒
      const isNetworkCmd = data.command && (
        data.command.includes('git push') || data.command.includes('git pull') ||
        data.command.includes('git fetch') || data.command.includes('git clone')
      )
      const timeoutMs = data.timeout || (isNetworkCmd ? 300000 : 120000)
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          console.error(`⏰ 命令执行超时 (${timeoutMs / 1000}s): ${data.command}`)
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 5000)
          resolve({
            success: false,
            output: stdout.trim(),
            stdout: stdout.trim(),
            stderr: `命令执行超时 (${timeoutMs / 1000}秒)`,
            exitCode: -1,
            timeout: true
          })
        }
      }, timeoutMs)

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          console.log(`✅ 命令执行完成，退出码: ${code}`)
          resolve({
            success: code === 0,
            output: stdout.trim(),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code
          })
        }
      })

      child.on('error', (error) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          console.error(`❌ 命令执行失败:`, error.message)
          resolve({
            success: false,
            output: '',
            stdout: stdout.trim(),
            stderr: error.message,
            exitCode: -1
          })
        }
      })
    })
  } catch (error) {
    console.error(`❌ 执行命令异常:`, error.message)
    return { success: false, message: `执行失败: ${error.message}` }
  }
})

// 实时命令执行（支持流式输出）
registerChannel('execute-command-realtime', async (event, data) => {
  try {
    const cwd = data.cwd || data.path || process.cwd()
    console.log(`⚡ 实时执行命令: ${data.command} 在 ${cwd}`)

    // 如果是 Git 写入命令，先检查并处理锁文件（读取命令跳过以提升性能）
    if (isGitWriteCommand(data.command)) {
      const lockResult = await checkAndRemoveGitLock(cwd)
      if (lockResult.removed) {
        console.log(`✅ Git 锁文件已处理: ${lockResult.reason}`)
        if (event?.sender && !event.sender.isDestroyed()) {
          event.sender.send('realtime-command-output', {
            type: 'stdout',
            data: `⚠️ 检测到 Git 锁文件，已自动处理\n`
          })
        }
      }
    }
    
    const { spawn } = require('child_process')
    const processId = ++_processIdCounter

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', data.command], {
        cwd: cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      // 注册进程以支持取消
      _runningProcesses.set(processId, child)
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send('command-process-id', { processId })
      }

      let stdout = ''
      let stderr = ''
      let allOutput = ''
      let resolved = false

      const cleanup = () => {
        _runningProcesses.delete(processId)
      }

      // 超时保护：默认 120 秒，网络命令给 300 秒
      const isNetworkCmd = data.command && (
        data.command.includes('git push') || data.command.includes('git pull') ||
        data.command.includes('git fetch') || data.command.includes('git clone')
      )
      const timeoutMs = data.timeout || (isNetworkCmd ? 300000 : 120000)
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup()
          console.error(`⏰ 实时命令执行超时 (${timeoutMs / 1000}s): ${data.command}`)
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 5000)
          if (event?.sender && !event.sender.isDestroyed()) {
            event.sender.send('realtime-command-output', {
              type: 'complete',
              code: -1,
              output: allOutput.trim(),
              stdout: stdout.trim(),
              stderr: `命令执行超时 (${timeoutMs / 1000}秒)`
            })
          }
          resolve({
            success: false,
            output: allOutput.trim(),
            stdout: stdout.trim(),
            stderr: `命令执行超时 (${timeoutMs / 1000}秒)`,
            exitCode: -1,
            timeout: true
          })
        }
      }, timeoutMs)

      // 监听实时输出（HTTP 调用时 event.sender 为 null，不推送）
      const sendRealtime = (payload) => {
        if (event?.sender && !event.sender.isDestroyed()) event.sender.send('realtime-command-output', payload)
      }
      child.stdout.on('data', (chunk) => {
        const output = chunk.toString()
        stdout += output
        allOutput += output
        sendRealtime({ type: 'stdout', data: output })
      })

      child.stderr.on('data', (chunk) => {
        const output = chunk.toString()
        stderr += output
        allOutput += output
        sendRealtime({ type: 'stderr', data: output })
      })

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          console.log(`✅ 实时命令执行完成，退出码: ${code}`)
          if (event?.sender && !event.sender.isDestroyed()) {
            event.sender.send('realtime-command-output', {
              type: 'complete',
              code: code,
              output: allOutput.trim(),
              stdout: stdout.trim(),
              stderr: stderr.trim()
            })
          }
          resolve({
            success: code === 0,
            output: allOutput.trim(),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code
          })
        }
      })

      child.on('error', (error) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          console.error(`❌ 实时命令执行失败:`, error.message)
          if (event?.sender && !event.sender.isDestroyed()) {
            event.sender.send('realtime-command-output', { type: 'error', error: error.message })
          }
          resolve({
            success: false,
            output: '',
            stdout: stdout.trim(),
            stderr: error.message,
            exitCode: -1
          })
        }
      })
    })
  } catch (error) {
    console.error(`❌ 实时命令执行异常:`, error.message)
    return { success: false, message: `执行失败: ${error.message}` }
  }
})

// 取消正在运行的命令进程
registerChannel('kill-command-process', async (event, { processId }) => {
  try {
    const child = _runningProcesses.get(processId)
    if (child) {
      console.log(`🛑 取消命令进程: ${processId}`)
      child.kill('SIGTERM')
      // 如果 5 秒后还没退出，强制杀掉
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
      }, 5000)
      _runningProcesses.delete(processId)
      return { success: true }
    }
    return { success: false, message: '进程不存在或已结束' }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('open-cursor', async (event, data) => {
  try {
    console.log(`🎨 尝试打开Cursor: ${data.path}`)
    console.log(`🔍 当前工作目录: ${process.cwd()}`)
    console.log(`🔍 Process PATH: ${process.env.PATH}`)
    
    const { spawn } = require('child_process')
    const { shell } = require('electron')
    
    // 尝试使用绝对路径
    const cursorPaths = [
      '/usr/local/bin/cursor',
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      'cursor' // 最后尝试相对路径
    ]
    
    for (const cursorPath of cursorPaths) {
      try {
        console.log(`🚀 尝试路径: ${cursorPath}`)
        
        // 先测试命令是否存在
        const testChild = spawn(cursorPath, ['--version'], { 
          stdio: 'pipe'
        })
        
        let versionOutput = ''
        testChild.stdout.on('data', (data) => {
          versionOutput += data.toString()
        })
        
        await new Promise((resolve, reject) => {
          testChild.on('close', (code) => {
            resolve(code)
          })
          testChild.on('error', (err) => {
            reject(err)
          })
        })
        
        console.log(`✅ Cursor路径有效 ${cursorPath}, 版本输出: ${versionOutput.trim()}`)
        
        // 如果测试成功，正式打开
        const child = spawn(cursorPath, [data.path], { 
          detached: true,
          stdio: 'ignore'
        })
        
        child.unref()
        console.log(`✅ 成功启动Cursor打开: ${data.path}`)
        return { success: true }
        
      } catch (error) {
        console.log(`❌ 路径 ${cursorPath} 失败: ${error.message}`)
        continue
      }
    }
    
    // 所有路径都失败了，降级到Finder
    console.log(`❌ 所有Cursor路径都失败，降级到在Finder中显示文件夹`)
    shell.showItemInFolder(data.path)
    return { success: true, fallback: true, message: 'cursor命令不可用，已在Finder中打开文件夹' }
    
  } catch (error) {
    console.error(`❌ 打开Cursor完全失败:`, error.message)
    const { shell } = require('electron')
    shell.showItemInFolder(data.path)
    return { success: false, message: `打开失败: ${error.message}` }
  }
})

registerChannel('open-terminal', async (event, data) => {
  try {
    const projectPath = data.path
    const terminalApp = data.terminalApp || 'terminal'
    console.log(`💻 打开终端: ${terminalApp} -> ${projectPath}`)
    const { spawn } = require('child_process')

    const appNameMap = {
      terminal: 'Terminal',
      iterm2: 'iTerm',
      warp: 'Warp',
      alacritty: 'Alacritty',
      kitty: 'kitty',
      hyper: 'Hyper',
      tabby: 'Tabby',
      rio: 'Rio'
    }
    const appName = appNameMap[terminalApp] || 'Terminal'
    spawn('open', ['-a', appName, projectPath], { detached: true, stdio: 'ignore' })
    return { success: true }
  } catch (error) {
    console.error(`❌ 打开终端失败:`, error.message)
    return { success: false, message: `打开失败: ${error.message}` }
  }
})

// 检测已安装的终端应用
registerChannel('get-available-terminals', async () => {
  const terminals = [
    { id: 'terminal', name: 'Terminal', desc: 'macOS 内置终端' }
  ]
  const checks = [
    { id: 'iterm2', name: 'iTerm2', desc: '功能强大的终端', path: '/Applications/iTerm.app' },
    { id: 'warp', name: 'Warp', desc: 'AI 驱动的现代终端', path: '/Applications/Warp.app' },
    { id: 'alacritty', name: 'Alacritty', desc: '基于 GPU 加速的终端', path: '/Applications/Alacritty.app' },
    { id: 'kitty', name: 'Kitty', desc: '基于 GPU 的快速终端', path: '/Applications/kitty.app' },
    { id: 'hyper', name: 'Hyper', desc: '基于 Electron 的终端', path: '/Applications/Hyper.app' },
    { id: 'tabby', name: 'Tabby', desc: '可定制的现代终端', path: '/Applications/Tabby.app' },
    { id: 'rio', name: 'Rio', desc: '基于 Rust 的终端', path: '/Applications/Rio.app' }
  ]
  for (const t of checks) {
    if (fs.existsSync(t.path)) {
      terminals.push({ id: t.id, name: t.name, desc: t.desc })
    }
  }
  return { success: true, terminals }
})

registerChannel('open-in-finder', async (event, data) => {
  try {
    let filePath = data.path
    // 支持 local-resource:// URL（如截图）
    if (filePath && filePath.startsWith('local-resource://')) {
      const url = new URL(filePath)
      const relPath = decodeURIComponent((url.host || '') + url.pathname)
      filePath = path.resolve(getAppRoot(), relPath)
    }
    console.log(`📂 在访达中打开: ${filePath}`)
    await shell.openPath(filePath)
    return { success: true }
  } catch (error) {
    console.error(`❌ 打开访达失败:`, error.message)
    return { success: false, message: `打开失败: ${error.message}` }
  }
})

registerChannel('open-external', async (event, url) => {
  try {
    console.log(`🌐 打开外部链接: ${url}`)
    await shell.openExternal(url)
    return { success: true }
  } catch (error) {
    console.error(`❌ 打开外部链接失败:`, error.message)
    return { success: false, message: `打开失败: ${error.message}` }
  }
})

// 全局方法：在新标签页中打开 URL（渲染进程请求）
ipcMain.on('request-open-url-in-new-tab', (event, url) => {
  console.log(`🔗 收到新标签页打开请求: ${url}`)
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('open-url-in-new-tab', url)
  }
})

// 浏览器收藏功能
registerChannel('get-browser-favorites', async (event) => {
  try {
    const favorites = store.get('browserFavorites', [])
    return { success: true, favorites }
  } catch (error) {
    console.error(`❌ 获取浏览器收藏失败:`, error.message)
    return { success: false, message: `获取失败: ${error.message}`, favorites: [] }
  }
})

registerChannel('add-browser-favorite', async (event, { title, url, icon }) => {
  try {
    if (!url) {
      return { success: false, message: 'URL 不能为空' }
    }
    
    const favorites = store.get('browserFavorites', [])
    
    // 检查是否已存在
    const existing = favorites.find(fav => fav.url === url)
    if (existing) {
      return { success: false, message: '该网址已收藏' }
    }
    
    // 提取域名
    let domain = ''
    try {
      const urlObj = new URL(url)
      domain = urlObj.hostname
    } catch (e) {
      // 如果 URL 解析失败，使用 URL 本身
      domain = url
    }
    
    const newFavorite = {
      id: Date.now().toString(),
      title: title || url,
      url: url,
      domain: domain,
      icon: icon || null,
      createdAt: new Date().toISOString()
    }
    
    favorites.push(newFavorite)
    store.set('browserFavorites', favorites)
    
    console.log(`✅ 添加浏览器收藏: ${url}`)
    return { success: true, favorite: newFavorite }
  } catch (error) {
    console.error(`❌ 添加浏览器收藏失败:`, error.message)
    return { success: false, message: `添加失败: ${error.message}` }
  }
})

registerChannel('remove-browser-favorite', async (event, { id }) => {
  try {
    if (!id) {
      return { success: false, message: 'ID 不能为空' }
    }
    
    const favorites = store.get('browserFavorites', [])
    const index = favorites.findIndex(fav => fav.id === id)
    
    if (index === -1) {
      return { success: false, message: '收藏不存在' }
    }
    
    favorites.splice(index, 1)
    store.set('browserFavorites', favorites)
    
    safeLog(`✅ 删除浏览器收藏: ${id}`)
    return { success: true }
  } catch (error) {
    safeError(`❌ 删除浏览器收藏失败:`, error.message)
    return { success: false, message: `删除失败: ${error.message}` }
  }
})

registerChannel('update-browser-favorite', async (event, { id, title, customColor, icon, sortOrder }) => {
  try {
    if (!id) {
      return { success: false, message: 'ID 不能为空' }
    }
    
    const favorites = store.get('browserFavorites', [])
    const index = favorites.findIndex(fav => fav.id === id)
    
    if (index === -1) {
      return { success: false, message: '收藏不存在' }
    }
    
    // 更新标题
    if (title !== undefined) {
      favorites[index].title = title || favorites[index].url
    }
    
    // 更新自定义颜色
    if (customColor !== undefined) {
      favorites[index].customColor = customColor
    }
    
    // 更新图标
    if (icon !== undefined) {
      favorites[index].icon = icon
      favorites[index].iconError = false
    }
    
    // 更新排序
    if (sortOrder !== undefined) {
      favorites[index].sortOrder = sortOrder
    }
    
    favorites[index].updatedAt = new Date().toISOString()
    store.set('browserFavorites', favorites)
    
    safeLog(`✅ 更新浏览器收藏: ${id}`)
    return { success: true, favorite: favorites[index] }
  } catch (error) {
    safeError(`❌ 更新浏览器收藏失败:`, error.message)
    return { success: false, message: `更新失败: ${error.message}` }
  }
})

// 批量更新收藏排序
registerChannel('save-browser-favorites-order', async (event, orderedIds) => {
  try {
    if (!Array.isArray(orderedIds)) {
      return { success: false, message: '排序数据格式错误' }
    }
    
    const favorites = store.get('browserFavorites', [])
    
    // 更新每个收藏的 sortOrder
    orderedIds.forEach((id, index) => {
      const favIndex = favorites.findIndex(fav => fav.id === id)
      if (favIndex !== -1) {
        favorites[favIndex].sortOrder = index
      }
    })
    
    store.set('browserFavorites', favorites)
    
    safeLog(`✅ 批量更新收藏排序: ${orderedIds.length} 个`)
    return { success: true }
  } catch (error) {
    safeError(`❌ 批量更新收藏排序失败:`, error.message)
    return { success: false, message: `更新失败: ${error.message}` }
  }
})

// 导出收藏数据
registerChannel('export-browser-favorites', async (event) => {
  try {
    const favorites = store.get('browserFavorites', [])
    
    // 显示保存对话框
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出收藏数据',
      defaultPath: 'browser-favorites.json',
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    
    if (result.canceled) {
      return { success: false, message: '用户取消导出' }
    }
    
    // 准备导出数据（包含所有字段）
    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      favorites: favorites.map(fav => ({
        id: fav.id,
        title: fav.title,
        url: fav.url,
        icon: fav.icon,
        domain: fav.domain,
        customColor: fav.customColor,
        createdAt: fav.createdAt,
        updatedAt: fav.updatedAt
      }))
    }
    
    // 写入文件
    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
    
    safeLog(`✅ 导出浏览器收藏成功: ${result.filePath}`)
    return { success: true, filePath: result.filePath, count: favorites.length }
  } catch (error) {
    safeError(`❌ 导出浏览器收藏失败:`, error.message)
    return { success: false, message: `导出失败: ${error.message}` }
  }
})

// 导入收藏数据
registerChannel('import-browser-favorites', async (event) => {
  try {
    // 显示打开对话框
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入收藏数据',
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, message: '用户取消导入' }
    }
    
    const filePath = result.filePaths[0]
    
    // 读取文件
    const fileContent = fs.readFileSync(filePath, 'utf-8')
    const importData = JSON.parse(fileContent)
    
    // 验证数据格式
    if (!importData.favorites || !Array.isArray(importData.favorites)) {
      return { success: false, message: '无效的收藏数据格式' }
    }
    
    const existingFavorites = store.get('browserFavorites', [])
    const importedFavorites = importData.favorites
    
    // 合并策略：如果 URL 已存在，更新；否则添加
    let addedCount = 0
    let updatedCount = 0
    
    importedFavorites.forEach(importedFav => {
      const existingIndex = existingFavorites.findIndex(fav => fav.url === importedFav.url)
      
      if (existingIndex >= 0) {
        // 更新现有收藏（保留原有 ID，更新其他字段）
        existingFavorites[existingIndex] = {
          ...existingFavorites[existingIndex],
          title: importedFav.title || existingFavorites[existingIndex].title,
          icon: importedFav.icon || existingFavorites[existingIndex].icon,
          domain: importedFav.domain || existingFavorites[existingIndex].domain,
          customColor: importedFav.customColor || existingFavorites[existingIndex].customColor,
          updatedAt: new Date().toISOString()
        }
        updatedCount++
      } else {
        // 添加新收藏（生成新 ID）
        const newFavorite = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          title: importedFav.title || importedFav.url,
          url: importedFav.url,
          icon: importedFav.icon || null,
          domain: importedFav.domain || null,
          customColor: importedFav.customColor || null,
          createdAt: importedFav.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        
        // 如果没有 domain，尝试从 URL 提取
        if (!newFavorite.domain && newFavorite.url) {
          try {
            const urlObj = new URL(newFavorite.url)
            newFavorite.domain = urlObj.hostname
          } catch (e) {
            newFavorite.domain = '其他'
          }
        }
        
        existingFavorites.push(newFavorite)
        addedCount++
      }
    })
    
    // 保存到存储
    store.set('browserFavorites', existingFavorites)
    
    safeLog(`✅ 导入浏览器收藏成功: 新增 ${addedCount} 个，更新 ${updatedCount} 个`)
    return { 
      success: true, 
      addedCount, 
      updatedCount, 
      totalCount: existingFavorites.length 
    }
  } catch (error) {
    safeError(`❌ 导入浏览器收藏失败:`, error.message)
    return { success: false, message: `导入失败: ${error.message}` }
  }
})

// 浏览器密码管理功能
registerChannel('get-browser-passwords', async (event) => {
  try {
    const passwords = store.get('browserPasswords', [])
    // 调试：检查读取的密码数据
    if (passwords.length > 0) {
      const firstPassword = passwords[0]
      console.log(`🔐 读取密码数据:`, {
        count: passwords.length,
        firstPasswordLength: firstPassword.password ? firstPassword.password.length : 0,
        firstPasswordPreview: firstPassword.password ? firstPassword.password.substring(0, 3) + '...' : 'null',
        firstPasswordType: typeof firstPassword.password
      })
    }
    // 返回完整密码数据（用于自动填充）
    return { success: true, passwords }
  } catch (error) {
    console.error(`❌ 获取浏览器密码失败:`, error.message)
    return { success: false, message: `获取失败: ${error.message}`, passwords: [] }
  }
})

registerChannel('save-browser-password', async (event, { username, password, domain }) => {
  try {
    if (!username || !password || !domain) {
      return { success: false, message: '用户名、密码和域名不能为空' }
    }
    
    const passwords = store.get('browserPasswords', [])
    
    // 检查是否已存在相同域名和用户名的密码
    const existingIndex = passwords.findIndex(
      pwd => pwd.domain === domain && pwd.username === username
    )
    
    const passwordData = {
      id: existingIndex !== -1 ? passwords[existingIndex].id : Date.now().toString(),
      username,
      password, // 注意：实际应用中应该加密存储
      domain,
      updatedAt: new Date().toISOString(),
      lastUsed: existingIndex !== -1 ? passwords[existingIndex].lastUsed : null
    }
    
    // 调试：检查保存的密码数据
    console.log(`🔐 保存密码数据:`, {
      domain,
      username,
      passwordLength: password ? password.length : 0,
      passwordPreview: password ? password.substring(0, 3) + '...' : 'null',
      passwordType: typeof password
    })
    
    if (existingIndex !== -1) {
      // 更新现有密码（保留 createdAt）
      passwordData.createdAt = passwords[existingIndex].createdAt
      passwords[existingIndex] = passwordData
      console.log(`✅ 更新浏览器密码: ${domain} - ${username}`)
    } else {
      // 添加新密码
      passwordData.createdAt = new Date().toISOString()
      passwords.push(passwordData)
      console.log(`✅ 新增浏览器密码: ${domain} - ${username}`)
    }
    
    store.set('browserPasswords', passwords)
    
    // 验证保存后的数据
    const savedPasswords = store.get('browserPasswords', [])
    const savedPassword = savedPasswords.find(pwd => pwd.id === passwordData.id)
    if (savedPassword) {
      console.log(`🔐 验证保存的密码:`, {
        savedPasswordLength: savedPassword.password ? savedPassword.password.length : 0,
        savedPasswordPreview: savedPassword.password ? savedPassword.password.substring(0, 3) + '...' : 'null',
        savedPasswordType: typeof savedPassword.password,
        matches: savedPassword.password === password
      })
    }
    
    return { success: true }
  } catch (error) {
    console.error(`❌ 保存浏览器密码失败:`, error.message)
    return { success: false, message: `保存失败: ${error.message}` }
  }
})

// 获取完整密码（用于自动填充）
registerChannel('get-browser-password', async (event, { domain, username }) => {
  try {
    const passwords = store.get('browserPasswords', [])
    // 优先匹配域名和用户名，如果没有用户名则只匹配域名
    const password = passwords.find(
      pwd => {
        const domainMatch = pwd.domain === domain || domain.includes(pwd.domain) || pwd.domain.includes(domain)
        if (username) {
          return domainMatch && pwd.username === username
        }
        return domainMatch
      }
    )
    
    if (password) {
      return { 
        success: true, 
        username: password.username,
        password: password.password
      }
    }
    
    return { success: false, message: '未找到匹配的密码' }
  } catch (error) {
    console.error(`❌ 获取浏览器密码失败:`, error.message)
    return { success: false, message: `获取失败: ${error.message}` }
  }
})

// 更新密码的最后使用时间
registerChannel('update-browser-password-used', async (event, { id }) => {
  try {
    if (!id) {
      return { success: false, message: 'ID 不能为空' }
    }
    
    const passwords = store.get('browserPasswords', [])
    const index = passwords.findIndex(pwd => pwd.id === id)
    
    if (index === -1) {
      return { success: false, message: '密码不存在' }
    }
    
    // 更新最后使用时间
    passwords[index].lastUsed = new Date().toISOString()
    store.set('browserPasswords', passwords)
    
    console.log(`✅ 更新密码使用时间: ${id}`)
    return { success: true }
  } catch (error) {
    console.error(`❌ 更新密码使用时间失败:`, error.message)
    return { success: false, message: `更新失败: ${error.message}` }
  }
})

// 清除所有浏览器密码
registerChannel('clear-browser-passwords', async (event) => {
  try {
    store.set('browserPasswords', [])
    console.log('✅ 已清除所有浏览器密码')
    return { success: true }
  } catch (error) {
    console.error(`❌ 清除浏览器密码失败:`, error.message)
    return { success: false, message: `清除失败: ${error.message}` }
  }
})

// 删除指定密码
registerChannel('delete-browser-password', async (event, { id }) => {
  try {
    if (!id) {
      return { success: false, message: 'ID 不能为空' }
    }
    
    const passwords = store.get('browserPasswords', [])
    const index = passwords.findIndex(pwd => pwd.id === id)
    
    if (index === -1) {
      return { success: false, message: '密码不存在' }
    }
    
    passwords.splice(index, 1)
    store.set('browserPasswords', passwords)
    
    console.log(`✅ 删除浏览器密码: ${id}`)
    return { success: true }
  } catch (error) {
    console.error(`❌ 删除浏览器密码失败:`, error.message)
    return { success: false, message: `删除失败: ${error.message}` }
  }
})

// 按域名删除密码
registerChannel('delete-browser-password-by-domain', async (event, { domain }) => {
  try {
    if (!domain) {
      return { success: false, message: '域名不能为空' }
    }
    
    const passwords = store.get('browserPasswords', [])
    const beforeCount = passwords.length
    
    // 删除匹配域名的所有密码
    const filtered = passwords.filter(pwd => pwd.domain !== domain)
    const deletedCount = beforeCount - filtered.length
    
    store.set('browserPasswords', filtered)
    
    console.log(`✅ 删除域名 ${domain} 的密码: ${deletedCount} 个`)
    return { success: true, deletedCount }
  } catch (error) {
    console.error(`❌ 删除域名密码失败:`, error.message)
    return { success: false, message: `删除失败: ${error.message}` }
  }
})

// Git 项目/分支/远程 UI 已移除，get-branch-*、refresh-remote 等 IPC 已删除


// 监听所有 webContents 创建，拦截 webview 中的新窗口请求
app.on('web-contents-created', (event, contents) => {
  // 为所有 webContents（包括 webview）设置新窗口处理器
  contents.setWindowOpenHandler(({ url }) => {
    console.log('🔗 [主进程] 拦截新窗口请求:', url)
    
    // 发送消息到渲染进程，让其在新标签页中打开
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('open-url-in-new-tab', url)
    }
    
    // 阻止默认行为（不创建新窗口）
    return { action: 'deny' }
  })
  
  // 为 webview 设置导航处理
  contents.on('will-navigate', (event, url) => {
    console.log('🔗 [主进程] webContents will-navigate:', url)
  })
})

// ============ MCP HTTP Bridge ============

let mcpHttpServer = null
let apiServer = null
let apiServerPort = null
let mcpBridgePort = null

function findGitRoot(filePath) {
  let dir = path.dirname(filePath)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    dir = path.dirname(dir)
  }
  return null
}

function startMcpBridgeServer() {
  mcpHttpServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const { action, params } = JSON.parse(body)
        if (!mainWindow || mainWindow.isDestroyed()) {
          res.writeHead(503)
          res.end(JSON.stringify({ error: 'Window not available' }))
          return
        }

        if (action === 'open_file' || action === 'open_diff') {
          const filePath = params.filePath
          const projectPath = findGitRoot(filePath)
          if (!projectPath) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: 'Not inside a git repository' }))
            return
          }
          const channel = action === 'open_file' ? 'mcp-open-file' : 'mcp-open-diff'
          mainWindow.webContents.send(channel, { projectPath, filePath })
          mainWindow.show()
          mainWindow.focus()
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true }))
        } else if (action === 'refresh') {
          mainWindow.webContents.send('refresh-on-focus')
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.writeHead(400)
          res.end(JSON.stringify({ error: `Unknown action: ${action}` }))
        }
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
  })

  mcpHttpServer.listen(0, '127.0.0.1', () => {
    mcpBridgePort = mcpHttpServer.address().port
    console.log(`MCP bridge server listening on port ${mcpBridgePort}`)
  })
}

app.whenReady().then(async () => {
  console.log('Electron app ready, creating window...')

  // 注册 local-resource:// 协议：安全地将应用数据根目录下的文件提供给渲染进程
  // URL 格式：local-resource://相对路径  例：local-resource://screenshots/screenshot-123.png
  const appRootBase = getAppRoot()
  session.defaultSession.protocol.handle('local-resource', (request) => {
    try {
      const url = new URL(request.url)
      // url.host + url.pathname 拼合出相对路径，例如 "screenshots/screenshot-123.png"
      const relPath = decodeURIComponent((url.host || '') + url.pathname)
      const fullPath = path.resolve(appRootBase, relPath)
      // 安全校验：只允许访问应用数据根目录下的文件
      if (!fullPath.startsWith(appRootBase + path.sep) && fullPath !== appRootBase) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(fullPath).toString())
    } catch (e) {
      return new Response('Internal Error', { status: 500 })
    }
  })

  // 配置 webview 使用的持久化 session
  // persist: 前缀会自动持久化 cookies, localStorage, IndexedDB 等
  const webviewSession = session.fromPartition('persist:main')
  
  // 允许所有权限请求（包括存储权限）
  webviewSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true)
  })
  
  // 配置存储访问权限
  webviewSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return true
  })
  
  // 设置存储路径（确保使用应用数据目录）
  const userDataPath = app.getPath('userData')
  console.log(`📁 User data path: ${userDataPath}`)
  console.log(`✅ Webview session configured with persist:main`)
  
  if (process.env.NODE_ENV === 'development') {
    createWindow()
  } else {
    startAppUiServer()
      .then((url) => createWindow(url))
      .catch((err) => {
        console.error('启动前端服务失败:', err)
        createWindow() // 降级：无 URL 时仍用 127.0.0.1:APP_UI_PORT
      })
  }

  // ============ MCP HTTP Bridge Server ============
  startMcpBridgeServer()

  // ============ 统一 API 服务（Node 直连 + 浏览器访问，与 IPC 共用数据源）============
  try {
    const { app: apiApp, port: apiPort } = createApiServer({
      port: API_DEFAULT_PORT,
      getGatewayStatus: () => aiGateway.isRunning?.() ?? false
    })
    apiServer = apiApp.listen(apiPort, '127.0.0.1', () => {
      apiServerPort = apiPort
      console.log(`OpenUltron API server: http://127.0.0.1:${apiPort}/api (invokeRegistry)`)
    })
  } catch (e) {
    console.warn('OpenUltron API server failed to start:', e.message)
  }

  // OpenClaw-style Gateway（开发 28792 / 正式 28790）
  aiGateway.start().catch(e => console.warn('[Gateway] start failed:', e.message))

  // 启动所有 MCP servers（app ready 后才 spawn，确保子进程环境正常）
  startSavedMcpServers().catch(err => console.error('[MCP] 启动失败:', err.message))

  // 启动 Heartbeat 定时巡检（每 30 分钟）
  startHeartbeat()
  cronScheduler.start(runHeartbeat)
  // 冷启动：延迟一帧再拉飞书连接，避免 config/窗口未就绪
  setImmediate(() => {
    startFeishuReceive().catch(e => console.warn('[Feishu] 启动接收失败:', e.message))
  })
}).catch((error) => {
  console.error('Error in app.whenReady():', error)
})

// 添加应用退出标记
app.isQuiting = false

app.on('before-quit', async () => {
  app.isQuiting = true

  // Cleanup MCP bridge server
  if (mcpHttpServer) {
    mcpHttpServer.close()
    mcpHttpServer = null
  }
  if (apiServer) {
    apiServer.close()
    apiServer = null
    apiServerPort = null
  }
  if (aiGateway && typeof aiGateway.stop === 'function') {
    aiGateway.stop()
  }
  if (appUiServer) {
    appUiServer.close()
    appUiServer = null
  }

  // 确保 webview session 的所有存储数据被刷新到磁盘
  try {
    const webviewSession = session.fromPartition('persist:main')
    
    // 刷新 cookies
    await webviewSession.cookies.flushStore()
    console.log('✅ Session cookies flushed to disk')
    
    // 刷新存储缓存（包括 localStorage, IndexedDB 等）
    // Electron 会在 session 关闭时自动保存，但显式刷新更可靠
    if (webviewSession.flushStorageData) {
      webviewSession.flushStorageData()
      console.log('✅ Storage data flushed to disk')
    }
    
    // 清理未使用的缓存（可选，保持磁盘空间）
    // await webviewSession.clearCache() // 不清理，保持缓存
    
    console.log('✅ All session data saved')
  } catch (error) {
    console.error('❌ Failed to flush session data:', error)
  }
})

app.on('window-all-closed', () => {
  // 在macOS上，应用会继续运行，即使所有窗口都关闭了
  // 只有当用户明确退出应用时才真正退出
})

app.on('activate', () => {
  // 如果有隐藏的窗口，就显示它们
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show()
    console.log('📱 恢复隐藏的主窗口')
  } else if (BrowserWindow.getAllWindows().length === 0) {
    // 如果没有窗口，创建新窗口
    createWindow()
  }
})

// Git/GitLab/GitHub/Gitee/editor-git IPC 已移除

// ==================== Chrome 扩展管理 ====================

// 存储已加载的扩展信息
const loadedExtensions = new Map()

// 获取 webview 使用的 session（必须与 webview 的 partition 一致）
const getWebviewSession = () => {
  const { session } = require('electron')
  return session.fromPartition('persist:main')
}

// 获取扩展列表
registerChannel('get-extensions', async () => {
  try {
    const webviewSession = getWebviewSession()
    const extensions = webviewSession.getAllExtensions()
    
    const extensionList = extensions.map(ext => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.manifest?.description || '',
      icon: (() => {
        // 使用本地文件路径而不是 chrome-extension:// 协议
        if (!ext.manifest?.icons) return null
        const iconFile = ext.manifest.icons['128'] || ext.manifest.icons['48'] || ext.manifest.icons['32'] || ext.manifest.icons['16']
        if (!iconFile || !ext.path) return null
        const iconPath = path.join(ext.path, iconFile)
        if (fs.existsSync(iconPath)) {
          // 返回 base64 格式的图标
          try {
            const iconBuffer = fs.readFileSync(iconPath)
            const ext_type = iconFile.endsWith('.png') ? 'png' : (iconFile.endsWith('.svg') ? 'svg+xml' : 'png')
            return `data:image/${ext_type};base64,${iconBuffer.toString('base64')}`
          } catch (e) {
            return null
          }
        }
        return null
      })(),
      enabled: loadedExtensions.get(ext.id)?.enabled !== false,
      path: ext.path
    }))
    
    console.log(`🧩 获取扩展列表: ${extensionList.length} 个`)
    return { success: true, extensions: extensionList }
  } catch (error) {
    console.error('❌ 获取扩展列表失败:', error)
    return { success: false, message: error.message, extensions: [] }
  }
})

// 从文件夹加载扩展
registerChannel('load-extension-from-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择扩展目录',
      properties: ['openDirectory'],
      message: '请选择包含 manifest.json 的扩展目录'
    })
    
    if (result.canceled || !result.filePaths.length) {
      return { success: false, message: '用户取消选择' }
    }
    
    const extensionPath = result.filePaths[0]
    
    // 检查 manifest.json 是否存在
    const manifestPath = path.join(extensionPath, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      return { success: false, message: '所选目录不包含 manifest.json 文件' }
    }
    
    // 加载扩展到 webview 使用的 session
    const webviewSession = getWebviewSession()
    const extension = await webviewSession.loadExtension(extensionPath, {
      allowFileAccess: true
    })
    
    // 保存扩展信息
    loadedExtensions.set(extension.id, { 
      path: extensionPath, 
      enabled: true 
    })
    
    // 保存到存储
    const savedExtensions = store.get('loadedExtensions', [])
    if (!savedExtensions.find(e => e.path === extensionPath)) {
      savedExtensions.push({ path: extensionPath, enabled: true })
      store.set('loadedExtensions', savedExtensions)
    }
    
    console.log(`🧩 扩展加载成功: ${extension.name} (${extension.id})`)
    return { 
      success: true, 
      extension: {
        id: extension.id,
        name: extension.name,
        version: extension.version
      }
    }
  } catch (error) {
    console.error('❌ 加载扩展失败:', error)
    return { success: false, message: error.message }
  }
})

// 从 CRX 文件加载扩展（暂不支持，需要解压 CRX）
registerChannel('load-extension-from-crx', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择扩展文件',
      filters: [{ name: 'Chrome 扩展', extensions: ['crx', 'zip'] }],
      properties: ['openFile'],
      message: '请选择 .crx 或 .zip 格式的扩展文件'
    })

    if (result.canceled || !result.filePaths.length) {
      return { success: false, message: '用户取消选择' }
    }

    // CRX 文件需要先解压才能加载
    // 这里暂时返回提示信息
    return {
      success: false,
      message: '暂不支持直接加载 CRX 文件，请先解压扩展后从文件夹加载'
    }
  } catch (error) {
    console.error('❌ 加载 CRX 失败:', error)
    return { success: false, message: error.message }
  }
})

// 获取 Chrome 扩展存放目录
const getChromeExtensionsPath = () => {
  const os = require('os')
  const platform = process.platform
  const homeDir = os.homedir()
  
  if (platform === 'darwin') {
    // macOS
    return path.join(homeDir, 'Library/Application Support/Google/Chrome/Default/Extensions')
  } else if (platform === 'win32') {
    // Windows
    return path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data/Default/Extensions')
  } else {
    // Linux
    const possiblePaths = [
      path.join(homeDir, '.config/google-chrome/Default/Extensions'),
      path.join(homeDir, '.config/google-chrome-beta/Default/Extensions'),
      path.join(homeDir, '.config/chromium/Default/Extensions')
    ]
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p
    }
    return possiblePaths[0]
  }
}

// 从 Chrome 已安装扩展加载
registerChannel('load-extension-from-chrome', async () => {
  try {
    const webviewSession = getWebviewSession()
    const chromeExtPath = getChromeExtensionsPath()
    
    if (!fs.existsSync(chromeExtPath)) {
      return { success: false, message: `未找到 Chrome 扩展目录: ${chromeExtPath}` }
    }
    
    // 扫描扩展目录
    const extDirs = fs.readdirSync(chromeExtPath)
    const loadedExts = []
    
    for (const extId of extDirs) {
      const extPath = path.join(chromeExtPath, extId)
      if (!fs.statSync(extPath).isDirectory()) continue
      
      // 找到最新版本
      const versions = fs.readdirSync(extPath).filter(v => {
        const vPath = path.join(extPath, v)
        return fs.statSync(vPath).isDirectory() && fs.existsSync(path.join(vPath, 'manifest.json'))
      }).sort().reverse()
      
      if (versions.length === 0) continue
      
      const latestVersion = versions[0]
      const extFullPath = path.join(extPath, latestVersion)
      
      try {
        // 读取 manifest 获取扩展名称
        const manifestPath = path.join(extFullPath, 'manifest.json')
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        
        // 检查是否已加载
        const existingExts = webviewSession.getAllExtensions()
        if (existingExts.some(e => e.id === extId)) {
          console.log(`🧩 扩展已加载，跳过: ${manifest.name || extId}`)
          continue
        }
        
        // 加载扩展到 webview session
        const extension = await webviewSession.loadExtension(extFullPath, {
          allowFileAccess: true
        })
        
        loadedExtensions.set(extension.id, { path: extFullPath, enabled: true })
        loadedExts.push({
          id: extension.id,
          name: extension.name,
          version: extension.version
        })
        
        console.log(`🧩 从 Chrome 加载扩展: ${extension.name}`)
      } catch (err) {
        console.warn(`⚠️ 加载扩展失败 ${extId}:`, err.message)
      }
    }
    
    // 保存到存储
    if (loadedExts.length > 0) {
      const savedExtensions = store.get('loadedExtensions', [])
      for (const ext of loadedExts) {
        const extInfo = loadedExtensions.get(ext.id)
        if (extInfo && !savedExtensions.find(e => e.path === extInfo.path)) {
          savedExtensions.push({ path: extInfo.path, enabled: true })
        }
      }
      store.set('loadedExtensions', savedExtensions)
    }
    
    return { success: true, extensions: loadedExts }
  } catch (error) {
    console.error('❌ 从 Chrome 加载扩展失败:', error)
    return { success: false, message: error.message }
  }
})

// 通过扩展 ID 加载（从 Chrome 扩展目录）
registerChannel('load-extension-by-id', async (event, extensionId) => {
  try {
    const webviewSession = getWebviewSession()
    const chromeExtPath = getChromeExtensionsPath()
    
    if (!extensionId || typeof extensionId !== 'string') {
      return { success: false, message: '无效的扩展 ID' }
    }
    
    const extPath = path.join(chromeExtPath, extensionId)
    
    if (!fs.existsSync(extPath)) {
      return { 
        success: false, 
        message: `未找到扩展 ${extensionId}，请确保已在 Chrome 中安装该扩展` 
      }
    }
    
    // 找到最新版本
    const versions = fs.readdirSync(extPath).filter(v => {
      const vPath = path.join(extPath, v)
      return fs.statSync(vPath).isDirectory() && fs.existsSync(path.join(vPath, 'manifest.json'))
    }).sort().reverse()
    
    if (versions.length === 0) {
      return { success: false, message: '扩展目录中未找到有效版本' }
    }
    
    const latestVersion = versions[0]
    const extFullPath = path.join(extPath, latestVersion)
    
    // 检查是否已加载
    const existingExts = webviewSession.getAllExtensions()
    const existing = existingExts.find(e => e.id === extensionId)
    if (existing) {
      return { 
        success: true, 
        extension: { id: existing.id, name: existing.name, version: existing.version },
        message: '扩展已加载'
      }
    }
    
    // 加载扩展到 webview session
    const extension = await webviewSession.loadExtension(extFullPath, {
      allowFileAccess: true
    })
    
    // 保存
    loadedExtensions.set(extension.id, { path: extFullPath, enabled: true })
    const savedExtensions = store.get('loadedExtensions', [])
    if (!savedExtensions.find(e => e.path === extFullPath)) {
      savedExtensions.push({ path: extFullPath, enabled: true })
      store.set('loadedExtensions', savedExtensions)
    }
    
    console.log(`🧩 通过 ID 加载扩展: ${extension.name} (${extension.id})`)
    return { 
      success: true, 
      extension: { id: extension.id, name: extension.name, version: extension.version }
    }
  } catch (error) {
    console.error('❌ 通过 ID 加载扩展失败:', error)
    return { success: false, message: error.message }
  }
})

// 切换扩展启用状态
registerChannel('toggle-extension', async (event, extensionId, enabled) => {
  try {
    const webviewSession = getWebviewSession()
    
    if (enabled) {
      // 启用扩展 - 需要重新加载
      const extInfo = loadedExtensions.get(extensionId)
      if (extInfo && extInfo.path) {
        await webviewSession.loadExtension(extInfo.path, {
          allowFileAccess: true
        })
        loadedExtensions.set(extensionId, { ...extInfo, enabled: true })
      }
    } else {
      // 禁用扩展 - 卸载
      await webviewSession.removeExtension(extensionId)
      const extInfo = loadedExtensions.get(extensionId)
      if (extInfo) {
        loadedExtensions.set(extensionId, { ...extInfo, enabled: false })
      }
    }
    
    // 更新存储
    const savedExtensions = store.get('loadedExtensions', [])
    const updatedExtensions = savedExtensions.map(e => {
      const ext = loadedExtensions.get(extensionId)
      if (ext && e.path === ext.path) {
        return { ...e, enabled }
      }
      return e
    })
    store.set('loadedExtensions', updatedExtensions)
    
    console.log(`🧩 扩展 ${extensionId} 已${enabled ? '启用' : '禁用'}`)
    return { success: true }
  } catch (error) {
    console.error('❌ 切换扩展状态失败:', error)
    return { success: false, message: error.message }
  }
})

// 卸载扩展
registerChannel('remove-extension', async (event, extensionId) => {
  try {
    const webviewSession = getWebviewSession()
    
    await webviewSession.removeExtension(extensionId)
    
    // 从存储中移除
    const extInfo = loadedExtensions.get(extensionId)
    if (extInfo) {
      const savedExtensions = store.get('loadedExtensions', [])
      const updatedExtensions = savedExtensions.filter(e => e.path !== extInfo.path)
      store.set('loadedExtensions', updatedExtensions)
    }
    
    loadedExtensions.delete(extensionId)
    
    console.log(`🧩 扩展 ${extensionId} 已卸载`)
    return { success: true }
  } catch (error) {
    console.error('❌ 卸载扩展失败:', error)
    return { success: false, message: error.message }
  }
})

// 扩展功能暂时禁用
// 清空已保存的扩展配置，避免影响应用
setTimeout(() => {
  try {
    store.set('loadedExtensions', [])
  } catch (error) {
    // ignore
  }
}, 500)

// ==================== 扣子 (Coze) AI API ====================
// 使用服务身份（API Token）方式，简单直接

// 扣子 API 配置
const COZE_API_URL = 'https://api.coze.cn'

// 获取扣子配置
registerChannel('get-coze-config', async () => {
  try {
    const config = store.get('cozeConfig', {})
    return { 
      success: true, 
      config: {
        botId: config.botId || '',
        hasToken: !!config.apiToken
      }
    }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 保存扣子配置（API Token + Bot ID）
registerChannel('save-coze-config', async (event, { apiToken, botId }) => {
  try {
    const config = store.get('cozeConfig', {})
    if (apiToken) {
      config.apiToken = apiToken
    }
    config.botId = botId
    store.set('cozeConfig', config)
    console.log('✅ 扣子配置已保存')
    return { success: true }
  } catch (error) {
    console.error('❌ 保存扣子配置失败:', error)
    return { success: false, message: error.message }
  }
})

// 调用扣子 AI 生成提交信息
registerChannel('coze-generate-commit-message', async (event, { diff, projectPath }) => {
  try {
    
    const config = store.get('cozeConfig', {})
    
    if (!config.apiToken) {
      return { success: false, message: '请先配置 API Token' }
    }
    
    if (!config.botId) {
      return { success: false, message: '请先配置 Bot ID' }
    }

    // 构建请求
    const chatUrl = `${COZE_API_URL}/v3/chat`
    
    // 从 diff 中提取每个文件的关键变更
    const extractFileChanges = (diffContent) => {
      const files = []
      const sections = diffContent.split(/\n(?=\[(新增文件|修改文件|文件)\])/)
      
      for (const section of sections) {
        if (!section.trim()) continue
        
        // 匹配文件标记
        const headerMatch = section.match(/^\[(新增文件|修改文件|文件)\]\s*(.+?)(?:\s*\(|:|\s*$)/m)
        if (!headerMatch) continue
        
        const fileType = headerMatch[1]
        const filePath = headerMatch[2].trim()
        
        // 提取关键的变更行（新增的行，去掉 + 前缀）
        const lines = section.split('\n')
        const keyChanges = []
        
        for (const line of lines) {
          // 跳过 diff 元数据
          if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) continue
          
          // 提取新增和删除的有意义的行
          if (line.startsWith('+') || line.startsWith('-')) {
            const isAdd = line.startsWith('+')
            const content = line.substring(1).trim()
            // 只过滤空行和纯符号行
            if (content && 
                content.length > 2 && 
                !content.match(/^[{}\[\]();,'"` ]+$/)) {
              const prefix = isAdd ? '+' : '-'
              keyChanges.push(prefix + content.substring(0, 200)) // 限制单行长度
              if (keyChanges.length >= 50) break // 每个文件最多 50 行关键变更
            }
          }
        }
        
        files.push({
          type: fileType,
          path: filePath,
          changes: keyChanges
        })
      }
      
      return files
    }
    
    const fileChanges = extractFileChanges(diff)
    
    // 构建详细的变更摘要
    let changeSummary = ''
    for (const file of fileChanges) {
      changeSummary += `\n文件: ${file.path} [${file.type}]\n`
      if (file.changes.length > 0) {
        changeSummary += `关键变更:\n`
        for (const change of file.changes) {
          changeSummary += `  - ${change}\n`
        }
      }
    }
    
    const prompt = `你是一个资深开发者，请根据代码变更生成专业简洁的 commit message。
${changeSummary}
要求：
1. 理解变更的本质意图，不要描述表面操作
2. 用专业术语，简洁有力，像资深开发者写的
3. 禁止输出 type 前缀（禁止 feat: fix: chore: 等）
4. 不超过50字，只输出一行
5. 禁止使用"修改xxx文件"、"将xxx改为xxx"这种表面描述

示例（好）：
- 切换到测试环境
- 添加用户认证拦截器
- 修复分页越界问题
- 重构订单状态机

示例（差，禁止）：
- 修改Env.ets文件将cur值改为Testing
- 在utils.js中添加了一个新函数`

    const body = JSON.stringify({
      bot_id: config.botId,
      user_id: 'git_manager_user',
      stream: false,
      auto_save_history: true,
      additional_messages: [{
        role: 'user',
        content: prompt,
        content_type: 'text'
      }]
    })

    // 使用 https 模块发送请求
    const makeRequest = (url, options, postData) => {
      return new Promise((resolve, reject) => {
        const urlObj = new URL(url)
        const req = https.request({
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search,
          method: options.method || 'GET',
          headers: options.headers
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            resolve({ status: res.statusCode, body: data })
          })
        })
        req.on('error', reject)
        if (postData) req.write(postData)
        req.end()
      })
    }
    
    const response = await makeRequest(chatUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json'
      }
    }, body)

    const responseText = response.body
    
    if (response.status !== 200) {
      console.error('🤖 API 错误响应:', responseText.substring(0, 500))
      return { success: false, message: `API 请求失败: ${response.status}` }
    }
    
    // 检查是否是 HTML 响应
    if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
      console.error('🤖 收到 HTML 响应，Token 可能无效')
      return { success: false, message: 'API Token 无效或已过期，请重新配置' }
    }
    
    let data
    try {
      data = JSON.parse(responseText)
    } catch (e) {
      console.error('🤖 JSON 解析失败:', responseText.substring(0, 200))
      return { success: false, message: '响应格式错误' }
    }

    if (data.code === 0 && data.data) {
      // 扣子 v3 API 返回的是异步任务，需要轮询获取结果
      const chatId = data.data.id
      const conversationId = data.data.conversation_id
      
      // 轮询获取结果
      let retries = 0
      while (retries < 30) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        
        const statusUrl = `${COZE_API_URL}/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${conversationId}`
        const statusResponse = await makeRequest(statusUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${config.apiToken}`
          }
        })
        
        let statusData
        try {
          statusData = JSON.parse(statusResponse.body)
        } catch (e) {
          console.error('轮询状态解析失败:', statusResponse.body.substring(0, 200))
          retries++
          continue
        }
        
        if (statusData.data && statusData.data.status === 'completed') {
          // 获取消息列表
          const messagesUrl = `${COZE_API_URL}/v3/chat/message/list?chat_id=${chatId}&conversation_id=${conversationId}`
          const messagesResponse = await makeRequest(messagesUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${config.apiToken}`
            }
          })
          
          let messagesData
          try {
            messagesData = JSON.parse(messagesResponse.body)
          } catch (e) {
            console.error('消息列表解析失败:', messagesResponse.body.substring(0, 200))
            break
          }
          
          if (messagesData.data && messagesData.data.length > 0) {
            // 找到助手的回复
            const assistantMessage = messagesData.data.find(m => m.role === 'assistant' && m.type === 'answer')
            if (assistantMessage) {
              const commitMessage = assistantMessage.content.trim()
              return { success: true, commitMessage }
            }
          }
          break
        } else if (statusData.data && statusData.data.status === 'failed') {
          return { success: false, message: '生成失败：' + (statusData.data.last_error?.msg || '未知错误') }
        }
        
        retries++
      }
      
      return { success: false, message: '生成超时，请重试' }
    } else {
      return { success: false, message: data.msg || '调用 AI 失败' }
    }
  } catch (error) {
    console.error('❌ 调用扣子 AI 失败:', error)
    return { success: false, message: error.message }
  }
})

// ==================== AI Agent (七牛 LLM) ====================
const { Orchestrator } = require('./ai/orchestrator')
const { McpManager } = require('./ai/mcp-client')
const { createDefaultRegistry } = require('./ai/tool-registry')
const { BUILTIN_SKILLS, REMOVED_BUILTIN_SKILL_IDS } = require('./ai/builtin-skills')
const aiConfigFile = require('./ai/ai-config-file')
const { ensurePromptsDirAndDefaults } = require('./ai/system-prompts')
const mcpConfigFile = require('./ai/mcp-config-file')
const conversationFile = require('./ai/conversation-file')
const memoryStore = require('./ai/memory-store')

function getAIConfigLegacy() {
  const data = aiConfigFile.readAIConfig(app, store)
  return aiConfigFile.toLegacyConfig(data)
}

// 启动时确保 <appRoot>/openultron.json 存在（含 AI + 飞书，首次可从原 ai-config.json / feishu.json 合并）
aiConfigFile.ensureAIConfigFile(app, store)
// 确保 <appRoot>/prompts/ 存在且缺失的提示词文件写入默认（可被 AI 通过 file_operation 修改）
ensurePromptsDirAndDefaults()
// 统一 AI 工作空间：~/.openultron/workspace/{scripts,projects}
ensureWorkspaceDirs()

function writeAIConfigFromTool(data) {
  aiConfigFile.writeAIConfig(app, data)
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('ai-config-updated')
    }
  })
}

// ── 技能目录：<appRoot>/skills/ ──────────────────────────
const _skillsDir = getAppRootPath('skills')

function ensureSkillsDir() {
  fs.mkdirSync(_skillsDir, { recursive: true })
}

// 解析 SKILL.md 文件（支持 YAML frontmatter），id 使用目录名
function parseSkillFile(skillDir) {
  const dirName = path.basename(skillDir)
  const filePath = path.join(skillDir, 'SKILL.md')
  const raw = fs.readFileSync(filePath, 'utf-8')
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (fm) {
    const meta = {}
    for (const line of fm[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return {
      id: dirName,
      name: meta.name || dirName,
      description: meta.description || '',
      category: meta.category || 'custom',
      projectType: meta.projectType || 'all',
      builtIn: meta.builtin === 'true',
      type: meta.type || 'markdown',
      prompt: fm[2].trim(),
      source: 'app'
    }
  }
  return {
    id: dirName, name: dirName,
    description: '', category: 'custom', projectType: 'all',
    builtIn: false, type: 'markdown', prompt: raw.trim(), source: 'app'
  }
}

// 写入技能到目录（<appRoot>/skills/<name>/SKILL.md）
function writeSkillFile(name, skill) {
  const skillDir = path.join(_skillsDir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  const lines = [
    '---',
    `name: ${skill.name || name}`,
    `description: ${skill.description || ''}`,
    `category: ${skill.category || 'custom'}`,
    `projectType: ${skill.projectType || 'all'}`,
    `builtin: ${skill.builtIn ? 'true' : 'false'}`
  ]
  if (skill.type) lines.push(`type: ${skill.type}`)
  lines.push('---', '', skill.prompt || '')
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), lines.join('\n'), 'utf-8')
}

// 读取所有技能（app 目录）；不含 _sandbox 下的草稿
function readAllSkills() {
  ensureSkillsDir()
  const skills = []
  for (const entry of fs.readdirSync(_skillsDir)) {
    if (entry === '_sandbox') continue // 沙箱目录不参与正式列表
    const entryPath = path.join(_skillsDir, entry)
    try { if (!fs.statSync(entryPath).isDirectory()) continue } catch { continue }
    const skillFile = path.join(entryPath, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    try { skills.push(parseSkillFile(entryPath)) } catch {}
  }
  return skills
}

// 读取沙箱内技能（<appRoot>/skills/_sandbox/*/SKILL.md），供 get_skill list_sandbox 与 validate_skill 使用
function readSandboxSkills() {
  ensureSkillsDir()
  const sandboxDir = path.join(_skillsDir, '_sandbox')
  if (!fs.existsSync(sandboxDir)) return []
  const skills = []
  for (const entry of fs.readdirSync(sandboxDir)) {
    const entryPath = path.join(sandboxDir, entry)
    try { if (!fs.statSync(entryPath).isDirectory()) continue } catch { continue }
    const skillFile = path.join(entryPath, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    try { skills.push(parseSkillFile(entryPath)) } catch {}
  }
  return skills
}

// 启动时写入内置技能（目录不存在才写，保留用户修改）；同时迁移旧 flat .md 文件
function initBuiltinSkills() {
  ensureSkillsDir()
  // 删除已移除的内置技能目录，并从「已删除」名单中清除
  const deletedList = store.get('aiDeletedBuiltinSkillIds', [])
  const newDeletedList = deletedList.filter(id => !REMOVED_BUILTIN_SKILL_IDS.includes(id))
  if (newDeletedList.length !== deletedList.length) store.set('aiDeletedBuiltinSkillIds', newDeletedList)
  for (const id of REMOVED_BUILTIN_SKILL_IDS) {
    const dir = path.join(_skillsDir, id)
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        console.warn('[initBuiltinSkills] 移除旧内置技能目录失败:', id, e.message)
      }
    }
  }
  // 迁移：把旧的 flat <name>.md 转为 <name>/SKILL.md
  for (const f of fs.readdirSync(_skillsDir).filter(f => f.endsWith('.md'))) {
    const oldPath = path.join(_skillsDir, f)
    const name = f.replace(/\.md$/, '')
    const newDir = path.join(_skillsDir, name)
    try {
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true })
        fs.renameSync(oldPath, path.join(newDir, 'SKILL.md'))
      } else {
        fs.unlinkSync(oldPath) // 目录已存在，删除旧文件
      }
    } catch {}
  }
  // 用户曾在应用内删除过的内置技能 id，不再自动写回（避免「目录里删掉又出现」）
  const deletedIds = new Set(store.get('aiDeletedBuiltinSkillIds', []))
  // 写入内置技能（仅当技能文件不存在且未被用户删除过时才写入）
  for (const skill of BUILTIN_SKILLS) {
    if (deletedIds.has(skill.id)) continue
    try {
      const skillFile = path.join(_skillsDir, skill.id, 'SKILL.md')
      if (!fs.existsSync(skillFile)) {
        writeSkillFile(skill.id, { ...skill, builtIn: true })
      }
    } catch {}
  }
  // 强制确保 agent-browser 存在（新增内置技能后，旧数据目录可能没有该文件；若曾被误删则从删除名单移除）
  const agentBrowser = BUILTIN_SKILLS.find(s => s.id === 'agent-browser')
  if (agentBrowser) {
    const deletedList = store.get('aiDeletedBuiltinSkillIds', [])
    if (deletedList.includes('agent-browser')) {
      store.set('aiDeletedBuiltinSkillIds', deletedList.filter(id => id !== 'agent-browser'))
    }
    const abFile = path.join(_skillsDir, 'agent-browser', 'SKILL.md')
    if (!fs.existsSync(abFile)) {
      try {
        writeSkillFile('agent-browser', { ...agentBrowser, builtIn: true })
      } catch (e) {
        console.warn('[initBuiltinSkills] agent-browser 写入失败:', e.message)
      }
    }
  }
}

// 在 AI 区域初始化时写入内置技能，并预加载所有技能
initBuiltinSkills()
let _skillsCache = readAllSkills()

const pendingEditorFilesRequests = new Map()

const aiMcpManager = new McpManager()

// 内置 chrome-devtools MCP：与 webview_control 互补，优先使用；失败或不可用时用 webview
const BUILTIN_CHROME_DEVTOOLS_MCP = {
  'chrome-devtools': {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest']
  }
}

// 解析 JSON 格式 MCP 配置 → McpManager 所需数组格式；合并内置 chrome-devtools（用户未配置时）
function parseMcpJsonConfig(jsonStr, disabledServers = []) {
  try {
    let obj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : (jsonStr || {})
    // 兼容 Claude Desktop 格式（带 mcpServers 包装）
    if (obj.mcpServers && typeof obj.mcpServers === 'object') obj = obj.mcpServers
    const merged = { ...BUILTIN_CHROME_DEVTOOLS_MCP, ...obj }
    return Object.entries(merged).map(([name, cfg]) => ({
      name,
      type: (cfg.type === 'sse' || cfg.url) ? 'sse' : 'stdio',
      command: cfg.command,
      args: cfg.args || [],
      env: cfg.env || {},
      url: cfg.url,
      headers: cfg.headers || {},
      enabled: !disabledServers.includes(name)
    }))
  } catch { return [] }
}

const executorRegistry = require('./extensions/executor-registry')
executorRegistry.register(require('./extensions/executors/shell'))
executorRegistry.register(require('./extensions/executors/python'))
executorRegistry.register(require('./extensions/executors/node'))

const hardwareRegistry = require('./extensions/hardware-registry')
hardwareRegistry.register(require('./extensions/hardware/screen'))
hardwareRegistry.register(require('./extensions/hardware/notify'))

const aiToolRegistry = createDefaultRegistry({
  pendingEditorFilesRequests,
  store,
  getAIConfig: getAIConfigLegacy,
  writeAIConfig: writeAIConfigFromTool,
  getValidatedModelsForBaseUrl: (baseUrl) => {
    const v = store.get('aiModelsValidatedByProvider', {})
    return v[baseUrl] || []
  },
  mcpManager: aiMcpManager,
  skillsDir: _skillsDir,
  getSkills: () => {
    _skillsCache = readAllSkills()
    return _skillsCache
  },
  getSandboxSkills: () => readSandboxSkills(),
  getSkillsSources: () => require('./openultron-config').getSkillsSources(),
  onSkillChanged: () => { _skillsCache = readAllSkills() }
})
const aiOrchestrator = new Orchestrator(getAIConfigLegacy, aiToolRegistry, aiMcpManager)

// OpenClaw-style Gateway：开发 28792 / 正式 28790，与 UI 端口分离且同机双装不冲突
const GATEWAY_PORT_PROD = 28790
const GATEWAY_PORT_DEV = 28792
const { createGateway } = require('./ai/gateway')
let currentOpenSession = null
registerChannel('ai-report-current-session', (event, { projectPath, sessionId }) => {
  currentOpenSession = (projectPath != null && sessionId != null) ? { projectPath: String(projectPath), sessionId: String(sessionId) } : null
  return { ok: true }
})
registerChannel('ai-get-current-session', () => {
  return { success: true, projectPath: currentOpenSession?.projectPath ?? null, sessionId: currentOpenSession?.sessionId ?? null }
})
registerChannel('get-gateway-ws-url', () => {
  const port = isDev ? GATEWAY_PORT_DEV : GATEWAY_PORT_PROD
  return `ws://127.0.0.1:${port}`
})
function getResolvedAIConfig() {
  const legacy = getAIConfigLegacy()
  const configuredBaseUrl = (legacy.config && legacy.config.apiBaseUrl) || 'https://api.qnaigc.com/v1'
  const bindings = legacy.raw?.modelBindings && typeof legacy.raw.modelBindings === 'object' ? legacy.raw.modelBindings : {}
  let defaultModel = (legacy.raw && legacy.raw.defaultModel) || (legacy.config && legacy.config.defaultModel) || 'deepseek-v3'
  const baseUrl = String(bindings[defaultModel] || configuredBaseUrl).trim() || configuredBaseUrl
  const globalPool = Array.isArray(legacy.raw?.modelPool)
    ? legacy.raw.modelPool.map(x => String(x || '').trim()).filter(Boolean)
    : []
  const validatedByProvider = store.get('aiModelsValidatedByProvider', {})
  const validated = validatedByProvider[baseUrl]
  let fallbackModels = [...new Set(globalPool.filter(id => id !== defaultModel))]
  if (Array.isArray(validated) && validated.length > 0) {
    const ids = validated
      .map(m => (m.id || m.name || '').trim())
      .filter(Boolean)
    // 仅在完全未配置模型时才回退到验证列表首项；避免被历史残留模型强行覆盖
    if (!defaultModel && ids.length > 0) defaultModel = ids[0]
    const extra = ids.filter(id => id !== defaultModel && !fallbackModels.includes(id))
    fallbackModels = [...fallbackModels, ...extra]
  }
  const providerMap = new Map((legacy.raw?.providers || []).filter(p => p && p.baseUrl).map(p => [p.baseUrl, p]))
  const providerKeys = legacy.providerKeys || {}
  const routeModels = [defaultModel, ...fallbackModels].filter(Boolean)
  const fallbackRoutes = []
  for (const m of routeModels) {
    const routeProvider = String(bindings[m] || baseUrl || configuredBaseUrl).trim()
    const p = providerMap.get(routeProvider)
    const key = String((providerKeys[routeProvider] || p?.apiKey || '')).trim()
    if (!key) continue
    const route = {
      model: m,
      config: {
        apiKey: key,
        apiBaseUrl: routeProvider,
        defaultModel: m,
        temperature: (legacy.config && legacy.config.temperature) ?? 0,
        maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
        maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0
      }
    }
    if (m !== defaultModel) fallbackRoutes.push(route)
  }
  const primaryApiKey = String(((legacy.providerKeys && legacy.providerKeys[baseUrl]) || providerMap.get(baseUrl)?.apiKey || '')).trim()
  const primary = routeModels.length > 0
    ? {
        model: defaultModel,
        config: fallbackRoutes.find(r => r.model === defaultModel)?.config || {
          apiKey: primaryApiKey || ((legacy.providerKeys && legacy.config && legacy.providerKeys[configuredBaseUrl]) || (legacy.config && legacy.config.apiKey) || ''),
          apiBaseUrl: baseUrl,
          defaultModel,
          temperature: (legacy.config && legacy.config.temperature) ?? 0,
          maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
          maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0
        }
      }
    : null
  return {
    apiKey: primary?.config?.apiKey || ((legacy.providerKeys && legacy.config && legacy.providerKeys[legacy.config.apiBaseUrl]) || (legacy.config && legacy.config.apiKey) || ''),
    apiBaseUrl: baseUrl,
    defaultModel,
    modelPool: [defaultModel, ...fallbackModels].filter(Boolean),
    fallbackModels,
    fallbackRoutes,
    modelBindings: bindings,
    temperature: (legacy.config && legacy.config.temperature) ?? 0,
    maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
    maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0
  }
}

/** 验证某供应商下某模型是否可用（发一次最小 chat 请求）。providerKey 为空则用当前默认供应商。供 AI 工具 verify_provider_model 调用。 */
async function verifyProviderModel(providerKey, modelId) {
  const config = (providerKey != null && String(providerKey).trim() !== '')
    ? getResolvedAIConfigForProvider(String(providerKey).trim())
    : getResolvedAIConfig()
  if (!config || !config.apiKey || !config.apiBaseUrl) {
    return { success: false, error: '未配置该供应商的 API Key 或供应商不存在' }
  }
  const baseUrl = (config.apiBaseUrl || '').replace(/\/$/, '')
  const model = String(modelId || config.defaultModel || '').trim()
  if (!model) return { success: false, error: '未指定模型 ID' }
  const isAnthropic = baseUrl.includes('anthropic.com')
  const anthropicBase = isAnthropic ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl

  const doPost = (url, body, headers) => new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const mod = isHttps ? https : http
    const postData = JSON.stringify(body)
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...headers }
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: h
    }, (res) => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    })
    req.on('error', reject)
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(postData)
    req.end()
  })

  try {
    if (isAnthropic) {
      const url = `${anthropicBase}/v1/messages`
      const r = await doPost(url, {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      }, { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' })
      if (r.status === 200) return { success: true }
      let err = r.body
      try { err = JSON.parse(r.body)?.error?.message || r.body } catch { /* ignore */ }
      return { success: false, error: `HTTP ${r.status}: ${(err || '').toString().slice(0, 200)}` }
    }
    const url = `${baseUrl}/chat/completions`
    const r = await doPost(url, {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1
    }, { 'Authorization': `Bearer ${config.apiKey}` })
    if (r.status === 200) return { success: true }
    let err = r.body
    try { err = JSON.parse(r.body)?.error?.message || r.body } catch { /* ignore */ }
    return { success: false, error: `HTTP ${r.status}: ${(err || '').toString().slice(0, 200)}` }
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
}

function getConfiguredProvidersWithKey() {
  const legacy = getAIConfigLegacy()
  const providers = Array.isArray(legacy?.raw?.providers) ? legacy.raw.providers : []
  const providerKeys = legacy?.providerKeys || {}
  return providers
    .filter(p => p && p.baseUrl)
    .map(p => ({
      name: p.name || p.baseUrl,
      baseUrl: p.baseUrl,
      apiKey: String(providerKeys[p.baseUrl] || p.apiKey || '').trim()
    }))
    .filter(p => !!p.apiKey)
}

function orderProvidersForModel(modelId, providers) {
  const id = String(modelId || '').toLowerCase()
  const rank = (p) => {
    const url = String(p.baseUrl || '').toLowerCase()
    const name = String(p.name || '').toLowerCase()
    if (id.startsWith('claude-')) {
      if (url.includes('anthropic.com') || name.includes('anthropic') || name.includes('claude')) return 0
    }
    if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3')) {
      if (url.includes('openai.com') || name.includes('openai')) return 0
    }
    return 10
  }
  return [...providers].sort((a, b) => rank(a) - rank(b))
}

// 校验当前默认供应商下模型是否可用（设置页/模型池选择用）
registerChannel('ai-verify-model', async (event, { model, provider } = {}) => {
  const modelId = String(model || '').trim()
  if (!modelId) return { success: false, error: '未指定模型 ID' }
  if (provider != null && String(provider).trim() !== '') {
    const r = await verifyProviderModel(provider, modelId)
    return { ...r, provider: String(provider).trim() }
  }
  const all = orderProvidersForModel(modelId, getConfiguredProvidersWithKey())
  if (all.length === 0) return { success: false, error: '未配置任何可用供应商 API Key' }
  let lastErr = ''
  for (const p of all) {
    // eslint-disable-next-line no-await-in-loop
    const r = await verifyProviderModel(p.baseUrl, modelId)
    if (r?.success) return { success: true, provider: p.baseUrl, providerName: p.name, model: modelId }
    lastErr = r?.error || ''
  }
  return { success: false, error: lastErr || `模型 ${modelId} 在已配置供应商中不可用` }
})

/** 按供应商名称或 baseUrl 解析出该供应商的 config（用于子 Agent 指定供应商） */
function getResolvedAIConfigForProvider(providerKey) {
  if (!providerKey || String(providerKey).trim() === '') return null
  const key = String(providerKey).trim()
  const legacy = getAIConfigLegacy()
  const raw = legacy?.raw
  const providers = raw?.providers
  if (!Array.isArray(providers) || providers.length === 0) return null
  const byUrl = new Map(providers.filter(p => p && p.baseUrl).map(p => [p.baseUrl, p]))
  const byName = new Map(providers.filter(p => p && p.name).map(p => [String(p.name).trim().toLowerCase(), p]))
  const p = byUrl.get(key) || byName.get(key.toLowerCase()) || null
  if (!p || !p.baseUrl) return null
  const apiKey = (legacy.providerKeys && legacy.providerKeys[p.baseUrl]) || p.apiKey || ''
  if (!apiKey || !String(apiKey).trim()) return null
  const bindings = legacy.raw?.modelBindings && typeof legacy.raw.modelBindings === 'object' ? legacy.raw.modelBindings : {}
  const globalPool = Array.isArray(legacy.raw?.modelPool)
    ? legacy.raw.modelPool.map(x => String(x || '').trim()).filter(Boolean)
    : []
  const globalDefaultModel = String((legacy.raw && legacy.raw.defaultModel) || (legacy.config && legacy.config.defaultModel) || '').trim()
  const defaultProvider = String(legacy.raw?.defaultProvider || '').trim()
  // 当前供应商可用的“配置模型池”：全局模型池中绑定到该 provider 的模型
  const providerPool = [...new Set(
    globalPool.filter((m) => {
      const bound = String(bindings[m] || defaultProvider).trim()
      return bound === p.baseUrl
    })
  )]
  const validatedByProvider = store.get('aiModelsValidatedByProvider', {})
  const validated = validatedByProvider[p.baseUrl]
  let defaultModel = providerPool[0] || ''
  let fallbackModels = [...providerPool.slice(1)]
  if (Array.isArray(validated) && validated.length > 0) {
    const ids = validated
      .map(m => (m.id || m.name || '').trim())
      .filter(Boolean)
    if (!defaultModel && ids.length > 0) defaultModel = ids[0]
    const extra = ids.filter(id => id !== defaultModel && !fallbackModels.includes(id))
    fallbackModels = [...fallbackModels, ...extra]
  }
  if (!defaultModel) {
    // 兜底：若全局主模型本就绑定到当前 provider，则用它
    const dmProvider = String(bindings[globalDefaultModel] || defaultProvider).trim()
    if (globalDefaultModel && dmProvider === p.baseUrl) defaultModel = globalDefaultModel
  }
  if (!defaultModel) defaultModel = globalDefaultModel || 'deepseek-v3'
  return {
    apiKey: String(apiKey).trim(),
    apiBaseUrl: p.baseUrl,
    defaultModel,
    modelPool: [defaultModel, ...fallbackModels].filter(Boolean),
    fallbackModels,
    modelBindings: bindings,
    temperature: (legacy.config && legacy.config.temperature) ?? 0,
    maxTokens: (legacy.config && legacy.config.maxTokens) ?? 0,
    maxToolIterations: (legacy.config && legacy.config.maxToolIterations) ?? 0
  }
}

// 多 Agent：派生子 Agent 执行任务并返回结果（sessions_spawn）
async function runSubChat(opts) {
  const { task, systemPrompt, roleName, model, projectPath, provider } = opts || {}
  const subSessionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const messages = []
  const rolePrompt = roleName && String(roleName).trim()
    ? `你当前扮演的角色是「${String(roleName).trim()}」。请严格按该角色完成任务，并仅输出该角色应给出的结果。`
    : ''
  const mergedSystemPrompt = [rolePrompt, systemPrompt && String(systemPrompt).trim() ? String(systemPrompt).trim() : '']
    .filter(Boolean)
    .join('\n\n')
  if (mergedSystemPrompt) {
    messages.push({ role: 'system', content: mergedSystemPrompt })
  }
  messages.push({ role: 'user', content: String(task || '').trim() })
  let resolvedConfig = null
  if (provider != null && String(provider).trim() !== '') {
    resolvedConfig = getResolvedAIConfigForProvider(String(provider).trim())
    if (!resolvedConfig) {
      return { success: false, error: `未找到或未配置该供应商的 API Key: ${provider}`, subSessionId }
    }
  }
  if (!resolvedConfig) resolvedConfig = getResolvedAIConfig()
  if (model != null && String(model).trim() !== '') {
    const pick = String(model).trim()
    const pool = Array.isArray(resolvedConfig.modelPool)
      ? resolvedConfig.modelPool.map(x => String(x || '').trim()).filter(Boolean)
      : []
    if (pool.length > 0 && !pool.includes(pick)) {
      return { success: false, error: `模型 ${pick} 不在全局模型池中`, subSessionId }
    }
    if ((provider == null || String(provider).trim() === '') && resolvedConfig.modelBindings && resolvedConfig.modelBindings[pick]) {
      const byModelProvider = getResolvedAIConfigForProvider(resolvedConfig.modelBindings[pick])
      if (byModelProvider) {
        resolvedConfig = { ...byModelProvider, defaultModel: pick }
      }
    }
  }
  const toolDefs = getToolsForChat()
  try {
    const result = await aiOrchestrator.startChat({
      sessionId: subSessionId,
      messages,
      model: model && String(model).trim() ? String(model).trim() : undefined,
      tools: toolDefs,
      sender: null,
      config: resolvedConfig,
      projectPath: projectPath || '__main_chat__',
      panelId: undefined,
      feishuChatId: undefined
    })
    if (!result.success) {
      return { success: false, error: result.error || '子 Agent 执行失败', subSessionId }
    }
    const msgs = result.messages || []
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant' && m.content != null)
    let resultText = ''
    if (lastAssistant && lastAssistant.content) {
      if (typeof lastAssistant.content === 'string') {
        resultText = lastAssistant.content.trim()
      } else if (Array.isArray(lastAssistant.content)) {
        resultText = lastAssistant.content.map(c => (c && c.text) || '').join('').trim()
      }
    }
    return { success: true, result: resultText, subSessionId, messages: msgs }
  } catch (e) {
    return { success: false, error: e.message || String(e), subSessionId }
  }
}
try {
  const { createSessionsSpawnTool } = require('./ai/tools/sessions-spawn')
  aiToolRegistry.register('sessions_spawn', createSessionsSpawnTool(runSubChat))
} catch (e) {
  console.warn('加载 sessions_spawn 工具失败:', e.message)
}
try {
  const { createListConfiguredModelsTool } = require('./ai/tools/list-configured-models')
  aiToolRegistry.register('list_configured_models', createListConfiguredModelsTool(getAIConfigLegacy))
} catch (e) {
  console.warn('加载 list_configured_models 工具失败:', e.message)
}
try {
  const { createListProvidersAndModelsTool } = require('./ai/tools/list-providers-models')
  aiToolRegistry.register('list_providers_and_models', createListProvidersAndModelsTool(store, getAIConfigLegacy))
} catch (e) {
  console.warn('加载 list_providers_and_models 工具失败:', e.message)
}
try {
  const { createVerifyProviderModelTool } = require('./ai/tools/verify-provider-model')
  aiToolRegistry.register('verify_provider_model', createVerifyProviderModelTool(verifyProviderModel))
} catch (e) {
  console.warn('加载 verify_provider_model 工具失败:', e.message)
}

// 按 sessionId 收集本轮 tool 结果中的截图，供「应用内飞书会话」完成时回发
const sessionScreenshots = new Map()

const aiGateway = createGateway({
  port: isDev ? GATEWAY_PORT_DEV : GATEWAY_PORT_PROD,
  getOrchestrator: () => aiOrchestrator,
  getResolvedConfig: getResolvedAIConfig,
  getToolDefinitions: () => getToolsForChat(),
  getCurrentOpenSession: () => currentOpenSession,
  getConfigForGateway: () => {
    const c = getResolvedAIConfig()
    return { defaultModel: c.defaultModel, apiBaseUrl: c.apiBaseUrl, temperature: c.temperature, maxTokens: c.maxTokens }
  },
  getCronStatus: () => ({ tasks: cronScheduler.listTasks() }),
  onToolResult: (sessionId, data) => {
    const raw = data.result != null ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result)) : ''
    if (!raw) return
    const items = parseScreenshotFromToolResult(raw)
    if (items.length === 0) return
    const list = sessionScreenshots.get(sessionId) || []
    list.push(...items)
    sessionScreenshots.set(sessionId, list)
  },
  onChatCompleteAny: (sessionId, projectPath, data, fromAppWindow) => {
    if (!fromAppWindow || projectPath !== '__feishu__') return
    const feishuProjectKey = conversationFile.hashProjectPath('__feishu__')
    const conv = conversationFile.loadConversation(feishuProjectKey, sessionId)
    const chatId = conv && conv.feishuChatId ? conv.feishuChatId : null
    if (!chatId) return
    const list = sessionScreenshots.get(sessionId) || []
    sessionScreenshots.delete(sessionId)
    const last = (data.messages && Array.isArray(data.messages))
      ? [...data.messages].reverse().find(m => m.role === 'assistant')
      : null
    let lastText = ''
    if (last && last.content) {
      lastText = typeof last.content === 'string' ? last.content : (last.content && Array.isArray(last.content) ? last.content.map(c => (c && c.text) || '').join('') : '')
    }
    const { cleanedText: cleanedRaw, filePaths: pathsFromText } = extractLocalResourceScreenshots(lastText)
    const imageItems = []
    const seenPath = new Set()
    const seenBase64Head = new Set()
    for (const item of list) {
      if (item.path && !seenPath.has(item.path)) { seenPath.add(item.path); imageItems.push({ path: item.path }) }
      else if (item.base64) { const h = item.base64.slice(0, 80); if (!seenBase64Head.has(h)) { seenBase64Head.add(h); imageItems.push({ base64: item.base64 }) } }
    }
    for (const p of pathsFromText) {
      if (!seenPath.has(p)) { seenPath.add(p); imageItems.push({ path: p }) }
    }
    const textToSend = (stripFeishuScreenshotMisfireText(cleanedRaw) || '').trim() || (imageItems.length > 0 ? '截图已发至当前会话。' : '（无回复内容）')
    const outBinding = { sessionId, projectPath: '__feishu__', channel: 'feishu', remoteId: chatId, feishuChatId: chatId }
    const outPayload = { text: textToSend, images: imageItems }
    if (imageItems.length > 0) appLogger?.info?.('[Feishu] 应用内飞书会话完成，带图回发', { imageCount: imageItems.length })
    eventBus.emit('chat.session.completed', { binding: outBinding, payload: outPayload })
  },
  forwardToMainWindow: (sessionId, _projectPath, channel, data) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, { ...data, sessionId })
    }
  },
  onRemoteUserMessage: (sessionId, projectPath, userContent) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('gateway-remote-user-message', { sessionId, projectPath, userContent })
    }
  },
  onChatComplete: (sessionId, messages, projectPath) => {
    try {
      const conv = require('./ai/conversation-file')
      const toSave = Array.isArray(messages)
        ? mergeCompactedConversationMessages(projectPath, sessionId, messages)
        : []
      if (!toSave.length) return
      if ((projectPath === FEISHU_PROJECT || projectPath === TELEGRAM_PROJECT || projectPath === DINGTALK_PROJECT) && isRunSessionId(sessionId)) return
      const projectKey = conv.hashProjectPath(projectPath)
      conv.saveConversation(projectKey, { id: sessionId, messages: toSave, projectPath })
      console.log('[Gateway] 会话已保存:', sessionId, '条数:', toSave.length)
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (win && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('gateway-session-updated', { sessionId, projectPath })
      }
    } catch (e) {
      console.error('[Gateway] onChatComplete 保存失败:', e.message)
    }
  }
})

try {
  const { createStopCurrentTaskTool } = require('./ai/tools/stop-current-task')
  aiToolRegistry.register('stop_current_task', createStopCurrentTaskTool((sessionId) => aiGateway.stopChat(sessionId)))
} catch (e) {
  console.warn('加载 stop_current_task 工具失败:', e.message)
}
try {
  const { createStopPreviousTaskTool } = require('./ai/tools/stop-previous-task')
  aiToolRegistry.register('stop_previous_task', createStopPreviousTaskTool(stopPreviousRunsForChannel))
} catch (e) {
  console.warn('加载 stop_previous_task 工具失败:', e.message)
}
try {
  const { createWaitForPreviousRunTool } = require('./ai/tools/wait-for-previous-run')
  aiToolRegistry.register('wait_for_previous_run', createWaitForPreviousRunTool(waitForPreviousRuns))
} catch (e) {
  console.warn('加载 wait_for_previous_run 工具失败:', e.message)
}

// 启动已保存的 MCP servers — 在 app.whenReady 后执行，确保 Electron 完全初始化
async function startSavedMcpServers() {
  const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
  const disabledServers = store.get('aiMcpDisabledServers', [])
  const servers = parseMcpJsonConfig(mcpConfigJson, disabledServers)
  if (servers.length > 0) {
    await aiMcpManager.startAll(servers)
  }
}

// ---------- Heartbeat 定时巡检 ----------
const os_module = require('os')
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000  // 30 分钟
const HEARTBEAT_PATH = getAppRootPath('HEARTBEAT.md')

function startHeartbeat() {
  // 延迟 5 分钟后才开始第一次，避免影响启动体验
  setTimeout(() => {
    runHeartbeat()
    setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS)
  }, 5 * 60 * 1000)
}

async function runHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT_PATH)) return
    const content = fs.readFileSync(HEARTBEAT_PATH, 'utf-8').trim()
    // 检查是否有实际检查项（排除注释和空内容）
    const hasItems = content.split('\n').some(l => l.trim().startsWith('-') && !l.trim().startsWith('<!-- '))
    if (!hasItems) return  // 无检查项，跳过

    const sessionId = `heartbeat-${Date.now()}`
    const fakeSender = { send: () => {} }
    const config = getAIConfigLegacy()
    if (!config?.config?.apiKey) return

    const messages = [
      {
        role: 'system',
        content: '你是一个后台巡检助手，静默执行检查清单，结果简洁记录，不需要向用户汇报。'
      },
      {
        role: 'user',
        content: `执行以下检查清单，对需要处理的项目调用工具完成，将发现写入今日日记（memory_save 或 execute_command 追加到应用数据目录 memory/$(date +%Y-%m-%d).md）：\n\n${content}`
      }
    ]

    await aiGateway.runChat(
      { sessionId, messages, model: undefined, tools: getToolsForChat(), projectPath: getWorkspaceRoot() },
      fakeSender
    )
    console.log('[Heartbeat] 巡检完成')
  } catch (e) {
    console.warn('[Heartbeat] 执行失败:', e.message)
  }
}

// ---------- 提取 diff 关键变更（commit message 生成共用）----------
function extractDiffFileChanges(diffContent) {
  const files = []
  const sections = diffContent.split(/\n(?=\[(新增文件|修改文件|文件)\])/)
  for (const section of sections) {
    if (!section.trim()) continue
    const headerMatch = section.match(/^\[(新增文件|修改文件|文件)\]\s*(.+?)(?:\s*\(|:|\s*$)/m)
    if (!headerMatch) continue
    const fileType = headerMatch[1]
    const filePath = headerMatch[2].trim()
    const lines = section.split('\n')
    const keyChanges = []
    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) continue
      if (line.startsWith('+') || line.startsWith('-')) {
        const isAdd = line.startsWith('+')
        const content = line.substring(1).trim()
        if (content && content.length > 2 && !content.match(/^[{}\[\]();,'"` ]+$/)) {
          keyChanges.push((isAdd ? '+' : '-') + content.substring(0, 200))
          if (keyChanges.length >= 50) break
        }
      }
    }
    files.push({ type: fileType, path: filePath, changes: keyChanges })
  }
  return files
}

function buildCommitMessagePrompt(diff) {
  const fileChanges = extractDiffFileChanges(diff)
  let changeSummary = ''
  for (const file of fileChanges) {
    changeSummary += `\n文件: ${file.path} [${file.type}]\n`
    if (file.changes.length > 0) {
      changeSummary += `关键变更:\n`
      for (const change of file.changes) changeSummary += `  - ${change}\n`
    }
  }
  // 兜底：无法解析结构时直接截取原始 diff
  if (!changeSummary.trim() && diff.trim()) {
    changeSummary = '\n代码变更:\n' + diff.substring(0, 3000)
  }
  return `你是一个资深开发者，请根据代码变更生成专业简洁的 commit message。
${changeSummary}
要求：
1. 理解变更的本质意图，不要描述表面操作
2. 用专业术语，简洁有力，像资深开发者写的
3. 禁止输出 type 前缀（禁止 feat: fix: chore: 等）
4. 不超过50字，只输出一行
5. 禁止使用"修改xxx文件"、"将xxx改为xxx"这种表面描述

示例（好）：
- 切换到测试环境
- 添加用户认证拦截器
- 修复分页越界问题
- 重构订单状态机

示例（差，禁止）：
- 修改Env.ets文件将cur值改为Testing
- 在utils.js中添加了一个新函数`
}

// AI 生成提交信息（走统一 AI 助手接口，不依赖 Coze）
registerChannel('ai-generate-commit-message', async (event, { diff }) => {
  try {
    const config = aiOrchestrator.getConfig()
    if (!config.apiKey) return { success: false, message: '请先配置 AI API Key' }
    const prompt = buildCommitMessagePrompt(diff)
    const commitMessage = await aiOrchestrator.generateText({ prompt })
    return { success: true, commitMessage }
  } catch (error) {
    console.error('[AI] generate commit message failed:', error)
    return { success: false, message: error.message }
  }
})

// 获取 AI 配置（从 openultron.json 的 ai 字段读取）
registerChannel('ai-get-config', async () => {
  try {
    const data = aiConfigFile.readAIConfig(app, store)
    const legacy = aiConfigFile.toLegacyConfig(data)
    return {
      success: true,
      config: { ...legacy.config, modelPool: Array.isArray(data.modelPool) ? data.modelPool : [] },
      providerKeys: legacy.providerKeys,
      raw: legacy.raw
    }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 首次使用引导：返回是否仍需配置 API / 消息通知（供设置页展示 Onboarding 横幅）
registerChannel('ai-get-onboarding-status', async () => {
  try {
    const legacy = getAIConfigLegacy()
    const hasApiKey = (legacy.providerKeys && Object.values(legacy.providerKeys).some(k => k && String(k).trim())) ||
      (legacy.config && legacy.config.apiKey && String(legacy.config.apiKey).trim())
    const openultronConfig = require('./openultron-config')
    const feishu = openultronConfig.getFeishu()
    const hasFeishu = !!(feishu && feishu.app_id && String(feishu.app_id).trim())
    return { needsApiConfig: !hasApiKey, needsFeishuConfig: !hasFeishu }
  } catch (e) {
    return { needsApiConfig: true, needsFeishuConfig: true }
  }
})

// 备份用：返回完整 AI 配置（raw 对象，用于写入备份包）
registerChannel('ai-get-config-for-backup', async () => {
  try {
    const data = aiConfigFile.readAIConfig(app, store)
    return { success: true, data }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 恢复用：从备份写入 AI 配置（支持 raw 或旧版 { config, providerKeys }）
registerChannel('ai-restore-config-from-backup', async (event, payload) => {
  try {
    let raw
    if (payload && payload.config !== undefined && payload.providerKeys !== undefined) {
      raw = aiConfigFile.fromLegacyBackup(payload)
    } else if (payload && Array.isArray(payload.providers)) {
      raw = {
        defaultProvider: payload.defaultProvider,
        defaultModel: payload.defaultModel,
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        maxToolIterations: payload.maxToolIterations,
        providers: payload.providers,
      }
    } else {
      return { success: false, message: '无效的 AI 配置备份数据' }
    }
    aiConfigFile.writeAIConfig(app, raw)
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 查询 Token 用量（支持按提供商 baseUrl 查询，目前仅七牛实现）
registerChannel('ai-get-usage', async (event, { granularity, start, end, baseUrl: providerBaseUrl }) => {
  try {
    const legacy = getAIConfigLegacy()
    const baseUrl = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
    const apiKey = legacy.providerKeys[baseUrl] || legacy.config.apiKey || ''
    if (!apiKey) return { success: false, message: '未配置该提供商的 API Key' }
    if (!baseUrl.includes('qnaigc.com')) {
      return { success: false, message: '该提供商暂不支持用量查询', unsupported: true }
    }

    const params = new URLSearchParams({ granularity, start, end })
    const result = await new Promise((resolve, reject) => {
      const req = require('https').request({
        hostname: 'api.qnaigc.com',
        path: `/v2/stat/usage?${params}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }) }
          catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.end()
    })
    if (result.status !== 200) return { success: false, message: result.json?.message || '查询失败' }
    return { success: true, data: result.json.data || [] }
  } catch (e) {
    return { success: false, message: e.message }
  }
})

// 查询预估账单（支持按提供商 baseUrl 查询，目前仅七牛实现）
registerChannel('ai-get-billing', async (event, { type, baseUrl: providerBaseUrl }) => {
  try {
    const legacy = getAIConfigLegacy()
    const baseUrl = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
    const apiKey = legacy.providerKeys[baseUrl] || legacy.config.apiKey || ''
    if (!apiKey) return { success: false, message: '未配置该提供商的 API Key' }
    if (!baseUrl.includes('qnaigc.com')) {
      return { success: false, message: '该提供商暂不支持预估账单', unsupported: true }
    }

    const result = await new Promise((resolve, reject) => {
      const req = require('https').request({
        hostname: 'api.qnaigc.com',
        path: `/v2/stat/usage/apikey/cost?type=${type}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }) }
          catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.end()
    })
    if (result.status !== 200) return { success: false, message: result.json?.message || '查询失败' }
    return { success: true, data: result.json.data || {} }
  } catch (e) {
    return { success: false, message: e.message }
  }
})

// 保存 AI 配置（写入 openultron.json 的 ai 字段）
registerChannel('ai-save-config', async (event, payload) => {
  try {
    const normalizePool = (pool, defaultModel) => {
      const list = Array.isArray(pool) ? pool.map(x => String(x || '').trim()).filter(Boolean) : []
      const uniq = [...new Set(list)]
      const dm = String(defaultModel || '').trim()
      if (dm && !uniq.includes(dm)) uniq.unshift(dm)
      return uniq
    }
    const normalizeBindings = (bindings, providers, pool, fallbackProvider) => {
      const allow = new Set((providers || []).map(p => String(p?.baseUrl || '').trim()).filter(Boolean))
      const out = {}
      const src = bindings && typeof bindings === 'object' ? bindings : {}
      for (const [k, v] of Object.entries(src)) {
        const model = String(k || '').trim()
        const provider = String(v || '').trim()
        if (!model || !provider) continue
        if (allow.size > 0 && !allow.has(provider)) continue
        out[model] = provider
      }
      const fb = String(fallbackProvider || '').trim()
      for (const m of pool || []) {
        const model = String(m || '').trim()
        if (!model) continue
        if (!out[model] && fb) out[model] = fb
      }
      return out
    }
    const data = aiConfigFile.readAIConfig(app, store)
    if (payload.raw !== undefined) {
      const raw = payload.raw
      if (raw.defaultProvider !== undefined && String(raw.defaultProvider).trim() !== '') {
        data.defaultProvider = String(raw.defaultProvider).trim()
      }
      if (raw.defaultModel !== undefined) data.defaultModel = raw.defaultModel ?? data.defaultModel
      if (Array.isArray(raw.modelPool)) data.modelPool = raw.modelPool
      if (raw.modelBindings && typeof raw.modelBindings === 'object') data.modelBindings = raw.modelBindings
      if (raw.temperature !== undefined) data.temperature = raw.temperature ?? data.temperature
      if (raw.maxTokens !== undefined) data.maxTokens = raw.maxTokens ?? data.maxTokens
      if (raw.maxToolIterations !== undefined) data.maxToolIterations = raw.maxToolIterations ?? data.maxToolIterations
      if (Array.isArray(raw.providers)) data.providers = raw.providers
    } else {
      const config = payload
      data.defaultProvider = config.apiBaseUrl || data.defaultProvider
      data.defaultModel = config.defaultModel ?? data.defaultModel
      if (Array.isArray(config.modelPool)) data.modelPool = config.modelPool
      if (config.modelBindings && typeof config.modelBindings === 'object') data.modelBindings = config.modelBindings
      data.temperature = config.temperature ?? data.temperature
      data.maxTokens = config.maxTokens ?? data.maxTokens
      data.maxToolIterations = config.maxToolIterations ?? data.maxToolIterations
      const provider = data.providers.find(p => p.baseUrl === (config.apiBaseUrl || data.defaultProvider))
      if (provider) {
        if (config.apiKey !== undefined) provider.apiKey = config.apiKey || ''
      }
    }
    data.modelPool = normalizePool(data.modelPool, data.defaultModel)
    data.modelBindings = normalizeBindings(data.modelBindings, data.providers, data.modelPool, data.defaultProvider)
    aiConfigFile.writeAIConfig(app, data)
    const verify = aiConfigFile.readAIConfig(app, store)
    if (verify.defaultProvider !== data.defaultProvider) {
      console.error('[AI] 配置写入后校验失败: defaultProvider 未持久化', { expected: data.defaultProvider, got: verify.defaultProvider })
      return { success: false, message: '配置未正确写入，请检查应用数据目录权限' }
    }
    return { success: true }
  } catch (error) {
    console.error('[AI] 保存配置失败:', error.message)
    return { success: false, message: error.message }
  }
})

// 获取模型列表
registerChannel('ai-fetch-models', async (event, options) => {
  const { forceRefresh } = options || {}
  try {
    const legacy = getAIConfigLegacy()
    const baseUrl = legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
    const apiKey = legacy.providerKeys[baseUrl] || legacy.config.apiKey
    if (!apiKey) {
      return { success: false, message: '未配置 API Key' }
    }

    // 未强制刷新时优先返回该供应商的缓存（按供应商分别缓存）
    const isQiniu = baseUrl.includes('qnaigc.com')
    if (!forceRefresh) {
      const byProvider = store.get('aiModelsByProvider', {})
      let cached = byProvider[baseUrl]
      if (!cached?.length && store.get('aiModelsProvider', '') === baseUrl) {
        cached = store.get('aiModels', [])
      }
      if (cached?.length) {
        return { success: true, models: cached, fromCache: true }
      }
    }

    // 辅助：发起 HTTP 请求
    const doRequest = (reqUrl, method, body, customHeaders) => new Promise((resolve, reject) => {
      const isHttps = reqUrl.protocol === 'https:'
      const httpModule = isHttps ? https : http
      const postData = body ? JSON.stringify(body) : null
      const headers = { ...(customHeaders || {}) }
      if (postData) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(postData)
      }
      const req = httpModule.request({
        hostname: reqUrl.hostname,
        port: reqUrl.port || (isHttps ? 443 : 80),
        path: reqUrl.pathname + reqUrl.search,
        method,
        headers
      }, (res) => {
        let resBody = ''
        res.on('data', chunk => resBody += chunk)
        res.on('end', () => resolve({ status: res.statusCode, body: resBody }))
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
      if (postData) req.write(postData)
      req.end()
    })

    // 1) 获取当前提供商模型列表（OpenAI 兼容用 Bearer；Anthropic 用 x-api-key 在步骤 2 拉取）
    const isAnthropicProvider = baseUrl.includes('anthropic.com')
    let models = []
    if (!isAnthropicProvider) {
      const modelsUrl = new URL(`${baseUrl}/models`)
      const modelsRes = await doRequest(modelsUrl, 'GET', null, { 'Authorization': `Bearer ${apiKey}` })
      if (modelsRes.status === 200) {
        try {
          const data = JSON.parse(modelsRes.body)
          models = (data.data || []).map(m => ({
            id: m.id,
            name: m.id,
            owned_by: m.owned_by || '',
            input_modalities: m.input_modalities || m.modalities || [],
            source: 'provider'
          }))
        } catch { /* ignore */ }
      } else if (modelsRes.status === 401 || modelsRes.status === 403) {
        return { success: false, message: 'API Key 无效，认证失败' }
      }
    }

    // 2) 仅 Anthropic 供应商：拉取并验证 Claude 模型；七牛只使用其 /models 接口返回的列表
    let claudeDiag = '' // 诊断信息，返回给前端
    if (isAnthropicProvider) {
      try {
        // 仅七牛使用 24h 缓存；Anthropic 官方每次拉取
        const useClaudeCache = isQiniu && !forceRefresh
        const cachedClaude = useClaudeCache ? store.get('aiClaudeValidated', null) : null
        const claudeCacheTime = useClaudeCache ? store.get('aiClaudeValidatedTime', 0) : 0
        const claudeCacheAge = Date.now() - claudeCacheTime

        if (cachedClaude && cachedClaude.length > 0 && claudeCacheAge < 24 * 60 * 60 * 1000) {
          const existingIds = new Set(models.map(m => m.id))
          for (const cm of cachedClaude) {
            if (!existingIds.has(cm.id)) models.unshift(cm)
          }
          claudeDiag = `Claude: ${cachedClaude.length} 个（缓存）`
        } else {
          // 从 Anthropic 兼容端点获取模型列表
          const anthropicBase = baseUrl.replace(/\/v1\/?$/, '')
          const anthropicModelsUrl = new URL(`${anthropicBase}/v1/models`)
          let anthropicRes
          try {
            anthropicRes = await doRequest(anthropicModelsUrl, 'GET', null, {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            })
          } catch (e) {
            anthropicRes = { status: 0, body: e.message }
          }

          let claudeCandidates = []
          if (anthropicRes.status === 200) {
            try {
              const data = JSON.parse(anthropicRes.body)
              claudeCandidates = (data.data || [])
                .filter(m => m.id && m.id.startsWith('claude-'))
                .map(m => {
                  const id = m.id
                  const alias = id.replace(/-\d{8}$/, '')
                  return {
                    alias: alias !== id ? alias : null,
                    dated: id,
                    name: m.display_name || alias || id,
                    owned_by: 'anthropic'
                  }
                })
            } catch { /* ignore */ }
          }
          console.log(`[AI] Anthropic models API status=${anthropicRes.status}, candidates=${claudeCandidates.length}, body=${anthropicRes.body?.substring(0, 200)}`)

          // 若 API 列表不可用，回退到已知模型 ID 作为候选
          if (claudeCandidates.length === 0) {
            const knownClaude = [
              { alias: 'claude-opus-4-6', dated: 'claude-opus-4-6-20250603' },
              { alias: 'claude-sonnet-4-6', dated: 'claude-sonnet-4-6-20250603' },
              { alias: 'claude-opus-4', dated: 'claude-opus-4-20250514' },
              { alias: 'claude-sonnet-4', dated: 'claude-sonnet-4-20250514' },
              { alias: 'claude-3-7-sonnet', dated: 'claude-3-7-sonnet-20250219' },
              { alias: 'claude-3-5-sonnet', dated: 'claude-3-5-sonnet-20241022' },
              { alias: 'claude-3-5-haiku', dated: 'claude-3-5-haiku-20241022' },
              { alias: 'claude-3-opus', dated: 'claude-3-opus-20240229' },
              { alias: 'claude-3-haiku', dated: 'claude-3-haiku-20240307' },
            ]
            claudeCandidates = knownClaude.map(m => ({
              alias: m.alias, dated: m.dated, name: m.alias, owned_by: 'anthropic'
            }))
          }

          // 并发验证：同时尝试 x-api-key 和 Bearer 两种认证，别名和带日期两种 ID；遇 429 限流即停并保留已验证
          const validated = []
          const diagErrors = []
          let hitRateLimit = false
          const testClaudeModel = async (modelId, authHeader) => {
            const testUrl = new URL(`${anthropicBase}/v1/messages`)
            const r = await doRequest(testUrl, 'POST', {
              model: modelId,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }]
            }, {
              ...authHeader,
              'anthropic-version': '2023-06-01'
            })
            return r
          }

          const BATCH = 5
          for (let i = 0; i < claudeCandidates.length && !hitRateLimit; i += BATCH) {
            if (i > 0) await new Promise(r => setTimeout(r, 400))
            const batch = claudeCandidates.slice(i, i + BATCH)
            const results = await Promise.allSettled(batch.map(async (cm) => {
              const idsToTry = [cm.alias, cm.dated].filter(Boolean)
              const authMethods = [
                { 'x-api-key': apiKey },
                { 'Authorization': `Bearer ${apiKey}` }
              ]

              for (const tryId of idsToTry) {
                for (const auth of authMethods) {
                  try {
                    const r = await testClaudeModel(tryId, auth)
                    if (r.status === 429) return { rateLimited: true }
                    if (r.status === 200) {
                      const authType = auth['x-api-key'] ? 'x-api-key' : 'Bearer'
                      console.log(`[AI] Claude ✓ ${tryId} (${authType})`)
                      return { id: tryId, name: cm.name || tryId, owned_by: cm.owned_by, input_modalities: ['text', 'image'], source: 'anthropic' }
                    }
                    if (diagErrors.length < 3) {
                      const authType = auth['x-api-key'] ? 'x-api-key' : 'Bearer'
                      let errMsg = ''
                      try { errMsg = JSON.parse(r.body)?.error?.message || r.body.substring(0, 100) } catch { errMsg = r.body?.substring(0, 100) }
                      diagErrors.push(`${tryId}(${authType}):${r.status} ${errMsg}`)
                    }
                  } catch { /* timeout etc */ }
                }
              }
              return null
            }))
            for (const r of results) {
              if (r.status === 'fulfilled' && r.value) {
                if (r.value.rateLimited) { hitRateLimit = true; break } else validated.push(r.value)
              }
            }
          }
          if (hitRateLimit) console.log('[AI] Claude 因 API 限流(429)停止，已保留已验证模型')

          console.log(`[AI] Claude validated: ${validated.length}/${claudeCandidates.length}`)
          if (diagErrors.length > 0) console.log(`[AI] Claude errors sample:`, diagErrors)

          // 仅七牛写入 Claude 缓存，避免覆盖为其他供应商数据
          if (isQiniu) {
            store.set('aiClaudeValidated', validated)
            store.set('aiClaudeValidatedTime', validated.length > 0 ? Date.now() : 0)
          }

          const existingIds = new Set(models.map(m => m.id))
          for (const cm of validated) {
            if (!existingIds.has(cm.id)) models.unshift(cm)
          }

          claudeDiag = `Claude: ${validated.length}/${claudeCandidates.length} 通过`
          if (hitRateLimit) claudeDiag += '（遇限流已停）'
          if (validated.length === 0 && diagErrors.length > 0) {
            claudeDiag += ` | ${diagErrors[0]}`
          }
        }
      } catch (e) {
        console.error('[AI] Anthropic models fetch error:', e.message)
        claudeDiag = `Claude 获取失败: ${e.message}`
      }
    }

    // 3) 验证 Key 对 chat 端点的有效性（用非 Claude 模型测试 OpenAI 格式）
    const nonClaudeModel = models.find(m => !m.id.startsWith('claude-')) || models[0]
    const verifyModelId = nonClaudeModel ? nonClaudeModel.id : 'gpt-3.5-turbo'
    const chatUrl = new URL(`${baseUrl}/chat/completions`)
    const verifyBody = {
      model: verifyModelId,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1
    }
    const chatRes = await doRequest(chatUrl, 'POST', verifyBody, { 'Authorization': `Bearer ${apiKey}` })
    let keyValid = true
    let keyWarning = ''
    if (chatRes.status === 401 || chatRes.status === 403) {
      keyValid = false
      try {
        const err = JSON.parse(chatRes.body)
        keyWarning = err.error?.message || 'API Key 认证失败，无法进行对话'
      } catch {
        keyWarning = 'API Key 认证失败，无法进行对话'
      }
    }

    // 按供应商缓存到 store
    const byProvider = store.get('aiModelsByProvider', {})
    byProvider[baseUrl] = models
    store.set('aiModelsByProvider', byProvider)
    store.set('aiModels', models)
    store.set('aiModelsProvider', baseUrl)

    // 仅将「测试过可用」的模型写入 aiModelsValidatedByProvider，供 list_providers_and_models 等只展示可用模型
    const validatedByProvider = store.get('aiModelsValidatedByProvider', {})
    let validatedList = []
    if (isAnthropicProvider) {
      validatedList = models.filter(m => m.source === 'anthropic')
    } else if (isQiniu) {
      validatedList = keyValid ? models : []
    } else {
      validatedList = keyValid ? models : []
    }
    if (validatedList.length > 0) {
      validatedByProvider[baseUrl] = validatedList
      store.set('aiModelsValidatedByProvider', validatedByProvider)
    }

    if (!keyValid) {
      return {
        success: true,
        models,
        keyInvalid: true,
        message: keyWarning
      }
    }

    return { success: true, models, claudeDiag }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 获取缓存的模型列表（仅返回指定供应商的模型；不传则用当前默认供应商）
registerChannel('ai-get-models', async (event, providerBaseUrl) => {
  const legacy = getAIConfigLegacy()
  const currentBase = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
  const byProvider = store.get('aiModelsByProvider', {})
  const cached = byProvider[currentBase]
  if (cached?.length) return { success: true, models: cached }
  if (store.get('aiModelsProvider', '') === currentBase) {
    return { success: true, models: store.get('aiModels', []) }
  }
  return { success: true, models: [] }
})

// 统一「对话用工具列表」：builtin + MCP，chrome-devtools 排最前（与主会话一致，飞书/Webhook 等入口共用）
const CHROME_DEVTOOLS_TOOL_PREFIX = 'mcp__chrome_devtools__'
function getToolsForChat() {
  const builtinTools = aiToolRegistry.getToolDefinitions()
  const mcpTools = aiMcpManager.getAllToolDefinitions()
  const all = [...builtinTools, ...mcpTools]
  const chromeDevtools = all.filter(t => (t.function?.name || '').startsWith(CHROME_DEVTOOLS_TOOL_PREFIX))
  const rest = all.filter(t => !(t.function?.name || '').startsWith(CHROME_DEVTOOLS_TOOL_PREFIX))
  return [...chromeDevtools, ...rest]
}
registerChannel('ai-get-tools', async () => {
  return { success: true, tools: getToolsForChat() }
})

function isVisionModelId(modelId = '') {
  const m = String(modelId || '').toLowerCase()
  if (!m) return false
  const hits = [
    /gpt-4o/, /gpt-4\.1/, /gpt-4\.5/, /o1/, /o3/, /omni/,
    /claude-3/, /claude-4/,
    /gemini/, /qwen-?vl/, /qvq/, /vision/, /vl-/, /pixtral/, /llava/
  ]
  return hits.some((re) => re.test(m))
}

function modelSupportsVision({ model, providerBaseUrl } = {}) {
  const legacy = getAIConfigLegacy()
  const baseUrl = providerBaseUrl || legacy.config.apiBaseUrl || 'https://api.qnaigc.com/v1'
  const byProvider = store.get('aiModelsByProvider', {})
  const models = byProvider[baseUrl] || []
  const modelId = String(model || legacy.config.defaultModel || '').trim()
  const found = models.find((m) => String(m.id || '').trim() === modelId)
  if (found) {
    const inputModalities = found.input_modalities || found.inputModalities || found.modalities || []
    if (Array.isArray(inputModalities)) {
      const modalSet = new Set(inputModalities.map((x) => String(x).toLowerCase()))
      if (modalSet.has('image') || modalSet.has('vision') || modalSet.has('input_image')) return true
    }
  }
  return isVisionModelId(modelId)
}

registerChannel('ai-model-supports-vision', async (event, { model, providerBaseUrl } = {}) => {
  try {
    const supportsVision = modelSupportsVision({ model, providerBaseUrl })
    return { success: true, supportsVision }
  } catch (e) {
    return { success: false, supportsVision: false, message: e.message || 'detect failed' }
  }
})

// 上传并摄取附件（主会话输入框 / 其他渠道复用）
registerChannel('ai-upload-attachments', async (event, { sessionId, source, attachments, imageMode }) => {
  try {
    if (!sessionId || String(sessionId).trim() === '') {
      return { success: false, message: 'missing sessionId' }
    }
    const result = await ingestRoundAttachments({
      sessionId: String(sessionId).trim(),
      source: source || 'main',
      attachments: Array.isArray(attachments) ? attachments : [],
      imageMode: imageMode === 'vision' ? 'vision' : 'ocr'
    })
    return result
  } catch (e) {
    return { success: false, message: e.message || 'attachment ingest failed' }
  }
})

// 启动 AI 对话（HTTP/浏览器 无 sender 时等待完整响应后返回，应用内则立即返回、流式走 sender）
registerChannel('ai-chat-start', async (event, { sessionId, messages, model, tools, projectPath, panelId }) => {
  try {
    const sender = event?.sender ?? null
    const ipcSender = sender ? { send: (ch, d) => sender.send(ch, d) } : null
    const promise = aiGateway.runChat(
      { sessionId, messages, model, tools, projectPath: projectPath || '', panelId: panelId || undefined, fromAppWindow: true },
      ipcSender
    )
    if (sender) {
      promise.catch(e => console.error('[AI] startChat error:', e.message))
      return { success: true }
    }
    const result = await promise
    return result != null ? result : { success: true }
  } catch (error) {
    return { success: false, message: error.message, error: error.message }
  }
})

// 停止 AI 对话
registerChannel('ai-chat-stop', async (event, { sessionId }) => {
  aiGateway.stopChat(sessionId)
  return { success: true }
})

// ---- 会话管理 IPC（供 SessionManager 使用） ----
const sessionRegistry = require('./ai/session-registry')

// 前端视图注册 / 注销（ChatPanel mount/unmount 时调用）
registerChannel('ai-session-register-view', (event, { sessionId, projectPath, projectName, sessionTitle, model, apiBaseUrl, lastContent }) => {
  const r = sessionRegistry.registerView(sessionId, { projectPath, projectName, sessionTitle, model, apiBaseUrl, lastContent, viewSender: event?.sender ?? null })
  return r && typeof r.success === 'boolean' ? r : { success: true }
})

registerChannel('ai-session-unregister-view', (event, { sessionId }) => {
  if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
    return { success: false, message: '无权操作该会话' }
  }
  sessionRegistry.unregisterView(sessionId)
  return { success: true }
})

registerChannel('ai-session-update-meta', (event, { sessionId, model, projectName, sessionTitle, apiBaseUrl, lastContent }) => {
  if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
    return { success: false, message: '无权操作该会话' }
  }
  sessionRegistry.updateMeta(sessionId, { model, projectName, sessionTitle, apiBaseUrl, lastContent })
  return { success: true }
})

registerChannel('ai-session-list', (event) => {
  const sender = event?.sender ?? null
  const sessions = sessionRegistry.getSnapshot().filter(s => sessionRegistry.isOwnedBy(s.sessionId, sender))
  return { success: true, sessions }
})

registerChannel('ai-session-pause', (event, { sessionId }) => {
  if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
    return { success: false, message: '无权操作该会话' }
  }
  const ok = sessionRegistry.pause(sessionId)
  return { success: ok }
})

registerChannel('ai-session-resume', (event, { sessionId }) => {
  if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
    return { success: false, message: '无权操作该会话' }
  }
  const ok = sessionRegistry.resume(sessionId)
  return { success: ok }
})

registerChannel('ai-session-stop', (event, { sessionId }) => {
  if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
    return { success: false, message: '无权操作该会话' }
  }
  const ok = sessionRegistry.stop(sessionId)
  return { success: ok }
})

registerChannel('ai-session-inject', (event, { sessionId, message }) => {
  if (!sessionRegistry.isOwnedBy(sessionId, event?.sender ?? null)) {
    return { success: false, message: '无权操作该会话' }
  }
  const ok = sessionRegistry.injectMessage(sessionId, message)
  return { success: ok }
})

// AI 编辑器打开文件列表回调
registerChannel('ai-editor-open-files-response', (event, { requestId, files }) => {
  const pending = pendingEditorFilesRequests.get(requestId)
  if (pending) {
    pending.resolve({
      success: true,
      files: files || [],
      count: (files || []).length
    })
  }
  return { ok: true }
})

// 会话历史持久化
// ---- 项目聊天历史（文件存储，自动从 store 迁移旧数据） ----
// 命令执行情况仅在进行中展示，不保留到历史消息；剥离后保存
function stripToolExecutionFromMessages(messages) {
  if (!Array.isArray(messages)) return messages
  return messages
    .filter(m => m && m.role !== 'tool')
    .map(m => {
      const out = { ...m }
      if (out.toolCalls !== undefined) delete out.toolCalls
      if (out.tool_calls !== undefined) delete out.tool_calls
      return out
    })
    .filter(m => m.role !== 'assistant' || (m.content && String(m.content).trim()))
}

function isCompactedSummaryMessage(msg) {
  if (!msg || msg.role !== 'system') return false
  const text = extractMessageTextForSummary(msg)
  if (!text) return false
  return text.includes('对话摘要') || text.includes('早期消息已压缩')
}

function toComparableEntries(messages) {
  return (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ key: `${m.role}:${extractMessageTextForSummary(m)}`, msg: m }))
    .filter((x) => x.key && x.key !== 'user:' && x.key !== 'assistant:')
}

function findTailPrefixOverlap(baseKeys, nextKeys) {
  const max = Math.min(baseKeys.length, nextKeys.length)
  for (let k = max; k > 0; k--) {
    let ok = true
    for (let i = 0; i < k; i++) {
      if (baseKeys[baseKeys.length - k + i] !== nextKeys[i]) {
        ok = false
        break
      }
    }
    if (ok) return k
  }
  return 0
}

function mergeCompactedConversationMessages(projectPath, sessionId, incomingMessages) {
  const incoming = stripToolExecutionFromMessages(incomingMessages)
  if (!incoming || incoming.length === 0) return []

  const hasCompactedMarker = incoming.some(isCompactedSummaryMessage)
  if (!hasCompactedMarker) return incoming

  const projectKey = conversationFile.hashProjectPath(projectPath)
  const existingConv = conversationFile.loadConversation(projectKey, sessionId)
  const existing = stripToolExecutionFromMessages(existingConv?.messages || [])
  if (!existing.length) return incoming

  const baseEntries = toComparableEntries(existing)
  const nextEntries = toComparableEntries(incoming)
  if (!nextEntries.length) return existing

  const overlap = findTailPrefixOverlap(
    baseEntries.map((x) => x.key),
    nextEntries.map((x) => x.key)
  )
  const appended = nextEntries.slice(overlap).map((x) => x.msg)
  if (!appended.length) return existing

  return [...existing, ...appended]
}

function compactSummaryText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function extractMessageTextForSummary(msg) {
  if (!msg || typeof msg !== 'object') return ''
  const c = msg.content
  if (typeof c === 'string') return compactSummaryText(c)
  if (Array.isArray(c)) {
    return compactSummaryText(c.map((x) => {
      if (!x) return ''
      if (typeof x === 'string') return x
      if (typeof x.text === 'string') return x.text
      return ''
    }).join(' '))
  }
  return ''
}

function buildSessionSummary(messages = []) {
  const list = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, text: extractMessageTextForSummary(m) }))
    .filter((m) => m.text)
  if (!list.length) return ''

  const recent = list.slice(-24)
  const userPoints = []
  const assistantPoints = []
  for (const item of recent) {
    if (item.role === 'user') {
      if (userPoints.length < 6) userPoints.push(item.text.slice(0, 120))
    } else if (item.role === 'assistant') {
      if (assistantPoints.length < 6) assistantPoints.push(item.text.slice(0, 140))
    }
  }

  const lines = []
  lines.push(`会话压缩摘要（${new Date().toLocaleString('zh-CN', { hour12: false })}）`)
  if (userPoints.length) {
    lines.push('用户关注点：')
    for (const p of userPoints) lines.push(`- ${p}`)
  }
  if (assistantPoints.length) {
    lines.push('已完成/已回复：')
    for (const p of assistantPoints) lines.push(`- ${p}`)
  }
  return lines.join('\n')
}

registerChannel('ai-save-chat-history', async (event, { projectPath, messages, sessionId, model, apiBaseUrl }) => {
  try {
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const id = sessionId || `proj-${Date.now()}`
    const toSave = stripToolExecutionFromMessages(messages)
    conversationFile.saveConversation(projectKey, { id, messages: toSave, projectPath, model, apiBaseUrl })
    return { success: true, sessionId: id }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

const MAIN_CHAT_PROJECT = '__main_chat__'
const FEISHU_PROJECT = '__feishu__'
const GATEWAY_PROJECT = '__gateway__'
const TELEGRAM_PROJECT = '__telegram__'
const DINGTALK_PROJECT = '__dingtalk__'

registerChannel('ai-save-session-summary', async (event, { projectPath, sessionId, messages }) => {
  try {
    const proj = String(projectPath || MAIN_CHAT_PROJECT).trim() || MAIN_CHAT_PROJECT
    const sid = String(sessionId || '').trim()
    if (!sid || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, message: 'invalid args' }
    }
    const summary = buildSessionSummary(messages)
    if (!summary) return { success: true, summary: '' }
    memoryStore.saveMemory({
      content: summary,
      tags: ['session-summary', `project:${proj}`, `session:${sid}`],
      projectPath: proj,
      source: 'auto'
    })
    return { success: true, summary }
  } catch (e) {
    return { success: false, message: e.message }
  }
})

registerChannel('ai-list-session-summaries', async (event, { projectPath, limit }) => {
  try {
    const proj = String(projectPath || MAIN_CHAT_PROJECT).trim() || MAIN_CHAT_PROJECT
    const lim = Math.min(Math.max(Number(limit) || 5, 1), 20)
    const rows = memoryStore.listMemoriesByTags(['session-summary', `project:${proj}`], proj, lim)
    return {
      success: true,
      summaries: (rows || []).map((m) => ({
        id: m.id,
        content: m.content || '',
        createdAt: m.createdAt || null,
        updatedAt: m.updatedAt || null,
        tags: m.tags || []
      }))
    }
  } catch (e) {
    return { success: false, summaries: [], message: e.message }
  }
})

registerChannel('ai-load-chat-history', async (event, { projectPath, sessionId }) => {
  try {
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const session = sessionId
      ? conversationFile.loadConversation(projectKey, sessionId)
      : conversationFile.loadLatestConversation(projectKey)
    if (!session) return { success: true, messages: [], sessionId: null }
    return {
      success: true,
      messages: session.messages || [],
      sessionId: session.id,
      apiBaseUrl: session.apiBaseUrl || null
    }
  } catch (error) {
    return { success: false, messages: [], sessionId: null }
  }
})

registerChannel('ai-clear-chat-history', async (event, { projectPath, sessionId }) => {
  try {
    if (sessionId) {
      const projectKey = conversationFile.hashProjectPath(projectPath)
      conversationFile.deleteConversation(projectKey, sessionId)
    }
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 开启新会话时主动自我进化：根据上一会话记录提炼经验并写入知识库（后台执行，不阻塞 UI）
registerChannel('ai-evolve-from-session', async (event, { projectPath, sessionId }) => {
  if (!projectPath || !sessionId) return { success: true }
  try {
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const conv = conversationFile.loadConversation(projectKey, sessionId)
    if (!conv || !conv.messages || conv.messages.length < 2) return { success: true }

    const dialogMsgs = conv.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? (m.content.map(c => c?.text || '').join('')) : '')
        return `[${m.role}]: ${text.slice(0, 1500)}${text.length > 1500 ? '...' : ''}`
      })
    const dialogText = dialogMsgs.join('\n\n').slice(0, 8000)
    if (!dialogText.trim()) return { success: true }

    const config = getResolvedAIConfig()
    if (!config?.apiKey?.trim()) return { success: true }

    const systemPrompt = '你负责从对话中提炼经验教训。只输出一个 JSON 数组，格式为 [{"content":"...", "category":"..."}]。每条 content 须详细：含具体场景、失败原因或成功做法、可复用的命令或步骤（80～400字）。category 为通用/git/部署/调试/命令等。若无值得提炼的则输出 []。不要输出 markdown 代码块或其它说明，仅输出 JSON。'
    const prompt = `请根据以下对话提炼 1～5 条经验教训：\n\n${dialogText}`

    const result = await aiOrchestrator.generateText({
      prompt,
      systemPrompt,
      config,
      model: config.defaultModel || 'deepseek-v3'
    })
    const raw = (result && typeof result === 'string') ? result.trim() : ''
    let jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let arr
    try {
      arr = JSON.parse(jsonStr)
    } catch (_) {
      return { success: true }
    }
    if (!Array.isArray(arr) || arr.length === 0) return { success: true }
    for (const item of arr.slice(0, 5)) {
      const content = item && (item.content || item.text)
      const category = (item && item.category) ? String(item.category).trim() : '通用'
      if (content && String(content).trim()) {
        try {
          memoryStore.appendLesson(String(content).trim(), category)
        } catch (e) {
          console.warn('[AI] evolve appendLesson failed:', e.message)
        }
      }
    }
    return { success: true }
  } catch (e) {
    console.warn('[AI] evolve-from-session failed:', e.message)
    return { success: true }
  }
})

// 列出项目所有历史对话（用于对话列表 UI）
registerChannel('ai-list-conversations', async (event, { projectPath }) => {
  try {
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const list = conversationFile.listConversations(projectKey)
    return { success: true, conversations: list }
  } catch (error) {
    return { success: false, conversations: [] }
  }
})

// 可扩展的会话来源：主会话、飞书、Gateway（浏览器/WebSocket 客户端）
const SESSION_SOURCES = [
  { projectPath: MAIN_CHAT_PROJECT, source: 'main', label: '主会话' },
  { projectPath: FEISHU_PROJECT, source: 'feishu', label: '飞书' },
  { projectPath: GATEWAY_PROJECT, source: 'gateway', label: 'Gateway' },
  { projectPath: TELEGRAM_PROJECT, source: 'telegram', label: 'Telegram' },
  { projectPath: DINGTALK_PROJECT, source: 'dingtalk', label: '钉钉' }
]

// 统一会话列表（主会话 + 飞书 + 后续扩展）；主会话只展示一条（最新），新会话 id 仍关联主会话
registerChannel('ai-list-all-sessions', async () => {
  try {
    const sessions = filterSessionsList(conversationFile.listAllSessions(SESSION_SOURCES))
    return { success: true, sessions }
  } catch (error) {
    return { success: false, sessions: [], message: error.message }
  }
})

// 更新某会话的统计（副标题等），不重写消息体
registerChannel('ai-update-session-stats', async (event, { projectPath, sessionId, lastMessage }) => {
  try {
    const projectKey = conversationFile.hashProjectPath(projectPath)
    const meta = {}
    if (lastMessage !== undefined) meta.lastMessage = lastMessage
    if (Object.keys(meta).length === 0) return { success: true }
    conversationFile.updateConversationMeta(projectKey, sessionId, meta)
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('ai-rename-conversation', async (event, { projectPath, sessionId, title }) => {
  try {
    const projectKey = conversationFile.hashProjectPath(projectPath)
    conversationFile.updateConversationMeta(projectKey, sessionId, { title })
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ---- 统一会话列表（主会话 + 飞书 + 可扩展） ----

registerChannel('ai-get-sessions', async () => {
  try {
    const sessions = filterSessionsList(conversationFile.listAllSessions(SESSION_SOURCES))
    return { success: true, sessions }
  } catch (error) {
    return { success: false, sessions: [], message: error.message }
  }
})

registerChannel('ai-save-session', async (event, { projectPath, id, title, updatedAt }) => {
  try {
    const proj = projectPath || MAIN_CHAT_PROJECT
    const projectKey = conversationFile.hashProjectPath(proj)
    conversationFile.updateConversationMeta(projectKey, id, { title, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString() })
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('ai-delete-session', async (event, { projectPath, id }) => {
  try {
    const proj = projectPath || MAIN_CHAT_PROJECT
    if (proj === MAIN_CHAT_PROJECT) {
      return { success: false, message: '主会话不可删除' }
    }
    const projectKey = conversationFile.hashProjectPath(proj)
    conversationFile.deleteConversation(projectKey, id)
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ==================== 飞书接收消息 → AI 思考 → 回发（长连接 + 会话列表） ====================
const { createEventBus } = require('./core/events')
const { createInboundMessage, createSessionBinding } = require('./core/message-model')
const eventBus = createEventBus()
const chatChannelRegistry = require('./extensions/chat-channel-registry')
const { createFeishuAdapter } = require('./extensions/adapters/feishu')
const { createTelegramAdapter } = require('./extensions/adapters/telegram')
const { createDingtalkAdapter } = require('./extensions/adapters/dingtalk')
const openultronConfigChannels = require('./openultron-config')
function getChannelConfig(key) {
  if (key === 'feishu') return openultronConfigChannels.getFeishu()
  if (key === 'telegram') return openultronConfigChannels.getTelegram()
  if (key === 'dingtalk') return openultronConfigChannels.getDingtalk()
  return null
}
chatChannelRegistry.register(createFeishuAdapter(eventBus, getChannelConfig))
chatChannelRegistry.register(createTelegramAdapter(eventBus, getChannelConfig))
chatChannelRegistry.register(createDingtalkAdapter(eventBus, getChannelConfig))

const feishuWsReceive = require('./ai/feishu-ws-receive')

// 从回复文本中提取 local-resource://screenshots/... 的截图，返回清理后的文本和本地文件路径列表
function extractLocalResourceScreenshots(text) {
  const re = /!\[([^\]]*)\]\((local-resource:\/\/screenshots\/[^)]+)\)/g
  const filePaths = []
  let match
  while ((match = re.exec(text)) !== null) {
    const urlPath = match[2] // local-resource://screenshots/filename.png
    const filename = urlPath.replace(/^local-resource:\/\/screenshots\//i, '').replace(/^\/+/, '')
    if (filename) {
      const fullPath = getAppRootPath('screenshots', filename)
      filePaths.push(fullPath)
    }
  }
  const cleanedText = text.replace(/!\[[^\]]*\]\(local-resource:\/\/screenshots\/[^)]+\)/g, '【截图】')
  return { cleanedText, filePaths }
}

// 只取「当前轮」消息：从最后一条 user 消息之后到结尾（避免把历史轮次的截图也发出去）
function getCurrentRoundMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx < 0) return messages
  return messages.slice(lastUserIdx + 1)
}

function detectImageExtFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9) return 'jpg'
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp'
  return null
}

function isValidImageBase64(input) {
  if (!input || typeof input !== 'string') return false
  let raw = input.trim()
  if (!raw) return false
  // 截断文本（工具结果被裁剪）直接判定无效，避免误发
  if (raw.includes('...(已截断') || raw.includes('...(truncated)')) return false
  const m = raw.match(/^data:[^;,]+;base64,(.*)$/i)
  if (m) raw = m[1] || ''
  raw = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  while (raw.length % 4 !== 0) raw += '='
  if (raw.length < 128) return false
  const buf = Buffer.from(raw, 'base64')
  if (!buf || buf.length < 16) return false
  return !!detectImageExtFromBuffer(buf)
}

// 从本轮对话的 tool 结果中收集截图：路径或 base64（webview_control 返回 file_path；MCP 可能只返回 image_base64）
// 返回 { path?: string, base64?: string }[]，供飞书 adapter 直接发图
function extractScreenshotsFromMessages(messages) {
  const out = []
  if (!Array.isArray(messages)) return out
  const seenPath = new Set()
  const seenBase64 = new Set()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    let raw = msg.content
    if (raw == null) continue
    if (typeof raw !== 'string') raw = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    let filePath = null
    let fileUrl = null
    let imageBase64 = null
    try {
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object') {
        filePath = obj.file_path || obj.filePath
        fileUrl = obj.file_url || obj.fileUrl
        imageBase64 = obj.image_base64 || obj.imageBase64
      }
    } catch (e) {
      const pathMatch = raw.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (pathMatch) filePath = pathMatch[1]
      if (!filePath) {
        const urlMatch = raw.match(/"file_url"\s*:\s*"(local-resource:\/\/screenshots\/[^"]+)"/)
        if (urlMatch) fileUrl = urlMatch[1]
      }
      if (!imageBase64 && raw.includes('"image_base64"')) {
        const b64Match = raw.match(/"image_base64"\s*:\s*"([^"]*)"/)
        if (b64Match && b64Match[1].length > 100) imageBase64 = b64Match[1]
      }
    }
    if (filePath && typeof filePath === 'string' && filePath.includes('screenshots') && !seenPath.has(filePath)) {
      seenPath.add(filePath)
      out.push({ path: filePath })
    } else if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('local-resource://screenshots/')) {
      const filename = fileUrl.replace(/^local-resource:\/\/screenshots\//i, '').replace(/^\/+/, '')
      if (filename) {
        const fullPath = getAppRootPath('screenshots', filename)
        if (!seenPath.has(fullPath)) {
          seenPath.add(fullPath)
          out.push({ path: fullPath })
        }
      }
    }
    if (imageBase64 && typeof imageBase64 === 'string' && isValidImageBase64(imageBase64) && !seenBase64.has(imageBase64.slice(0, 50))) {
      seenBase64.add(imageBase64.slice(0, 50))
      out.push({ base64: imageBase64 })
    }
  }
  return out
}

// 从单条工具结果（字符串或对象）中解析出截图 path 或 base64，供飞书从 ai-chat-tool-result 实时收集
function parseScreenshotFromToolResult(result) {
  const out = []
  let filePath = null
  let fileUrl = null
  let imageBase64 = null
  let obj = null
  if (result == null) return out
  if (typeof result === 'object' && !Array.isArray(result) && !result.error) {
    obj = result
    filePath = obj.file_path || obj.filePath || obj.path
    fileUrl = obj.file_url || obj.fileUrl
    imageBase64 = obj.image_base64 || obj.imageBase64
  } else {
    const resultStr = typeof result === 'string' ? result : String(result)
    try {
      obj = JSON.parse(resultStr)
      if (obj && typeof obj === 'object' && !obj.error) {
        filePath = obj.file_path || obj.filePath || obj.path
        fileUrl = obj.file_url || obj.fileUrl
        imageBase64 = obj.image_base64 || obj.imageBase64
      }
    } catch (e) {
      const pathMatch = resultStr.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (pathMatch) filePath = pathMatch[1]
      if (!filePath) {
        const pathAlt = resultStr.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        if (pathAlt) filePath = pathAlt[1]
      }
      if (!filePath) {
        const urlMatch = resultStr.match(/"file_url"\s*:\s*"(local-resource:\/\/screenshots\/[^"]+)"/)
        if (urlMatch) fileUrl = urlMatch[1]
      }
      if (resultStr.includes('"image_base64"')) {
        const b64Match = resultStr.match(/"image_base64"\s*:\s*"([^"]*)"/)
        if (b64Match && b64Match[1].length > 100) imageBase64 = b64Match[1]
      }
    }
  }
  if (filePath && typeof filePath === 'string' && filePath.length > 0) {
    const pathToPush = path.isAbsolute(filePath) ? filePath : getAppRootPath('screenshots', path.basename(filePath))
    out.push({ path: pathToPush })
  }
  if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('local-resource://screenshots/')) {
    const filename = fileUrl.replace(/^local-resource:\/\/screenshots\//i, '').replace(/^\/+/, '')
    if (filename) out.push({ path: getAppRootPath('screenshots', filename) })
  }
  if (imageBase64 && typeof imageBase64 === 'string' && isValidImageBase64(imageBase64)) {
    out.push({ base64: imageBase64 })
  }
  return out
}

// 已通过飞书发出截图时，去掉回复里「需要配置 chat_id」「请提供会话 ID」「截图文件路径」等误导性文案
function stripFeishuScreenshotMisfireText(text) {
  if (!text || typeof text !== 'string') return text
  let s = text
  // 整段：从「由于飞书通知需要配置」到「我就可以把截图发给你了」整句
  s = s.replace(/由于飞书通知需要配置[^。]*chat_id[^。]*。[^\n]*请提供[^。]*。[^\n]*我就可以把截图发给你了[^。]*。?/g, '')
  s = s.replace(/由于飞书通知需要配置[^\n]+/g, '')
  s = s.replace(/请提供你的飞书会话\s*ID[^\n]+/g, '')
  s = s.replace(/或者到[^\n]+配置默认会话[^\n]+/g, '')
  s = s.replace(/我就可以把截图发给你了[^\n]*/g, '')
  // 去掉「截图文件路径：`/xxx`」整行
  s = s.replace(/截图文件路径[：:]\s*`[^`]+`\s*/g, '')
  s = s.replace(/^截图已保存[。.]?\s*/gm, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

// 仅从 assistant 消息内容中提取可发送文本（支持 string / 多段 content）
function getAssistantText(message) {
  if (!message || message.role !== 'assistant') return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (!part) return ''
        if (typeof part === 'string') return part
        if (typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

// 主 Agent + 子 Agent：新消息到达时派生子 Agent，不直接停前一个；子 Agent 可调 stop_previous_task 停掉前边，或 wait_for_previous_run 等待前边完成再继续
function channelSessionKey(binding) {
  return `${binding.projectPath}:${binding.sessionId}`
}
const channelCurrentRun = new Map() // key -> Array<{ runId, runSessionId, promise, startTime }>
const channelKeyByRunSessionId = new Map() // runSessionId -> key（供 stop_previous_task / wait_for_previous_run 用）
const runStartTimeBySessionId = new Map() // runSessionId -> startTime
const abortedRunSessionIds = new Set() // 被 stop_previous_task 停掉的 run，完成时不合并、不回发

async function processMessageReplace(payload) {
  const { binding } = payload || {}
  if (!binding || (binding.channel !== 'feishu' && binding.channel !== 'telegram' && binding.channel !== 'dingtalk')) return
  const key = channelSessionKey(binding)
  const mainSessionId = binding.sessionId
  // 同一会话收到新消息时，默认中止之前仍在运行的子任务，避免并发串话/错答
  const existingRuns = channelCurrentRun.get(key) || []
  for (const r of existingRuns) {
    abortedRunSessionIds.add(r.runSessionId)
    aiOrchestrator.stopChat(r.runSessionId)
  }
  const runId = Date.now()
  const runSessionId = `${mainSessionId}-run-${runId}`
  const startTime = Date.now()
  if (binding.channel === 'feishu' && payload.message && payload.message.messageId) {
    try {
      const res = await feishuNotify.addMessageReaction(payload.message.messageId, 'Typing')
      if (res && res.success && res.reaction_id) payload.typingReactionId = res.reaction_id
    } catch (_) { /* 在用户消息上加「敲键盘」表情失败则忽略 */ }
  }
  if (!channelCurrentRun.has(key)) channelCurrentRun.set(key, [])
  const promise = handleChatMessageReceived(payload, runSessionId, mainSessionId, key, runId, startTime).finally(() => {
    const arr = channelCurrentRun.get(key)
    if (arr) {
      const i = arr.findIndex(r => r.runSessionId === runSessionId)
      if (i >= 0) arr.splice(i, 1)
      if (arr.length === 0) channelCurrentRun.delete(key)
    }
    channelKeyByRunSessionId.delete(runSessionId)
    runStartTimeBySessionId.delete(runSessionId)
  })
  const runEntry = { runId, runSessionId, promise, startTime }
  channelCurrentRun.get(key).push(runEntry)
  channelKeyByRunSessionId.set(runSessionId, key)
  runStartTimeBySessionId.set(runSessionId, startTime)
}

// 应用层：每条新消息派生子 Agent（runSessionId），子 Agent 可停前边或等待前边；完成时合并回主会话并回发
async function handleChatMessageReceived(payload, runSessionId, mainSessionId, key, runId, startTime) {
  const { message, binding } = payload || {}
  if (!message || !binding) return
  if (binding.channel !== 'feishu' && binding.channel !== 'telegram' && binding.channel !== 'dingtalk') return
  const typingReactionId = payload.typingReactionId || null
  const userMessageId = message.messageId || null
  const chatId = binding.remoteId
  const projectPath = binding.channel === 'feishu'
    ? FEISHU_PROJECT
    : (binding.channel === 'telegram' ? TELEGRAM_PROJECT : DINGTALK_PROJECT)
  const projectKey = conversationFile.hashProjectPath(projectPath)
  let conv = conversationFile.loadConversation(projectKey, mainSessionId)
  if (!conv) {
    const now = new Date().toISOString()
    const titlePrefix = binding.channel === 'feishu'
      ? '飞书'
      : (binding.channel === 'telegram' ? 'Telegram' : '钉钉')
    conversationFile.updateConversationMeta(projectKey, mainSessionId, {
      title: `${titlePrefix}: ${String(chatId).slice(0, 20)}`,
      updatedAt: now,
      createdAt: now,
      messageCount: 0
    })
  }
  const messages = (conv && conv.messages) ? [...conv.messages] : []
  messages.push({ role: 'user', content: message.text })
  const originalConvLength = messages.length - 1
  const nowIso = new Date().toISOString()
  conversationFile.updateConversationMeta(projectKey, mainSessionId, { updatedAt: nowIso })
  if (binding.channel === 'feishu' && mainWindow && mainWindow.webContents) {
    const displayText = message?.metadata?.displayText || message.text
    const attachments = Array.isArray(message?.metadata?.attachments)
      ? message.metadata.attachments
      : (Array.isArray(message?.attachments) ? message.attachments : [])
    mainWindow.webContents.send('feishu-session-user-message', {
      sessionId: mainSessionId,
      text: displayText,
      attachments,
      messageId: userMessageId || ''
    })
  }
  const legacy = getAIConfigLegacy()
  const resolvedKey = legacy && legacy.providerKeys && legacy.config && legacy.providerKeys[legacy.config.apiBaseUrl]
  const apiKey = resolvedKey || (legacy && legacy.config && legacy.config.apiKey) || ''
  if (!apiKey) {
    if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
      await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
    }
    const errBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
    eventBus.emit('chat.session.completed', { binding: errBinding, payload: { text: '请先在应用内配置 API Key 后再使用。' } })
    return
  }
  const collectedScreenshots = []
  const completePromise = new Promise((resolve, reject) => {
    const fakeSender = {
      send: (channel, data) => {
        if (channel === 'ai-chat-complete' && data && data.messages) {
          resolve(data.messages)
        }
        if (channel === 'ai-chat-error') reject(new Error((data && data.error) || 'AI 出错'))
        if (channel === 'ai-chat-tool-result' && data) {
          const raw = data.result != null ? (typeof data.result === 'string' ? data.result : JSON.stringify(data.result)) : ''
          if (raw) {
            // execute_command 的流式增量（partial/running）不做截图解析，避免高频 JSON 解析拖慢主线程
            let skipParse = false
            try {
              const obj = JSON.parse(raw)
              if (obj && typeof obj === 'object' && (obj.partial === true || obj.running === true)) skipParse = true
            } catch (_) { /* ignore */ }
            const items = skipParse ? [] : parseScreenshotFromToolResult(raw)
            if (items.length > 0) {
              appLogger?.info?.('[Feishu] 从 tool 结果收集到截图', { name: data.name, count: items.length })
            }
            for (const item of items) collectedScreenshots.push(item)
          }
        }
        if (binding.channel === 'feishu' && mainWindow && mainWindow.webContents && data) {
          const p = { ...data, sessionId: mainSessionId }
          if (channel === 'ai-chat-token' || channel === 'ai-chat-tool-call' || channel === 'ai-chat-tool-result' || channel === 'ai-chat-complete' || channel === 'ai-chat-error') {
            mainWindow.webContents.send(channel, p)
          }
        }
      }
    }
    const runChatPayload = {
      sessionId: runSessionId,
      messages,
      model: undefined,
      tools: getToolsForChat(),
      projectPath
    }
    if (binding.channel === 'feishu') runChatPayload.feishuChatId = chatId
    aiGateway.runChat(runChatPayload, fakeSender).catch(reject)
  })
  try {
    const finalMessages = await completePromise
    const wasAborted = abortedRunSessionIds.has(runSessionId)
    if (wasAborted) {
      abortedRunSessionIds.delete(runSessionId)
      if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
        await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
      }
      return
    }
    const delta = finalMessages.slice(originalConvLength)
    const latestAssistant = [...delta]
      .reverse()
      .find((m) => m && m.role === 'assistant' && getAssistantText(m).trim())
    const toSend = latestAssistant ? getAssistantText(latestAssistant) : ''
    const { cleanedText: cleanedRaw, filePaths: pathsFromText } = extractLocalResourceScreenshots(toSend)
    const currentRound = getCurrentRoundMessages(finalMessages)
    const screenshotsFromTools = extractScreenshotsFromMessages(currentRound)
    const imageItems = []
    const seenPath = new Set()
    const seenBase64Head = new Set()
    for (const item of collectedScreenshots) {
      if (item.path && !seenPath.has(item.path)) {
        seenPath.add(item.path)
        imageItems.push({ path: item.path })
      } else if (item.base64) {
        const head = item.base64.slice(0, 80)
        if (!seenBase64Head.has(head)) { seenBase64Head.add(head); imageItems.push({ base64: item.base64 }) }
      }
    }
    for (const p of pathsFromText) {
      if (!seenPath.has(p)) { seenPath.add(p); imageItems.push({ path: p }) }
    }
    for (const item of screenshotsFromTools) {
      if (item.path && !seenPath.has(item.path)) {
        seenPath.add(item.path)
        imageItems.push({ path: item.path })
      } else if (item.base64) {
        const head = item.base64.slice(0, 80)
        if (!seenBase64Head.has(head)) { seenBase64Head.add(head); imageItems.push({ base64: item.base64 }) }
      }
    }
    const cleanedText = stripFeishuScreenshotMisfireText(cleanedRaw)
    const textToSend = (cleanedText && cleanedText.trim()) ? cleanedText.trim() : (imageItems.length > 0 ? '截图已发至当前会话。' : '（无回复内容）')
    if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
      await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
    }
    const mainConv = conversationFile.loadConversation(projectKey, mainSessionId)
    const baseMessages = (mainConv && mainConv.messages) ? mainConv.messages : []
    const insertAt = Math.min(originalConvLength, baseMessages.length)
    const merged = [...baseMessages.slice(0, insertAt), ...delta, ...baseMessages.slice(insertAt)]
    const messagesToSave = stripToolExecutionFromMessages(merged)
    const savePayload = { id: mainSessionId, messages: messagesToSave, projectPath }
    if (binding.channel === 'feishu') savePayload.feishuChatId = chatId
    conversationFile.saveConversation(projectKey, savePayload)
    if (binding.channel === 'feishu' && mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('feishu-session-updated', { sessionId: mainSessionId })
    }
    const outBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
    const outPayload = { text: textToSend, images: imageItems }
    if (binding.channel === 'telegram') {
      try {
        const tgCfg = require('./openultron-config').getTelegram()
        if (tgCfg && tgCfg.voice_reply_enabled) outPayload.audio_text = textToSend
      } catch (_) {}
    }
    if (binding.channel === 'dingtalk') {
      try {
        const dtCfg = require('./openultron-config').getDingtalk()
        if (dtCfg && dtCfg.voice_reply_enabled) outPayload.audio_text = textToSend
      } catch (_) {}
    }
    if (imageItems.length > 0) {
      appLogger?.info?.(`[${binding.channel}] 会话完成，带图回发`, { imageCount: imageItems.length })
    }
    eventBus.emit('chat.session.completed', { binding: outBinding, payload: outPayload })
  } catch (e) {
    console.error(`[${binding.channel}] 处理或回复失败:`, e.message)
    if (binding.channel === 'feishu' && userMessageId && typingReactionId) {
      await feishuNotify.deleteMessageReaction(userMessageId, typingReactionId).catch(() => {})
    }
    const errBinding = { ...binding, sessionId: mainSessionId, projectPath, remoteId: chatId, ...(binding.channel === 'feishu' && { feishuChatId: chatId }) }
    eventBus.emit('chat.session.completed', { binding: errBinding, payload: { text: `处理出错: ${e.message}` } })
  }
}

function stopPreviousRunsForChannel(currentRunSessionId) {
  const key = channelKeyByRunSessionId.get(currentRunSessionId)
  if (!key) return 0
  const runs = channelCurrentRun.get(key) || []
  let affected = 0
  for (const r of runs) {
    if (r.runSessionId !== currentRunSessionId) {
      abortedRunSessionIds.add(r.runSessionId)
      aiOrchestrator.stopChat(r.runSessionId)
      affected++
    }
  }
  return affected
}

async function waitForPreviousRuns(currentRunSessionId) {
  const key = channelKeyByRunSessionId.get(currentRunSessionId)
  const currentStart = runStartTimeBySessionId.get(currentRunSessionId)
  if (!key || currentStart == null) return 0
  const runs = (channelCurrentRun.get(key) || []).filter(r => r.runSessionId !== currentRunSessionId && r.startTime < currentStart)
  if (runs.length === 0) return 0
  await Promise.all(runs.map(r => r.promise.catch(() => {})))
  return runs.length
}

eventBus.on('chat.message.received', processMessageReplace)

function handleChatSessionCompleted(payload) {
  const { binding, payload: outPayload } = payload || {}
  if (!binding || !binding.channel) return
  const adapter = chatChannelRegistry.get(binding.channel)
  if (adapter && adapter.send) {
    adapter.send(binding, outPayload || {}).catch(e => console.error('[ChatChannel] send failed:', e.message))
  }
}
eventBus.on('chat.session.completed', handleChatSessionCompleted)

function getConfigForChannels(key) {
  if (key === 'feishu') return feishuNotify.getConfig()
  if (key === 'telegram') return require('./openultron-config').getTelegram()
  if (key === 'dingtalk') return require('./openultron-config').getDingtalk()
  return null
}

function startFeishuReceive() {
  return chatChannelRegistry.startAll(getConfigForChannels).catch(e => {
    console.warn('[Feishu] 接收启动失败:', e.message)
    throw e
  })
}

registerChannel('feishu-receive-status', () => {
  const feishuAdapter = chatChannelRegistry.get('feishu')
  return {
    running: feishuAdapter ? feishuAdapter.isRunning() : false,
    error: feishuWsReceive.getLastError ? feishuWsReceive.getLastError() : null
  }
})

registerChannel('get-telegram-config', () => require('./openultron-config').getTelegram())
registerChannel('set-telegram-config', (event, payload) => {
  require('./openultron-config').setTelegram(payload || {})
  startFeishuReceive().catch(e => console.warn('[Channels] 重启渠道失败:', e.message))
  return { ok: true }
})
registerChannel('telegram-receive-status', () => {
  const adapter = chatChannelRegistry.get('telegram')
  return {
    running: adapter ? adapter.isRunning() : false,
    error: adapter && adapter.getLastError ? adapter.getLastError() : null
  }
})

registerChannel('get-dingtalk-config', () => require('./openultron-config').getDingtalk())
registerChannel('set-dingtalk-config', (event, payload) => {
  require('./openultron-config').setDingtalk(payload || {})
  startFeishuReceive().catch(e => console.warn('[Channels] 重启渠道失败:', e.message))
  return { ok: true }
})
registerChannel('dingtalk-receive-status', () => {
  const adapter = chatChannelRegistry.get('dingtalk')
  return {
    running: adapter ? adapter.isRunning() : false,
    error: adapter && adapter.getLastError ? adapter.getLastError() : null
  }
})
registerChannel('dingtalk-inbound', async (event, payload = {}) => {
  const adapter = chatChannelRegistry.get('dingtalk')
  if (!adapter || typeof adapter.receive !== 'function') {
    return { ok: false, error: 'dingtalk adapter unavailable' }
  }
  return adapter.receive(payload || {})
})

// Doctor：轻量诊断（配置、端口、飞书连接等），供设置页与 GET /api/doctor 使用
registerChannel('doctor-run', async () => {
  const openultronConfig = require('./openultron-config')
  const checks = []
  // Gateway 是否在监听
  const gatewayOk = aiGateway && typeof aiGateway.isRunning === 'function' && aiGateway.isRunning()
  checks.push({
    id: 'gateway',
    name: 'Gateway WebSocket',
    status: gatewayOk ? 'pass' : 'fail',
    message: gatewayOk ? 'Gateway 正在监听' : 'Gateway 未在监听',
    fixHint: gatewayOk ? null : '请确认应用已正常启动，或查看日志排查 Gateway 启动失败原因。'
  })
  // 飞书接收状态（仅当配置了 receive_enabled 时要求 running）
  const feishuConfig = openultronConfig.getFeishu()
  const feishuStatus = (() => {
    try {
      const feishuAdapter = chatChannelRegistry.get('feishu')
      return {
        running: feishuAdapter ? feishuAdapter.isRunning() : false,
        error: feishuWsReceive.getLastError ? feishuWsReceive.getLastError() : null
      }
    } catch (_) {
      return { running: false, error: '无法获取状态' }
    }
  })()
  const feishuEnabled = feishuConfig && feishuConfig.receive_enabled
  let feishuCheckStatus = 'pass'
  let feishuMessage = '未开启飞书接收'
  let feishuFixHint = null
  if (feishuEnabled) {
    if (feishuStatus.running) {
      feishuMessage = '飞书接收长连接运行中'
    } else {
      feishuCheckStatus = 'fail'
      feishuMessage = feishuStatus.error || '飞书接收未连接'
      feishuFixHint = '请检查飞书 app_id/app_secret 与事件订阅配置，或在「消息通知」中重新开启接收。'
    }
  }
  checks.push({
    id: 'feishu',
    name: '飞书消息接收',
    status: feishuCheckStatus,
    message: feishuMessage,
    fixHint: feishuFixHint
  })
  // 应用根目录是否存在
  const appRoot = getAppRoot()
  const appRootExists = fs.existsSync(appRoot)
  checks.push({
    id: 'app_root',
    name: '应用数据目录',
    status: appRootExists ? 'pass' : 'warn',
    message: appRootExists ? `目录存在: ${appRoot}` : `目录不存在: ${appRoot}`,
    fixHint: appRootExists ? null : '应用会在首次写入配置时自动创建，若持续报错请检查磁盘权限。'
  })
  // 配置文件是否存在
  const configPath = openultronConfig.getPath()
  const configExists = fs.existsSync(configPath)
  checks.push({
    id: 'config',
    name: '配置文件',
    status: configExists ? 'pass' : 'warn',
    message: configExists ? `已找到: ${configPath}` : `未找到: ${configPath}`,
    fixHint: configExists ? null : '首次打开设置并保存后会创建，或从备份恢复。'
  })
  // 硬件能力（screen / notify）注册与开关
  const hwConfig = openultronConfig.getHardware && openultronConfig.getHardware()
  const hwList = hardwareRegistry.list()
  const hwSummary = hwList.length
    ? hwList.map(c => `${c.id}(${hwConfig && hwConfig[c.id] && hwConfig[c.id].enabled === false ? '已关闭' : '已开启'})`).join('、')
    : '无'
  checks.push({
    id: 'hardware',
    name: '硬件能力',
    status: 'pass',
    message: `已注册: ${hwSummary}。可通过 hardware_invoke 调用；在 openultron.json 的 hardware.<id>.enabled 可开关。`,
    fixHint: null
  })
  return { checks }
})

// Webhook 触发：外部系统 POST /api/webhook 后调用，校验 path/secret 后触发一次 runChat（fire-and-forget）
registerChannel('webhook-trigger', async (event, payload) => {
  const { path: webhookPath, secret, body, userMessage } = payload || {}
  const openultronConfigWebhooks = require('./openultron-config').getWebhooks()
  const entry = openultronConfigWebhooks.find(w => w.path && String(w.path).trim() === String(webhookPath).trim())
  if (!entry) {
    return { success: false, error: 'unknown path', accepted: false }
  }
  if (entry.secret && String(entry.secret).trim() !== '') {
    if (secret !== entry.secret) {
      return { success: false, error: 'invalid secret', accepted: false }
    }
  }
  const sessionId = `webhook-${String(webhookPath).replace(/[^a-zA-Z0-9-_]/g, '_')}-${Date.now()}`
  const projectPath = '__webhook__'
  const systemContent = '这是一次由 Webhook 触发的执行。请根据用户提供的上下文完成任务。'
  const userContent = userMessage != null && String(userMessage).trim() !== '' ? String(userMessage).trim() : (body && typeof body === 'string' ? body : (body && body.message ? String(body.message) : '（无正文）'))
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ]
  const noopSender = { send: () => {} }
  aiGateway.runChat(
    {
      sessionId,
      projectPath,
      messages,
      model: undefined,
      tools: getToolsForChat()
    },
    noopSender
  ).catch(e => appLogger?.warn?.('[Webhook] runChat 失败:', e.message))
  return { success: true, accepted: true, sessionId }
})

registerChannel('feishu-receive-start', async () => {
  try {
    await startFeishuReceive()
    const feishuAdapter = chatChannelRegistry.get('feishu')
    return { success: true, running: feishuAdapter ? feishuAdapter.isRunning() : false, error: null }
  } catch (e) {
    const err = e.message || String(e)
    return { success: false, running: false, error: err }
  }
})
registerChannel('feishu-receive-stop', () => {
  const feishuAdapter = chatChannelRegistry.get('feishu')
  if (feishuAdapter) feishuAdapter.stop()
  return { success: true }
})

// 读取项目 AGENT.md（存放于 .gitManager/AGENT.md，与 .cursor/rules、.claude/CLAUDE.md 同理）
registerChannel('ai-read-agent-md', async (event, { projectPath }) => {
  try {
    if (!projectPath) return { success: false, content: null }
    const agentMdPath = path.join(projectPath, '.gitManager', 'AGENT.md')
    if (!fs.existsSync(agentMdPath)) return { success: true, content: null }
    const content = fs.readFileSync(agentMdPath, 'utf-8').trim()
    return { success: true, content: content || null }
  } catch (error) {
    return { success: false, content: null }
  }
})

// 技能管理（基于文件 <appRoot>/skills/）
registerChannel('ai-get-skills', async () => {
  try {
    _skillsCache = readAllSkills()
    return { success: true, skills: _skillsCache }
  } catch (error) {
    return { success: false, message: error.message, skills: _skillsCache || [] }
  }
})

registerChannel('ai-save-skill', async (event, skill) => {
  try {
    ensureSkillsDir()
    const safeName = (skill.id || skill.name).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_')
    writeSkillFile(safeName, skill)
    _skillsCache = readAllSkills()
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('ai-delete-skill', async (event, { id }) => {
  try {
    const builtinIds = new Set(BUILTIN_SKILLS.map(s => s.id))
    if (builtinIds.has(id)) {
      const deleted = store.get('aiDeletedBuiltinSkillIds', [])
      if (!deleted.includes(id)) store.set('aiDeletedBuiltinSkillIds', [...deleted, id])
    }
    const skillDir = path.join(_skillsDir, id)
    if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true })
    _skillsCache = readAllSkills()
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})
// ── MCP 配置管理（JSON 格式，兼容 Claude Desktop）──────────────────

function getClaudeDesktopConfigPath() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'Claude', 'claude_desktop_config.json')
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

// 返回「内置 chrome-devtools + 文件」合并后的配置，供 UI 展示，避免内置项消失
function getMergedMcpConfigForDisplay() {
  const json = mcpConfigFile.readMcpConfig(store)
  let obj = {}
  try {
    obj = typeof json === 'string' ? JSON.parse(json) : (json || {})
  } catch { return JSON.stringify({ mcpServers: BUILTIN_CHROME_DEVTOOLS_MCP }) }
  if (obj.mcpServers && typeof obj.mcpServers === 'object') obj = obj.mcpServers
  const merged = { ...BUILTIN_CHROME_DEVTOOLS_MCP, ...obj }
  return JSON.stringify({ mcpServers: merged }, null, 2)
}

// 保存时剔除内置 chrome-devtools，只把用户配置写入文件
function stripBuiltinMcpForSave(configStr) {
  let obj = {}
  try {
    obj = typeof configStr === 'string' ? JSON.parse(configStr) : (configStr || {})
  } catch { return configStr }
  const servers = obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj
  const builtin = BUILTIN_CHROME_DEVTOOLS_MCP['chrome-devtools']
  if (builtin && servers['chrome-devtools']) {
    const cur = servers['chrome-devtools']
    if (cur.command === builtin.command && JSON.stringify(cur.args || []) === JSON.stringify(builtin.args || [])) {
      delete servers['chrome-devtools']
    }
  }
  return JSON.stringify({ mcpServers: servers }, null, 2)
}

registerChannel('ai-get-mcp-config', async () => {
  try {
    const config = getMergedMcpConfigForDisplay()
    return { success: true, config }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('ai-save-mcp-config', async (event, { config }) => {
  try {
    // 验证 JSON 合法性
    JSON.parse(config)
    // 保存时剔除内置 chrome-devtools，只写用户配置到文件
    const toWrite = stripBuiltinMcpForSave(config)
    mcpConfigFile.writeMcpConfig(toWrite)
    // 重启所有 MCP servers（parseMcpJsonConfig 会再次合并内置，保证 chrome-devtools 被启动）
    aiMcpManager.stopAll()
    const disabledServers = store.get('aiMcpDisabledServers', [])
    const servers = parseMcpJsonConfig(toWrite, disabledServers)
    if (servers.length > 0) {
      await aiMcpManager.startAll(servers)
    }
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('ai-import-claude-mcp', async () => {
  try {
    const configPath = getClaudeDesktopConfigPath()
    if (!fs.existsSync(configPath)) {
      return { success: false, message: '未找到 Claude Desktop 配置文件' }
    }
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const mcpServers = parsed.mcpServers || {}
    return { success: true, config: JSON.stringify(mcpServers, null, 2) }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('ai-get-mcp-status', async () => {
  try {
    return { success: true, status: aiMcpManager.getStatus() }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 重新连接所有 MCP：先 stopAll 再按当前配置 startAll（用于「刷新状态」真正重连）
registerChannel('ai-reconnect-mcp', async () => {
  try {
    const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
    const disabledServers = store.get('aiMcpDisabledServers', [])
    aiMcpManager.stopAll()
    const servers = parseMcpJsonConfig(mcpConfigJson, disabledServers)
    if (servers.length > 0) {
      await aiMcpManager.startAll(servers)
    }
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

registerChannel('ai-get-mcp-disabled', async () => {
  return { success: true, disabled: store.get('aiMcpDisabledServers', []) }
})

registerChannel('ai-toggle-mcp-server', async (event, { name, enabled }) => {
  try {
    let disabled = store.get('aiMcpDisabledServers', [])
    if (enabled) {
      disabled = disabled.filter(n => n !== name)
    } else {
      if (!disabled.includes(name)) disabled.push(name)
    }
    store.set('aiMcpDisabledServers', disabled)
    // 按需启动或停止该 server
    if (enabled) {
      const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
      const allServers = parseMcpJsonConfig(mcpConfigJson, [])
      const cfg = allServers.find(s => s.name === name)
      if (cfg) await aiMcpManager.startServer({ ...cfg })
    } else {
      aiMcpManager.stopServer(name)
    }
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 单服务器重启：先停止再启动（chrome-devtools 会在 startServer 内清除 profile 锁，解决「被占用」）
registerChannel('ai-restart-mcp-server', async (event, { name }) => {
  try {
    const disabledServers = store.get('aiMcpDisabledServers', [])
    if (disabledServers.includes(name)) {
      return { success: false, message: '该服务器已禁用，请先启用后再重启' }
    }
    aiMcpManager.stopServer(name)
    const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
    const servers = parseMcpJsonConfig(mcpConfigJson, disabledServers)
    const cfg = servers.find(s => s.name === name)
    if (!cfg) return { success: false, message: `未找到服务器 "${name}" 的配置` }
    await aiMcpManager.startServer({ ...cfg })
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ── AI 数据备份 / 恢复 ──────────────────────────────────────
// 导出备份：返回 JSON 字符串，包含技能、MCP 配置
registerChannel('ai-export-backup', async () => {
  try {
    // 1. 读取 <appRoot>/skills/ 下所有技能（含内置，不含 claude 来源）
    const skillsData = {}
    if (fs.existsSync(_skillsDir)) {
      for (const entry of fs.readdirSync(_skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skillDir = path.join(_skillsDir, entry.name)
        const filePath = path.join(skillDir, 'SKILL.md')
        if (fs.existsSync(filePath)) {
          skillsData[entry.name] = fs.readFileSync(filePath, 'utf-8')
        }
      }
    }

    // 2. MCP 配置
    const mcpConfig = mcpConfigFile.readMcpConfig(store)
    const mcpDisabled = store.get('aiMcpDisabledServers', [])

    // 3. AI 配置（openultron.json 的 ai 字段）
    let aiConfig = null
    try {
      aiConfig = aiConfigFile.readAIConfig(app, store)
    } catch (e) { /* ignore */ }

    const backup = {
      version: 2,
      exportedAt: new Date().toISOString(),
      skills: skillsData,
      mcpConfig,
      mcpDisabledServers: mcpDisabled,
      aiConfig
    }

    return { success: true, data: JSON.stringify(backup, null, 2) }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ── AI ZIP 备份导出 ──────────────────────────────────────────
registerChannel('ai-backup-export', async (event, { options } = {}) => {
  try {
    const AdmZip = require('adm-zip')
    const { dialog } = require('electron')
    const os = require('os')
    const appRootDir = getAppRoot()

    const zip = new AdmZip()
    const stats = { fileCount: 0, dirCount: 0, totalBytes: 0, root: appRootDir }
    const zipRoot = 'app_root'

    const addDirToZip = (dirPath) => {
      if (!fs.existsSync(dirPath)) return
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name)
        const rel = path.relative(appRootDir, fullPath).split(path.sep).join('/')
        const zPath = rel ? `${zipRoot}/${rel}` : zipRoot
        if (entry.isDirectory()) {
          stats.dirCount += 1
          addDirToZip(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        const buf = fs.readFileSync(fullPath)
        zip.addFile(zPath, buf)
        stats.fileCount += 1
        stats.totalBytes += buf.length
      }
    }
    fs.mkdirSync(appRootDir, { recursive: true })
    addDirToZip(appRootDir)

    // meta.json
    zip.addFile('meta.json', Buffer.from(JSON.stringify({
      version: 2,
      mode: 'full_app_root',
      appRootDirname: path.basename(appRootDir),
      exportedAt: new Date().toISOString(),
      stats
    }, null, 2), 'utf-8'))

    // 弹出保存对话框
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const defaultPath = path.join(os.homedir(), 'Desktop', `ai-backup-${ts}.zip`)
    const { canceled, filePath: savePath } = await dialog.showSaveDialog({
      title: '保存 AI 备份',
      defaultPath,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
    })
    if (canceled || !savePath) return { success: false, message: 'canceled' }

    zip.writeZip(savePath)
    const fileSize = fs.statSync(savePath).size
    return { success: true, savePath, fileSize, stats }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ── AI ZIP 备份预览（选择文件后返回 meta 信息）──────────────
registerChannel('ai-backup-preview', async () => {
  try {
    const AdmZip = require('adm-zip')
    const { dialog } = require('electron')
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择 AI 备份文件',
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths.length) return { success: false, message: 'canceled' }
    const filePath = filePaths[0]
    const zip = new AdmZip(filePath)
    const metaEntry = zip.getEntry('meta.json')
    if (!metaEntry) return { success: false, message: '无效的备份文件（缺少 meta.json）' }
    const meta = JSON.parse(metaEntry.getData().toString('utf-8'))
    const hasFullRoot = zip.getEntries().some((e) => e.entryName.startsWith('app_root/'))
    meta.mode = meta.mode || (hasFullRoot ? 'full_app_root' : 'legacy_partial')
    if (!meta.stats) meta.stats = {}
    if (meta.mode === 'full_app_root') {
      if (typeof meta.stats.fileCount !== 'number' || typeof meta.stats.dirCount !== 'number') {
        let fileCount = 0
        let dirCount = 0
        let totalBytes = 0
        for (const entry of zip.getEntries()) {
          if (!entry.entryName.startsWith('app_root/')) continue
          if (entry.isDirectory) {
            dirCount += 1
          } else {
            fileCount += 1
            totalBytes += entry.header.size || 0
          }
        }
        meta.stats.fileCount = fileCount
        meta.stats.dirCount = dirCount
        meta.stats.totalBytes = totalBytes
      }
    }
    return { success: true, filePath, meta }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ── AI ZIP 备份恢复 ──────────────────────────────────────────
registerChannel('ai-backup-restore', async (event, { filePath, options = {} }) => {
  try {
    const AdmZip = require('adm-zip')
    const os = require('os')
    const appRootDir = getAppRoot()
    const tmpZipPath = path.join(os.tmpdir(), `openultron-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
    fs.copyFileSync(filePath, tmpZipPath)
    const zip = new AdmZip(tmpZipPath)
    const summary = { skillsRestored: 0, conversationsRestored: 0, memoriesRestored: false, mcpRestored: false, aiConfigRestored: false }

    const extractDir = (zipPrefix, targetDir) => {
      fs.mkdirSync(targetDir, { recursive: true })
      const base = path.resolve(targetDir)
      for (const entry of zip.getEntries()) {
        if (!entry.entryName.startsWith(zipPrefix + '/') || entry.isDirectory) continue
        const relPath = entry.entryName.slice(zipPrefix.length + 1)
        const destPath = path.join(targetDir, relPath)
        if (!path.resolve(destPath).startsWith(base + path.sep)) continue
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, entry.getData())
      }
    }

    const hasFullRoot = zip.getEntries().some((e) => e.entryName.startsWith('app_root/'))
    if (hasFullRoot) {
      const restoreBackupPath = `${appRootDir}.pre-restore-${Date.now()}`
      let movedOldRoot = false
      try {
        if (fs.existsSync(appRootDir)) {
          fs.renameSync(appRootDir, restoreBackupPath)
          movedOldRoot = true
        }
        fs.mkdirSync(appRootDir, { recursive: true })
        const base = path.resolve(appRootDir)
        let restoredFiles = 0
        for (const entry of zip.getEntries()) {
          if (!entry.entryName.startsWith('app_root/') || entry.isDirectory) continue
          const relPath = entry.entryName.slice('app_root/'.length)
          if (!relPath) continue
          const destPath = path.join(appRootDir, relPath)
          const resolved = path.resolve(destPath)
          if (!resolved.startsWith(base + path.sep) && resolved !== base) continue
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, entry.getData())
          restoredFiles += 1
        }

        // 恢复完成后刷新内存态
        try {
          ensureSkillsDir()
          _skillsCache = readAllSkills()
        } catch (e) { /* ignore */ }
        try {
          const mcpCfg = mcpConfigFile.readMcpConfig(store)
          aiMcpManager.stopAll()
          const disabledServers = store.get('aiMcpDisabledServers', [])
          const servers = parseMcpJsonConfig(mcpCfg, disabledServers)
          if (servers.length > 0) await aiMcpManager.startAll(servers)
        } catch (e) { /* ignore */ }
        try {
          BrowserWindow.getAllWindows().forEach((win) => {
            if (win && !win.isDestroyed()) win.webContents.send('ai-config-updated')
          })
        } catch (e) { /* ignore */ }

        summary.mode = 'full_app_root'
        summary.restoredFiles = restoredFiles
        summary.rollbackPath = movedOldRoot ? restoreBackupPath : null
        try { fs.unlinkSync(tmpZipPath) } catch (_) {}
        return { success: true, summary }
      } catch (error) {
        try { if (fs.existsSync(appRootDir)) fs.rmSync(appRootDir, { recursive: true, force: true }) } catch (_) {}
        if (movedOldRoot) {
          try { fs.renameSync(restoreBackupPath, appRootDir) } catch (_) {}
        }
        throw error
      }
    }

    // 1. 统一配置 openultron.json（含 AI + 飞书）
    if (options.aiConfig !== false) {
      const openultronConfig = require('./openultron-config')
      const entry = zip.getEntry('openultron.json')
      if (entry) {
        try {
          const full = JSON.parse(entry.getData().toString('utf-8'))
          if (full && (full.ai || full.feishu)) {
            const cur = openultronConfig.readAll()
            openultronConfig.writeAll({ ai: full.ai || cur.ai, feishu: full.feishu || cur.feishu })
            summary.aiConfigRestored = true
          }
        } catch (e) { /* ignore */ }
      } else {
        const legacyEntry = zip.getEntry('ai-config.json')
        if (legacyEntry) {
          try {
            const cfg = JSON.parse(legacyEntry.getData().toString('utf-8'))
            if (cfg && Array.isArray(cfg.providers)) {
              openultronConfig.writeAI(cfg)
              summary.aiConfigRestored = true
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    // 2. MCP 配置
    if (options.mcpConfig !== false) {
      const entry = zip.getEntry('mcp-config.json')
      if (entry) {
        try {
          const mcpStr = entry.getData().toString('utf-8')
          JSON.parse(mcpStr) // 验证合法性
          mcpConfigFile.writeMcpConfig(mcpStr)
          aiMcpManager.stopAll()
          const disabledServers = store.get('aiMcpDisabledServers', [])
          const servers = parseMcpJsonConfig(mcpStr, disabledServers)
          if (servers.length > 0) await aiMcpManager.startAll(servers)
          summary.mcpRestored = true
        } catch (e) { /* ignore, continue with other restore steps */ }
      }
    }

    // 3. Skills
    if (options.skills !== false) {
      ensureSkillsDir()
      const skillsBase = path.resolve(_skillsDir)
      for (const entry of zip.getEntries()) {
        if (!entry.entryName.startsWith('skills/') || entry.isDirectory) continue
        const relPath = entry.entryName.slice('skills/'.length)
        const destPath = path.join(_skillsDir, relPath)
        if (!path.resolve(destPath).startsWith(skillsBase + path.sep)) continue
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, entry.getData())
        if (entry.entryName.endsWith('/SKILL.md')) summary.skillsRestored++
      }
      _skillsCache = readAllSkills()
    }

    // 4. 对话历史
    if (options.conversations !== false) {
      const convsDir = path.join(appRootDir, 'conversations')
      extractDir('conversations', convsDir)
      for (const entry of zip.getEntries()) {
        if (entry.entryName.startsWith('conversations/') && entry.entryName.endsWith('.json') && !entry.entryName.endsWith('index.json')) {
          summary.conversationsRestored++
        }
      }
    }

    // 5. 记忆
    if (options.memory !== false) {
      const memDir = path.join(appRootDir, 'memory')
      extractDir('memory', memDir)
      const memMd = zip.getEntry('MEMORY.md')
      if (memMd) fs.writeFileSync(path.join(appRootDir, 'MEMORY.md'), memMd.getData())
      summary.memoriesRestored = true
    }

    try { fs.unlinkSync(tmpZipPath) } catch (_) {}
    return { success: true, summary }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 导入恢复备份：接收 JSON 字符串，写入技能、MCP
registerChannel('ai-import-backup', async (event, { data, options }) => {
  try {
    const backup = JSON.parse(data)
    const opts = options || { skills: true, mcp: true, aiConfig: true }
    const summary = { skillsImported: 0, mcpImported: false, aiConfigImported: false }

    // 恢复技能
    if (opts.skills && backup.skills) {
      ensureSkillsDir()
      for (const [dirName, content] of Object.entries(backup.skills)) {
        const skillDir = path.join(_skillsDir, dirName)
        fs.mkdirSync(skillDir, { recursive: true })
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
        summary.skillsImported++
      }
      _skillsCache = readAllSkills()
    }

    // 恢复 AI 配置（写入 openultron.json 的 ai 字段）
    if (opts.aiConfig && backup.aiConfig) {
      try {
        const raw = backup.aiConfig?.config !== undefined && backup.aiConfig?.providerKeys !== undefined
          ? aiConfigFile.fromLegacyBackup(backup.aiConfig)
          : backup.aiConfig
        if (raw && Array.isArray(raw.providers)) {
          aiConfigFile.writeAIConfig(app, raw)
          summary.aiConfigImported = true
        }
      } catch (e) { /* ignore */ }
    }

    // 恢复 MCP 配置（直接覆盖）
    if (opts.mcp && backup.mcpConfig) {
      JSON.parse(backup.mcpConfig)  // 验证 JSON 合法性
      mcpConfigFile.writeMcpConfig(backup.mcpConfig)
      if (backup.mcpDisabledServers) {
        store.set('aiMcpDisabledServers', backup.mcpDisabledServers)
      }
      // 重启 MCP servers
      aiMcpManager.stopAll()
      const disabledServers = store.get('aiMcpDisabledServers', [])
      const servers = parseMcpJsonConfig(backup.mcpConfig, disabledServers)
      if (servers.length > 0) {
        await aiMcpManager.startAll(servers)
      }
      summary.mcpImported = true
    }

    return { success: true, summary }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ── 仅技能包导出（ZIP，仅含 skills/ 或含 _sandbox）────────────────────
registerChannel('ai-export-skills-pack', async (event, { names, includeSandbox }) => {
  try {
    const AdmZip = require('adm-zip')
    const { dialog } = require('electron')
    const os = require('os')
    const zip = new AdmZip()
    let count = 0
    ensureSkillsDir()
    const wantNames = Array.isArray(names) && names.length > 0 ? new Set(names.map(String)) : null
    for (const entry of fs.readdirSync(_skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '_sandbox') continue
      if (wantNames && !wantNames.has(entry.name)) continue
      const filePath = path.join(_skillsDir, entry.name, 'SKILL.md')
      if (!fs.existsSync(filePath)) continue
      zip.addFile(`skills/${entry.name}/SKILL.md`, fs.readFileSync(filePath))
      count++
    }
    if (includeSandbox) {
      const sandboxDir = path.join(_skillsDir, '_sandbox')
      if (fs.existsSync(sandboxDir)) {
        for (const entry of fs.readdirSync(sandboxDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const filePath = path.join(sandboxDir, entry.name, 'SKILL.md')
          if (!fs.existsSync(filePath)) continue
          zip.addFile(`skills/_sandbox/${entry.name}/SKILL.md`, fs.readFileSync(filePath))
          count++
        }
      }
    }
    zip.addFile('meta.json', Buffer.from(JSON.stringify({
      type: 'skills-pack',
      exportedAt: new Date().toISOString(),
      skillsCount: count,
      includeSandbox: !!includeSandbox
    }, null, 2), 'utf-8'))
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const defaultPath = path.join(os.homedir(), 'Desktop', `skills-pack-${ts}.zip`)
    const { canceled, filePath: savePath } = await dialog.showSaveDialog({
      title: '导出技能包',
      defaultPath,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
    })
    if (canceled || !savePath) return { success: false, message: 'canceled' }
    zip.writeZip(savePath)
    return { success: true, savePath, skillsCount: count }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ── 仅技能包导入（从 ZIP 恢复技能到 skills/，可选到沙箱）──────────────
registerChannel('ai-import-skills-pack', async (event, { filePath, toSandbox }) => {
  try {
    const AdmZip = require('adm-zip')
    const { dialog } = require('electron')
    let zipPath = filePath
    if (!zipPath) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择技能包 ZIP',
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (canceled || !filePaths.length) return { success: false, message: 'canceled' }
      zipPath = filePaths[0]
    }
    const zip = new AdmZip(zipPath)
    ensureSkillsDir()
    let count = 0
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory()) continue
      const name = entry.entryName
      if (!name.startsWith('skills/') || !name.endsWith('/SKILL.md')) continue
      const inner = name.slice(7, name.length - 9).replace(/\/$/, '')
      const parts = inner.split('/').filter(Boolean)
      if (parts.length === 0) continue
      const skillName = parts[parts.length - 1]
      const destBase = toSandbox ? path.join(_skillsDir, '_sandbox') : _skillsDir
      const skillDir = path.join(destBase, skillName)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), entry.getData())
      count++
    }
    _skillsCache = readAllSkills()
    return { success: true, skillsImported: count }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ==================== 飞书通知 ====================
const feishuNotify = require('./ai/feishu-notify')
registerChannel('feishu-get-config', () => {
  try {
    const config = feishuNotify.getConfig()
    return { success: true, ...config }
  } catch (e) {
    return { success: false, app_id: '', app_secret: '', default_chat_id: '', message: e.message }
  }
})
registerChannel('feishu-set-config', (event, payload) => {
  try {
    feishuNotify.setConfig(payload)
    return { success: true }
  } catch (e) {
    return { success: false, message: e.message }
  }
})
registerChannel('feishu-send-message', async (event, options) => {
  try {
    return await feishuNotify.sendMessage(options || {})
  } catch (e) {
    return { success: false, message: e.message }
  }
})

// 身份与用户文件（<appRoot>/）：供 AI 注入，对标 OpenClaw
const SOUL_MD_PATH = getAppRootPath('SOUL.md')
const IDENTITY_MD_PATH = getAppRootPath('IDENTITY.md')
const USER_MD_PATH = getAppRootPath('USER.md')
const BOOT_MD_PATH = getAppRootPath('BOOT.md')

// 若不存在则创建 IDENTITY.md、SOUL.md 空文档（带默认模板），避免首次注入时无文件
function ensureIdentityAndSoulFiles() {
  try {
    const dir = path.dirname(IDENTITY_MD_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(IDENTITY_MD_PATH)) {
      fs.writeFileSync(IDENTITY_MD_PATH, '# IDENTITY.md\n\n# Agent 身份\n\n- 名字：\n- 形象/类型：\n- vibe/语气：\n- 代词：\n', 'utf-8')
    }
    if (!fs.existsSync(SOUL_MD_PATH)) {
      fs.writeFileSync(SOUL_MD_PATH, '# SOUL.md\n\n# 性格与原则\n\n在此定义你的默认行为、语气与优先级。\n', 'utf-8')
    }
  } catch (e) {
    console.warn('[main] ensureIdentityAndSoulFiles failed:', e.message)
  }
}
ensureIdentityAndSoulFiles()

function ensureAndOpenMd(name, filePath, defaultContent) {
  return async () => {
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent, 'utf-8')
      }
      const { shell } = require('electron')
      await shell.openPath(filePath)
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  }
}

registerChannel('ai-get-soul-md-path', () => ({ path: SOUL_MD_PATH }))
registerChannel('ai-open-soul-md', ensureAndOpenMd('SOUL', SOUL_MD_PATH,
  '# SOUL.md\n\n# 性格与原则\n\n在此定义你的默认行为、语气与优先级。\n'))

registerChannel('ai-get-identity-md-path', () => {
  const home = os_module.homedir()
  const short = home && IDENTITY_MD_PATH.startsWith(home) ? '~' + IDENTITY_MD_PATH.slice(home.length) : IDENTITY_MD_PATH
  return { path: IDENTITY_MD_PATH, shortPath: short }
})
registerChannel('ai-open-identity-md', ensureAndOpenMd('IDENTITY', IDENTITY_MD_PATH,
  '# IDENTITY.md\n\n# Agent 身份\n\n- 名字：\n- 形象/类型：\n- vibe/语气：\n- 代词：\n'))
registerChannel('ai-get-agent-display-name', () => ({ name: memoryStore.readAgentDisplayName() }))

registerChannel('ai-get-user-md-path', () => ({ path: USER_MD_PATH }))
registerChannel('ai-open-user-md', ensureAndOpenMd('USER', USER_MD_PATH,
  '# USER.md\n\n# 用户信息\n\n- 姓名/称呼：\n- 时区：\n- 工作/项目：\n- 偏好与习惯：\n- 关键人物：\n'))

registerChannel('ai-get-boot-md-path', () => ({ path: BOOT_MD_PATH }))
registerChannel('ai-open-boot-md', ensureAndOpenMd('BOOT', BOOT_MD_PATH,
  '# BOOT.md\n\n# 会话启动指令\n\n每次会话开始时加载的简短指令（如：发消息前先用消息工具再 NO_REPLY）。\n'))

// ==================== 定时任务 Cron ====================
const cronScheduler = require('./ai/cron-scheduler')
registerChannel('cron-list', () => ({ success: true, tasks: cronScheduler.listTasks() }))
registerChannel('cron-add', (event, task) => {
  try {
    const t = cronScheduler.addTask(task)
    return { success: true, task: t }
  } catch (e) {
    return { success: false, message: e.message }
  }
})
registerChannel('cron-update', (event, { taskId, updates }) => {
  try {
    const t = cronScheduler.updateTask(taskId, updates)
    return { success: true, task: t }
  } catch (e) {
    return { success: false, message: e.message }
  }
})
registerChannel('cron-remove', (event, taskId) => {
  try {
    const ok = cronScheduler.removeTask(taskId)
    return { success: ok }
  } catch (e) {
    return { success: false, message: e.message }
  }
})
registerChannel('cron-run-now', async (event, taskId) => {
  try {
    const tasks = cronScheduler.listTasks()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return { success: false, message: '任务不存在' }
    const result = await cronScheduler.runTask(task)
    return result
  } catch (e) {
    return { success: false, message: e.message }
  }
})

// 检查扣子配置状态
registerChannel('coze-check-auth', async () => {
  try {
    const config = store.get('cozeConfig', {})
    
    return { 
      success: true, 
      authorized: !!(config.apiToken && config.botId),
      botId: config.botId
    }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// 清除扣子配置
registerChannel('coze-logout', async () => {
  try {
    store.set('cozeConfig', {})
    console.log('✅ 已清除扣子配置')
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
})

// ==================== Workspace ====================
registerChannel('workspace-get-defaults', async () => {
  try {
    ensureWorkspaceDirs()
    return {
      success: true,
      root: getWorkspaceRoot(),
      scriptsPath: getWorkspacePath('scripts'),
      projectsPath: getWorkspacePath('projects')
    }
  } catch (e) {
    return { success: false, message: e.message }
  }
})

registerChannel('workspace-load', async (event, { primaryPath }) => {
  try {
    const key = `workspace_${primaryPath}`
    const data = store.get(key, { extraPaths: [] })
    return { success: true, extraPaths: data.extraPaths || [] }
  } catch (e) {
    return { success: false, extraPaths: [], message: e.message }
  }
})

registerChannel('workspace-save', async (event, { primaryPath, extraPaths }) => {
  try {
    const key = `workspace_${primaryPath}`
    store.set(key, { extraPaths: extraPaths || [] })
    return { success: true }
  } catch (e) {
    return { success: false, message: e.message }
  }
})

registerChannel('workspace-pick-folder', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '添加文件夹到工作区'
    })
    if (result.canceled || !result.filePaths.length) {
      return { success: false, path: null }
    }
    return { success: true, path: result.filePaths[0] }
  } catch (e) {
    return { success: false, path: null, message: e.message }
  }
})

// 通过路径字符串解析目录，不弹授权/选择框；主进程直接读盘（无 sandbox 时无弹窗）
registerChannel('workspace-resolve-path', async (event, { path: rawPath }) => {
  if (!rawPath || typeof rawPath !== 'string') {
    return { success: false, path: null, message: '路径为空' }
  }
  try {
    const path = require('path')
    const os = require('os')
    const expanded = rawPath.trim().replace(/^~/, os.homedir())
    const absolutePath = path.resolve(expanded)
    const stat = fs.statSync(absolutePath)
    if (!stat.isDirectory()) {
      return { success: false, path: null, message: '不是目录' }
    }
    // 轻量读一下以确认可读（避免仅存在但无权限）
    fs.readdirSync(absolutePath, { withFileTypes: true })
    return { success: true, path: absolutePath }
  } catch (e) {
    const msg = e.code === 'ENOENT' ? '路径不存在' : e.code === 'EACCES' ? '无读取权限' : e.message
    return { success: false, path: null, message: msg }
  }
})
