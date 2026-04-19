/**
 * Web 应用注册表：~/.openultron/web-apps/<id>/<version>/
 * 对齐 docs/WEB-APPS-SANDBOX-DESIGN.md §3、§7、§20 Phase A
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const semver = require('semver')
const { execFileSync } = require('child_process')
const { getAppRootPath } = require('../app-root')

const TEMPLATE_DIR = path.join(__dirname, 'hello-webapp-template')
const { checkHostOpenUltronRange } = require('./host-openultron')
const {
  ensureWebAppService,
  getWebAppServiceStatus,
  stopWebAppService,
  getWebAppServiceLogs
} = require('./process-manager')
const WEBAPP_ID_RE = /^[a-zA-Z0-9._-]{1,120}$/
const WEBAPP_VERSION_RE = /^[a-zA-Z0-9._-]{1,64}$/
const PROJECT_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/
const ZIP_MAX_FILES = 5000
const ZIP_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024

function getWebAppsRoot() {
  return getAppRootPath('web-apps')
}

function ensureWebAppsRoot() {
  const root = getWebAppsRoot()
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * MVP：必填字段子集
 * @param {object} m
 * @param {{ checkHostVersion?: boolean }} [options] 为 true 时校验 host.openUltron 与当前宿主 semver（仅安装/导入应开启）
 */
function validateMvpManifest(m, options = {}) {
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest 不是对象' }
  const checkHost = options.checkHostVersion === true
  const id = String(m.id || '').trim()
  const name = String(m.name || '').trim()
  const version = String(m.version || '').trim()
  if (!id) return { ok: false, error: '缺少 id' }
  if (!name) return { ok: false, error: '缺少 name' }
  if (!version) return { ok: false, error: '缺少 version' }
  if (!WEBAPP_ID_RE.test(id)) return { ok: false, error: 'id 仅允许字母、数字、点、下划线、短横线（1-120）' }
  if (!WEBAPP_VERSION_RE.test(version)) return { ok: false, error: 'version 仅允许字母、数字、点、下划线、短横线（1-64）' }
  const host = m.host || {}
  if (!String(host.openUltron || '').trim()) return { ok: false, error: '缺少 host.openUltron' }
  if (host.protocol == null) return { ok: false, error: '缺少 host.protocol' }
  const entry = m.entry || {}
  const html = String(entry.html || 'index.html').trim() || 'index.html'
  let service = null
  if (entry.service != null) {
    if (typeof entry.service !== 'object' || Array.isArray(entry.service)) {
      return { ok: false, error: 'entry.service 必须是对象' }
    }
    const cmd = String(entry.service.command || '').trim()
    if (!cmd) return { ok: false, error: 'entry.service.command 不能为空' }
    const cwd = String(entry.service.cwd || '.').trim() || '.'
    const healthPath = String(entry.service.healthPath || '').trim() || '/'
    const portEnv = String(entry.service.portEnv || 'PORT').trim() || 'PORT'
    const startupTimeoutMs = Number.isFinite(Number(entry.service.startupTimeoutMs))
      ? Math.max(3000, Math.min(120000, Number(entry.service.startupTimeoutMs)))
      : 30000
    const rawEnv = entry.service.env
    const env = {}
    if (rawEnv != null) {
      if (typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
        return { ok: false, error: 'entry.service.env 必须是对象' }
      }
      for (const [k, v] of Object.entries(rawEnv)) {
        const key = String(k || '').trim()
        if (!key) continue
        env[key] = String(v == null ? '' : v)
      }
    }
    service = {
      command: cmd,
      cwd,
      healthPath,
      portEnv,
      startupTimeoutMs,
      ...(Object.keys(env).length ? { env } : {})
    }
  }

  let runtime = m.runtime
  if (runtime == null) {
    runtime = { browser: true, node: false }
  } else if (typeof runtime !== 'object' || Array.isArray(runtime)) {
    return { ok: false, error: 'runtime 必须是对象' }
  }
  const browser = runtime.browser !== false
  const node = runtime.node === true
  if (!browser && !node) {
    return { ok: false, error: 'runtime 需至少启用 browser 或 node 之一' }
  }

  if (checkHost) {
    const hostChk = checkHostOpenUltronRange(host.openUltron)
    if (!hostChk.ok) return { ok: false, error: hostChk.error || 'host.openUltron 与当前宿主不兼容' }
  }

  return {
    ok: true,
    normalized: {
      ...m,
      id,
      name,
      version,
      host: { ...host },
      entry: { ...entry, html, ...(service ? { service } : {}) },
      runtime: { browser, node }
    }
  }
}

function readManifestJson(dir) {
  const p = path.join(dir, 'manifest.json')
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readSourceMeta(appDir) {
  const p = path.join(appDir, '.source.json')
  if (!fs.existsSync(p)) return {}
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function writeSourceMeta(appDir, meta) {
  const next = meta && typeof meta === 'object' ? meta : {}
  try {
    fs.writeFileSync(path.join(appDir, '.source.json'), JSON.stringify(next, null, 2), 'utf-8')
  } catch (_) {}
}

/**
 * @returns {Array<{ id: string, version: string, name: string, path: string, manifest: object }>}
 */
function listInstalledApps() {
  const root = ensureWebAppsRoot()
  const out = []
  let appDirs = []
  try {
    appDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const appId of appDirs) {
    const appPath = path.join(root, appId)
    let versions = []
    try {
      versions = fs.readdirSync(appPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue
    }
    for (const ver of versions) {
      const dir = path.join(appPath, ver)
      const manifest = readManifestJson(dir)
      if (!manifest) continue
      const v = validateMvpManifest(manifest)
      if (!v.ok) continue
      out.push({
        id: v.normalized.id,
        version: v.normalized.version,
        name: v.normalized.name,
        path: dir,
        manifest: v.normalized,
        sourceMeta: readSourceMeta(dir)
      })
    }
  }
  out.sort((a, b) => (a.id + a.version).localeCompare(b.id + b.version))
  return out
}

/**
 * local-resource:// 相对 app 根路径，见 main 中 protocol 处理
 * @returns {string}
 */
function getPreviewUrlForApp(manifest, _appDir) {
  const v = validateMvpManifest(manifest)
  if (!v.ok) return ''
  const m = v.normalized
  const html = String(m.entry.html || 'index.html').replace(/^\/+/, '')
  // 使用「空 host + 全路径」形式，避免部分 Chromium/嵌套场景下对 host 的解析差异导致崩溃
  const rel = ['web-apps', m.id, m.version, html].join('/')
  return `local-resource:///${rel}`
}

function escapeHtml(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildSandboxReadme({ name, id, version, entryHtml = 'index.html', serviceCommand = '' }) {
  const appName = String(name || '未命名应用').trim() || '未命名应用'
  const appId = String(id || '').trim()
  const appVersion = String(version || '').trim()
  const html = String(entryHtml || 'index.html').trim() || 'index.html'
  const svc = String(serviceCommand || '').trim()
  return `# ${appName}

这是一个 OpenUltron 沙盒应用（Web App）。

## 应用信息

- id: \`${appId}\`
- version: \`${appVersion}\`
- 入口页面: \`${html}\`
${svc ? `- 服务命令: \`${svc}\`` : '- 服务命令:（未配置，使用内置静态服务）'}

## 目录约定

- \`manifest.json\`: 应用元数据、运行时与服务配置
- \`${html}\`: 页面入口
- \`README.md\`: 本开发文档

## 开发方式（推荐）

1. 在 OpenUltron 的「应用工作室」打开该应用。
2. 左侧预览默认会尝试启动服务并打开本地服务地址（localhost）。
3. 右侧 AI 可在应用目录执行命令与改写文件。

## manifest 关键字段

\`\`\`json
{
  "entry": {
    "html": "${html}",
    "service": {
      "command": "${svc || "node server.js"}",
      "cwd": ".",
      "portEnv": "PORT",
      "startupTimeoutMs": 20000
    }
  },
  "runtime": {
    "browser": true,
    "node": true
  }
}
\`\`\`

## 调试建议

- Node 检查:
\`\`\`bash
node --check server.js
\`\`\`

- Python（如需）:
\`\`\`bash
python3 -c "print('python ok')"
\`\`\`

## 主题兼容（必须）

沙箱预览会跟随宿主主题在 **light / dark** 间切换。实现页面时必须保证两套主题可用，避免只适配一种导致不可读。

- 不要把文字和背景颜色写死为单一深浅组合。
- 优先使用 CSS 变量承载颜色，再通过主题态切换变量值。
- 兼容选择器建议：\`html[data-theme="light"]\` / \`html[data-theme="dark"]\` 或 \`.theme-light\` / \`.theme-dark\`。
- 对比度至少保证正文可读（避免浅色字配浅底、深色字配深底）。

## 注意事项

- 仅在应用目录内读写文件，避免越界到主程序目录。
- 若服务启动失败，可先检查服务命令、端口环境变量和日志输出。
- 可通过版本号管理多个应用版本目录。
`
}

/**
 * 新建空白应用：id 来自英文项目名，版本 0.1.0、manifest + 最小 index.html
 * @param {{ name?: string, description?: string, projectName?: string }} opts
 */
function createBlankWebApp(opts = {}) {
  ensureWebAppsRoot()
  const name = String(opts.name || '').trim()
  const description = String(opts.description || '').trim()
  const projectName = String(opts.projectName || '').trim().toLowerCase()
  if (!name) return { success: false, error: '应用名称不能为空' }
  if (!description) return { success: false, error: '应用描述不能为空' }
  if (!PROJECT_NAME_RE.test(projectName)) {
    return { success: false, error: '英文项目名称仅允许小写字母、数字、短横线，且需字母开头（2-64）' }
  }
  const version = '0.1.0'
  const id = projectName
  const dest = path.join(getWebAppsRoot(), id, version)
  if (fs.existsSync(dest)) {
    return { success: false, error: `项目名称已存在：${projectName}` }
  }
  const manifest = {
    id,
    name,
    description,
    version,
    host: {
      openUltron: '>=1.0.0',
      protocol: 1
    },
    entry: {
      html: 'index.html',
      service: {
        command: 'node service.js',
        cwd: '.',
        portEnv: 'PORT',
        startupTimeoutMs: 20000
      }
    },
    runtime: { browser: true, node: true }
  }
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  fs.writeFileSync(
    path.join(dest, 'README.md'),
    buildSandboxReadme({
      name,
      id,
      version,
      entryHtml: manifest.entry?.html || 'index.html',
      serviceCommand: manifest.entry?.service?.command || ''
    }),
    'utf-8'
  )
  const safeName = escapeHtml(name)
  const safeDesc = escapeHtml(description)
  const indexHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeName}</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2028;
      --text: #e6edf3;
      --muted: #9fb0c0;
      --border: #2d3642;
    }
    html[data-theme="light"], html.theme-light {
      --bg: #f6f8fb;
      --panel: #ffffff;
      --text: #1f2937;
      --muted: #4b5563;
      --border: #d8dee6;
    }
    html[data-theme="dark"], html.theme-dark {
      --bg: #0f1419;
      --panel: #1a2028;
      --text: #e6edf3;
      --muted: #9fb0c0;
      --border: #2d3642;
    }
    body {
      margin: 0;
      padding: 24px;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .card {
      max-width: 860px;
      margin: 0 auto;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--panel);
      padding: 14px 16px;
    }
    h1 { font-size: 22px; margin: 0 0 8px; letter-spacing: -0.02em; }
    p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
    code { font-size: 0.9em; color: var(--text); }
  </style>
</head>
<body>
  <main class="card">
    <h1>${safeName}</h1>
    <p>${safeDesc}</p>
    <p style="margin-top:8px;">在 <strong>应用工作室</strong> 右侧用 AI 协助，或直接编辑本目录下的 <code>index.html</code>、<code>service.js</code> 与 <code>manifest.json</code>。本页面已兼容浅色/深色主题。</p>
  </main>
</body>
</html>
`
  fs.writeFileSync(path.join(dest, 'index.html'), indexHtml, 'utf-8')
  const serviceJs = `'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

const host = '127.0.0.1'
const port = Number(process.env.PORT || 3000)
const root = __dirname

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function sendFile(res, fp) {
  const ext = path.extname(fp).toLowerCase()
  const contentType = ext === '.html'
    ? 'text/html; charset=utf-8'
    : ext === '.js'
      ? 'application/javascript; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': contentType })
  fs.createReadStream(fp).pipe(res)
}

const server = http.createServer((req, res) => {
  const reqUrl = String(req.url || '/')
  if (reqUrl === '/health' || reqUrl === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'new-webapp', ts: new Date().toISOString() })
  }
  const pathname = reqUrl.split('?')[0]
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\\/+/, '')
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.writeHead(403)
    return res.end('Forbidden')
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404)
    return res.end('Not Found')
  }
  return sendFile(res, abs)
})

server.listen(port, host, () => {
  process.stdout.write('[new-webapp] running at http://' + host + ':' + port + '\\n')
})
`
  fs.writeFileSync(path.join(dest, 'service.js'), serviceJs, 'utf-8')
  return {
    success: true,
    id,
    version,
    path: dest,
    manifest,
    previewUrl: getPreviewUrlForApp(manifest, dest)
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) copyDirRecursive(s, d)
    else fs.copyFileSync(s, d)
  }
}

function isPathInside(baseDir, targetPath) {
  const baseResolved = path.resolve(baseDir)
  const targetResolved = path.resolve(targetPath)
  return targetResolved === baseResolved || targetResolved.startsWith(baseResolved + path.sep)
}

function isSymlinkZipEntry(ent) {
  try {
    const mode = (Number(ent?.attr) >>> 16) & 0xffff
    return (mode & 0o170000) === 0o120000
  } catch {
    return false
  }
}

function sanitizeZipEntryName(entryName) {
  const raw = String(entryName || '').replace(/\\/g, '/')
  if (!raw || raw.includes('\0') || raw.startsWith('/')) return null
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, '')
  if (!normalized || normalized === '.' || normalized === '..') return null
  if (normalized.startsWith('../') || normalized.includes('/../')) return null
  return normalized
}

function extractZipSafeToTemp(zip, tmpDir) {
  const entries = zip.getEntries()
  if (!Array.isArray(entries) || entries.length === 0) {
    return { success: false, error: 'ZIP 内容为空' }
  }
  let fileCount = 0
  let totalSize = 0
  for (const ent of entries) {
    const safeRel = sanitizeZipEntryName(ent.entryName)
    if (!safeRel) {
      return { success: false, error: `ZIP 含非法路径: ${String(ent.entryName || '')}` }
    }
    if (isSymlinkZipEntry(ent)) {
      return { success: false, error: `ZIP 不允许符号链接: ${safeRel}` }
    }
    const abs = path.resolve(path.join(tmpDir, safeRel))
    if (!isPathInside(tmpDir, abs)) {
      return { success: false, error: `ZIP 路径越界: ${safeRel}` }
    }
    if (ent.isDirectory) {
      fs.mkdirSync(abs, { recursive: true })
      continue
    }
    fileCount += 1
    if (fileCount > ZIP_MAX_FILES) {
      return { success: false, error: `ZIP 文件数超限（>${ZIP_MAX_FILES}）` }
    }
    const data = ent.getData()
    totalSize += data.length
    if (totalSize > ZIP_MAX_TOTAL_UNCOMPRESSED) {
      return {
        success: false,
        error: `ZIP 解压体积超限（>${Math.floor(ZIP_MAX_TOTAL_UNCOMPRESSED / 1024 / 1024)}MB）`
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
  }
  return { success: true }
}

function installHelloSample() {
  ensureWebAppsRoot()
  if (!fs.existsSync(TEMPLATE_DIR)) {
    return { success: false, error: '内置模板缺失' }
  }
  const manifest = readManifestJson(TEMPLATE_DIR)
  const v = validateMvpManifest(manifest, { checkHostVersion: true })
  if (!v.ok) return { success: false, error: v.error || '模板 manifest 无效' }
  const { id, version } = v.normalized
  const dest = path.join(getWebAppsRoot(), id, version)
  if (fs.existsSync(path.join(dest, 'manifest.json'))) {
    return { success: true, skipped: true, id, version, path: dest }
  }
  try {
    copyDirRecursive(TEMPLATE_DIR, dest)
    return { success: true, id, version, path: dest }
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
}

function importFromZip(zipPath) {
  const AdmZip = require('adm-zip')
  ensureWebAppsRoot()
  const zip = new AdmZip(zipPath)
  const tmp = path.join(require('os').tmpdir(), `openultron-webapp-import-${Date.now()}`)
  fs.mkdirSync(tmp, { recursive: true })
  const extractResult = extractZipSafeToTemp(zip, tmp)
  if (!extractResult.success) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
    return { success: false, error: extractResult.error || 'ZIP 解压失败' }
  }
  const manifestPath = path.join(tmp, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
    return { success: false, error: 'ZIP 根目录缺少 manifest.json' }
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
    return { success: false, error: 'manifest.json 解析失败' }
  }
  const v = validateMvpManifest(manifest, { checkHostVersion: true })
  if (!v.ok) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
    return { success: false, error: v.error || 'manifest 校验失败' }
  }
  const { id, version } = v.normalized
  const root = ensureWebAppsRoot()
  const dest = path.resolve(path.join(root, id, version))
  if (!isPathInside(root, dest)) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
    return { success: false, error: '导入目标路径非法（越界）' }
  }
  if (fs.existsSync(dest)) {
    try {
      fs.rmSync(dest, { recursive: true, force: true })
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
      return { success: false, error: `无法覆盖已存在目录: ${e.message}` }
    }
  }
  try {
    copyDirRecursive(tmp, dest)
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
    return { success: false, error: e.message || String(e) }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
  let npmResult = null
  try {
    const { runNpmInstallIfNeeded, hasPackageJson } = require('./npm-install')
    const m = readManifestJson(dest)
    if (hasPackageJson(dest) && m && m.npm && m.npm.allowScripts === true) {
      const { dialog } = require('electron')
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['继续导入并执行脚本', '取消导入'],
        defaultId: 1,
        cancelId: 1,
        title: '安全确认',
        message: '该应用声明 npm.allowScripts=true',
        detail:
          '导入后将允许 npm 生命周期脚本执行（可能运行任意代码）。仅在你信任此 ZIP 来源时继续。'
      })
      if (choice !== 0) {
        try { fs.rmSync(dest, { recursive: true, force: true }) } catch (_) {}
        return {
          success: false,
          error: '用户取消：未允许执行 npm 脚本',
          id,
          version,
          path: dest
        }
      }
    }
    npmResult = runNpmInstallIfNeeded(dest, m || {})
    if (hasPackageJson(dest) && npmResult && npmResult.success === false && !npmResult.skipped) {
      return {
        success: false,
        error: npmResult.message || 'npm 安装失败',
        npm: npmResult,
        id,
        version,
        path: dest
      }
    }
  } catch (e) {
    return {
      success: false,
      error: e.message || String(e),
      id,
      version,
      path: dest
    }
  }
  try {
    require('./guest-session').invalidateManifestNetCache(id, version)
  } catch (_) {}
  return {
    success: true,
    id,
    version,
    path: dest,
    npm: npmResult
  }
}

function exportToZip(id, version) {
  const AdmZip = require('adm-zip')
  const { dialog } = require('electron')
  const os = require('os')
  const dir = path.join(getWebAppsRoot(), id, version)
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    return { success: false, error: '应用不存在或缺少 manifest' }
  }
  const zip = new AdmZip()
  const walk = (sub) => {
    const abs = sub ? path.join(dir, sub) : dir
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue
      const rel = sub ? `${sub}/${ent.name}` : ent.name
      const fp = path.join(dir, rel)
      if (ent.isDirectory()) walk(rel)
      else zip.addFile(rel.split(path.sep).join('/'), fs.readFileSync(fp))
    }
  }
  walk('')
  zip.addFile(
    'meta.json',
    Buffer.from(
      JSON.stringify(
        {
          type: 'web-app-pack',
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          appId: id,
          appVersion: version
        },
        null,
        2
      ),
      'utf-8'
    )
  )
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const defaultPath = path.join(os.homedir(), 'Desktop', `web-app-${id}-${version}-${ts}.zip`)
  return new Promise((resolve) => {
    dialog
      .showSaveDialog({
        title: '导出应用',
        defaultPath,
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      })
      .then(({ canceled, filePath }) => {
        if (canceled || !filePath) return resolve({ success: false, message: 'canceled' })
        zip.writeZip(filePath)
        resolve({ success: true, savePath: filePath })
      })
      .catch((e) => resolve({ success: false, error: e.message }))
  })
}

function getCatalogRepoConfig() {
  return {
    repoUrl: 'https://github.com/TerraRoot3/openultron-apps.git',
    branch: 'main',
    catalogAppsRoot: 'apps'
  }
}

function execGit(args, cwd) {
  return String(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim()
}

function getWebAppsCatalogCacheRoot() {
  const root = getAppRootPath('web-apps-catalog-cache')
  fs.mkdirSync(root, { recursive: true })
  return root
}

function getCatalogRepoDir(repoUrl) {
  const key = crypto.createHash('sha1').update(String(repoUrl || '')).digest('hex').slice(0, 12)
  return path.join(getWebAppsCatalogCacheRoot(), key)
}

function ensureRepoPulled() {
  const cfg = getCatalogRepoConfig()
  const repoDir = getCatalogRepoDir(cfg.repoUrl)
  const hasGitDir = fs.existsSync(path.join(repoDir, '.git'))
  try {
    if (!hasGitDir) {
      fs.mkdirSync(path.dirname(repoDir), { recursive: true })
      execGit(['clone', '--depth', '1', '--branch', cfg.branch, cfg.repoUrl, repoDir], process.cwd())
      try { execGit(['fetch', '--tags', 'origin'], repoDir) } catch (_) {}
      execGit(['checkout', '-B', cfg.branch, `origin/${cfg.branch}`], repoDir)
      execGit(['reset', '--hard', `origin/${cfg.branch}`], repoDir)
      // 清理缓存仓库中的未跟踪残留目录，避免远端已删除应用仍出现在列表
      execGit(['clean', '-fd'], repoDir)
    } else {
      execGit(['fetch', '--depth', '1', 'origin', cfg.branch], repoDir)
      try { execGit(['fetch', '--tags', 'origin'], repoDir) } catch (_) {}
      execGit(['checkout', '-B', cfg.branch, `origin/${cfg.branch}`], repoDir)
      execGit(['reset', '--hard', `origin/${cfg.branch}`], repoDir)
      // 清理缓存仓库中的未跟踪残留目录，避免远端已删除应用仍出现在列表
      execGit(['clean', '-fd'], repoDir)
    }
    const commit = execGit(['rev-parse', 'HEAD'], repoDir)
    return { success: true, repoDir, ...cfg, commit }
  } catch (e) {
    return { success: false, repoDir, ...cfg, error: `git 拉取失败: ${e.message || String(e)}` }
  }
}

function parseOfficialTagVersion(appId, tagName) {
  const raw = String(tagName || '').trim()
  const prefix = `${appId}/v`
  if (!raw.startsWith(prefix)) return null
  const v = raw.slice(prefix.length).trim()
  return semver.valid(v) ? v : null
}

function listOfficialTagsForApp(repoDir, appId) {
  let lines = ''
  try {
    lines = execGit(['tag', '--list', `${appId}/v*`], repoDir)
  } catch (e) {
    return { success: false, error: `读取 tag 失败: ${e.message || String(e)}`, tags: [] }
  }
  const tags = String(lines || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: parseOfficialTagVersion(appId, tag) }))
    .filter((x) => !!x.version)
    .sort((a, b) => semver.rcompare(a.version, b.version))
  return { success: true, tags }
}

function getInstalledAppVersionDir(appId, version) {
  const root = ensureWebAppsRoot()
  const dir = path.resolve(path.join(root, String(appId || ''), String(version || '')))
  if (!isPathInside(root, dir)) return ''
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return ''
  return dir
}

function maybeBackfillCatalogSourceMeta(repoDir, appId, installedVersion, latestTag) {
  const ver = String(installedVersion || '').trim()
  if (!appId || !ver) return
  const dir = getInstalledAppVersionDir(appId, ver)
  if (!dir) return
  const meta = readSourceMeta(dir)
  if (meta && meta.source) return

  // 仅在“已安装版本属于该 app 的官方 tag 版本”时回填，避免把同名本地应用误标为远端
  const listed = listOfficialTagsForApp(repoDir, appId)
  if (!listed.success || !Array.isArray(listed.tags) || listed.tags.length === 0) return
  const hasExact = listed.tags.some((t) => String(t.version || '') === ver)
  if (!hasExact) return

  writeSourceMeta(dir, {
    source: 'catalog',
    appId,
    tag: String(latestTag || ''),
    repo: getCatalogRepoConfig().repoUrl,
    backfilledAt: new Date().toISOString()
  })
}

function getInstalledLatestVersionMap() {
  const installed = listInstalledApps()
  const byAppId = {}
  for (const item of installed) {
    const id = String(item.id || '').trim()
    const ver = String(item.version || '').trim()
    if (!id || !ver) continue
    if (!byAppId[id]) {
      byAppId[id] = ver
      continue
    }
    const cur = byAppId[id]
    if (semver.valid(ver) && semver.valid(cur)) {
      if (semver.gt(ver, cur)) byAppId[id] = ver
    } else if (ver > cur) {
      byAppId[id] = ver
    }
  }
  return byAppId
}

function installAppFromSourceDir(sourceDir, options = {}) {
  const manifest = readManifestJson(sourceDir)
  const v = validateMvpManifest(manifest, { checkHostVersion: true })
  if (!v.ok) return { success: false, error: v.error || 'manifest 校验失败' }
  const { id, version } = v.normalized
  const root = ensureWebAppsRoot()
  const dest = path.resolve(path.join(root, id, version))
  if (!isPathInside(root, dest)) return { success: false, error: '安装目标路径非法（越界）' }
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    copyDirRecursive(sourceDir, dest)
    writeSourceMeta(dest, options.sourceMeta || { source: 'local' })
    require('./guest-session').invalidateManifestNetCache(id, version)
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
  return { success: true, id, version, path: dest }
}

function installCatalogAppByTag(repoDir, root, appId, tag) {
  const rel = `${root}/${appId}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openultron-webapp-tag-'))
  const tarPath = path.join(tmp, 'src.tar')
  try {
    const archiveBuf = execFileSync('git', ['archive', tag, rel], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    fs.writeFileSync(tarPath, archiveBuf)
    execFileSync('tar', ['-xf', tarPath, '-C', tmp], { stdio: ['ignore', 'pipe', 'pipe'] })
    const sourceDir = path.resolve(tmp, rel)
    return installAppFromSourceDir(sourceDir, {
      sourceMeta: {
        source: 'catalog',
        appId,
        tag,
        repo: getCatalogRepoConfig().repoUrl
      }
    })
  } catch (e) {
    return { success: false, error: `安装失败: ${e.message || String(e)}` }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}
  }
}

function listRemoteCatalogApps() {
  const pulled = ensureRepoPulled()
  if (!pulled.success) return { ...pulled, apps: [] }
  const appsRoot = path.resolve(pulled.repoDir, pulled.catalogAppsRoot)
  if (!isPathInside(pulled.repoDir, appsRoot) || !fs.existsSync(appsRoot)) {
    return { success: false, error: `未找到 catalog 目录: ${pulled.catalogAppsRoot}`, apps: [] }
  }
  const installedMap = getInstalledLatestVersionMap()
  const dirs = fs.readdirSync(appsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const apps = dirs.map((appId) => {
    const listed = listOfficialTagsForApp(pulled.repoDir, appId)
    const latest = listed.success && listed.tags[0] ? listed.tags[0] : null
    const installedVersion = installedMap[appId] || ''
    const hasUpdate = !!(latest && (!semver.valid(installedVersion) || semver.gt(latest.version, installedVersion)))
    return {
      appId,
      installedVersion,
      latestVersion: latest?.version || '',
      latestTag: latest?.tag || '',
      hasOfficialRelease: !!latest,
      hasUpdate
    }
  }).filter((x) => x.hasOfficialRelease)
  return { success: true, apps, commit: pulled.commit }
}

function installRemoteApps(payload = {}) {
  const pulled = ensureRepoPulled()
  if (!pulled.success) return { ...pulled, items: [] }
  const listed = listRemoteCatalogApps()
  if (!listed.success) return { success: false, error: listed.error || '读取远端应用失败', items: [] }
  const wantedIds = Array.isArray(payload.appIds)
    ? [...new Set(payload.appIds.map((x) => String(x || '').trim()).filter(Boolean))]
    : []
  const targets = payload.all === true ? listed.apps : listed.apps.filter((a) => wantedIds.includes(a.appId))
  const items = []
  for (const app of targets) {
    if (!app.hasOfficialRelease || !app.latestTag) {
      items.push({ appId: app.appId, success: false, error: '无正式版 tag' })
      continue
    }
    const r = installCatalogAppByTag(pulled.repoDir, pulled.catalogAppsRoot, app.appId, app.latestTag)
    items.push({ appId: app.appId, latestVersion: app.latestVersion, latestTag: app.latestTag, ...r })
  }
  return { success: true, items }
}

function checkRemoteUpdates(payload = {}) {
  const listed = listRemoteCatalogApps()
  if (!listed.success) return { success: false, error: listed.error || '检查更新失败', items: [] }
  const pulled = ensureRepoPulled()
  if (pulled.success) {
    for (const app of listed.apps) {
      maybeBackfillCatalogSourceMeta(pulled.repoDir, app.appId, app.installedVersion, app.latestTag)
    }
  }
  // 仅返回“本地已安装”的应用更新状态；未安装项不应出现在检查更新列表中
  const installedOnly = listed.apps.filter((x) => String(x?.installedVersion || '').trim())
  // 无正式版 tag 的应用不参与更新
  const releaseOnly = installedOnly.map((x) => ({
    ...x,
    hasUpdate: x.hasOfficialRelease ? !!x.hasUpdate : false
  }))
  const wantedIds = Array.isArray(payload.appIds)
    ? [...new Set(payload.appIds.map((x) => String(x || '').trim()).filter(Boolean))]
    : []
  const items = wantedIds.length > 0 ? releaseOnly.filter((a) => wantedIds.includes(a.appId)) : releaseOnly
  return { success: true, items }
}

function updateRemoteApps(payload = {}) {
  const checked = checkRemoteUpdates(payload)
  if (!checked.success) return { success: false, error: checked.error || '检查更新失败', items: [] }
  const targets = payload.all === true
    ? checked.items.filter((x) => x.hasUpdate)
    : checked.items.filter((x) => x.hasUpdate)
  return installRemoteApps({ appIds: targets.map((x) => x.appId), all: false })
}

function parseGitHubRepo(repoUrl) {
  const src = String(repoUrl || '').trim()
  if (!src) return { owner: '', repo: '' }
  let m = src.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i)
  if (m) return { owner: m[1], repo: m[2] }
  m = src.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i)
  if (m) return { owner: m[1], repo: m[2] }
  return { owner: '', repo: '' }
}

function sanitizeBranchFragment(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function publishWebAppToCatalog(payload = {}) {
  const id = String(payload.id || '').trim()
  const version = String(payload.version || '').trim()
  if (!id || !version) return { success: false, error: '缺少 id 或 version' }
  if (!semver.valid(version)) {
    return { success: false, error: '发布版本必须是标准语义化版本（如 0.2.0）' }
  }
  const root = ensureWebAppsRoot()
  const localDir = path.resolve(path.join(root, id, version))
  if (!isPathInside(root, localDir) || !fs.existsSync(path.join(localDir, 'manifest.json'))) {
    return { success: false, error: '本地应用不存在' }
  }
  const pulled = ensureRepoPulled()
  if (!pulled.success) return { success: false, error: pulled.error || '拉取仓库失败' }
  const released = listOfficialTagsForApp(pulled.repoDir, id)
  if (!released.success) return { success: false, error: released.error || '读取远端版本失败' }
  const latest = released.tags && released.tags[0] ? released.tags[0] : null
  const installedLatestMap = getInstalledLatestVersionMap()
  const installedLatest = String(installedLatestMap[id] || '').trim()
  if (latest && latest.version && semver.valid(installedLatest) && semver.lt(installedLatest, latest.version)) {
    return {
      success: false,
      error: `检测到远端已有更新版本 ${latest.version}，请先安装最新正式版后再修改发布`
    }
  }
  if (latest && latest.version && !semver.gt(version, latest.version)) {
    return { success: false, error: `版本号需递增：当前远端最新正式版为 ${latest.version}，请先提升本地版本` }
  }
  const repoDir = pulled.repoDir
  const targetDir = path.resolve(path.join(repoDir, pulled.catalogAppsRoot, id))
  if (!isPathInside(repoDir, targetDir)) return { success: false, error: '目标目录非法（越界）' }
  const branch = `publish/${sanitizeBranchFragment(id)}/v${sanitizeBranchFragment(version)}-${Date.now().toString(36)}`
  try {
    execGit(['checkout', '-B', branch, `origin/${pulled.branch}`], repoDir)
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true })
    copyDirRecursive(localDir, targetDir)
    execGit(['add', '-A', path.relative(repoDir, targetDir)], repoDir)
    try {
      const staged = execGit(['diff', '--cached', '--name-only'], repoDir)
      if (!staged) return { success: false, error: '没有可发布改动' }
    } catch (_) {}
    execGit(['commit', '-m', `publish(${id}): ${version}`], repoDir)
    execGit(['push', '-u', 'origin', branch], repoDir)
  } catch (e) {
    return { success: false, error: `发布提交失败: ${e.message || String(e)}` }
  }
  const ghRepo = parseGitHubRepo(pulled.repoUrl)
  if (!ghRepo.owner || !ghRepo.repo) {
    return { success: false, error: '仅支持 GitHub 仓库自动创建 PR' }
  }
  try {
    const title = `Publish ${id} ${version}`
    const body = `## Summary\n- publish ${id}@${version} to catalog\n`
    const prUrl = execFileSync(
      'gh',
      ['pr', 'create', '--repo', `${ghRepo.owner}/${ghRepo.repo}`, '--base', pulled.branch, '--head', branch, '--title', title, '--body', body],
      { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString().trim()
    // 持久化“审核中”状态，跨重启仍可展示
    const prev = readSourceMeta(localDir)
    writeSourceMeta(localDir, {
      ...prev,
      source: prev.source || 'local',
      publishState: 'reviewing',
      publishBranch: branch,
      publishPrUrl: prUrl,
      publishVersion: version,
      publishSubmittedAt: new Date().toISOString()
    })
    return { success: true, branch, prUrl }
  } catch (e) {
    return { success: false, error: `创建 PR 失败: ${e.message || String(e)}`, branch }
  }
}

function registerWebAppsIpc(registerChannel) {
  registerChannel('web-apps-list', () => {
    try {
      return { success: true, apps: listInstalledApps() }
    } catch (e) {
      return { success: false, error: e.message || String(e), apps: [] }
    }
  })

  registerChannel('web-apps-get', async (event, { id, version, ensureService = true } = {}) => {
    const dir = path.join(getWebAppsRoot(), String(id || ''), String(version || ''))
    const manifest = readManifestJson(dir)
    const v = validateMvpManifest(manifest)
    if (!v.ok) return { success: false, error: v.error || '未找到应用' }
    let previewUrl = getPreviewUrlForApp(v.normalized, dir)
    let service = { success: true, status: 'stopped', running: false }
    if (ensureService !== false) {
      const started = await ensureWebAppService(v.normalized, dir)
      if (started && started.success && started.url) {
        previewUrl = started.url
      } else if (started && started.error) {
        // 自定义服务启动失败时，自动回退到内置静态服务，避免直接访问 html
        const fallbackManifest = { ...v.normalized, entry: { ...(v.normalized.entry || {}) } }
        delete fallbackManifest.entry.service
        const fallback = await ensureWebAppService(fallbackManifest, dir)
        if (fallback && fallback.success && fallback.url) {
          previewUrl = fallback.url
          service = {
            ...fallback,
            warning: `自定义服务启动失败，已回退内置静态服务：${started.error}`
          }
        } else {
          service = { ...started, running: false }
        }
      }
    }
    if (!service || !service.running) {
      service = getWebAppServiceStatus(v.normalized.id, v.normalized.version)
      if (service && service.url && service.running) previewUrl = service.url
    }
    return {
      success: true,
      path: dir,
      manifest: v.normalized,
      previewUrl,
      service
    }
  })

  registerChannel('web-apps-preview-url', async (event, { id, version, ensureService = true } = {}) => {
    const dir = path.join(getWebAppsRoot(), String(id || ''), String(version || ''))
    const manifest = readManifestJson(dir)
    const v = validateMvpManifest(manifest)
    if (!v.ok) return { success: false, error: v.error || '无效应用' }
    if (ensureService !== false) {
      const started = await ensureWebAppService(v.normalized, dir)
      if (started && started.success && started.url) {
        return { success: true, previewUrl: started.url, service: started }
      }
      if (started && started.error) {
        const fallbackManifest = { ...v.normalized, entry: { ...(v.normalized.entry || {}) } }
        delete fallbackManifest.entry.service
        const fallback = await ensureWebAppService(fallbackManifest, dir)
        if (fallback && fallback.success && fallback.url) {
          return {
            success: true,
            previewUrl: fallback.url,
            service: {
              ...fallback,
              warning: `自定义服务启动失败，已回退内置静态服务：${started.error}`
            }
          }
        }
        return {
          success: true,
          previewUrl: getPreviewUrlForApp(v.normalized, dir),
          service: { ...started, running: false }
        }
      }
    }
    const svc = getWebAppServiceStatus(v.normalized.id, v.normalized.version)
    if (svc && svc.running && svc.url) {
      return { success: true, previewUrl: svc.url, service: svc }
    }
    return { success: true, previewUrl: getPreviewUrlForApp(v.normalized, dir), service: svc }
  })

  registerChannel('web-apps-service-start', async (event, { id, version } = {}) => {
    const dir = path.join(getWebAppsRoot(), String(id || ''), String(version || ''))
    const manifest = readManifestJson(dir)
    const v = validateMvpManifest(manifest)
    if (!v.ok) return { success: false, error: v.error || '无效应用' }
    return await ensureWebAppService(v.normalized, dir)
  })

  registerChannel('web-apps-service-status', (event, { id, version } = {}) => {
    return getWebAppServiceStatus(String(id || ''), String(version || ''))
  })

  registerChannel('web-apps-service-stop', (event, { id, version } = {}) => {
    return stopWebAppService(String(id || ''), String(version || ''))
  })

  registerChannel('web-apps-service-logs', (event, { id, version } = {}) => {
    return getWebAppServiceLogs(String(id || ''), String(version || ''))
  })

  registerChannel('web-apps-install-sample', () => installHelloSample())

  registerChannel('web-apps-list-remote', () => {
    try {
      return listRemoteCatalogApps()
    } catch (e) {
      return { success: false, error: e.message || String(e), apps: [] }
    }
  })

  registerChannel('web-apps-install-remote', (event, payload = {}) => {
    try {
      return installRemoteApps(payload || {})
    } catch (e) {
      return { success: false, error: e.message || String(e), items: [] }
    }
  })

  registerChannel('web-apps-check-updates', (event, payload = {}) => {
    try {
      return checkRemoteUpdates(payload || {})
    } catch (e) {
      return { success: false, error: e.message || String(e), items: [] }
    }
  })

  registerChannel('web-apps-update-remote', (event, payload = {}) => {
    try {
      return updateRemoteApps(payload || {})
    } catch (e) {
      return { success: false, error: e.message || String(e), items: [] }
    }
  })

  registerChannel('web-apps-publish', (event, payload = {}) => {
    try {
      return publishWebAppToCatalog(payload || {})
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  })

  registerChannel('web-apps-create', (event, payload = {}) => {
    try {
      const name = payload && typeof payload.name === 'string' ? payload.name : undefined
      const description = payload && typeof payload.description === 'string' ? payload.description : undefined
      const projectName = payload && typeof payload.projectName === 'string' ? payload.projectName : undefined
      return createBlankWebApp({ name, description, projectName })
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  })

  registerChannel('web-apps-import-zip', async (event, { filePath } = {}) => {
    const { dialog } = require('electron')
    let zipPath = filePath
    if (!zipPath) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择应用 ZIP',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (canceled || !filePaths.length) return { success: false, message: 'canceled' }
      zipPath = filePaths[0]
    }
    return importFromZip(zipPath)
  })

  registerChannel('web-apps-export-zip', async (event, { id, version }) => {
    return exportToZip(String(id || ''), String(version || ''))
  })

  registerChannel('web-apps-delete', (event, { id, version } = {}) => {
    try {
      const appId = String(id || '').trim()
      const appVersion = String(version || '').trim()
      if (!appId || !appVersion) return { success: false, error: '缺少 id 或 version' }

      const root = path.resolve(ensureWebAppsRoot())
      const appDir = path.resolve(path.join(root, appId))
      const versionDir = path.resolve(path.join(appDir, appVersion))
      if (!isPathInside(root, versionDir)) return { success: false, error: '删除路径非法（越界）' }
      if (!fs.existsSync(path.join(versionDir, 'manifest.json'))) {
        return { success: false, error: '应用不存在或已删除' }
      }

      // 若服务在跑，先停掉
      try { stopWebAppService(appId, appVersion) } catch (_) {}

      fs.rmSync(versionDir, { recursive: true, force: true })

      // 清理空应用目录
      let removedAppDir = false
      try {
        if (fs.existsSync(appDir)) {
          // 仅统计“版本目录（含 manifest）”；若一个都没有，整个 app 目录删掉（强制）
          const versionDirs = fs.readdirSync(appDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(appDir, d.name))
          const validVersions = versionDirs.filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
          if (validVersions.length === 0) {
            fs.rmSync(appDir, { recursive: true, force: true })
            removedAppDir = true
          }
        }
      } catch (_) {}

      return { success: true, id: appId, version: appVersion, removedAppDir }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  })
}

/**
 * 更新应用展示名（manifest.json 的 `name`）。
 * 单独导出并由 main.js 显式 registerChannel，避免仅热更新渲染进程时主进程未加载 registry 内全部 handler。
 * @param {{ id?: string, version?: string, name?: string }} payload
 */
function updateWebAppDisplayName(payload = {}) {
  try {
    const { id, version, name } = payload || {}
    const rawName = String(name ?? '').trim()
    if (!rawName) return { success: false, error: '名称不能为空' }
    const idStr = String(id || '').trim()
    const verStr = String(version || '').trim()
    if (!idStr || !verStr) return { success: false, error: '缺少 appId 或 version' }
    const rootResolved = path.resolve(ensureWebAppsRoot())
    const dir = path.join(getWebAppsRoot(), idStr, verStr)
    const dirResolved = path.resolve(dir)
    if (!dirResolved.startsWith(rootResolved + path.sep)) {
      return { success: false, error: '无效应用路径' }
    }
    if (!fs.existsSync(dirResolved)) return { success: false, error: '应用目录不存在' }
    const manifest = readManifestJson(dirResolved)
    if (!manifest) return { success: false, error: '未找到 manifest.json' }
    const v = validateMvpManifest(manifest)
    if (!v.ok) return { success: false, error: v.error || 'manifest 无效' }
    if (v.normalized.id !== idStr) return { success: false, error: '应用 id 不一致' }
    if (v.normalized.version !== verStr) return { success: false, error: '版本不一致' }
    const next = { ...manifest, name: rawName }
    const v2 = validateMvpManifest(next)
    if (!v2.ok) return { success: false, error: v2.error || '更新后 manifest 校验失败' }
    fs.writeFileSync(path.join(dirResolved, 'manifest.json'), JSON.stringify(v2.normalized, null, 2), 'utf-8')
    return {
      success: true,
      path: dirResolved,
      manifest: v2.normalized,
      previewUrl: getPreviewUrlForApp(v2.normalized, dirResolved)
    }
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
}

module.exports = {
  getWebAppsRoot,
  ensureWebAppsRoot,
  validateMvpManifest,
  readManifestJson,
  listInstalledApps,
  getPreviewUrlForApp,
  installHelloSample,
  listRemoteCatalogApps,
  installRemoteApps,
  checkRemoteUpdates,
  updateRemoteApps,
  publishWebAppToCatalog,
  importFromZip,
  exportToZip,
  createBlankWebApp,
  registerWebAppsIpc,
  updateWebAppDisplayName
}
