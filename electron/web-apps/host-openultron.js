/**
 * 宿主 OpenUltron 版本：与 manifest.host.openUltron（semver 范围）比对
 */
'use strict'

const fs = require('fs')
const path = require('path')

let cachedVersion = null

function getPackageJsonPath() {
  return path.join(__dirname, '../../package.json')
}

/** @returns {string} 根 package.json 的 version，失败时为 0.0.0 */
function getOpenUltronAppVersion() {
  if (cachedVersion != null) return cachedVersion
  try {
    const raw = fs.readFileSync(getPackageJsonPath(), 'utf-8')
    const j = JSON.parse(raw)
    cachedVersion = String(j.version || '0.0.0').trim() || '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

/**
 * @param {string} rangeStr manifest.host.openUltron，如 >=1.0.26
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function checkHostOpenUltronRange(rangeStr) {
  let semver
  try {
    semver = require('semver')
  } catch {
    return { ok: false, error: 'semver 模块不可用，无法校验 host.openUltron' }
  }
  const range = String(rangeStr || '').trim()
  if (!range) return { ok: false, error: '缺少 host.openUltron' }
  const ver = getOpenUltronAppVersion()
  const coerced = semver.coerce(ver)
  if (!coerced) {
    return { ok: false, error: `无法解析宿主版本: ${ver}` }
  }
  if (!semver.validRange(range)) {
    return { ok: false, error: `host.openUltron 不是有效的 semver 范围: ${range}` }
  }
  if (!semver.satisfies(coerced, range, { includePrerelease: true })) {
    return {
      ok: false,
      error: `当前 OpenUltron ${coerced.version} 不满足应用要求的宿主版本: ${range}`
    }
  }
  return { ok: true }
}

module.exports = {
  getOpenUltronAppVersion,
  checkHostOpenUltronRange
}
