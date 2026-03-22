/**
 * 主窗口、应用内静态 UI 服务（生产 dist）、应用菜单
 */

/**
 * @param {{
 *   app: import('electron').App
 *   BrowserWindow: typeof import('electron').BrowserWindow
 *   Menu: typeof import('electron').Menu
 *   shell: import('electron').Shell
 *   path: import('path')
 *   fs: import('fs')
 *   isDev: boolean
 *   APP_UI_PORT: number
 *   DEV_UI_PORT: number
 *   safeLog: (...args: any[]) => void
 *   safeError: (...args: any[]) => void
 *   preloadPath: string
 *   distPath: string
 *   getMainWindow: () => import('electron').BrowserWindow | null | undefined
 *   assignMainWindow: (w: import('electron').BrowserWindow | null) => void
 *   onDidFinishLoad: () => void | Promise<void>
 * }} deps
 */
function createMainWindowController(deps) {
  const {
    app,
    BrowserWindow,
    Menu,
    shell,
    path,
    fs,
    isDev,
    APP_UI_PORT,
    DEV_UI_PORT,
    safeLog,
    safeError,
    preloadPath,
    distPath,
    getMainWindow,
    assignMainWindow,
    onDidFinishLoad
  } = deps

  let appUiServer = null

  function startAppUiServer() {
    return new Promise((resolve, reject) => {
      if (appUiServer) return resolve(`http://127.0.0.1:${APP_UI_PORT}`)
      if (!fs.existsSync(distPath)) return reject(new Error('dist 目录不存在'))
      const express = require('express')
      const expressApp = express()
      expressApp.use(express.static(distPath, { index: false }))
      expressApp.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')))
      appUiServer = expressApp.listen(APP_UI_PORT, '127.0.0.1', () => {
        safeLog('App UI server:', `http://127.0.0.1:${APP_UI_PORT}`)
        resolve(`http://127.0.0.1:${APP_UI_PORT}`)
      })
      appUiServer.on('error', reject)
    })
  }

  function createMenu() {
    const mainWindow = getMainWindow()
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
              const mw = getMainWindow()
              if (mw && mw.webContents) {
                console.log('📡 发送 refresh-current-tab 消息到渲染进程')
                mw.webContents.send('refresh-current-tab')
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
              const mw = getMainWindow()
              if (mw && mw.webContents) {
                mw.webContents.send('open-webview-devtools')
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
              const mw = getMainWindow()
              if (mw && mw.webContents) mw.webContents.send('export-favorites')
            }
          },
          {
            label: '导入收藏',
            click: () => {
              const mw = getMainWindow()
              if (mw && mw.webContents) mw.webContents.send('import-favorites')
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

  function createWindow(productionAppUrl) {
    let mainWindow = getMainWindow()
    if (mainWindow) {
      safeLog('窗口已存在，聚焦到现有窗口')
      mainWindow.focus()
      return
    }

    safeLog('Creating window...')
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1200,
      minHeight: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false,
        preload: preloadPath,
        webviewTag: true
      },
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 8, y: 8 },
      show: false
    })
    assignMainWindow(mainWindow)

    if (isDev) {
      safeLog('Loading development server...')
      mainWindow.loadURL('http://localhost:' + DEV_UI_PORT)
      mainWindow.webContents.openDevTools()
    } else {
      const url = productionAppUrl || `http://127.0.0.1:${APP_UI_PORT}`
      safeLog('Loading production build from', url)
      mainWindow.loadURL(url)
    }

    mainWindow.once('ready-to-show', () => {
      safeLog('Window ready to show, showing window...')
      mainWindow.show()
    })

    mainWindow.webContents.on('did-finish-load', () => {
      safeLog('Page finished loading')
      Promise.resolve(onDidFinishLoad()).catch(e => console.warn('[Feishu] 窗口加载后启动接收失败:', e.message))
    })

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      safeError('Page failed to load:', errorCode, errorDescription, validatedURL)
      if (isDev) {
        safeLog('Retrying to load...')
        setTimeout(() => {
          const mw = getMainWindow()
          if (mw) mw.loadURL('http://localhost:' + DEV_UI_PORT)
        }, 1000)
      }
    })

    if (isDev) {
      mainWindow.webContents.on('dom-ready', () => {
        safeLog('DOM ready in development mode')
      })
    }

    mainWindow.on('close', (event) => {
      if (!app.isQuiting) {
        event.preventDefault()
        mainWindow.hide()
        safeLog('📱 窗口已隐藏到应用图标')
      }
    })

    mainWindow.on('closed', () => {
      assignMainWindow(null)
    })

    mainWindow.on('focus', () => {
      const mw = getMainWindow()
      if (mw && mw.webContents) {
        mw.webContents.send('refresh-on-focus')
      }
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      const newWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: preloadPath
        },
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 8, y: 8 },
        show: false
      })

      newWindow.loadURL(url)
      newWindow.once('ready-to-show', () => {
        newWindow.show()
      })

      newWindow.on('close', (event) => {
        if (!app.isQuiting) {
          event.preventDefault()
          newWindow.hide()
          console.log('📱 新窗口已隐藏到应用图标')
        }
      })

      newWindow.on('closed', () => {})

      return { action: 'allow' }
    })

    createMenu()
  }

  function closeAppUiServer() {
    if (appUiServer) {
      appUiServer.close()
      appUiServer = null
    }
  }

  return {
    startAppUiServer,
    createWindow,
    closeAppUiServer
  }
}

module.exports = { createMainWindowController }
