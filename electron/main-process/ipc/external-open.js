/**
 * 打开外部应用 / 系统访达 / 外部 URL；检测已安装终端。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {typeof import('electron').shell} deps.shell
 * @param {() => string} deps.getAppRoot
 */
function registerExternalOpenIpc (deps) {
  const { registerChannel, shell, getAppRoot } = deps

  function resolveLocalPath(inputPath) {
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

  registerChannel('open-cursor', async (event, data) => {
    try {
      console.log(`🎨 尝试打开Cursor: ${data.path}`)
      console.log(`🔍 当前工作目录: ${process.cwd()}`)
      console.log(`🔍 Process PATH: ${process.env.PATH}`)

      const cursorPaths = [
        '/usr/local/bin/cursor',
        '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
        'cursor'
      ]

      for (const cursorPath of cursorPaths) {
        try {
          console.log(`🚀 尝试路径: ${cursorPath}`)

          const testChild = spawn(cursorPath, ['--version'], {
            stdio: 'pipe'
          })

          let versionOutput = ''
          testChild.stdout.on('data', (chunk) => {
            versionOutput += chunk.toString()
          })

          await new Promise((resolve, reject) => {
            testChild.on('close', (code) => {
              resolve(code)
            })
            testChild.on('error', (err) => {
              reject(err)
            })
          })

          console.log(`✅ Cursor路径有效 ${cursorPath}, 版本输出: ${versionOutput.trim()}`)

          const child = spawn(cursorPath, [data.path], {
            detached: true,
            stdio: 'ignore'
          })

          child.unref()
          console.log(`✅ 成功启动Cursor打开: ${data.path}`)
          return { success: true }
        } catch (error) {
          console.log(`❌ 路径 ${cursorPath} 失败: ${error.message}`)
        }
      }

      console.log('❌ 所有Cursor路径都失败，降级到在Finder中显示文件夹')
      shell.showItemInFolder(data.path)
      return { success: true, fallback: true, message: 'cursor命令不可用，已在Finder中打开文件夹' }
    } catch (error) {
      console.error('❌ 打开Cursor完全失败:', error.message)
      shell.showItemInFolder(data.path)
      return { success: false, message: `打开失败: ${error.message}` }
    }
  })

  registerChannel('open-terminal', async (event, data) => {
    try {
      const projectPath = data.path
      const terminalApp = data.terminalApp || 'terminal'
      console.log(`💻 打开终端: ${terminalApp} -> ${projectPath}`)

      const appNameMap = {
        terminal: 'Terminal',
        iterm2: 'iTerm',
        warp: 'Warp',
        alacritty: 'Alacritty',
        kitty: 'kitty',
        hyper: 'Hyper',
        tabby: 'Tabby',
        rio: 'Rio'
      }
      const appName = appNameMap[terminalApp] || 'Terminal'
      spawn('open', ['-a', appName, projectPath], { detached: true, stdio: 'ignore' })
      return { success: true }
    } catch (error) {
      console.error('❌ 打开终端失败:', error.message)
      return { success: false, message: `打开失败: ${error.message}` }
    }
  })

  registerChannel('get-available-terminals', async () => {
    const terminals = [
      { id: 'terminal', name: 'Terminal', desc: 'macOS 内置终端' }
    ]
    const checks = [
      { id: 'iterm2', name: 'iTerm2', desc: '功能强大的终端', path: '/Applications/iTerm.app' },
      { id: 'warp', name: 'Warp', desc: 'AI 驱动的现代终端', path: '/Applications/Warp.app' },
      { id: 'alacritty', name: 'Alacritty', desc: '基于 GPU 加速的终端', path: '/Applications/Alacritty.app' },
      { id: 'kitty', name: 'Kitty', desc: '基于 GPU 的快速终端', path: '/Applications/kitty.app' },
      { id: 'hyper', name: 'Hyper', desc: '基于 Electron 的终端', path: '/Applications/Hyper.app' },
      { id: 'tabby', name: 'Tabby', desc: '可定制的现代终端', path: '/Applications/Tabby.app' },
      { id: 'rio', name: 'Rio', desc: '基于 Rust 的终端', path: '/Applications/Rio.app' }
    ]
    for (const t of checks) {
      if (fs.existsSync(t.path)) {
        terminals.push({ id: t.id, name: t.name, desc: t.desc })
      }
    }
    return { success: true, terminals }
  })

  registerChannel('open-in-finder', async (event, data) => {
    try {
      const filePath = resolveLocalPath(data.path)
      console.log(`📂 在访达中打开: ${filePath}`)
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      console.error('❌ 打开访达失败:', error.message)
      return { success: false, message: `打开失败: ${error.message}` }
    }
  })

  registerChannel('open-external', async (event, url) => {
    try {
      const target = String(url || '').trim()
      if (!target) return { success: false, message: '打开目标为空' }
      console.log(`🌐 打开外部链接: ${target}`)
      if (target.startsWith('local-resource://') || target.startsWith('file://')) {
        const fullPath = resolveLocalPath(target)
        await shell.openPath(fullPath)
      } else {
        await shell.openExternal(target)
      }
      return { success: true }
    } catch (error) {
      console.error('❌ 打开外部链接失败:', error.message)
      return { success: false, message: `打开失败: ${error.message}` }
    }
  })
}

module.exports = { registerExternalOpenIpc }
