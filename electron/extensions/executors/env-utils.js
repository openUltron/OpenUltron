'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

function uniqueExistingDirs(list) {
  const out = []
  const seen = new Set()
  for (const raw of list || []) {
    const p = String(raw || '').trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    try {
      if (fs.existsSync(p)) out.push(p)
    } catch (_) {}
  }
  return out
}

function getUserBinPaths() {
  const home = process.env.HOME || os.homedir()
  const pyBins = uniqueExistingDirs([
    path.join(home, 'Library/Python/3.13/bin'),
    path.join(home, 'Library/Python/3.12/bin'),
    path.join(home, 'Library/Python/3.11/bin'),
    path.join(home, 'Library/Python/3.10/bin'),
    path.join(home, '.local/bin')
  ])
  const common = uniqueExistingDirs([
    path.join(home, '.cargo/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.bun/bin')
  ])
  return [...pyBins, ...common]
}

function getNodeManagerBinPaths() {
  const home = process.env.HOME || os.homedir()
  const nvmRoot = process.env.NVM_DIR || path.join(home, '.nvm')
  const out = []
  try {
    const versionsDir = path.join(nvmRoot, 'versions', 'node')
    if (fs.existsSync(versionsDir)) {
      for (const v of fs.readdirSync(versionsDir)) {
        const bin = path.join(versionsDir, v, 'bin')
        if (fs.existsSync(path.join(bin, 'node'))) out.push(bin)
      }
    }
  } catch (_) {}
  try {
    const fnmRoot = process.env.FNM_DIR || path.join(home, '.fnm')
    const aliases = path.join(fnmRoot, 'aliases')
    if (fs.existsSync(aliases)) {
      for (const a of fs.readdirSync(aliases)) {
        const bin = path.join(aliases, a, 'bin')
        if (fs.existsSync(path.join(bin, 'node'))) out.push(bin)
      }
    }
  } catch (_) {}
  return uniqueExistingDirs(out)
}

function extendPath(pathVal) {
  let out = String(pathVal || '').trim()
  const sep = process.platform === 'win32' ? ';' : ':'
  const appendFront = (p) => {
    if (!p) return
    const exists = out.split(sep).includes(p)
    if (!exists) out = out ? `${p}${sep}${out}` : p
  }
  const platformDefaults = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    : process.platform === 'linux'
      ? ['/usr/local/bin', '/usr/bin', '/bin']
      : []
  for (const p of platformDefaults) appendFront(p)
  for (const p of getUserBinPaths()) appendFront(p)
  for (const p of getNodeManagerBinPaths()) appendFront(p)
  return out
}

function cleanEnvForChild(baseEnv) {
  const env = { ...(baseEnv || process.env) }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'CHROME_DESKTOP' || key === 'ORIGINAL_XDG_CURRENT_DESKTOP') {
      delete env[key]
    }
  }
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const current = env[pathKey] || env.PATH || process.env[pathKey] || process.env.PATH || ''
  env[pathKey] = extendPath(current)
  if (pathKey !== 'PATH') env.PATH = env[pathKey]
  return env
}

function resolveCommand(cmd, env) {
  if (!cmd || path.isAbsolute(cmd) || String(cmd).includes(path.sep)) return cmd
  const pathVal = String((env && (env.PATH || env.Path)) || '')
  const sep = process.platform === 'win32' ? ';' : ':'
  const dirs = pathVal ? pathVal.split(sep) : []
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full)) return full
      } catch (_) {}
    }
  }
  return cmd
}

module.exports = {
  cleanEnvForChild,
  resolveCommand
}

