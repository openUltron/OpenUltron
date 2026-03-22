/**
 * app.whenReady：协议、webview session、窗口、MCP bridge、API、Gateway、MCP 子进程、Heartbeat、飞书、skills 监听
 *
 * 须在 main 中 aiGateway / startFeishuReceive 等依赖就绪后再调用本函数注册（避免闭包捕获未初始化 const）。
 */
function registerAppWhenReady(deps) {
  const {
    app,
    session,
    registerLocalResourceProtocol,
    getAppRoot,
    path,
    fs,
    net,
    pathToFileURL,
    URL,
    createWindow,
    startAppUiServer,
    mcpHttpBridge,
    createApiServer,
    API_DEFAULT_PORT,
    aiGateway,
    startSavedMcpServers,
    appLogger,
    startHeartbeat,
    runHeartbeat,
    cronScheduler,
    startFeishuReceive,
    skillsRt,
    apiServerHolder
  } = deps

  app.whenReady().then(async () => {
    console.log('Electron app ready, creating window...')

    registerLocalResourceProtocol({
      session,
      getAppRoot,
      path,
      fs,
      net,
      pathToFileURL,
      URL
    })

    const webviewSession = session.fromPartition('persist:main')

    webviewSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(true)
    })

    webviewSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      return true
    })

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
          createWindow()
        })
    }

    mcpHttpBridge.start()

    try {
      const { app: apiApp, port: apiPort } = createApiServer({
        port: API_DEFAULT_PORT,
        getGatewayStatus: () => aiGateway.isRunning?.() ?? false
      })
      apiServerHolder.server = apiApp.listen(apiPort, '127.0.0.1', () => {
        apiServerHolder.port = apiPort
        console.log(`OpenUltron API server: http://127.0.0.1:${apiPort}/api (invokeRegistry)`)
      })
    } catch (e) {
      console.warn('OpenUltron API server failed to start:', e.message)
    }

    aiGateway.start().catch((e) => console.warn('[Gateway] start failed:', e.message))

    startSavedMcpServers().catch((err) => appLogger?.error?.('[MCP] 启动失败:', err.message))

    startHeartbeat()
    cronScheduler.start(runHeartbeat)
    setImmediate(() => {
      startFeishuReceive().catch((e) => console.warn('[Feishu] 启动接收失败:', e.message))
    })
    setImmediate(() => skillsRt.rebindSkillsWatchPaths())
  }).catch((error) => {
    console.error('Error in app.whenReady():', error)
  })
}

module.exports = { registerAppWhenReady }
