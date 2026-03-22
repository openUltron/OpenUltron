/**
 * 主窗口新标签：webview 弹窗拦截 + 渲染进程 request-open-url-in-new-tab
 */
function registerMainWindowTabForwarding(deps) {
  const { app, ipcMain, getMainWindow } = deps

  ipcMain.on('request-open-url-in-new-tab', (event, url) => {
    console.log(`🔗 收到新标签页打开请求: ${url}`)
    const mainWindow = getMainWindow()
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('open-url-in-new-tab', url)
    }
  })

  app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      console.log('🔗 [主进程] 拦截新窗口请求:', url)
      const mainWindow = getMainWindow()
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('open-url-in-new-tab', url)
      }
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      console.log('🔗 [主进程] webContents will-navigate:', url)
    })
  })
}

module.exports = { registerMainWindowTabForwarding }
