/**
 * 渠道首行 `/model` / `/模型` 解析与全局默认模型写入（与设置页、ai-save-config 语义一致）。
 * 从 main.js 抽出，便于单测与后续 IPC 域拆分。
 */
const { normalizeModelPool, finalizeAiModelFields } = require('../ai/ai-config-normalize')

/**
 * @param {{ app: import('electron').App, store: object, BrowserWindow: typeof import('electron').BrowserWindow, aiConfigFile: object }} deps
 */
function createInboundModelCommandHandlers (deps) {
  const { app, store, BrowserWindow, aiConfigFile } = deps

  /** 飞书/Telegram/钉钉 首行 `/model <id>` 或 `/模型 <id>`，与 App 内 /model 一致，写入全局 defaultModel */
  function parseInboundModelCommand (rawText) {
    const t = String(rawText || '').trim()
    if (!t) return null
    const lines = t.split(/\r?\n/)
    const first = lines[0].trim()
    const m = first.match(/^\/(model|模型)\s+(.+)$/i)
    if (!m) return null
    const modelId = String(m[2] || '').trim().replace(/^["']|["']$/g, '')
    if (!modelId) return null
    const remainderText = lines.slice(1).join('\n').trim()
    return { modelId, remainderText }
  }

  /** 将全局主模型写入 openultron.json（与设置页、ai_config_control 一致） */
  function applyGlobalDefaultModel (modelId) {
    const mid = String(modelId || '').trim()
    if (!mid) return { success: false, error: '未指定模型 ID' }
    try {
      const data = aiConfigFile.readAIConfig(app, store)
      const pool = normalizeModelPool(data.modelPool, data.defaultModel)
      if (pool.length > 0 && !pool.includes(mid)) {
        return { success: false, error: `模型 "${mid}" 不在全局模型池中` }
      }
      data.defaultModel = mid
      finalizeAiModelFields(data)
      aiConfigFile.writeAIConfig(app, data)
      BrowserWindow.getAllWindows().forEach((win) => {
        if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('ai-config-updated')
      })
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return { parseInboundModelCommand, applyGlobalDefaultModel }
}

module.exports = { createInboundModelCommandHandlers }
