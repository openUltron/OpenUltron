/**
 * 命令执行单独存储：不写入对话消息，仅用于按命令聚合查看过的目录/文件，并供 AI 工具查询以支持后续进化。
 * 历史消息里只在「进行中」展示命令执行情况，保存时剥离。
 */
const path = require('path')
const fs = require('fs')
const { getAppRootPath } = require('../app-root')

// 新结构：
// ~/.openultron/command-execution-log/
//   ├─ 2026-03-19.jsonl
//   ├─ 2026-03-20.jsonl
//   └─ SUMMARY.md
// 旧结构兼容读取：~/.openultron/command-execution-log.json
const LOG_DIR = getAppRootPath('command-execution-log')
const LEGACY_LOG_FILE = getAppRootPath('command-execution-log.json')
const SUMMARY_FILE = path.join(LOG_DIR, 'SUMMARY.md')
const MAX_ENTRIES_PER_PROJECT = 2000
const RETAIN_DAYS = 90
const SUMMARY_WINDOW_DAYS = 30

function hashProjectKey(projectPath) {
  if (!projectPath) return '__general__'
  let h = 0
  for (let i = 0; i < projectPath.length; i++) {
    h = (Math.imul(31, h) + projectPath.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(16).padStart(8, '0')
}

/** 从命令字符串中尽量提取可能涉及的文件/目录路径（用于聚合） */
function extractPathsFromCommand(command, cwd) {
  const dirs = new Set()
  const files = new Set()
  if (cwd) dirs.add(cwd)
  if (!command || typeof command !== 'string') return { directories: [...dirs], files: [...files] }
  // 常见模式：cat path, grep x path, head/tail -n path, ls path, find path, cd path
  const tokens = command.split(/\s+/).filter(Boolean)
  const pathLike = /^[./~]|\.(js|ts|vue|json|md|py|html|css|mjs|cjs)$/i
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-n' || t === '-c' || t === '-A' || t === '-B' || t === '-l') continue
    const normalized = t.replace(/^['"]|['"]$/g, '')
    if (normalized.includes('/') || pathLike.test(normalized)) {
      if (/\.(js|ts|vue|json|md|py|html|css|mjs|cjs)$/i.test(normalized)) {
        files.add(normalized)
      } else {
        dirs.add(normalized)
      }
    }
  }
  return { directories: [...dirs], files: [...files] }
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
}

function currentDateKey() {
  return new Date().toISOString().slice(0, 10)
}

function dailyLogPath(dateKey) {
  return path.join(LOG_DIR, `${dateKey}.jsonl`)
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function readJsonlEntries(filePath) {
  try {
    if (!fs.existsSync(filePath)) return []
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (!raw.trim()) return []
    const lines = raw.split('\n').filter(Boolean)
    return lines.map(parseJsonLine).filter(Boolean)
  } catch {
    return []
  }
}

function listDailyFiles() {
  ensureLogDir()
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort() // asc
  } catch {
    return []
  }
}

function readLegacyByProject() {
  try {
    if (!fs.existsSync(LEGACY_LOG_FILE)) return {}
    const raw = fs.readFileSync(LEGACY_LOG_FILE, 'utf-8')
    const data = JSON.parse(raw)
    const byProject = data && typeof data === 'object' && data.byProject && typeof data.byProject === 'object'
      ? data.byProject
      : {}
    return byProject
  } catch {
    return {}
  }
}

function readProjectEntries(projectPath) {
  const key = hashProjectKey(projectPath)
  const out = []

  // 读取新结构（日志按日期）
  const dailyFiles = listDailyFiles()
  for (let i = dailyFiles.length - 1; i >= 0; i--) {
    const fp = path.join(LOG_DIR, dailyFiles[i])
    const dayEntries = readJsonlEntries(fp)
    for (let j = dayEntries.length - 1; j >= 0; j--) {
      const e = dayEntries[j]
      if (!e || e.projectKey !== key) continue
      out.push({
        toolName: e.toolName,
        command: e.command,
        cwd: e.cwd,
        success: e.success === true,
        exitCode: e.exitCode,
        ts: Number(e.ts || 0),
        sessionId: e.sessionId
      })
      if (out.length >= MAX_ENTRIES_PER_PROJECT) return out
    }
  }

  // 兼容旧结构（作为补充）
  const legacy = readLegacyByProject()
  const legacyProj = legacy[key]
  if (legacyProj && Array.isArray(legacyProj.entries)) {
    for (const e of legacyProj.entries) {
      out.push({
        toolName: e.toolName,
        command: e.command,
        cwd: e.cwd,
        success: e.success === true,
        exitCode: e.exitCode,
        ts: Number(e.ts || 0),
        sessionId: e.sessionId
      })
      if (out.length >= MAX_ENTRIES_PER_PROJECT) break
    }
  }
  return out.slice(0, MAX_ENTRIES_PER_PROJECT)
}

function pruneOldDailyFiles() {
  const files = listDailyFiles()
  if (!files.length) return
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000
  for (const name of files) {
    const dateStr = name.replace(/\.jsonl$/, '')
    const ts = Date.parse(`${dateStr}T00:00:00.000Z`)
    if (!Number.isFinite(ts) || ts >= cutoff) continue
    try { fs.unlinkSync(path.join(LOG_DIR, name)) } catch (_) {}
  }
}

function readAllRecentEntries(days = SUMMARY_WINDOW_DAYS) {
  const files = listDailyFiles()
  if (!files.length) return []
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const out = []
  for (let i = files.length - 1; i >= 0; i--) {
    const name = files[i]
    const dateStr = name.replace(/\.jsonl$/, '')
    const ts = Date.parse(`${dateStr}T00:00:00.000Z`)
    if (Number.isFinite(ts) && ts < cutoff) break
    const fp = path.join(LOG_DIR, name)
    const rows = readJsonlEntries(fp)
    out.push(...rows)
  }
  return out
}

function writeSummaryMarkdown() {
  ensureLogDir()
  const rows = readAllRecentEntries(SUMMARY_WINDOW_DAYS)
  const byProject = new Map()
  for (const r of rows) {
    const key = String(r.projectKey || '__general__')
    if (!byProject.has(key)) {
      byProject.set(key, {
        projectPath: String(r.projectPath || ''),
        total: 0,
        success: 0,
        failed: 0,
        installs: new Map(),
        latest: []
      })
    }
    const p = byProject.get(key)
    p.total++
    if (r.success) p.success++
    else p.failed++
    const cmd = String(r.command || '').trim()
    if (/^\s*(npm|pnpm|yarn|pip3?|brew)\s+.*(install|add)\b/i.test(cmd) && r.success) {
      p.installs.set(cmd, (p.installs.get(cmd) || 0) + 1)
    }
    if (p.latest.length < 12) {
      p.latest.push({
        ts: Number(r.ts || 0),
        success: r.success === true,
        cwd: String(r.cwd || ''),
        command: cmd.slice(0, 180)
      })
    }
  }

  const lines = []
  lines.push('# Command Execution Summary')
  lines.push('')
  lines.push(`更新于：${new Date().toISOString()}`)
  lines.push(`统计窗口：最近 ${SUMMARY_WINDOW_DAYS} 天`)
  lines.push(`日志目录：${LOG_DIR}`)
  lines.push(`保留策略：按日文件，保留 ${RETAIN_DAYS} 天`)
  lines.push('')
  if (byProject.size === 0) {
    lines.push('暂无命令执行记录。')
  } else {
    for (const [, p] of byProject) {
      const title = p.projectPath || '(unknown project)'
      lines.push(`## ${title}`)
      lines.push(`- 总执行：${p.total}（成功 ${p.success} / 失败 ${p.failed}）`)
      const installRows = [...p.installs.entries()].slice(0, 8)
      lines.push('- 最近成功安装命令：')
      if (installRows.length) {
        for (const [cmd, c] of installRows) lines.push(`  - ${cmd} (${c} 次)`)
      } else {
        lines.push('  - 无')
      }
      lines.push('- 最近命令：')
      if (p.latest.length) {
        for (const e of p.latest) {
          const status = e.success ? '✓' : '✗'
          const t = e.ts ? new Date(e.ts).toISOString() : ''
          const cwd = e.cwd ? ` cwd=${e.cwd}` : ''
          lines.push(`  - [${status}] ${t}${cwd} ${e.command}`)
        }
      } else {
        lines.push('  - 无')
      }
      lines.push('')
    }
  }
  try {
    fs.writeFileSync(SUMMARY_FILE, lines.join('\n'), 'utf-8')
  } catch (_) {}
}

/**
 * 追加一条执行记录（成功/失败），并根据命令聚合目录与文件
 */
function append(projectPath, sessionId, payload) {
  ensureLogDir()
  const key = hashProjectKey(projectPath)
  const entry = {
    projectKey: key,
    projectPath: projectPath || '',
    toolName: payload.toolName,
    command: payload.command,
    cwd: payload.cwd,
    success: payload.success === true,
    exitCode: payload.exitCode,
    ts: Date.now(),
    sessionId: payload.sessionId || sessionId,
    date: currentDateKey()
  }
  try {
    const line = `${JSON.stringify(entry)}\n`
    fs.appendFileSync(dailyLogPath(entry.date), line, 'utf-8')
  } catch {
    // ignore
  }
  pruneOldDailyFiles()
  writeSummaryMarkdown()
}

/**
 * 按命令聚合：查看过哪些目录、哪些文件（去重）
 */
function getViewedPaths(projectPath) {
  const entries = readProjectEntries(projectPath)
  if (!entries.length) {
    return { directories: [], files: [], summary: { total: 0, success: 0, failed: 0 } }
  }
  const dirs = new Set()
  const files = new Set()
  let success = 0
  let failed = 0
  for (const e of entries) {
    if (e.success) success++
    else failed++
    if (e.toolName === 'execute_command' && (e.cwd || e.command)) {
      const { directories, files: f } = extractPathsFromCommand(e.command, e.cwd)
      directories.forEach(d => dirs.add(d))
      f.forEach(fi => files.add(fi))
    }
  }
  return {
    directories: [...dirs],
    files: [...files],
    summary: { total: entries.length, success, failed }
  }
}

/**
 * 执行统计：总数、成功/失败、按工具名聚合
 */
function getExecutionSummary(projectPath) {
  const entries = readProjectEntries(projectPath)
  if (!entries.length) {
    return { total: 0, success: 0, failed: 0, byTool: {} }
  }
  const byTool = {}
  let success = 0
  let failed = 0
  for (const e of entries) {
    if (!byTool[e.toolName]) byTool[e.toolName] = { total: 0, success: 0, failed: 0 }
    byTool[e.toolName].total++
    if (e.success) {
      success++
      byTool[e.toolName].success++
    } else {
      failed++
      byTool[e.toolName].failed++
    }
  }
  return {
    total: entries.length,
    success,
    failed,
    byTool
  }
}

/**
 * 获取最近执行记录（用于会话摘要与经验提炼：看了哪些命令、安装了什么、成功/失败）
 * @param {string} projectPath - 项目路径
 * @param {number} limit - 最多返回条数
 * @param {string} [sessionId] - 可选，仅返回该会话内的记录
 * @returns {{ entries: Array<{ command: string, cwd: string, success: boolean, toolName: string, exitCode?: number }> }}
 */
function getRecentEntries(projectPath, limit = 50, sessionId = null) {
  let list = readProjectEntries(projectPath)
  if (!list.length) {
    return { entries: [] }
  }
  if (sessionId && String(sessionId).trim()) {
    const sid = String(sessionId).trim()
    list = list.filter((e) => e.sessionId === sid)
  }
  const recent = list.slice(0, Math.min(limit, list.length))
  return {
    entries: recent.map((e) => ({
      command: e.command || '',
      cwd: e.cwd || '',
      success: e.success === true,
      toolName: e.toolName || 'execute_command',
      exitCode: e.exitCode
    }))
  }
}

module.exports = {
  append,
  getViewedPaths,
  getExecutionSummary,
  getRecentEntries,
  extractPathsFromCommand
}
