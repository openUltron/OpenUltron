/**
 * 记录用户最近一次打开的应用工作室（sessionStorage），用于侧栏「应用」从聊天等页返回时恢复工作室。
 */
const STORAGE_KEY = 'openultron:lastWebAppStudio'

export function saveLastWebAppStudio({ appId, version }) {
  const id = String(appId || '').trim()
  const ver = String(version || '').trim()
  if (!id || !ver) return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ appId: id, version: ver }))
  } catch {
    /* ignore */
  }
}

export function getLastWebAppStudio() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (
      o &&
      typeof o.appId === 'string' &&
      typeof o.version === 'string' &&
      o.appId.trim() &&
      o.version.trim()
    ) {
      return { appId: o.appId.trim(), version: o.version.trim() }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function clearLastWebAppStudio() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
