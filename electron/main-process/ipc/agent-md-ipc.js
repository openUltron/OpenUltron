/**
 * 项目 AGENT.md 与 <appRoot> 下 SOUL/IDENTITY/USER/BOOT.md 路径与打开。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {(rel: string) => string} deps.getAppRootPath
 * @param {object} deps.memoryStore
 * @param {typeof import('electron').shell} deps.shell
 */
function registerAgentMdIpc (deps) {
  const { registerChannel, getAppRootPath, memoryStore, shell } = deps

  const SOUL_MD_PATH = getAppRootPath('SOUL.md')
  const IDENTITY_MD_PATH = getAppRootPath('IDENTITY.md')
  const USER_MD_PATH = getAppRootPath('USER.md')
  const BOOT_MD_PATH = getAppRootPath('BOOT.md')

  function ensureIdentityAndSoulFiles () {
    try {
      const dir = path.dirname(IDENTITY_MD_PATH)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      if (!fs.existsSync(IDENTITY_MD_PATH)) {
        fs.writeFileSync(IDENTITY_MD_PATH, '# IDENTITY.md\n\n# Agent 身份\n\n- 名字：\n- 形象/类型：\n- vibe/语气：\n- 代词：\n', 'utf-8')
      }
      if (!fs.existsSync(SOUL_MD_PATH)) {
        fs.writeFileSync(SOUL_MD_PATH, '# SOUL.md\n\n# 性格与原则\n\n在此定义你的默认行为、语气与优先级。\n', 'utf-8')
      }
    } catch (e) {
      console.warn('[agent-md-ipc] ensureIdentityAndSoulFiles failed:', e.message)
    }
  }
  ensureIdentityAndSoulFiles()

  function ensureAndOpenMd (name, filePath, defaultContent) {
    return async () => {
      try {
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, defaultContent, 'utf-8')
        }
        await shell.openPath(filePath)
        return { success: true }
      } catch (e) {
        return { success: false, message: e.message }
      }
    }
  }

  registerChannel('ai-read-agent-md', async (event, { projectPath }) => {
    try {
      if (!projectPath) return { success: false, content: null }
      const agentMdPath = path.join(projectPath, '.gitManager', 'AGENT.md')
      if (!fs.existsSync(agentMdPath)) return { success: true, content: null }
      const content = fs.readFileSync(agentMdPath, 'utf-8').trim()
      return { success: true, content: content || null }
    } catch (error) {
      return { success: false, content: null }
    }
  })

  registerChannel('ai-get-soul-md-path', () => ({ path: SOUL_MD_PATH }))
  registerChannel('ai-open-soul-md', ensureAndOpenMd('SOUL', SOUL_MD_PATH,
    '# SOUL.md\n\n# 性格与原则\n\n在此定义你的默认行为、语气与优先级。\n'))

  registerChannel('ai-get-identity-md-path', () => {
    const home = os.homedir()
    const short = home && IDENTITY_MD_PATH.startsWith(home) ? '~' + IDENTITY_MD_PATH.slice(home.length) : IDENTITY_MD_PATH
    return { path: IDENTITY_MD_PATH, shortPath: short }
  })
  registerChannel('ai-open-identity-md', ensureAndOpenMd('IDENTITY', IDENTITY_MD_PATH,
    '# IDENTITY.md\n\n# Agent 身份\n\n- 名字：\n- 形象/类型：\n- vibe/语气：\n- 代词：\n'))
  registerChannel('ai-get-agent-display-name', () => ({ name: memoryStore.readAgentDisplayName() }))

  registerChannel('ai-get-user-md-path', () => ({ path: USER_MD_PATH }))
  registerChannel('ai-open-user-md', ensureAndOpenMd('USER', USER_MD_PATH,
    '# USER.md\n\n# 用户信息\n\n- 姓名/称呼：\n- 时区：\n- 工作/项目：\n- 偏好与习惯：\n- 关键人物：\n'))

  registerChannel('ai-get-boot-md-path', () => ({ path: BOOT_MD_PATH }))
  registerChannel('ai-open-boot-md', ensureAndOpenMd('BOOT', BOOT_MD_PATH,
    '# BOOT.md\n\n# 会话启动指令\n\n每次会话开始时加载的简短指令（如：发消息前先用消息工具再 NO_REPLY）。\n'))
}

module.exports = { registerAgentMdIpc }
