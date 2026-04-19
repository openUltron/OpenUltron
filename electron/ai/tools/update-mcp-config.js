// AI 工具：更新 MCP 配置（与设置页 / mcp.json 同源，避免只写 store 导致 UI 读不到）
const path = require('path')
const os = require('os')
const { getAppRootPath } = require('../../app-root')
const mcpConfigFile = require('../mcp-config-file')
const { createMcpJsonConfigParsers } = require('../../main-process/mcp-json-config')

const { parseMcpJsonConfig, BUILTIN_CHROME_DEVTOOLS_MCP } = createMcpJsonConfigParsers({
  path,
  os,
  getAppRootPath
})

function parseUserServersMap(jsonStr) {
  let obj = {}
  try {
    obj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : (jsonStr || {})
  } catch {
    return {}
  }
  if (obj.mcpServers && typeof obj.mcpServers === 'object') return { ...obj.mcpServers }
  return typeof obj === 'object' && obj ? { ...obj } : {}
}

/** 与 ipc/mcp-admin-ipc stripBuiltinMcpForSave 一致：落盘不写回内置 chrome-devtools 占位 */
function stripBuiltinMcpForSave(configStr, builtinChromeDevtoolsMcp) {
  let obj = {}
  try {
    obj = typeof configStr === 'string' ? JSON.parse(configStr) : (configStr || {})
  } catch {
    return configStr
  }
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

function createUpdateMcpConfigTool(store, mcpManager) {
  return {
    definition: {
      description: '更新 MCP 服务器配置，或查询各 MCP 运行状态。可添加、修改、删除服务器；用 status 验证各服务器是否就绪、工具数量及错误信息。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'update', 'remove', 'get', 'status'],
            description: 'add=添加/更新服务器, remove=删除, get=获取当前配置, status=查询各 MCP 运行状态与可用性'
          },
          name: {
            type: 'string',
            description: '服务器名称（action 为 add/update/remove 时必填）'
          },
          config: {
            type: 'object',
            description: '服务器配置（action 为 add/update 时必填）。stdio 类型：{ command, args, env }，SSE 类型：{ url, headers }'
          }
        },
        required: ['action']
      }
    },
    async execute({ action, name, config }) {
      const raw = mcpConfigFile.readMcpConfig(store)
      const servers = parseUserServersMap(raw)

      if (action === 'get') {
        return { config: servers }
      }

      if (action === 'status') {
        const status = mcpManager.getStatus()
        return { status }
      }

      if (action === 'remove') {
        if (!name) return { error: '缺少 name 参数' }
        delete servers[name]
        mcpManager.stopServer(name)
      } else if (action === 'add' || action === 'update') {
        if (!name || !config) return { error: '缺少 name 或 config 参数' }
        servers[name] = config
      } else {
        return { error: `不支持的 action: ${action}` }
      }

      const wrapped = JSON.stringify({ mcpServers: servers }, null, 2)
      const toWrite = stripBuiltinMcpForSave(wrapped, BUILTIN_CHROME_DEVTOOLS_MCP)
      mcpConfigFile.writeMcpConfig(toWrite)
      try {
        store.set('aiMcpConfig', toWrite)
      } catch (_) {}

      mcpManager.stopAll()
      const disabledServers = store.get('aiMcpDisabledServers', [])
      const list = parseMcpJsonConfig(toWrite, disabledServers)
      if (list.length > 0) {
        try {
          await mcpManager.startAll(list)
        } catch (e) {
          if (action === 'remove') {
            return { success: true, message: `MCP 服务器 "${name}" 已移除；重连部分服务器失败: ${e.message}` }
          }
          return { success: true, message: `配置已写入 mcp.json，但启动失败: ${e.message}` }
        }
      }

      if (action === 'remove') {
        return { success: true, message: `MCP 服务器 "${name}" 已移除` }
      }
      return { success: true, message: `MCP 服务器 "${name}" 已配置并写入 mcp.json` }
    }
  }
}

module.exports = { createUpdateMcpConfigTool }
