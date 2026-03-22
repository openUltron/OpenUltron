/**
 * MCP 配置管理（JSON，兼容 Claude Desktop）与连接状态
 */

function getClaudeDesktopConfigPath (os, path) {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'Claude', 'claude_desktop_config.json')
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

/** 返回「内置 chrome-devtools + 文件」合并后的配置，供 UI 展示 */
function getMergedMcpConfigForDisplay (store, mcpConfigFile, builtinChromeDevtoolsMcp) {
  const json = mcpConfigFile.readMcpConfig(store)
  let obj = {}
  try {
    obj = typeof json === 'string' ? JSON.parse(json) : (json || {})
  } catch { return JSON.stringify({ mcpServers: builtinChromeDevtoolsMcp }) }
  if (obj.mcpServers && typeof obj.mcpServers === 'object') obj = obj.mcpServers
  const merged = { ...builtinChromeDevtoolsMcp, ...obj }
  return JSON.stringify({ mcpServers: merged }, null, 2)
}

/** 保存时剔除内置 chrome-devtools，只把用户配置写入文件 */
function stripBuiltinMcpForSave (configStr, builtinChromeDevtoolsMcp) {
  let obj = {}
  try {
    obj = typeof configStr === 'string' ? JSON.parse(configStr) : (configStr || {})
  } catch { return configStr }
  const servers = obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj
  const builtin = builtinChromeDevtoolsMcp['chrome-devtools']
  if (builtin && servers['chrome-devtools']) {
    const cur = servers['chrome-devtools']
    if (cur.command === builtin.command && JSON.stringify(cur.args || []) === JSON.stringify(builtin.args || [])) {
      delete servers['chrome-devtools']
    }
  }
  return JSON.stringify({ mcpServers: servers }, null, 2)
}

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.store
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {typeof import('os')} deps.os
 * @param {object} deps.mcpConfigFile
 * @param {object} deps.builtinChromeDevtoolsMcp
 * @param {object} deps.aiMcpManager
 * @param {(jsonStr: string, disabledServers?: string[]) => any[]} deps.parseMcpJsonConfig
 */
function registerMcpAdminIpc (deps) {
  const {
    registerChannel,
    store,
    path,
    fs,
    os,
    mcpConfigFile,
    builtinChromeDevtoolsMcp,
    aiMcpManager,
    parseMcpJsonConfig
  } = deps

  registerChannel('ai-get-mcp-config', async () => {
    try {
      const config = getMergedMcpConfigForDisplay(store, mcpConfigFile, builtinChromeDevtoolsMcp)
      return { success: true, config }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-save-mcp-config', async (event, { config }) => {
    try {
      JSON.parse(config)
      const toWrite = stripBuiltinMcpForSave(config, builtinChromeDevtoolsMcp)
      mcpConfigFile.writeMcpConfig(toWrite)
      aiMcpManager.stopAll()
      const disabledServers = store.get('aiMcpDisabledServers', [])
      const servers = parseMcpJsonConfig(toWrite, disabledServers)
      if (servers.length > 0) {
        await aiMcpManager.startAll(servers)
      }
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-import-claude-mcp', async () => {
    try {
      const configPath = getClaudeDesktopConfigPath(os, path)
      if (!fs.existsSync(configPath)) {
        return { success: false, message: '未找到 Claude Desktop 配置文件' }
      }
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const mcpServers = parsed.mcpServers || {}
      return { success: true, config: JSON.stringify(mcpServers, null, 2) }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-get-mcp-status', async () => {
    try {
      return { success: true, status: aiMcpManager.getStatus() }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-reconnect-mcp', async () => {
    try {
      const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
      const disabledServers = store.get('aiMcpDisabledServers', [])
      aiMcpManager.stopAll()
      const servers = parseMcpJsonConfig(mcpConfigJson, disabledServers)
      if (servers.length > 0) {
        await aiMcpManager.startAll(servers)
      }
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-get-mcp-disabled', async () => {
    return { success: true, disabled: store.get('aiMcpDisabledServers', []) }
  })

  registerChannel('ai-toggle-mcp-server', async (event, { name, enabled }) => {
    try {
      let disabled = store.get('aiMcpDisabledServers', [])
      if (enabled) {
        disabled = disabled.filter(n => n !== name)
      } else {
        if (!disabled.includes(name)) disabled.push(name)
      }
      store.set('aiMcpDisabledServers', disabled)
      if (enabled) {
        const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
        const allServers = parseMcpJsonConfig(mcpConfigJson, [])
        const cfg = allServers.find(s => s.name === name)
        if (cfg) await aiMcpManager.startServer({ ...cfg })
      } else {
        aiMcpManager.stopServer(name)
      }
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-restart-mcp-server', async (event, { name }) => {
    try {
      const disabledServers = store.get('aiMcpDisabledServers', [])
      if (disabledServers.includes(name)) {
        return { success: false, message: '该服务器已禁用，请先启用后再重启' }
      }
      aiMcpManager.stopServer(name)
      const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
      const servers = parseMcpJsonConfig(mcpConfigJson, disabledServers)
      const cfg = servers.find(s => s.name === name)
      if (!cfg) return { success: false, message: `未找到服务器 "${name}" 的配置` }
      await aiMcpManager.startServer({ ...cfg })
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
}

module.exports = { registerMcpAdminIpc }
