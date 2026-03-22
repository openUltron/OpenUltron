/**
 * 将工具产出的图片注册为 local-resource URL（主进程侧）
 */

/** @param {object} deps */
function createAiChatArtifactRegistrars(deps) {
  const { path, fs, getAppRoot, getAppRootPath, artifactRegistry, appLogger } = deps

  async function registerImageBase64ForChat(base64, sessionId) {
    if (!base64 || typeof base64 !== 'string' || base64.length < 100) return null
    try {
      const rec = artifactRegistry.registerBase64Artifact({
        base64,
        ext: '.png',
        kind: 'image',
        source: 'chat_tool',
        sessionId: String(sessionId || '')
      })
      if (!rec || !rec.path) return null
      const appRoot = getAppRoot()
      const rel = path.relative(appRoot, rec.path)
      if (rel.startsWith('..')) return null
      return 'local-resource://' + rel.split(path.sep).join('/')
    } catch (e) {
      appLogger?.warn?.('[main] registerImageBase64ForChat 失败', { error: e?.message })
      return null
    }
  }

  async function registerScreenshotFilePathForChat(filePath, sessionId) {
    if (!filePath || typeof filePath !== 'string') {
      appLogger?.info?.('[main] registerScreenshotFilePathForChat 跳过: 无 path 或非字符串')
      return null
    }
    const trimmed = String(filePath).trim()
    if (!trimmed || !path.isAbsolute(trimmed)) {
      appLogger?.info?.('[main] registerScreenshotFilePathForChat 跳过: 非绝对路径', { path: trimmed.slice(0, 80) })
      return null
    }
    try {
      if (!fs.existsSync(trimmed) || !fs.statSync(trimmed).isFile()) {
        appLogger?.warn?.('[main] registerScreenshotFilePathForChat 文件不存在或非文件', { path: trimmed.slice(-80) })
        return null
      }
      const dir = getAppRootPath('screenshots')
      fs.mkdirSync(dir, { recursive: true })
      const base = path.basename(trimmed)
      const ext = path.extname(base) || '.png'
      const name = (base.slice(0, -ext.length) || 'screenshot') + '-' + Date.now() + ext
      const dest = path.join(dir, name)
      fs.copyFileSync(trimmed, dest)
      const url = 'local-resource://screenshots/' + name
      appLogger?.info?.('[main] registerScreenshotFilePathForChat 已复制', { from: trimmed.slice(-60), to: url })
      return url
    } catch (e) {
      appLogger?.warn?.('[main] registerScreenshotFilePathForChat 失败', { error: e?.message })
      return null
    }
  }

  return {
    registerImageBase64ForChat,
    registerScreenshotFilePathForChat
  }
}

module.exports = { createAiChatArtifactRegistrars }
