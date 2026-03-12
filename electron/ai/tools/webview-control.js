// electron/ai/tools/webview-control.js
// 完全基于主进程 BrowserWindow，不再依赖渲染进程 webview

const fs = require('fs')
const path = require('path')
const { getAppRootPath } = require('../../app-root')
const browserManager = require('../browser-window-manager')

const definition = {
  name: 'webview_control',
  description: '控制应用内置浏览器（主进程 BrowserWindow）：导航、截图、执行 JS、点击/填写元素、快照、等待、弹窗等。与 chrome-devtools MCP 互补：优先使用 chrome-devtools MCP；当其失败或不可用时使用本工具，以扩展浏览器自动化能力。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'navigate',
          'get_url',
          'get_title',
          'reload',
          'go_back',
          'go_forward',
          'take_screenshot',
          'take_snapshot',
          'execute_js',
          'click_element',
          'get_element',
          'fill',
          'fill_form',
          'type_text',
          'press_key',
          'hover',
          'drag',
          'wait_for',
          'wait_for_load',
          'handle_dialog',
          'list_console',
          'get_console_message',
          'resize_page',
          'emulate',
          'set_cookie',
          'get_cookies',
          'check_login',
          'close'
        ],
        description: 'navigate/.../resize_page/emulate/set_cookie/get_cookies/close。emulate: 修改 UA(user_agent) 或视口(width+height); set_cookie: url+name+value 设置 Cookie; get_cookies: url 可选，获取当前页或指定 URL 的 Cookie'
      },
      user_agent:      { type: 'string',  description: 'emulate 时可选，设置 User-Agent' },
      cookie_url:      { type: 'string',  description: 'set_cookie/get_cookies 时：设置时必填（Cookie 所属 URL），获取时可选（默认当前页）' },
      cookie_name:     { type: 'string',  description: 'set_cookie 时必填' },
      cookie_value:    { type: 'string',  description: 'set_cookie 时必填' },
      cookie_domain:   { type: 'string',  description: 'set_cookie 时可选' },
      cookie_path:     { type: 'string',  description: 'set_cookie 时可选，默认 /' },
      cookie_http_only:{ type: 'boolean', description: 'set_cookie 时可选' },
      cookie_secure:   { type: 'boolean', description: 'set_cookie 时可选' },
      cookie_expires:   { type: 'number',  description: 'set_cookie 时可选，过期时间戳（秒）' },
      url:             { type: 'string',  description: 'navigate 时必填' },
      js_code:         { type: 'string',  description: 'execute_js 时必填' },
      selector:        { type: 'string',  description: 'click_element/get_element/fill/hover/drag 时必填' },
      target_selector: { type: 'string',  description: 'drag 时可选，拖拽目标元素（与 offset_x/y 二选一）' },
      offset_x:        { type: 'number',  description: 'drag 时可选，位移 X' },
      offset_y:        { type: 'number',  description: 'drag 时可选，位移 Y' },
      value:           { type: 'string',  description: 'fill 时必填' },
      fields:          { type: 'array',   description: 'fill_form 时必填，[{ selector, value }]', items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } } } },
      text:            { type: 'string',  description: 'type_text/wait_for 时必填' },
      key:             { type: 'string',  description: 'press_key 时必填' },
      dialog_action:   { type: 'string',  enum: ['accept', 'dismiss'], description: 'handle_dialog 时必填' },
      prompt_text:     { type: 'string',  description: 'handle_dialog prompt 时可选' },
      index:           { type: 'number',  description: 'get_console_message 时可选，默认最后一条' },
      width:           { type: 'number',  description: 'resize_page 时必填' },
      height:          { type: 'number',  description: 'resize_page 时必填' },
      fullPage:        { type: 'boolean', description: 'take_screenshot 时可选，是否截取整页' },
      full_page:       { type: 'boolean', description: 'take_screenshot 时可选，fullPage 的别名' },
      format:          { type: 'string',  description: 'take_screenshot 时可选：png/jpeg' },
      quality:         { type: 'number',  description: 'take_screenshot 时可选：jpeg 质量 1-100' },
      timeout:         { type: 'number',  description: '超时毫秒，默认 30000' }
    },
    required: ['action']
  }
}

function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  const s = String(v == null ? '' : v).trim().toLowerCase()
  if (!s) return fallback
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false
  return fallback
}

async function waitForScreenshotReady(wc, timeoutMs = 30000) {
  const start = Date.now()
  const deadline = start + Math.max(800, Number(timeoutMs) || 30000)
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const status = await wc.executeJavaScript(`
        (async function () {
          const body = document.body
          const ready = document.readyState === 'complete' || document.readyState === 'interactive'
          const textLen = (body && body.innerText ? body.innerText.trim().length : 0)
          let fontsReady = true
          try { if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 200))]) } catch (_) {}
          try { fontsReady = !document.fonts || document.fonts.status === 'loaded' } catch (_) {}
          const imgs = Array.from(document.images || [])
          const allImagesDone = imgs.every((img) => img.complete)
          const hasVisualRoot = !!(body && body.children && body.children.length > 0)
          return { ready, textLen, fontsReady, allImagesDone, hasVisualRoot, state: document.readyState }
        })()
      `)
      const ok = !!(status && status.ready && status.hasVisualRoot && (status.textLen > 0 || status.allImagesDone) && status.fontsReady)
      if (ok) return
      lastErr = `state=${status?.state || 'unknown'} textLen=${status?.textLen || 0}`
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 180))
  }
  throw new Error(`页面渲染等待超时: ${lastErr || 'unknown'}`)
}

const SCREENSHOT_STABILIZE_MS = 700

async function execute(args) {
  const {
    action, user_agent, url, cookie_url, cookie_name, cookie_value, cookie_domain, cookie_path, cookie_http_only, cookie_secure, cookie_expires,
    js_code, selector, target_selector, offset_x, offset_y, value, fields, text, key, dialog_action, prompt_text, index, width, height,
    fullPage, full_page, format, quality, timeout = 30000
  } = args

  if (action === 'close') {
    browserManager.destroy()
    return { success: true }
  }

  const win = await browserManager.getWindow()
  const wc = win.webContents

  if (action === 'navigate') {
    if (!url) return { success: false, error: 'navigate 需要 url 参数' }
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('navigate 超时')), timeout)
      wc.once('did-finish-load', () => { clearTimeout(t); resolve() })
      wc.once('did-fail-load', (e, code, desc) => { if (code === -3) return; clearTimeout(t); reject(new Error(`加载失败: ${desc}`)) })
      win.loadURL(url).catch(reject)
    })
    return { success: true, url: wc.getURL(), title: wc.getTitle() }
  }

  if (action === 'get_url')   return { url: wc.getURL() }
  if (action === 'get_title') return { title: wc.getTitle() }

  if (action === 'reload') {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, timeout)
      wc.once('did-finish-load', () => { clearTimeout(t); resolve() })
      wc.reload()
    })
    return { success: true, url: wc.getURL() }
  }

  if (action === 'go_back') {
    if (wc.canGoBack()) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, timeout)
        wc.once('did-finish-load', () => { clearTimeout(t); resolve() })
        wc.goBack()
      })
    }
    return { success: true, url: wc.getURL() }
  }

  if (action === 'go_forward') {
    if (wc.canGoForward()) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, timeout)
        wc.once('did-finish-load', () => { clearTimeout(t); resolve() })
        wc.goForward()
      })
    }
    return { success: true, url: wc.getURL() }
  }

  if (action === 'take_screenshot') {
    const wantFullPage = toBool(fullPage, toBool(full_page, false))
    const fmt = String(format || 'png').trim().toLowerCase() === 'jpeg' ? 'jpeg' : 'png'
    const q = Number.isFinite(Number(quality)) ? Math.max(1, Math.min(100, Number(quality))) : 80
    let restoreSize = null
    // 先等待页面渲染完成，避免截到白板
    await waitForScreenshotReady(wc, timeout)
    await new Promise((r) => setTimeout(r, SCREENSHOT_STABILIZE_MS))
    if (wantFullPage) {
      try {
        const dim = await wc.executeJavaScript(`({
          width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, window.innerWidth),
          height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight)
        })`)
        const w = Math.max(800, Math.min(5000, Number(dim?.width || 1366)))
        const h = Math.max(600, Math.min(12000, Number(dim?.height || 900)))
        const cur = win.getContentBounds()
        restoreSize = { width: cur.width, height: cur.height }
        win.setContentSize(w, h)
        await new Promise((r) => setTimeout(r, SCREENSHOT_STABILIZE_MS))
      } catch (_) { /* ignore */ }
    }
    const img = await wc.capturePage()
    const outBuffer = fmt === 'jpeg' ? img.toJPEG(q) : img.toPNG()
    if (restoreSize) {
      try { win.setContentSize(restoreSize.width, restoreSize.height) } catch (_) {}
    }
    const screenshotDir = getAppRootPath('screenshots')
    fs.mkdirSync(screenshotDir, { recursive: true })
    const filename = `screenshot-${Date.now()}.${fmt === 'jpeg' ? 'jpg' : 'png'}`
    const filepath = path.join(screenshotDir, filename)
    fs.writeFileSync(filepath, outBuffer)
    const resourceUrl = `local-resource://screenshots/${filename}`
    return {
      file_path: filepath,
      file_url: resourceUrl,
      url: wc.getURL(),
      tip: `截图已保存到本地。应用内展示：![截图](${resourceUrl})。如需发给用户，请调用对应渠道的 *_send_message 工具发送。`
    }
  }

  if (action === 'take_snapshot') {
    const snapshot = await wc.executeJavaScript(`
      (function() {
        function getTextContent(el, depth) {
          if (depth > 8) return ''
          const tag = el.tagName ? el.tagName.toLowerCase() : ''
          const skip = ['script','style','noscript','svg','path','head']
          if (skip.includes(tag)) return ''
          const role = el.getAttribute && el.getAttribute('role')
          const ariaLabel = el.getAttribute && el.getAttribute('aria-label')
          const placeholder = el.getAttribute && el.getAttribute('placeholder')
          const text = (el.innerText || '').trim().slice(0, 200)
          const id = el.id ? '#' + el.id : ''
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().replace(/\\s+/g, '.').slice(0, 40) : ''
          let line = ''
          if (tag) {
            line = '  '.repeat(depth) + '<' + tag + id + cls
            if (role) line += ' role="' + role + '"'
            if (ariaLabel) line += ' aria-label="' + ariaLabel + '"'
            if (placeholder) line += ' placeholder="' + placeholder + '"'
            if (el.href) line += ' href="' + el.href.slice(0, 80) + '"'
            if (el.value !== undefined && el.tagName && ['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) line += ' value="' + String(el.value).slice(0,80) + '"'
            if (text && !el.children.length) line += '>' + text
            else line += '>'
          }
          const childLines = Array.from(el.children || []).map(c => getTextContent(c, depth + 1)).filter(Boolean)
          return [line, ...childLines].filter(Boolean).join('\\n')
        }
        return getTextContent(document.body, 0).slice(0, 15000)
      })()
    `)
    return { snapshot, url: wc.getURL(), title: wc.getTitle() }
  }

  if (action === 'execute_js') {
    if (!js_code) return { success: false, error: 'execute_js 需要 js_code 参数' }
    const result = await wc.executeJavaScript(js_code)
    return { result }
  }

  if (action === 'click_element') {
    if (!selector) return { success: false, error: 'click_element 需要 selector 参数' }
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { clicked: false, error: '未找到元素: ' + ${JSON.stringify(selector)} }
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        el.click()
        return { clicked: true, tag: el.tagName, text: (el.innerText||'').slice(0,100) }
      })()
    `)
    return result
  }

  if (action === 'get_element') {
    if (!selector) return { success: false, error: 'get_element 需要 selector 参数' }
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        return {
          tag: el.tagName,
          text: (el.innerText||'').slice(0, 2000),
          value: el.value,
          href: el.href,
          checked: el.checked,
          disabled: el.disabled,
          placeholder: el.getAttribute('placeholder')
        }
      })()
    `)
    return result || { error: '未找到元素: ' + selector }
  }

  if (action === 'fill') {
    if (!selector) return { success: false, error: 'fill 需要 selector 参数' }
    if (value === undefined) return { success: false, error: 'fill 需要 value 参数' }
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { success: false, error: '未找到元素: ' + ${JSON.stringify(selector)} }
        el.focus()
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        if (nativeInputValueSetter && nativeInputValueSetter.set) {
          nativeInputValueSetter.set.call(el, ${JSON.stringify(value)})
        } else {
          el.value = ${JSON.stringify(value)}
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true, tag: el.tagName }
      })()
    `)
    return result
  }

  if (action === 'fill_form') {
    if (!Array.isArray(fields) || fields.length === 0) return { success: false, error: 'fill_form 需要 fields 数组，每项含 selector 与 value' }
    const results = []
    for (const item of fields) {
      const sel = item.selector
      const val = item.value
      if (!sel) continue
      const one = await wc.executeJavaScript(`
        (function(){
          var el = document.querySelector(${JSON.stringify(sel)})
          if (!el) return { success: false, error: '未找到: ' + ${JSON.stringify(sel)} }
          el.focus()
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement && window.HTMLInputElement.prototype, 'value') ||
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype, 'value')
          if (setter && setter.set) setter.set.call(el, ${JSON.stringify(val == null ? '' : String(val))})
          else el.value = ${JSON.stringify(val == null ? '' : String(val))}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return { success: true, selector: ${JSON.stringify(sel)} }
        })()
      `)
      results.push(one)
    }
    return { success: true, filled: results.length, results }
  }

  if (action === 'hover') {
    if (!selector) return { success: false, error: 'hover 需要 selector 参数' }
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { success: false, error: '未找到元素' }
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        return { success: true, tag: el.tagName }
      })()
    `)
    return result
  }

  if (action === 'drag') {
    if (!selector) return { success: false, error: 'drag 需要 selector 参数' }
    const hasTarget = target_selector && String(target_selector).trim()
    const hasOffset = typeof offset_x === 'number' || typeof offset_y === 'number'
    if (!hasTarget && !hasOffset) return { success: false, error: 'drag 需要 target_selector 或 offset_x/offset_y' }
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { success: false, error: '未找到元素: ' + ${JSON.stringify(selector)} }
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        var rect = el.getBoundingClientRect()
        var startX = rect.left + rect.width/2, startY = rect.top + rect.height/2
        var endX = startX, endY = startY
        if (${JSON.stringify(hasTarget)}) {
          var target = document.querySelector(${JSON.stringify(target_selector || '')})
          if (!target) return { success: false, error: '未找到目标: ' + ${JSON.stringify(target_selector)} }
          var tr = target.getBoundingClientRect()
          endX = tr.left + tr.width/2
          endY = tr.top + tr.height/2
        } else {
          endX = startX + (${Number(offset_x) || 0})
          endY = startY + (${Number(offset_y) || 0})
        }
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY, button: 0 }))
        document.documentElement.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: endX, clientY: endY, button: 0 }))
        document.documentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: endX, clientY: endY, button: 0 }))
        return { success: true, from: selector, to: ${JSON.stringify(hasTarget ? target_selector : 'offset')} }
      })()
    `)
    return result
  }

  if (action === 'type_text') {
    if (!text) return { success: false, error: 'type_text 需要 text 参数' }
    for (const char of text) {
      wc.sendInputEvent({ type: 'char', keyCode: char })
    }
    return { success: true, typed: text.length }
  }

  if (action === 'press_key') {
    if (!key) return { success: false, error: 'press_key 需要 key 参数' }
    const parts = key.split('+')
    const mainKey = parts[parts.length - 1]
    const modMap = { ctrl: 'control', cmd: 'meta', command: 'meta', opt: 'alt', option: 'alt' }
    const modifiers = parts.slice(0, -1).map(m => { const l = m.toLowerCase(); return modMap[l] ?? l })
    wc.sendInputEvent({ type: 'keyDown', keyCode: mainKey, modifiers })
    wc.sendInputEvent({ type: 'keyUp',   keyCode: mainKey, modifiers })
    return { success: true, key }
  }

  if (action === 'wait_for_load') {
    await new Promise((resolve) => {
      if (!wc.isLoading()) { resolve(); return }
      const t = setTimeout(resolve, timeout)
      wc.once('did-finish-load', () => { clearTimeout(t); resolve() })
    })
    return { success: true, url: wc.getURL() }
  }

  if (action === 'wait_for') {
    if (!text) return { success: false, error: 'wait_for 需要 text 参数' }
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const found = await wc.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(text)})`
      ).catch(() => false)
      if (found) return { success: true, found: true, text }
      await new Promise(r => setTimeout(r, 300))
    }
    return { success: false, found: false, text, error: `等待超时：页面未出现文本 "${text}"` }
  }

  if (action === 'handle_dialog') {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ success: false, error: '等待弹窗超时' }), timeout)
      const onDialog = (e) => {
        clearTimeout(t)
        e.preventDefault()
        if (dialog_action === 'dismiss') {
          resolve({ success: true, dismissed: true })
        } else {
          resolve({ success: true, accepted: true, message: e.message })
        }
      }
      // Electron webContents 无 'dialog' 事件，仅依赖下方 JS monkey-patch 作为实现
      wc.executeJavaScript(`
        window._dialogResult = null
        window.alert   = function(m){ window._dialogResult = { type:'alert', message:m } }
        window.confirm = function(m){ window._dialogResult = { type:'confirm', message:m }; return ${dialog_action === 'accept' ? 'true' : 'false'} }
        window.prompt  = function(m,d){ window._dialogResult = { type:'prompt', message:m, defaultValue:d }; return ${JSON.stringify(prompt_text || '')} }
      `).catch(() => {})
      setTimeout(async () => {
        const r = await wc.executeJavaScript('window._dialogResult').catch(() => null)
        if (r) { clearTimeout(t); wc.removeListener('dialog', onDialog); resolve({ success: true, result: r }) }
      }, 500)
    })
  }

  if (action === 'list_console') {
    return { messages: browserManager.getConsoleMessages() }
  }

  if (action === 'get_console_message') {
    const messages = browserManager.getConsoleMessages()
    const idx = typeof index === 'number' ? index : messages.length - 1
    const msg = messages[idx]
    if (msg === undefined) return { message: null, index: idx, total: messages.length }
    return { message: msg, index: idx, total: messages.length }
  }

  if (action === 'resize_page') {
    if (typeof width !== 'number' || typeof height !== 'number') return { success: false, error: 'resize_page 需要 width 和 height 参数' }
    win.setSize(Math.max(320, width), Math.max(240, height))
    return { success: true, width: win.getBounds().width, height: win.getBounds().height }
  }

  if (action === 'emulate') {
    const changed = {}
    if (user_agent != null && String(user_agent).trim()) {
      wc.setUserAgent(String(user_agent).trim())
      changed.user_agent = true
    }
    if (typeof width === 'number' && typeof height === 'number') {
      win.setSize(Math.max(320, width), Math.max(240, height))
      changed.viewport = { width: win.getBounds().width, height: win.getBounds().height }
    }
    if (Object.keys(changed).length === 0) return { success: false, error: 'emulate 需要 user_agent 或 width+height 至少一项' }
    return { success: true, ...changed }
  }

  if (action === 'set_cookie') {
    const targetUrl = cookie_url && String(cookie_url).trim() ? String(cookie_url).trim() : wc.getURL()
    if (!targetUrl || targetUrl === 'about:blank') return { success: false, error: 'set_cookie 需要 cookie_url（或先 navigate 到目标页）' }
    if (!cookie_name || !cookie_value) return { success: false, error: 'set_cookie 需要 cookie_name 和 cookie_value' }
    const details = { url: targetUrl, name: String(cookie_name), value: String(cookie_value) }
    if (cookie_domain != null && String(cookie_domain).trim()) details.domain = String(cookie_domain).trim()
    if (cookie_path != null && String(cookie_path).trim()) details.path = String(cookie_path).trim()
    if (cookie_http_only === true) details.httpOnly = true
    if (cookie_secure === true) details.secure = true
    if (typeof cookie_expires === 'number' && cookie_expires > 0) details.expirationDate = cookie_expires
    await wc.session.cookies.set(details)
    return { success: true, url: targetUrl, name: cookie_name }
  }

  if (action === 'get_cookies') {
    const targetUrl = cookie_url && String(cookie_url).trim() ? String(cookie_url).trim() : wc.getURL()
    if (!targetUrl || targetUrl === 'about:blank') return { success: false, error: 'get_cookies 需要 cookie_url（或先 navigate 到目标页）' }
    const list = await wc.session.cookies.get({ url: targetUrl })
    const cookies = list.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))
    return { url: targetUrl, cookies }
  }

  if (action === 'check_login') {
    const currentUrl = wc.getURL()
    return {
      needs_login: /login|signin|sign-in|auth\/login/i.test(currentUrl),
      current_url: currentUrl
    }
  }

  return { success: false, error: `未知 action: ${action}` }
}

module.exports = { definition, execute }
