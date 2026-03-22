/**
 * 工作区路径：默认目录、持久化 extraPaths、选择文件夹、解析路径字符串。
 */

const fs = require('fs')
const pathMod = require('path')
const os = require('os')

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.store
 * @param {typeof import('electron').dialog} deps.dialog
 * @param {() => import('electron').BrowserWindow | null | undefined} deps.getMainWindow
 * @param {() => void} deps.ensureWorkspaceDirs
 * @param {() => string} deps.getWorkspaceRoot
 * @param {(sub: string) => string} deps.getWorkspacePath
 */
function registerWorkspaceIpc (deps) {
  const {
    registerChannel,
    store,
    dialog,
    getMainWindow,
    ensureWorkspaceDirs,
    getWorkspaceRoot,
    getWorkspacePath
  } = deps

  registerChannel('workspace-get-defaults', async () => {
    try {
      ensureWorkspaceDirs()
      return {
        success: true,
        root: getWorkspaceRoot(),
        scriptsPath: getWorkspacePath('scripts'),
        projectsPath: getWorkspacePath('projects')
      }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('workspace-load', async (event, { primaryPath }) => {
    try {
      const key = `workspace_${primaryPath}`
      const data = store.get(key, { extraPaths: [] })
      return { success: true, extraPaths: data.extraPaths || [] }
    } catch (e) {
      return { success: false, extraPaths: [], message: e.message }
    }
  })

  registerChannel('workspace-save', async (event, { primaryPath, extraPaths }) => {
    try {
      const key = `workspace_${primaryPath}`
      store.set(key, { extraPaths: extraPaths || [] })
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('workspace-pick-folder', async (event) => {
    try {
      const parent = getMainWindow()
      const result = await dialog.showOpenDialog(parent, {
        properties: ['openDirectory'],
        title: '添加文件夹到工作区'
      })
      if (result.canceled || !result.filePaths.length) {
        return { success: false, path: null }
      }
      return { success: true, path: result.filePaths[0] }
    } catch (e) {
      return { success: false, path: null, message: e.message }
    }
  })

  registerChannel('workspace-resolve-path', async (event, { path: rawPath }) => {
    if (!rawPath || typeof rawPath !== 'string') {
      return { success: false, path: null, message: '路径为空' }
    }
    try {
      const expanded = rawPath.trim().replace(/^~/, os.homedir())
      const absolutePath = pathMod.resolve(expanded)
      const stat = fs.statSync(absolutePath)
      if (!stat.isDirectory()) {
        return { success: false, path: null, message: '不是目录' }
      }
      fs.readdirSync(absolutePath, { withFileTypes: true })
      return { success: true, path: absolutePath }
    } catch (e) {
      const msg = e.code === 'ENOENT' ? '路径不存在' : e.code === 'EACCES' ? '无读取权限' : e.message
      return { success: false, path: null, message: msg }
    }
  })
}

module.exports = { registerWorkspaceIpc }
