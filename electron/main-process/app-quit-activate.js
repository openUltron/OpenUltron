/**
 * app.isQuiting、before-quit 清理、window-all-closed、activate（与 Dock 恢复窗口）
 */
function registerAppQuitActivate(deps) {
  const {
    app,
    session,
    BrowserWindow,
    getMainWindow,
    stopAllWebAppServices,
    mcpHttpBridge,
    apiServerHolder,
    aiGateway,
    closeAppUiServer,
    createWindow,
    skillsRt
  } = deps

  app.isQuiting = false

  app.on('before-quit', async () => {
    app.isQuiting = true
    try {
      skillsRt.closeSkillsWatcher()
    } catch (_) {}
    try {
      stopAllWebAppServices()
    } catch (_) {}

    try {
      mcpHttpBridge.stop()
    } catch (_) {}
    if (apiServerHolder.server) {
      apiServerHolder.server.close()
      apiServerHolder.server = null
      apiServerHolder.port = null
    }
    if (aiGateway && typeof aiGateway.stop === 'function') {
      aiGateway.stop()
    }
    closeAppUiServer()

    try {
      const webviewSession = session.fromPartition('persist:main')

      await webviewSession.cookies.flushStore()
      console.log('✅ Session cookies flushed to disk')

      if (webviewSession.flushStorageData) {
        webviewSession.flushStorageData()
        console.log('✅ Storage data flushed to disk')
      }

      console.log('✅ All session data saved')
    } catch (error) {
      console.error('❌ Failed to flush session data:', error)
    }
  })

  app.on('window-all-closed', () => {
    // 在 macOS 上，应用会继续运行，即使所有窗口都关闭了
    // 只有当用户明确退出应用时才真正退出
  })

  app.on('activate', () => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show()
      console.log('📱 恢复隐藏的主窗口')
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

module.exports = { registerAppQuitActivate }
