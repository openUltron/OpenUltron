/**
 * 通过隐藏 BrowserWindow 加载页面，再把标题、可见文本、链接列表返回给上层工具。
 * 这样 AI 可以自己解析搜索页或 JS 渲染页，而不是依赖脆弱的站点私有选择器。
 */

const { BrowserWindow } = require('electron')

const TIMEOUT_MS = 18000
const DEFAULT_WAIT_MS = 2000
const MAX_RESULTS = 15
const MAX_TEXT_LEN = 6000
const MAX_LINKS = 40

function getBaiduSearchUrl(query) {
  return `https://www.baidu.com/s?wd=${encodeURIComponent(query.trim())}`
}

function getGoogleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`
}

function buildPageExtractScript() {
  return `
(function () {
  function textOf(node) {
    return String(
      (node && (node.innerText || node.textContent)) || ''
    ).replace(/\\s+/g, ' ').trim()
  }

  var title = textOf(document.querySelector('title')) || textOf(document.querySelector('h1')) || document.title || ''
  var bodyText = textOf(document.body)
  var links = Array.from(document.querySelectorAll('a[href]')).map(function (a) {
    var href = a.href || a.getAttribute('href') || ''
    var text = textOf(a)
    var titleAttr = String(a.getAttribute('title') || '').trim()
    var container = a.closest('article, main, section, div, li') || a.parentElement
    var context = textOf(container)
    return {
      href: href,
      text: text,
      title: titleAttr,
      context: context
    }
  })

  return {
    title: title,
    url: location.href,
    text: bodyText,
    links: links
  }
})()
`
}

function truncateText(text, maxLen = MAX_TEXT_LEN) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLen) return normalized
  return `${normalized.slice(0, maxLen)}...`
}

function normalizeExtractedPage(payload = {}, options = {}) {
  const pageUrl = String(payload.url || '').trim()
  const maxLinks = Number.isFinite(Number(options.maxLinks)) ? Math.max(1, Math.min(100, Number(options.maxLinks))) : MAX_LINKS
  const maxTextLength = Number.isFinite(Number(options.maxTextLength)) ? Math.max(200, Math.min(20000, Number(options.maxTextLength))) : MAX_TEXT_LEN
  const links = []
  const seen = new Set()

  const rawLinks = Array.isArray(payload.links) ? payload.links : []
  for (const raw of rawLinks) {
    const href = String(raw?.href || '').trim()
    if (!href) continue

    let absoluteUrl = href
    try {
      absoluteUrl = pageUrl ? new URL(href, pageUrl).href : new URL(href).href
    } catch {
      continue
    }

    const protocol = new URL(absoluteUrl).protocol
    if (!['http:', 'https:'].includes(protocol)) continue

    const text = String(raw?.text || raw?.title || '').replace(/\s+/g, ' ').trim()
    const context = String(raw?.context || '').replace(/\s+/g, ' ').trim()
    const label = text || context.slice(0, 120) || absoluteUrl
    const dedupeKey = absoluteUrl
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    links.push({
      text: label.slice(0, 200),
      url: absoluteUrl,
      context: truncateText(context, 300)
    })

    if (links.length >= maxLinks) break
  }

  return {
    title: String(payload.title || '').trim().slice(0, 300),
    url: pageUrl,
    text: truncateText(payload.text || '', maxTextLength),
    links
  }
}

function buildSearchResultsFromPage(page, engine = 'baidu', maxResults = MAX_RESULTS) {
  const engineHost = engine === 'google' ? 'google.com' : 'baidu.com'
  const results = []
  const seen = new Set()
  for (const link of Array.isArray(page.links) ? page.links : []) {
    let parsed
    try {
      parsed = new URL(link.url)
    } catch {
      continue
    }
    if (parsed.hostname.includes(engineHost)) continue
    if (seen.has(link.url)) continue
    seen.add(link.url)
    const title = String(link.text || '').trim()
    if (title.length < 2) continue
    results.push({
      index: results.length + 1,
      title: title.slice(0, 200),
      url: link.url,
      content: String(link.context || '').slice(0, 400)
    })
    if (results.length >= maxResults) break
  }
  return results
}

function loadViaWebview(url, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(3000, Math.min(60000, Number(options.timeoutMs))) : TIMEOUT_MS
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Math.min(10000, Number(options.waitMs))) : DEFAULT_WAIT_MS
  const maxLinks = Number.isFinite(Number(options.maxLinks)) ? Number(options.maxLinks) : MAX_LINKS
  const maxTextLength = Number.isFinite(Number(options.maxTextLength)) ? Number(options.maxTextLength) : MAX_TEXT_LEN

  return new Promise((resolve) => {
    let win = null
    const cleanup = () => {
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolve({ success: false, error: '隐藏浏览器加载超时' })
    }, timeoutMs)

    try {
      win = new BrowserWindow({
        show: false,
        width: 1366,
        height: 900,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      })

      win.webContents.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      )

      win.webContents.on('did-finish-load', () => {
        setTimeout(() => {
          if (!win || win.isDestroyed()) return
          win.webContents.executeJavaScript(buildPageExtractScript())
            .then((payload) => {
              clearTimeout(timeout)
              const page = normalizeExtractedPage(payload, { maxLinks, maxTextLength })
              cleanup()
              resolve({ success: true, page })
            })
            .catch((err) => {
              clearTimeout(timeout)
              cleanup()
              resolve({ success: false, error: `执行页面提取失败: ${err.message}` })
            })
        }, waitMs)
      })

      win.webContents.on('did-fail-load', (_, code, desc) => {
        clearTimeout(timeout)
        cleanup()
        resolve({ success: false, error: `页面加载失败: ${code} ${desc}` })
      })

      win.loadURL(url, { userAgent: win.webContents.getUserAgent() })
    } catch (e) {
      clearTimeout(timeout)
      cleanup()
      resolve({ success: false, error: `创建隐藏浏览器失败: ${e.message}` })
    }
  })
}

async function searchViaWebview(query, engine = 'baidu') {
  const url = engine === 'google' ? getGoogleSearchUrl(query) : getBaiduSearchUrl(query)
  const loaded = await loadViaWebview(url, { waitMs: DEFAULT_WAIT_MS, maxLinks: 60, maxTextLength: 8000 })
  if (!loaded.success) return loaded

  const page = loaded.page || {}
  const results = buildSearchResultsFromPage(page, engine, MAX_RESULTS)
  if (results.length === 0) {
    return {
      success: false,
      error: '隐藏浏览器已加载页面，但未提取到有效搜索结果',
      page
    }
  }

  return {
    success: true,
    query: query.trim(),
    results,
    total: results.length,
    page
  }
}

module.exports = {
  searchViaWebview,
  loadViaWebview,
  normalizeExtractedPage,
  buildSearchResultsFromPage,
  getBaiduSearchUrl,
  getGoogleSearchUrl
}
