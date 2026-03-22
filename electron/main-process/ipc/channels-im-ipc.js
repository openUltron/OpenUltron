/**
 * 飞书 / Telegram / 钉钉 状态与配置、Doctor、Webhook、飞书通知与发消息 IPC
 */

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.chatChannelRegistry
 * @param {object} deps.feishuWsReceive
 * @param {() => Promise<void>} deps.startFeishuReceive
 * @param {object} deps.aiGateway
 * @param {() => string} deps.getAppRoot
 * @param {typeof import('fs')} deps.fs
 * @param {object} deps.hardwareRegistry
 * @param {() => any[]} deps.getToolsForChat
 * @param {object} deps.appLogger
 * @param {import('electron').Shell} deps.shell
 * @param {object} deps.cronScheduler
 * @param {object} deps.feishuNotify
 */
function registerChannelsImIpc (deps) {
  const {
    registerChannel,
    chatChannelRegistry,
    feishuWsReceive,
    startFeishuReceive,
    aiGateway,
    getAppRoot,
    fs,
    hardwareRegistry,
    getToolsForChat,
    appLogger,
    shell,
    cronScheduler,
    feishuNotify
  } = deps

  registerChannel('feishu-receive-status', () => {
    const feishuAdapter = chatChannelRegistry.get('feishu')
    return {
      running: feishuAdapter ? feishuAdapter.isRunning() : false,
      error: feishuWsReceive.getLastError ? feishuWsReceive.getLastError() : null
    }
  })

  registerChannel('get-telegram-config', () => require('../../openultron-config').getTelegram())
  registerChannel('set-telegram-config', (event, payload) => {
    require('../../openultron-config').setTelegram(payload || {})
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

  registerChannel('get-dingtalk-config', () => require('../../openultron-config').getDingtalk())
  registerChannel('set-dingtalk-config', (event, payload) => {
    require('../../openultron-config').setDingtalk(payload || {})
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

  registerChannel('doctor-run', async () => {
    const openultronConfig = require('../../openultron-config')
    const checks = []
    const gatewayOk = aiGateway && typeof aiGateway.isRunning === 'function' && aiGateway.isRunning()
    checks.push({
      id: 'gateway',
      name: 'Gateway WebSocket',
      status: gatewayOk ? 'pass' : 'fail',
      message: gatewayOk ? 'Gateway 正在监听' : 'Gateway 未在监听',
      fixHint: gatewayOk ? null : '请确认应用已正常启动，或查看日志排查 Gateway 启动失败原因。'
    })
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
    const appRoot = getAppRoot()
    const appRootExists = fs.existsSync(appRoot)
    checks.push({
      id: 'app_root',
      name: '应用数据目录',
      status: appRootExists ? 'pass' : 'warn',
      message: appRootExists ? `目录存在: ${appRoot}` : `目录不存在: ${appRoot}`,
      fixHint: appRootExists ? null : '应用会在首次写入配置时自动创建，若持续报错请检查磁盘权限。'
    })
    const configPath = openultronConfig.getPath()
    const configExists = fs.existsSync(configPath)
    checks.push({
      id: 'config',
      name: '配置文件',
      status: configExists ? 'pass' : 'warn',
      message: configExists ? `已找到: ${configPath}` : `未找到: ${configPath}`,
      fixHint: configExists ? null : '首次打开设置并保存后会创建，或从备份恢复。'
    })
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

  registerChannel('webhook-trigger', async (event, payload) => {
    const { path: webhookPath, secret, body, userMessage } = payload || {}
    const openultronConfigWebhooks = require('../../openultron-config').getWebhooks()
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

  registerChannel('im-coordinator-get-config', () => {
    try {
      const oc = require('../../openultron-config')
      return { success: true, ...oc.getImCoordinator() }
    } catch (e) {
      return { success: false, include_sessions_spawn: false, message: e.message }
    }
  })
  registerChannel('im-coordinator-set-config', (event, payload) => {
    try {
      const oc = require('../../openultron-config')
      oc.setImCoordinator(payload && typeof payload === 'object' ? payload : {})
      return { success: true, ...oc.getImCoordinator() }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

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
      const cfg = feishuNotify.getConfig()
      const hasUserToken = String(cfg?.user_access_token || '').trim() || String(cfg?.user_refresh_token || '').trim()
      if (!hasUserToken) {
        try {
          cronScheduler.listTasks().forEach((t) => {
            if (t.type === 'feishu_refresh_token') cronScheduler.removeTask(t.id)
          })
        } catch (_) {}
      }
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })
  registerChannel('feishu-authorize-user-token', async () => {
    const http = require('http')
    const crypto = require('crypto')
    const cfg = feishuNotify.getConfig ? feishuNotify.getConfig() : {}
    if (!String(cfg?.app_id || '').trim() || !String(cfg?.app_secret || '').trim()) {
      return { success: false, message: '请先在飞书配置中填写 App ID 与 App Secret' }
    }
    const redirectUri = String(cfg?.oauth_redirect_uri || 'http://127.0.0.1:14579/feishu/oauth/callback').trim()
    let redirect = null
    try {
      redirect = new URL(redirectUri)
    } catch (_) {
      return { success: false, message: `oauth_redirect_uri 配置非法：${redirectUri}` }
    }
    if (!/^https?:$/.test(String(redirect.protocol || ''))) {
      return { success: false, message: `oauth_redirect_uri 协议非法，仅支持 http/https：${redirectUri}` }
    }
    const host = String(redirect.hostname || '').trim() || '127.0.0.1'
    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
    const callbackPath = String(redirect.pathname || '/').trim() || '/'
    if (!port || Number.isNaN(port)) {
      return { success: false, message: `oauth_redirect_uri 缺少端口：${redirectUri}` }
    }
    const state = crypto.randomBytes(16).toString('hex')
    const result = await new Promise(async (resolve) => {
      let done = false
      let timeoutId = null
      const finish = (payload) => {
        if (done) return
        done = true
        if (timeoutId) clearTimeout(timeoutId)
        try { server.close() } catch (_) {}
        resolve(payload)
      }
      const server = http.createServer(async (req, res) => {
        try {
          const base = `http://${req.headers.host || '127.0.0.1'}`
          const parsed = new URL(req.url || '/', base)
          if (parsed.pathname !== callbackPath) {
            res.statusCode = 404
            res.end('Not Found')
            return
          }
          const qState = String(parsed.searchParams.get('state') || '').trim()
          const code = String(parsed.searchParams.get('code') || '').trim()
          const err = String(parsed.searchParams.get('error') || '').trim()
          const errDesc = String(parsed.searchParams.get('error_description') || '').trim()
          if (!code || err || qState !== state) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end('<html><body><h3>飞书授权失败，请返回应用重试</h3></body></html>')
            finish({ success: false, message: errDesc || err || '授权失败或 state 校验失败' })
            return
          }
          const tokenRes = await feishuNotify.exchangeUserAccessTokenByCode({ code, redirectUri })
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end('<html><body><h3>飞书授权成功，可返回应用继续操作。</h3></body></html>')
          try {
            const tasks = cronScheduler.listTasks()
            appLogger.info('[Feishu OAuth] 授权成功，检查定时任务', { taskCount: tasks.length, hasFeishuTask: tasks.some((t) => t.type === 'feishu_refresh_token') })
            if (!tasks.some((t) => t.type === 'feishu_refresh_token')) {
              cronScheduler.addTask({
                name: '飞书 User Token 刷新',
                schedule: '0 */1 * * *',
                type: 'feishu_refresh_token',
                enabled: true
              })
              appLogger.info('[Feishu OAuth] 已添加飞书 Token 刷新定时任务', { cronPath: cronScheduler.CRON_JSON_PATH })
            }
          } catch (e) {
            appLogger.warn('[Feishu OAuth] 添加定时任务失败，授权成功后前端会再次尝试', { error: e?.message, stack: e?.stack })
          }
          finish({
            success: true,
            message: '飞书用户授权成功',
            expires_in: tokenRes?.expires_in || 0,
            expire_at: tokenRes?.expire_at || 0
          })
        } catch (e) {
          const errMsg = String(e?.message || '授权处理失败')
          try {
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(`<html><body><h3>处理授权回调失败，请返回应用重试</h3><pre style="white-space:pre-wrap;">${errMsg}</pre></body></html>`)
          } catch (_) {}
          finish({ success: false, message: errMsg || '授权处理失败' })
        }
      })
      server.listen(port, host, async () => {
        try {
          const authUrl = feishuNotify.buildUserAuthorizeUrl({ redirectUri, state })
          await shell.openExternal(authUrl)
          timeoutId = setTimeout(() => {
            finish({ success: false, message: '授权超时，请重试' })
          }, 180000)
        } catch (e) {
          finish({ success: false, message: e?.message || '拉起授权失败' })
        }
      })
      server.on('error', (e) => finish({
        success: false,
        message: `${e?.message || '本地回调服务启动失败'}；请确认回调地址已在飞书后台配置：${redirectUri}`
      }))
    })
    return result
  })
  registerChannel('feishu-send-message', async (event, options) => {
    try {
      return await feishuNotify.sendMessage(options || {})
    } catch (e) {
      return { success: false, message: e.message }
    }
  })
}

module.exports = { registerChannelsImIpc }
