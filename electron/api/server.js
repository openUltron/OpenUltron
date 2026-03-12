/**
 * HTTP API 服务：与 IPC 共用同一数据源（invokeRegistry），浏览器或 Node 可通过 HTTP 调用相同能力。
 * 监听本地端口，支持 CORS，便于浏览器或本地脚本访问。
 */

const express = require('express')
const invokeRegistry = require('./invokeRegistry')

const DEFAULT_PORT = 38472

/**
 * 创建并返回 Express 应用（不 listen，由调用方在 app.whenReady 后 listen）。
 * @param {object} opts - { port?: number, getGatewayStatus?: () => boolean }
 * @returns {{ app: import('express').Express, port: number }}
 */
function createApiServer(opts = {}) {
  const app = express()
  const port = opts.port || DEFAULT_PORT
  const getGatewayStatus = opts.getGatewayStatus
  const invokeToken = (process.env.OPENULTRON_INVOKE_TOKEN || process.env.OPENULTRON_API_TOKEN || '').trim()

  app.use(express.json({ limit: '10mb' }))

  // CORS：仅允许本地源（localhost / 127.0.0.1）
  app.use((req, res, next) => {
    const origin = req.headers.origin
    const localOrigin = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)
    if (!localOrigin) {
      return res.status(403).json({ success: false, error: 'Forbidden origin' })
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OpenUltron-Token')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // 健康检查：本 API 进程 + Gateway 是否在监听
  app.get('/api/health', (req, res) => {
    const gateway = typeof getGatewayStatus === 'function' ? getGatewayStatus() : false
    const ok = gateway
    res.status(ok ? 200 : 503).json({
      ok,
      service: 'openultron-api',
      gateway,
      timestamp: new Date().toISOString()
    })
  })

  // 诊断：与 invoke('doctor-run', []) 一致，供脚本或设置页调用
  app.get('/api/doctor', async (req, res) => {
    try {
      if (!invokeRegistry.has('doctor-run')) {
        return res.status(501).json({ success: false, error: 'doctor-run not registered' })
      }
      const result = await invokeRegistry.invoke('doctor-run', [])
      res.json({ success: true, ...result })
    } catch (err) {
      console.error('[API] doctor error:', err.message)
      res.status(500).json({ success: false, error: err.message })
    }
  })

  // 列出已注册的 channel（便于文档与调试）
  app.get('/api/channels', (req, res) => {
    res.json({ channels: invokeRegistry.listChannels() })
  })

  /**
   * Webhook 触发：POST /api/webhook
   * Body: { "path": "my-webhook", "secret": "可选，与配置一致", "message": "可选，作为用户消息正文" }
   * 校验配置中 webhooks[].path 与 secret 后触发一次 Agent 执行，返回 202 Accepted。
   */
  app.post('/api/webhook', async (req, res) => {
    try {
      const body = req.body || {}
      const path = body.path || body.webhook_path
      const secret = body.secret || req.headers['x-webhook-secret']
      const userMessage = body.message ?? body.userMessage ?? body.body
      if (!path || String(path).trim() === '') {
        return res.status(400).json({ success: false, error: 'missing path' })
      }
      if (!invokeRegistry.has('webhook-trigger')) {
        return res.status(501).json({ success: false, error: 'webhook-trigger not registered' })
      }
      const result = await invokeRegistry.invoke('webhook-trigger', [{ path: String(path).trim(), secret, body, userMessage }])
      if (!result.accepted) {
        return res.status(result.error === 'invalid secret' ? 403 : 400).json({ success: false, error: result.error || 'rejected' })
      }
      res.status(202).json({ success: true, accepted: true, sessionId: result.sessionId })
    } catch (err) {
      console.error('[API] webhook error:', err.message)
      res.status(500).json({ success: false, error: err.message })
    }
  })

  /**
   * DingTalk 回调入口：POST /api/dingtalk/inbound
   * - 若携带 challenge，按钉钉握手要求原样返回
   * - 其余事件透传到 dingtalk-inbound channel 处理
   */
  app.post('/api/dingtalk/inbound', async (req, res) => {
    try {
      const body = req.body || {}
      if (body.challenge) {
        return res.json({ challenge: body.challenge })
      }
      if (!invokeRegistry.has('dingtalk-inbound')) {
        return res.status(501).json({ success: false, error: 'dingtalk-inbound not registered' })
      }
      const result = await invokeRegistry.invoke('dingtalk-inbound', [body])
      res.json({ success: true, data: result })
    } catch (err) {
      console.error('[API] dingtalk inbound error:', err.message)
      res.status(500).json({ success: false, error: err.message })
    }
  })

  /**
   * 统一调用入口：POST /api/invoke
   * Body: { "channel": "get-config", "args": ["myKey"] }
   * 与 IPC 使用同一套 channel 与 args，数据源一致。
   */
  app.post('/api/invoke', async (req, res) => {
    try {
      if (invokeToken) {
        const auth = String(req.headers.authorization || '')
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
        const byHeader = String(req.headers['x-openultron-token'] || '').trim()
        const given = bearer || byHeader
        if (!given || given !== invokeToken) {
          return res.status(401).json({ success: false, error: 'Unauthorized' })
        }
      }
      const { channel, args = [] } = req.body || {}
      if (!channel || !invokeRegistry.has(channel)) {
        return res.status(400).json({
          success: false,
          error: 'Missing or unknown channel',
          available: invokeRegistry.listChannels()
        })
      }
      const result = await invokeRegistry.invoke(channel, Array.isArray(args) ? args : [args])
      res.json({ success: true, data: result })
    } catch (err) {
      console.error('[API] invoke error:', err.message)
      res.status(500).json({ success: false, error: err.message })
    }
  })

  return { app, port }
}

module.exports = { createApiServer, DEFAULT_PORT }
