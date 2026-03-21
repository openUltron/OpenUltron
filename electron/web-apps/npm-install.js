/**
 * Web 应用目录内 npm 依赖安装（对齐 WEB-APPS-SANDBOX-DESIGN §4.2）
 * 默认：npm ci（有 lock）或 npm install（无 lock）+ --omit=dev + --ignore-scripts（除非 manifest.npm.allowScripts）
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function hasPackageJson(dir) {
  return fs.existsSync(path.join(dir, 'package.json'))
}

function hasLockfile(dir) {
  return (
    fs.existsSync(path.join(dir, 'package-lock.json')) ||
    fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'))
  )
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/**
 * @param {string} appDir 应用根目录
 * @param {object} [manifest] 已解析的 manifest（可选，用于 allowScripts）
 * @returns {{ success: boolean, skipped?: boolean, message?: string, stdout?: string, stderr?: string }}
 */
function runNpmInstallIfNeeded(appDir, manifest = {}) {
  if (!appDir || !fs.existsSync(appDir)) {
    return { success: false, message: '应用目录无效' }
  }
  if (!hasPackageJson(appDir)) {
    return { success: true, skipped: true, message: '无 package.json，跳过 npm' }
  }

  const allowScripts = !!(manifest.npm && manifest.npm.allowScripts === true)
  const args = []
  if (hasLockfile(appDir)) {
    args.push('ci', '--omit=dev')
  } else {
    args.push('install', '--omit=dev')
  }
  if (!allowScripts) {
    args.push('--ignore-scripts')
  }

  const r = spawnSync(npmCmd(), args, {
    cwd: appDir,
    encoding: 'utf-8',
    env: { ...process.env, npm_config_yes: 'true' },
    maxBuffer: 10 * 1024 * 1024
  })
  const stdout = (r.stdout || '').toString()
  const stderr = (r.stderr || '').toString()
  if (r.error) {
    return {
      success: false,
      message: r.error.message || String(r.error),
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000)
    }
  }
  if (r.status !== 0) {
    return {
      success: false,
      message: `npm 退出码 ${r.status}`,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000)
    }
  }
  return { success: true, message: 'npm 依赖已安装', stdout: stdout.slice(0, 2000) }
}

module.exports = {
  runNpmInstallIfNeeded,
  hasPackageJson
}
