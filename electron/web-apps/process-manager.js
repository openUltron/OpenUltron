'use strict'

const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')

const MAX_LOG_LEN = 200 * 1024
const DEFAULT_STARTUP_TIMEOUT_MS = 30000
const SERVICE_LOOPBACK_HOST = '127.0.0.1'
const WAIT_POLL_MS = 250

/** @type {Map<string, {
 *   key: string,
 *   appId: string,
 *   version: string,
 *   appDir: string,
 *   mode: 'managed'|'static',
 *   pid: number|null,
 *   port: number,
 *   url: string,
 *   status: 'starting'|'running'|'stopped'|'failed',
 *   startedAt: number,
 *   logs: string,
 *   child?: import('child_process').ChildProcess,
 *   server?: import('http').Server,
 *   error?: string,
 * }>} */
const appServices = new Map()

function serviceKey(appId, version) {
  return `${String(appId || '').trim()}@${String(version || '').trim()}`
}

function clipAppendLogs(oldLogs, addText) {
  const merged = `${oldLogs || ''}${addText || ''}`
  if (merged.length <= MAX_LOG_LEN) return merged
  return merged.slice(merged.length - MAX_LOG_LEN)
}

function parseServiceConfig(manifest) {
  const entry = manifest && typeof manifest === 'object' ? (manifest.entry || {}) : {}
  const svc = entry && typeof entry === 'object' ? entry.service : null
  if (!svc || typeof svc !== 'object') return null
  const command = String(svc.command || '').trim()
  if (!command) return null
  const cwd = String(svc.cwd || '.').trim() || '.'
  const healthPathRaw = String(svc.healthPath || '').trim()
  const portEnv = String(svc.portEnv || 'PORT').trim() || 'PORT'
  const rawEnv = svc.env && typeof svc.env === 'object' && !Array.isArray(svc.env) ? svc.env : null
  const env = {}
  if (rawEnv) {
    for (const [k, v] of Object.entries(rawEnv)) {
      const key = String(k || '').trim()
      if (!key) continue
      env[key] = String(v == null ? '' : v)
    }
  }
  const startupTimeoutMs = Number.isFinite(Number(svc.startupTimeoutMs))
    ? Math.max(3000, Math.min(120000, Number(svc.startupTimeoutMs)))
    : DEFAULT_STARTUP_TIMEOUT_MS
  return {
    command,
    cwd,
    portEnv,
    healthPath: healthPathRaw || '/',
    startupTimeoutMs,
    env
  }
}

async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer()
    server.on('error', reject)
    server.listen(0, SERVICE_LOOPBACK_HOST, () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      server.close((err) => {
        if (err) return reject(err)
        if (!port) return reject(new Error('无法分配端口'))
        resolve(port)
      })
    })
  })
}

function normalizeUnderApp(appDir, maybeRelative) {
  const raw = String(maybeRelative || '.').trim() || '.'
  const abs = path.resolve(appDir, raw)
  const root = path.resolve(appDir)
  if (abs === root || abs.startsWith(root + path.sep)) return abs
  return root
}

function renderCommand(command, port) {
  return String(command || '').replace(/\$\{PORT\}/g, String(port)).trim()
}

function waitForHealth(url, timeoutMs) {
  const endAt = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > endAt) return resolve(false)
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) return resolve(true)
        setTimeout(tick, WAIT_POLL_MS)
      })
      req.on('error', () => setTimeout(tick, WAIT_POLL_MS))
      req.setTimeout(1200, () => {
        try { req.destroy() } catch (_) {}
        setTimeout(tick, WAIT_POLL_MS)
      })
    }
    tick()
  })
}

function createStaticServer(appDir, port) {
  const root = path.resolve(appDir)
  const server = http.createServer((req, res) => {
    try {
      const reqPath = String((req.url || '/').split('?')[0] || '/')
      const decoded = decodeURIComponent(reqPath)
      let rel = decoded.replace(/^\/+/, '')
      if (!rel) rel = 'index.html'
      const abs = path.resolve(root, rel)
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      let target = abs
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        target = path.join(root, 'index.html')
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      const ext = path.extname(target).toLowerCase()
      const mime = (
        ext === '.html' ? 'text/html; charset=utf-8'
          : ext === '.js' ? 'application/javascript; charset=utf-8'
            : ext === '.css' ? 'text/css; charset=utf-8'
              : ext === '.json' ? 'application/json; charset=utf-8'
                : ext === '.svg' ? 'image/svg+xml'
                  : ext === '.png' ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                      : ext === '.gif' ? 'image/gif'
                        : ext === '.ico' ? 'image/x-icon'
                          : ext === '.txt' ? 'text/plain; charset=utf-8'
                            : 'application/octet-stream'
      )
      res.setHeader('Content-Type', mime)
      fs.createReadStream(target).pipe(res)
    } catch (e) {
      res.writeHead(500)
      res.end(e.message || 'Internal Error')
    }
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, SERVICE_LOOPBACK_HOST, () => resolve(server))
  })
}

function normalizeStatus(item) {
  if (!item) return null
  return {
    key: item.key,
    appId: item.appId,
    version: item.version,
    appDir: item.appDir,
    mode: item.mode,
    pid: item.pid,
    port: item.port,
    url: item.url,
    status: item.status,
    startedAt: item.startedAt,
    error: item.error || ''
  }
}

async function ensureWebAppService(manifest, appDir, opts = {}) {
  const id = String(manifest?.id || '').trim()
  const version = String(manifest?.version || '').trim()
  if (!id || !version) return { success: false, error: '无效 manifest：缺少 id/version' }
  const key = serviceKey(id, version)
  const running = appServices.get(key)
  if (running && (running.status === 'starting' || running.status === 'running')) {
    return { success: true, reused: true, ...normalizeStatus(running) }
  }

  const appRoot = path.resolve(appDir)
  const port = Number.isFinite(Number(opts.port)) && Number(opts.port) > 0
    ? Number(opts.port)
    : await allocateLoopbackPort()
  const url = `http://${SERVICE_LOOPBACK_HOST}:${port}`
  const svcCfg = parseServiceConfig(manifest)
  const mode = svcCfg ? 'managed' : 'static'
  const next = {
    key,
    appId: id,
    version,
    appDir: appRoot,
    mode,
    pid: null,
    port,
    url,
    status: 'starting',
    startedAt: Date.now(),
    logs: mode === 'static'
      ? `[service] static server starting at ${url}\n`
      : `[service] spawn command in ${appRoot}\n`,
    error: ''
  }
  appServices.set(key, next)

  if (mode === 'static') {
    try {
      next.server = await createStaticServer(appRoot, port)
      next.status = 'running'
      next.logs = clipAppendLogs(next.logs, '[service] static server ready\n')
      return { success: true, ...normalizeStatus(next) }
    } catch (e) {
      next.status = 'failed'
      next.error = e.message || String(e)
      next.logs = clipAppendLogs(next.logs, `[service][error] ${next.error}\n`)
      return { success: false, error: next.error, ...normalizeStatus(next) }
    }
  }

  const cwd = normalizeUnderApp(appRoot, svcCfg.cwd)
  const fullCommand = renderCommand(svcCfg.command, port)
  const child = spawn(fullCommand, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      ...svcCfg.env,
      [svcCfg.portEnv]: String(port),
      PORT: String(port)
    }
  })
  next.child = child
  next.pid = child.pid || null
  next.logs = clipAppendLogs(next.logs, `[service][cmd] ${fullCommand}\n`)
  child.stdout?.on('data', (chunk) => {
    next.logs = clipAppendLogs(next.logs, String(chunk || ''))
  })
  child.stderr?.on('data', (chunk) => {
    next.logs = clipAppendLogs(next.logs, String(chunk || ''))
  })
  child.on('error', (err) => {
    next.status = 'failed'
    next.error = err.message || String(err)
    next.logs = clipAppendLogs(next.logs, `[service][error] ${next.error}\n`)
  })
  child.on('exit', (code, signal) => {
    if (next.status === 'stopped') return
    next.status = code === 0 ? 'stopped' : 'failed'
    next.error = code === 0 ? '' : `进程退出：code=${code ?? 'null'} signal=${signal || ''}`.trim()
    next.logs = clipAppendLogs(next.logs, `[service] exit code=${code ?? 'null'} signal=${signal || 'null'}\n`)
  })

  const healthPath = String(svcCfg.healthPath || '/').startsWith('/')
    ? String(svcCfg.healthPath || '/')
    : `/${String(svcCfg.healthPath || '')}`
  const healthUrl = `${url}${healthPath}`
  const ready = await waitForHealth(healthUrl, svcCfg.startupTimeoutMs)
  if (!ready) {
    next.status = 'failed'
    next.error = `服务启动超时（>${svcCfg.startupTimeoutMs}ms）：${healthUrl}`
    next.logs = clipAppendLogs(next.logs, `[service][error] ${next.error}\n`)
    try { child.kill('SIGTERM') } catch (_) {}
    return { success: false, error: next.error, ...normalizeStatus(next) }
  }
  next.status = 'running'
  next.logs = clipAppendLogs(next.logs, `[service] ready ${healthUrl}\n`)
  return { success: true, ...normalizeStatus(next) }
}

function getWebAppServiceStatus(appId, version) {
  const item = appServices.get(serviceKey(appId, version))
  if (!item) return { success: true, status: 'stopped', running: false }
  const base = normalizeStatus(item)
  return { success: true, running: item.status === 'running' || item.status === 'starting', ...base }
}

function stopWebAppService(appId, version) {
  const key = serviceKey(appId, version)
  const item = appServices.get(key)
  if (!item) return { success: true, stopped: true, message: '服务未运行' }
  item.status = 'stopped'
  if (item.child) {
    try { item.child.kill('SIGTERM') } catch (_) {}
  }
  if (item.server) {
    try { item.server.close() } catch (_) {}
  }
  appServices.delete(key)
  return { success: true, stopped: true }
}

function getWebAppServiceLogs(appId, version) {
  const item = appServices.get(serviceKey(appId, version))
  if (!item) return { success: true, logs: '', status: 'stopped' }
  return { success: true, logs: item.logs || '', status: item.status }
}

function stopAllWebAppServices() {
  for (const item of appServices.values()) {
    try {
      if (item.child) item.child.kill('SIGTERM')
      if (item.server) item.server.close()
    } catch (_) {}
  }
  appServices.clear()
}

module.exports = {
  ensureWebAppService,
  getWebAppServiceStatus,
  stopWebAppService,
  getWebAppServiceLogs,
  stopAllWebAppServices
}
