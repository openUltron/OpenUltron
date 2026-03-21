/**
 * manifest.aiTools → OpenAI 工具定义 + 执行路由（§6）
 */
'use strict'

const path = require('path')
const fs = require('fs')
const { readManifestJson } = require('./registry')

function parseWebappToolFullName(fullName) {
  const s = String(fullName || '')
  if (!s.startsWith('webapp__')) return null
  const rest = s.slice('webapp__'.length)
  const idx = rest.indexOf('__')
  if (idx <= 0) return null
  const appId = rest.slice(0, idx)
  const innerName = rest.slice(idx + 2)
  if (!appId || !innerName) return null
  return { appId, innerName }
}

/**
 * 是否合并 manifest.aiTools（受 store 开关与白名单约束）
 * @param {string} projectPath
 * @param {() => object} getStore electron-store
 */
function shouldMergeWebAppTools(projectPath, getStore) {
  const p = String(projectPath || '').trim()
  if (!p || p.startsWith('__')) return false
  if (!/web-apps/i.test(p.replace(/\\/g, '/'))) return false
  let store
  try {
    store = typeof getStore === 'function' ? getStore() : null
  } catch {
    store = null
  }
  if (!store || typeof store.get !== 'function') return true
  if (!store.get('aiWebAppToolsEnabled', true)) return false
  const rawScope = store.get('aiWebAppToolsScope', null)
  const allow = store.get('aiWebAppToolsAllowlist', [])
  const allowArr = Array.isArray(allow) ? allow.map((x) => String(x || '').trim()).filter(Boolean) : []
  /** @type {'all'|'allowlist'} */
  let scope = rawScope === 'all' || rawScope === 'allowlist' ? rawScope : null
  if (scope == null) {
    scope = allowArr.length > 0 ? 'allowlist' : 'all'
  }
  if (scope === 'all') return true
  const manifest = readManifestJson(p)
  const id = manifest && String(manifest.id || '').trim()
  if (!id) return false
  return allowArr.length > 0 && allowArr.includes(id)
}

/**
 * @param {string} projectPath 应用根目录绝对路径
 * @returns {Array<{ type: string, function: object }>}
 */
function buildWebAppToolDefinitions(projectPath) {
  const p = String(projectPath || '').trim()
  if (!p || p.startsWith('__')) return []
  if (!/web-apps/i.test(p.replace(/\\/g, '/'))) return []
  const manifest = readManifestJson(p)
  if (!manifest || !Array.isArray(manifest.aiTools)) return []
  const id = String(manifest.id || '').trim()
  if (!id) return []
  const out = []
  for (const t of manifest.aiTools) {
    if (!t || !t.name) continue
    const inner = String(t.name).trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(inner)) continue
    const fname = `webapp__${id}__${inner}`
    const params = t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} }
    out.push({
      type: 'function',
      function: {
        name: fname,
        description: String(t.description || `Web 应用 ${id} 提供的工具 ${inner}`),
        parameters: params
      }
    })
  }
  return out
}

/**
 * @param {string} fullName webapp__appId__toolName
 * @param {object} args
 * @param {string} projectPath 当前会话 projectPath（必须与应用目录一致）
 * @param {string} [sessionId]
 */
async function executeWebAppTool(fullName, args, projectPath, sessionId = '') {
  const parsed = parseWebappToolFullName(fullName)
  if (!parsed) return { error: `工具名格式无效: ${fullName}` }
  const { appId, innerName } = parsed
  const root = String(projectPath || '').trim()
  if (!root || !path.isAbsolute(root)) {
    return { error: '当前会话无有效 projectPath，无法调用 Web 应用工具' }
  }
  const manifest = readManifestJson(root)
  if (!manifest || String(manifest.id || '').trim() !== appId) {
    return { error: '当前会话与工具所属应用不一致（请在对应应用的工作室内调用）' }
  }
  const tools = Array.isArray(manifest.aiTools) ? manifest.aiTools : []
  const def = tools.find((t) => t && String(t.name) === innerName)
  if (!def) return { error: `manifest 中未找到 aiTools 项: ${innerName}` }

  const handler = String(def.handler || 'browser').toLowerCase()
  if (handler === 'browser') {
    return {
      success: false,
      error:
        'handler: browser 尚未接入 WebContents 消息路由。请使用 file_operation 或改为 Node handler（manifest.aiTools[].handler=node + entry）。'
    }
  }
  if (handler === 'node') {
    const entry = String(def.entry || '').trim()
    if (!entry) return { error: 'aiTools 缺少 entry（Node 模块相对路径）' }
    const abs = path.resolve(root, entry)
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      return { error: 'entry 路径非法（必须位于应用目录内）' }
    }
    if (!fs.existsSync(abs)) return { error: `工具入口文件不存在: ${entry}` }
    if (abs.endsWith('.js')) {
      try {
        const resolved = require.resolve(abs)
        delete require.cache[resolved]
      } catch (_) {}
    }
    let mod
    try {
      mod = require(abs)
    } catch (e) {
      return { error: `加载 Node 模块失败: ${e.message || String(e)}` }
    }
    const fn = typeof mod === 'function' ? mod : mod.default || mod.invoke
    if (typeof fn !== 'function') {
      return { error: 'Node 模块需导出函数、default 或 invoke' }
    }
    try {
      const ctx = { projectPath: root, sessionId, appId, toolName: innerName }
      const result = await fn(args || {}, ctx)
      return result != null && typeof result === 'object' ? result : { success: true, result }
    } catch (e) {
      return { error: `工具执行异常: ${e.message || String(e)}` }
    }
  }
  return { error: `未知 handler: ${handler}` }
}

module.exports = {
  parseWebappToolFullName,
  shouldMergeWebAppTools,
  buildWebAppToolDefinitions,
  executeWebAppTool
}
