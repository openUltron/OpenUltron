// electron/ai/browser-window-manager.js
const { BrowserWindow } = require('electron')

class BrowserWindowManager {
  constructor() {
    this._win = null
    this._consoleMessages = []   // 收集 console 日志
    this._downloadGuardInstalled = false
  }

  // 获取或创建隐藏窗口
  async getWindow() {
    if (this._win && !this._win.isDestroyed()) return this._win

    this._win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,          // sandbox=false 才能执行 executeJavaScript
        partition: 'persist:ai-browser'  // 独立 session，不影响主窗口
      }
    })

    // 收集 console 日志（最近 200 条）
    this._win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      this._consoleMessages.push({ level, message, line, sourceId, time: Date.now() })
      if (this._consoleMessages.length > 200) this._consoleMessages.shift()
    })

    // AI 自动化窗口禁止触发系统下载弹窗（如直接打开 .pptx/.zip 链接）
    if (!this._downloadGuardInstalled) {
      const ses = this._win.webContents.session
      ses.on('will-download', (event, item) => {
        try {
          const url = item && item.getURL ? item.getURL() : ''
          console.log('[AI Browser] blocked download:', url)
        } catch (_) { /* ignore */ }
        event.preventDefault()
        try { item.cancel() } catch (_) { /* ignore */ }
      })
      this._downloadGuardInstalled = true
    }

    return this._win
  }

  destroy() {
    if (this._win && !this._win.isDestroyed()) {
      this._win.destroy()
      this._win = null
    }
  }

  getConsoleMessages() {
    return [...this._consoleMessages]
  }

  clearConsoleMessages() {
    this._consoleMessages = []
  }
}

module.exports = new BrowserWindowManager()
