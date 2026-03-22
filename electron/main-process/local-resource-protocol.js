/**
 * 注册 local-resource://（defaultSession + Web 应用预览分区），并初始化 web-apps guest session
 */

/** 与 electron/web-apps/guest-session.js 中 WEB_APP_GUEST_PARTITION 一致 */
const WEB_APP_GUEST_PARTITION = 'persist:ou-webapps'

/** @param {object} deps — session, getAppRoot, path, fs, net, pathToFileURL, URL（url.URL 构造器） */
function registerLocalResourceProtocol(deps) {
  const { session, getAppRoot, path, fs, net, pathToFileURL, URL } = deps
  const appRootBase = getAppRoot()

  function parseWebAppLocFromAnyUrl(raw) {
    if (!raw || typeof raw !== 'string') return null
    try {
      const u = new URL(raw)
      const pathname = String(u.pathname || '').replace(/^\/+/, '')
      const parts = pathname.split('/').filter(Boolean)
      if (parts[0] !== 'web-apps' || parts.length < 3) return null
      return { appId: parts[1], version: parts[2] }
    } catch {
      return null
    }
  }

  async function localResourceProtocolHandler(request, options = {}) {
    const guestMode = options && options.guestMode === true
    try {
      const url = new URL(request.url)
      let relPath
      if (url.host) {
        relPath = decodeURIComponent((url.host || '') + url.pathname)
      } else {
        relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      }
      const segments = relPath.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..')
      const fullPath = path.join(appRootBase, ...segments)
      if (!fullPath.startsWith(appRootBase + path.sep) && fullPath !== appRootBase) {
        return new Response('Forbidden', { status: 403 })
      }
      const ext = path.extname(fullPath).toLowerCase()
      if (guestMode) {
        if (segments[0] !== 'web-apps' || segments.length < 3) {
          return new Response('Forbidden', { status: 403 })
        }
        const target = { appId: segments[1], version: segments[2] }
        const reqHeaders = request.headers || {}
        const referrer =
          request.referrer ||
          reqHeaders.Referer ||
          reqHeaders.referer ||
          reqHeaders.Origin ||
          reqHeaders.origin ||
          ''
        const ctx = parseWebAppLocFromAnyUrl(String(referrer || ''))
        if (ctx && (ctx.appId !== target.appId || ctx.version !== target.version)) {
          return new Response('Forbidden', { status: 403 })
        }
        if (!ctx && ext !== '.html') {
          return new Response('Forbidden', { status: 403 })
        }
      }
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return new Response('Not Found', { status: 404 })
      }
      if (segments[0] === 'web-apps' && ext === '.html') {
        const buf = fs.readFileSync(fullPath)
        const csp = [
          "default-src 'self' local-resource: data: blob:",
          "script-src 'self' local-resource: 'unsafe-inline'",
          "style-src 'self' local-resource: 'unsafe-inline'",
          "img-src 'self' local-resource: data: blob: https:",
          "font-src 'self' local-resource: data:",
          "connect-src 'self' local-resource:",
          "base-uri 'self' local-resource:",
          "frame-ancestors 'none'"
        ].join('; ')
        return new Response(buf, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': csp,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
          }
        })
      }
      const resp = await net.fetch(pathToFileURL(fullPath).toString())
      if (segments[0] === 'web-apps') {
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: {
            'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
          }
        })
      }
      return resp
    } catch (e) {
      return new Response('Internal Error', { status: 500 })
    }
  }

  session.defaultSession.protocol.handle('local-resource', (request) =>
    localResourceProtocolHandler(request, { guestMode: false })
  )
  session.fromPartition(WEB_APP_GUEST_PARTITION).protocol.handle('local-resource', (request) =>
    localResourceProtocolHandler(request, { guestMode: true })
  )

  try {
    require('../web-apps/guest-session').setupWebAppGuestSession()
  } catch (e) {
    console.warn('[web-apps] guest session setup failed:', e.message)
  }
}

module.exports = { registerLocalResourceProtocol, WEB_APP_GUEST_PARTITION }
