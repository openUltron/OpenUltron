/**
 * 应用统一日志：写入 ~/.openultron/logs/app.log
 * 格式统一、易读；仅将 warn/error 从 console 写入文件，减少噪音；显式 logger 全部落盘。
 */
const fs = require('fs')
const path = require('path')
const { getAppRootPath } = require('./app-root')

const LOG_DIR = getAppRootPath('logs')
const LOG_FILE = path.join(LOG_DIR, 'app.log')

/** 单条日志最大长度（字符），超出截断 */
const MAX_MESSAGE_LENGTH = 800

/** 将 level 格式化为固定 5 字符，便于对齐 */
function levelTag(level) {
  const s = (level || 'info').toUpperCase()
  if (s === 'DEBUG') return 'DBUG '
  return (s + '     ').slice(0, 5)
}

/** 将参数序列化为单行字符串，对象截断过长部分 */
function serializeArgs(args) {
  if (!args || args.length === 0) return ''
  const parts = args.map(arg => {
    if (arg == null) return String(arg)
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return arg.message
    if (typeof arg === 'object') {
      try {
        const str = JSON.stringify(arg, null, 2)
        if (str.length > MAX_MESSAGE_LENGTH) {
          return str.slice(0, MAX_MESSAGE_LENGTH) + '\n... (已截断)'
        }
        return str
      } catch {
        return Object.prototype.toString.call(arg)
      }
    }
    return String(arg)
  })
  const joined = parts.join(' ').replace(/\n/g, ' ') // 多行压成一行，避免一条 log 占多行（stack 单独处理）
  if (joined.length > MAX_MESSAGE_LENGTH) {
    return joined.slice(0, MAX_MESSAGE_LENGTH) + '... (已截断)'
  }
  return joined
}

/** 从 console 参数中提取 Error 的 stack（若有） */
function getStackFromArgs(args) {
  if (!args || !args.length) return undefined
  const err = args.find(a => a && typeof a === 'object' && a.stack)
  return err ? err.stack : undefined
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

/**
 * 统一格式：时间 LEVEL [module] 消息
 * level 固定 5 字符；stack 另起行并缩进 4 格。
 */
function formatLine(level, message, moduleName, stack) {
  const ts = new Date().toISOString()
  const tag = levelTag(level)
  const mod = moduleName ? ` [${moduleName}]` : ' '
  const msg = String(message).trim().replace(/\n/g, ' ')
  let line = `${ts} ${tag}${mod} ${msg}`
  if (stack && (level === 'error' || level === 'warn')) {
    const stackLines = stack.split('\n').map(l => '    ' + l.trim()).join('\n')
    line += '\n' + stackLines
  }
  return line
}

function write(level, message, options = {}) {
  const { module: moduleName, stack } = options
  ensureLogDir()
  const line = formatLine(level, String(message), moduleName, stack)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch (err) {
    try {
      if (typeof process !== 'undefined' && process.stdout && process.stdout.write) {
        process.stdout.write('[app-logger] write failed: ' + err.message + '\n')
      }
    } catch (_) {}
  }
}

function writeWithMeta(level, msg, opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    write(level, msg, {})
    return
  }
  const { module, stack, ...meta } = opts
  const metaText = Object.keys(meta).length ? ` ${serializeArgs([meta])}` : ''
  write(level, `${String(msg || '')}${metaText}`, { module, stack })
}

const logger = {
  debug: (msg, opts) => writeWithMeta('debug', msg, opts),
  info: (msg, opts) => writeWithMeta('info', msg, opts),
  warn: (msg, opts) => writeWithMeta('warn', msg, opts),
  error: (msg, opts) => writeWithMeta('error', msg, opts),
  /** 带 module 的快捷方法，便于各模块打日志 */
  module(moduleName) {
    return {
      debug: (msg, o) => writeWithMeta('debug', msg, { ...o, module: moduleName }),
      info: (msg, o) => writeWithMeta('info', msg, { ...o, module: moduleName }),
      warn: (msg, o) => writeWithMeta('warn', msg, { ...o, module: moduleName }),
      error: (msg, o) => writeWithMeta('error', msg, { ...o, module: moduleName })
    }
  }
}

/** 返回日志文件路径（供界面展示与「打开目录」） */
function getLogPath() {
  ensureLogDir()
  return LOG_FILE
}

/** 读取最后 N 行（从文件末尾往前读，返回字符串） */
function readTail(lines = 2000) {
  ensureLogDir()
  if (!fs.existsSync(LOG_FILE)) return ''
  const content = fs.readFileSync(LOG_FILE, 'utf8')
  const all = content.split('\n').filter(Boolean)
  const tail = all.slice(-Math.max(1, lines))
  return tail.join('\n')
}

/**
 * 供 AI 定位/分析问题：返回带说明的最近 N 行文本
 */
function getForAi(lines = 500) {
  const tail = readTail(lines)
  const header = `--- OpenUltron 应用日志（最近 ${lines} 行，供 AI 定位问题） ---`
  return tail ? header + '\n\n' + tail : header + '\n\n（暂无日志）'
}

/**
 * 仅将 console.warn / console.error 写入日志文件，避免 console.log 刷屏；
 * 控制台仍正常输出全部内容。
 */
function patchConsole() {
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
  const toFile = (level, args, stack) => {
    const msg = serializeArgs(args)
    if (msg) write(level, msg, { module: 'main', stack })
  }
  console.log = (...args) => {
    orig.log.apply(console, args)
  }
  console.info = (...args) => {
    orig.info.apply(console, args)
  }
  console.debug = (...args) => {
    if (orig.debug) orig.debug.apply(console, args)
  }
  console.warn = (...args) => {
    orig.warn.apply(console, args)
    toFile('warn', args, getStackFromArgs(args))
  }
  console.error = (...args) => {
    orig.error.apply(console, args)
    toFile('error', args, getStackFromArgs(args))
  }
}

module.exports = {
  logger,
  getLogPath,
  readTail,
  getForAi,
  patchConsole
}
