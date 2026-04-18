/**
 * 基础文件对话框与同步读写（小文件），供渲染进程选用。
 */

const fs = require('fs')
const path = require('path')

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {typeof import('electron').dialog} deps.dialog
 * @param {() => import('electron').BrowserWindow | null | undefined} deps.getMainWindow
 * @param {() => string} deps.getAppRoot
 */
function registerFsDialogBasicIpc (deps) {
  const { registerChannel, dialog, getMainWindow, getAppRoot } = deps

  function resolveReadablePath(inputPath) {
    const raw = String(inputPath || '').trim()
    if (!raw) return ''
    if (raw.startsWith('local-resource://')) {
      const url = new URL(raw)
      const relPath = decodeURIComponent((url.host || '') + url.pathname)
      return path.resolve(getAppRoot(), relPath)
    }
    if (raw.startsWith('file://')) {
      try {
        return decodeURIComponent(raw.slice('file://'.length))
      } catch (_) {
        return raw.slice('file://'.length)
      }
    }
    return raw
  }

  registerChannel('show-open-dialog', async (event, options) => {
    try {
      const parent = getMainWindow()
      const result = await dialog.showOpenDialog(parent, options)
      console.log('📁 打开对话框:', result.canceled ? '已取消' : `${result.filePaths.length}个路径`)
      return result
    } catch (error) {
      console.error('❌ 打开对话框失败:', error.message)
      return { canceled: true, filePaths: [] }
    }
  })

  registerChannel('read-image-as-base64', async (event, filePath) => {
    try {
      const resolvedPath = resolveReadablePath(filePath)
      const ext = path.extname(resolvedPath).toLowerCase()
      const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      }
      const mimeType = mimeTypes[ext] || 'image/jpeg'
      const imageBuffer = fs.readFileSync(resolvedPath)
      const base64 = imageBuffer.toString('base64')
      const dataUrl = `data:${mimeType};base64,${base64}`
      console.log(`🖼️ 读取图片成功: ${resolvedPath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`)
      return { success: true, dataUrl }
    } catch (error) {
      console.error('❌ 读取图片失败:', error.message)
      return { success: false, error: error.message }
    }
  })

  registerChannel('show-save-dialog', async (event, options) => {
    try {
      const parent = getMainWindow()
      const result = await dialog.showSaveDialog(parent, {
        title: options.title || '保存文件',
        defaultPath: options.defaultPath,
        filters: options.filters || [{ name: '所有文件', extensions: ['*'] }]
      })
      return result
    } catch (error) {
      console.error('显示保存对话框失败:', error)
      return { canceled: true, error: error.message }
    }
  })

  registerChannel('save-file', async (event, data) => {
    try {
      fs.writeFileSync(data.filePath, data.content, 'utf-8')
      console.log(`💾 文件保存成功: ${data.filePath}`)
      return { success: true }
    } catch (error) {
      console.error('保存文件失败:', error)
      return { success: false, error: error.message }
    }
  })

  registerChannel('read-file', async (event, filePath) => {
    try {
      const resolvedPath = resolveReadablePath(filePath)
      const content = fs.readFileSync(resolvedPath, 'utf-8')
      console.log(`📖 文件读取成功: ${resolvedPath}`)
      return content
    } catch (error) {
      console.error('读取文件失败:', error)
      throw error
    }
  })
}

module.exports = { registerFsDialogBasicIpc }
