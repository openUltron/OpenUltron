/**
 * 内置 webview（persist:main）的 Chrome 扩展加载、列表、启用/禁用与卸载。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const loadedExtensions = new Map()

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {typeof import('electron').session} deps.session
 * @param {typeof import('electron').dialog} deps.dialog
 * @param {object} deps.store electron-store
 * @param {() => import('electron').BrowserWindow | null | undefined} deps.getMainWindow
 */
function registerBrowserExtensionsIpc (deps) {
  const { registerChannel, session, dialog, store, getMainWindow } = deps

  const getWebviewSession = () => session.fromPartition('persist:main')

  const getChromeExtensionsPath = () => {
    const platform = process.platform
    const homeDir = os.homedir()

    if (platform === 'darwin') {
      return path.join(homeDir, 'Library/Application Support/Google/Chrome/Default/Extensions')
    }
    if (platform === 'win32') {
      return path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data/Default/Extensions')
    }
    const possiblePaths = [
      path.join(homeDir, '.config/google-chrome/Default/Extensions'),
      path.join(homeDir, '.config/google-chrome-beta/Default/Extensions'),
      path.join(homeDir, '.config/chromium/Default/Extensions')
    ]
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p
    }
    return possiblePaths[0]
  }

  registerChannel('get-extensions', async () => {
    try {
      const webviewSession = getWebviewSession()
      const extensions = webviewSession.getAllExtensions()

      const extensionList = extensions.map((ext) => ({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        description: ext.manifest?.description || '',
        icon: (() => {
          if (!ext.manifest?.icons) return null
          const iconFile = ext.manifest.icons['128'] || ext.manifest.icons['48'] || ext.manifest.icons['32'] || ext.manifest.icons['16']
          if (!iconFile || !ext.path) return null
          const iconPath = path.join(ext.path, iconFile)
          if (fs.existsSync(iconPath)) {
            try {
              const iconBuffer = fs.readFileSync(iconPath)
              const extType = iconFile.endsWith('.png') ? 'png' : (iconFile.endsWith('.svg') ? 'svg+xml' : 'png')
              return `data:image/${extType};base64,${iconBuffer.toString('base64')}`
            } catch (e) {
              return null
            }
          }
          return null
        })(),
        enabled: loadedExtensions.get(ext.id)?.enabled !== false,
        path: ext.path
      }))

      console.log(`🧩 获取扩展列表: ${extensionList.length} 个`)
      return { success: true, extensions: extensionList }
    } catch (error) {
      console.error('❌ 获取扩展列表失败:', error)
      return { success: false, message: error.message, extensions: [] }
    }
  })

  registerChannel('load-extension-from-folder', async () => {
    try {
      const parent = getMainWindow()
      const result = await dialog.showOpenDialog(parent, {
        title: '选择扩展目录',
        properties: ['openDirectory'],
        message: '请选择包含 manifest.json 的扩展目录'
      })

      if (result.canceled || !result.filePaths.length) {
        return { success: false, message: '用户取消选择' }
      }

      const extensionPath = result.filePaths[0]

      const manifestPath = path.join(extensionPath, 'manifest.json')
      if (!fs.existsSync(manifestPath)) {
        return { success: false, message: '所选目录不包含 manifest.json 文件' }
      }

      const webviewSession = getWebviewSession()
      const extension = await webviewSession.loadExtension(extensionPath, {
        allowFileAccess: true
      })

      loadedExtensions.set(extension.id, {
        path: extensionPath,
        enabled: true
      })

      const savedExtensions = store.get('loadedExtensions', [])
      if (!savedExtensions.find(e => e.path === extensionPath)) {
        savedExtensions.push({ path: extensionPath, enabled: true })
        store.set('loadedExtensions', savedExtensions)
      }

      console.log(`🧩 扩展加载成功: ${extension.name} (${extension.id})`)
      return {
        success: true,
        extension: {
          id: extension.id,
          name: extension.name,
          version: extension.version
        }
      }
    } catch (error) {
      console.error('❌ 加载扩展失败:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('load-extension-from-crx', async () => {
    try {
      const parent = getMainWindow()
      const result = await dialog.showOpenDialog(parent, {
        title: '选择扩展文件',
        filters: [{ name: 'Chrome 扩展', extensions: ['crx', 'zip'] }],
        properties: ['openFile'],
        message: '请选择 .crx 或 .zip 格式的扩展文件'
      })

      if (result.canceled || !result.filePaths.length) {
        return { success: false, message: '用户取消选择' }
      }

      return {
        success: false,
        message: '暂不支持直接加载 CRX 文件，请先解压扩展后从文件夹加载'
      }
    } catch (error) {
      console.error('❌ 加载 CRX 失败:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('load-extension-from-chrome', async () => {
    try {
      const webviewSession = getWebviewSession()
      const chromeExtPath = getChromeExtensionsPath()

      if (!fs.existsSync(chromeExtPath)) {
        return { success: false, message: `未找到 Chrome 扩展目录: ${chromeExtPath}` }
      }

      const extDirs = fs.readdirSync(chromeExtPath)
      const loadedExts = []

      for (const extId of extDirs) {
        const extPath = path.join(chromeExtPath, extId)
        if (!fs.statSync(extPath).isDirectory()) continue

        const versions = fs.readdirSync(extPath).filter((v) => {
          const vPath = path.join(extPath, v)
          return fs.statSync(vPath).isDirectory() && fs.existsSync(path.join(vPath, 'manifest.json'))
        }).sort().reverse()

        if (versions.length === 0) continue

        const latestVersion = versions[0]
        const extFullPath = path.join(extPath, latestVersion)

        try {
          const manifestPath = path.join(extFullPath, 'manifest.json')
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

          const existingExts = webviewSession.getAllExtensions()
          if (existingExts.some(e => e.id === extId)) {
            console.log(`🧩 扩展已加载，跳过: ${manifest.name || extId}`)
            continue
          }

          const extension = await webviewSession.loadExtension(extFullPath, {
            allowFileAccess: true
          })

          loadedExtensions.set(extension.id, { path: extFullPath, enabled: true })
          loadedExts.push({
            id: extension.id,
            name: extension.name,
            version: extension.version
          })

          console.log(`🧩 从 Chrome 加载扩展: ${extension.name}`)
        } catch (err) {
          console.warn(`⚠️ 加载扩展失败 ${extId}:`, err.message)
        }
      }

      if (loadedExts.length > 0) {
        const savedExtensions = store.get('loadedExtensions', [])
        for (const ext of loadedExts) {
          const extInfo = loadedExtensions.get(ext.id)
          if (extInfo && !savedExtensions.find(e => e.path === extInfo.path)) {
            savedExtensions.push({ path: extInfo.path, enabled: true })
          }
        }
        store.set('loadedExtensions', savedExtensions)
      }

      return { success: true, extensions: loadedExts }
    } catch (error) {
      console.error('❌ 从 Chrome 加载扩展失败:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('load-extension-by-id', async (event, extensionId) => {
    try {
      const webviewSession = getWebviewSession()
      const chromeExtPath = getChromeExtensionsPath()

      if (!extensionId || typeof extensionId !== 'string') {
        return { success: false, message: '无效的扩展 ID' }
      }

      const extPath = path.join(chromeExtPath, extensionId)

      if (!fs.existsSync(extPath)) {
        return {
          success: false,
          message: `未找到扩展 ${extensionId}，请确保已在 Chrome 中安装该扩展`
        }
      }

      const versions = fs.readdirSync(extPath).filter((v) => {
        const vPath = path.join(extPath, v)
        return fs.statSync(vPath).isDirectory() && fs.existsSync(path.join(vPath, 'manifest.json'))
      }).sort().reverse()

      if (versions.length === 0) {
        return { success: false, message: '扩展目录中未找到有效版本' }
      }

      const latestVersion = versions[0]
      const extFullPath = path.join(extPath, latestVersion)

      const existingExts = webviewSession.getAllExtensions()
      const existing = existingExts.find(e => e.id === extensionId)
      if (existing) {
        return {
          success: true,
          extension: { id: existing.id, name: existing.name, version: existing.version },
          message: '扩展已加载'
        }
      }

      const extension = await webviewSession.loadExtension(extFullPath, {
        allowFileAccess: true
      })

      loadedExtensions.set(extension.id, { path: extFullPath, enabled: true })
      const savedExtensions = store.get('loadedExtensions', [])
      if (!savedExtensions.find(e => e.path === extFullPath)) {
        savedExtensions.push({ path: extFullPath, enabled: true })
        store.set('loadedExtensions', savedExtensions)
      }

      console.log(`🧩 通过 ID 加载扩展: ${extension.name} (${extension.id})`)
      return {
        success: true,
        extension: { id: extension.id, name: extension.name, version: extension.version }
      }
    } catch (error) {
      console.error('❌ 通过 ID 加载扩展失败:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('toggle-extension', async (event, extensionId, enabled) => {
    try {
      const webviewSession = getWebviewSession()

      if (enabled) {
        const extInfo = loadedExtensions.get(extensionId)
        if (extInfo && extInfo.path) {
          await webviewSession.loadExtension(extInfo.path, {
            allowFileAccess: true
          })
          loadedExtensions.set(extensionId, { ...extInfo, enabled: true })
        }
      } else {
        await webviewSession.removeExtension(extensionId)
        const extInfo = loadedExtensions.get(extensionId)
        if (extInfo) {
          loadedExtensions.set(extensionId, { ...extInfo, enabled: false })
        }
      }

      const savedExtensions = store.get('loadedExtensions', [])
      const updatedExtensions = savedExtensions.map((e) => {
        const ext = loadedExtensions.get(extensionId)
        if (ext && e.path === ext.path) {
          return { ...e, enabled }
        }
        return e
      })
      store.set('loadedExtensions', updatedExtensions)

      console.log(`🧩 扩展 ${extensionId} 已${enabled ? '启用' : '禁用'}`)
      return { success: true }
    } catch (error) {
      console.error('❌ 切换扩展状态失败:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('remove-extension', async (event, extensionId) => {
    try {
      const webviewSession = getWebviewSession()

      await webviewSession.removeExtension(extensionId)

      const extInfo = loadedExtensions.get(extensionId)
      if (extInfo) {
        const savedExtensions = store.get('loadedExtensions', [])
        const updatedExtensions = savedExtensions.filter(e => e.path !== extInfo.path)
        store.set('loadedExtensions', updatedExtensions)
      }

      loadedExtensions.delete(extensionId)

      console.log(`🧩 扩展 ${extensionId} 已卸载`)
      return { success: true }
    } catch (error) {
      console.error('❌ 卸载扩展失败:', error)
      return { success: false, message: error.message }
    }
  })

  // 扩展功能暂时禁用：清空已保存的扩展配置，避免影响应用（与原 main 行为一致）
  setTimeout(() => {
    try {
      store.set('loadedExtensions', [])
    } catch (error) {
      // ignore
    }
  }, 500)
}

module.exports = { registerBrowserExtensionsIpc }
