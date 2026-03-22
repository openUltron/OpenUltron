/**
 * Web 应用：展示名称更新（registry）、AI 工具白名单/开关（electron-store）。
 */

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.store
 */
function registerWebAppsSettingsIpc (deps) {
  const { registerChannel, store } = deps

  try {
    const { updateWebAppDisplayName } = require('../../web-apps/registry')
    registerChannel('web-apps-update-name', (event, payload = {}) => updateWebAppDisplayName(payload))
  } catch (e) {
    console.warn('[web-apps] IPC web-apps-update-name 注册失败:', e.message)
  }

  registerChannel('web-apps-get-ai-settings', () => {
    try {
      const allow = store.get('aiWebAppToolsAllowlist', [])
      const allowArr = Array.isArray(allow) ? allow : []
      const rawScope = store.get('aiWebAppToolsScope', null)
      const aiWebAppToolsScope =
        rawScope === 'all' || rawScope === 'allowlist'
          ? rawScope
          : allowArr.length > 0
            ? 'allowlist'
            : 'all'
      return {
        success: true,
        aiWebAppToolsEnabled: store.get('aiWebAppToolsEnabled', true),
        aiWebAppToolsAllowlist: allowArr.map((x) => String(x || '').trim()).filter(Boolean),
        aiWebAppToolsScope
      }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  })

  registerChannel('web-apps-set-ai-settings', (event, payload = {}) => {
    try {
      if (payload && payload.aiWebAppToolsEnabled !== undefined) {
        store.set('aiWebAppToolsEnabled', !!payload.aiWebAppToolsEnabled)
      }
      if (payload && Array.isArray(payload.aiWebAppToolsAllowlist)) {
        store.set(
          'aiWebAppToolsAllowlist',
          payload.aiWebAppToolsAllowlist.map((x) => String(x || '').trim()).filter(Boolean)
        )
      }
      if (payload && (payload.aiWebAppToolsScope === 'all' || payload.aiWebAppToolsScope === 'allowlist')) {
        store.set('aiWebAppToolsScope', payload.aiWebAppToolsScope)
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  })
}

module.exports = { registerWebAppsSettingsIpc }
