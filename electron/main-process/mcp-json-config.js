/**
 * 解析 mcp.json（含 Claude Desktop mcpServers）并合并内置 chrome-devtools MCP
 */

/**
 * @param {{
 *   path: import('path')
 *   os: import('os')
 *   getAppRootPath: (rel: string) => string
 * }} deps
 */
function createMcpJsonConfigParsers(deps) {
  const { path, os, getAppRootPath } = deps

  function getChromeDevtoolsPersistentProfileDir() {
    try {
      return getAppRootPath('chrome-devtools-profile')
    } catch (_) {
      const home = process.env.HOME || os.homedir()
      return path.join(home || '', '.openultron', 'chrome-devtools-profile')
    }
  }

  const BUILTIN_CHROME_DEVTOOLS_MCP = {
    'chrome-devtools': {
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--headless=false', `--userDataDir=${getChromeDevtoolsPersistentProfileDir()}`]
    }
  }

  function parseMcpJsonConfig(jsonStr, disabledServers = []) {
    try {
      let obj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : (jsonStr || {})
      if (obj.mcpServers && typeof obj.mcpServers === 'object') obj = obj.mcpServers
      const merged = { ...BUILTIN_CHROME_DEVTOOLS_MCP, ...obj }
      return Object.entries(merged).map(([name, cfg]) => {
        const rawArgs = Array.isArray(cfg.args) ? [...cfg.args] : []
        let args = rawArgs
        if (name === 'chrome-devtools') {
          const strArgs = rawArgs.map((x) => String(x))
          args = strArgs.filter((x) => !x.startsWith('--headless'))
          args.push('--headless=false')
          args = args.filter((x) => !/^--isolated(?:=|$)/i.test(String(x || '').trim()))
          args = args.filter((x) => !/^--user-?data-?dir(?:=|$)/i.test(String(x || '').trim()))
          if (!args.some((x) => /^--user-?data-?dir(?:=|$)/i.test(String(x || '').trim()))) {
            args.push(`--userDataDir=${getChromeDevtoolsPersistentProfileDir()}`)
          }
        }
        return ({
          name,
          type: (cfg.type === 'sse' || cfg.url) ? 'sse' : 'stdio',
          command: cfg.command,
          args,
          env: cfg.env || {},
          url: cfg.url,
          headers: cfg.headers || {},
          enabled: !disabledServers.includes(name)
        })
      })
    } catch { return [] }
  }

  return {
    getChromeDevtoolsPersistentProfileDir,
    BUILTIN_CHROME_DEVTOOLS_MCP,
    parseMcpJsonConfig
  }
}

module.exports = { createMcpJsonConfigParsers }
