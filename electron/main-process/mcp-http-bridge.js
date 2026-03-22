/**
 * MCP 外部工具调用的本地 HTTP 桥（open_file / open_diff / refresh）
 */
function findGitRoot(filePath, path, fs) {
  let dir = path.dirname(filePath)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    dir = path.dirname(dir)
  }
  return null
}

/**
 * @param {{
 *   http: typeof import('http')
 *   path: import('path')
 *   fs: import('fs')
 *   getMainWindow: () => import('electron').BrowserWindow | null | undefined
 * }} deps
 */
function createMcpHttpBridge(deps) {
  const { http, path, fs, getMainWindow } = deps
  let server = null

  function start() {
    if (server) return
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const { action, params } = JSON.parse(body)
          const mainWindow = getMainWindow()
          if (!mainWindow || mainWindow.isDestroyed()) {
            res.writeHead(503)
            res.end(JSON.stringify({ error: 'Window not available' }))
            return
          }

          if (action === 'open_file' || action === 'open_diff') {
            const filePath = params.filePath
            const projectPath = findGitRoot(filePath, path, fs)
            if (!projectPath) {
              res.writeHead(400)
              res.end(JSON.stringify({ error: 'Not inside a git repository' }))
              return
            }
            const channel = action === 'open_file' ? 'mcp-open-file' : 'mcp-open-diff'
            mainWindow.webContents.send(channel, { projectPath, filePath })
            mainWindow.show()
            mainWindow.focus()
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true }))
          } else if (action === 'refresh') {
            mainWindow.webContents.send('refresh-on-focus')
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true }))
          } else {
            res.writeHead(400)
            res.end(JSON.stringify({ error: `Unknown action: ${action}` }))
          }
        } catch (err) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: err.message }))
        }
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      console.log(`MCP bridge server listening on port ${port}`)
    })
  }

  function stop() {
    if (server) {
      server.close()
      server = null
    }
  }

  return { start, stop }
}

module.exports = { createMcpHttpBridge, findGitRoot }
