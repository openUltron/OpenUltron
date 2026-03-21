/**
 * Web 应用预览专用 Session：与主窗口 persist:main 隔离，并做出站网络默认拒绝（§2.1、§5）
 */
'use strict'

const { session, webContents: webContentsModule } = require('electron')
const path = require('path')
const fs = require('fs')
const { getWebAppsRoot } = require('./registry')

const WEB_APP_GUEST_PARTITION = 'persist:ou-webapps'

/** @type {Map<string, { hosts: Set<string>, patterns: string[], at: number }>} */
const manifestNetCache = new Map()
const CACHE_TTL_MS = 60 * 1000

function cacheKey(appId, version) {
  return `${appId}@${version}`
}

function readManifestNetAllowlist(appId, version) {
  const key = cacheKey(appId, version)
  const hit = manifestNetCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit
  }
  const manifestPath = path.join(getWebAppsRoot(), appId, version, 'manifest.json')
  let hosts = new Set()
  let patterns = []
  try {
    if (!fs.existsSync(manifestPath)) {
      manifestNetCache.set(key, { hosts, patterns, at: Date.now() })
      return { hosts, patterns }
    }
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    const perms = Array.isArray(m.permissions) ? m.permissions : []
    const allowNet =
      perms.includes('net:allowlist') ||
      (m.network && typeof m.network === 'object' && m.network.mode === 'allowlist')
    if (!allowNet) {
      manifestNetCache.set(key, { hosts, patterns, at: Date.now() })
      return { hosts, patterns }
    }
    const list = Array.isArray(m.netAllowlist) ? m.netAllowlist : Array.isArray(m.network?.allowlist) ? m.network.allowlist : []
    for (const entry of list) {
      const s = String(entry || '').trim()
      if (!s) continue
      try {
        const u = new URL(s.includes('://') ? s : `https://${s}`)
        if (u.hostname) hosts.add(u.hostname.toLowerCase())
      } catch {
        if (/^[a-z0-9.-]+$/i.test(s)) hosts.add(s.toLowerCase())
      }
    }
  } catch {
    /* ignore */
  }
  const out = { hosts, patterns, at: Date.now() }
  manifestNetCache.set(key, out)
  return out
}

function parseWebAppFromUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return null
  try {
    const u = new URL(pageUrl)
    const pathname = (u.pathname || '').replace(/^\/+/, '')
    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] !== 'web-apps' || parts.length < 3) return null
    return { appId: parts[1], version: parts[2] }
  } catch {
    return null
  }
}

function urlAllowedByAllowlist(targetUrl, hosts) {
  try {
    const u = new URL(targetUrl)
    const h = (u.hostname || '').toLowerCase()
    if (hosts.has(h)) return true
    return false
  } catch {
    return false
  }
}

function setupWebAppGuestSession() {
  const sess = session.fromPartition(WEB_APP_GUEST_PARTITION)

  sess.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url || ''

    if (
      url.startsWith('local-resource:') ||
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      url.startsWith('chrome-devtools:') ||
      url.startsWith('data:') ||
      url.startsWith('about:') ||
      url.startsWith('blob:')
    ) {
      return callback({})
    }

    if (!/^https?:\/\//i.test(url)) {
      return callback({})
    }

    let pageUrl = ''
    let wc = null
    try {
      wc = details.webContents
      if (!wc && details.webContentsId != null && webContentsModule && typeof webContentsModule.fromId === 'function') {
        wc = webContentsModule.fromId(details.webContentsId)
      }
      if (wc && !wc.isDestroyed()) {
        pageUrl = wc.getURL() || ''
      }
    } catch {
      pageUrl = ''
    }

    /** 导航初期 getURL() 可能仍为空；用 Referrer 解析 web-apps 上下文（Review：避免误拦首屏子资源） */
    let loc = parseWebAppFromUrl(pageUrl)
    if (!loc && details.referrer) {
      loc = parseWebAppFromUrl(String(details.referrer))
    }
    if (!loc && details.requestHeaders) {
      const rh = details.requestHeaders
      const ref = rh.Referer || rh.referer
      if (typeof ref === 'string' && ref) loc = parseWebAppFromUrl(ref)
    }
    if (!loc) {
      console.warn('[web-apps] Blocked network (no web-apps page context):', url.slice(0, 120))
      return callback({ cancel: true })
    }

    const { hosts } = readManifestNetAllowlist(loc.appId, loc.version)
    if (hosts.size === 0) {
      console.warn('[web-apps] Blocked network (net:none default):', url.slice(0, 120))
      return callback({ cancel: true })
    }

    if (urlAllowedByAllowlist(url, hosts)) {
      return callback({})
    }

    console.warn('[web-apps] Blocked network (not in netAllowlist):', url.slice(0, 120))
    return callback({ cancel: true })
  })

  console.log(`[web-apps] Guest session ready: ${WEB_APP_GUEST_PARTITION} (default net:none; use manifest.permissions + netAllowlist)`)
}

function invalidateManifestNetCache(appId, version) {
  if (!appId || !version) return
  manifestNetCache.delete(cacheKey(String(appId).trim(), String(version).trim()))
}

module.exports = {
  WEB_APP_GUEST_PARTITION,
  setupWebAppGuestSession,
  readManifestNetAllowlist,
  invalidateManifestNetCache
}
