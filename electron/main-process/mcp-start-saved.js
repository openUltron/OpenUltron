/**
 * app.ready 后启动 mcp.json 中配置的 MCP 服务
 */
function createStartSavedMcpServers(deps) {
  const { mcpConfigFile, store, parseMcpJsonConfig, aiMcpManager, appLogger } = deps

  return async function startSavedMcpServers() {
    const mcpConfigJson = mcpConfigFile.readMcpConfig(store)
    const disabledServers = store.get('aiMcpDisabledServers', [])
    const servers = parseMcpJsonConfig(mcpConfigJson, disabledServers)
    if (servers.length === 0) {
      appLogger?.warn?.('[MCP] 无可用服务器：配置解析失败或未包含任何服务器。请检查 mcp.json 或设置中是否禁用了 chrome-devtools。')
      return
    }
    const names = servers.map((s) => (s.enabled !== false ? s.name : `${s.name}(已禁用)`)).join(', ')
    appLogger?.info?.('[MCP] 正在启动 MCP 服务器:', names)
    await aiMcpManager.startAll(servers)
    const ready = [...aiMcpManager.connections.entries()].filter(([, c]) => c.ready).map(([n]) => n)
    const failed = [...aiMcpManager.errors.entries()].map(([n, msg]) => `${n}: ${msg}`)
    if (ready.length) appLogger?.info?.('[MCP] 已就绪:', ready.join(', '))
    if (failed.length) {
      appLogger?.warn?.('[MCP] 启动失败:', failed.join('; '))
      const hasChrome = failed.some((x) => String(x).includes('chrome-devtools'))
      if (hasChrome) {
        appLogger?.info?.('[MCP] chrome-devtools 排查建议: 1) 确认已安装 Node 20+（nvm install 20 或 fnm install 20）；2) 若为「请求超时: initialize」多为 npx 拉包或 Chrome 启动慢，可重试或检查网络；3) 若为「进程退出」请查看本日志上方该进程的 stderr 输出。')
      }
    }
  }
}

module.exports = { createStartSavedMcpServers }
