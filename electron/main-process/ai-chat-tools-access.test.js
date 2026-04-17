const path = require('path')
const { createAiChatToolsAccess } = require('./ai-chat-tools-access')
const { getWebAppsRoot } = require('../web-apps/registry')

function tool(name) {
  return { function: { name } }
}

describe('ai-chat-tools-access webapp studio permissions', () => {
  function createAccess() {
    return createAiChatToolsAccess({
      aiToolRegistry: {
        getToolDefinitions() {
          return [
            tool('sessions_spawn'),
            tool('webapp_studio_invoke'),
            tool('web_apps_create'),
            tool('file_operation'),
            tool('feishu_send_message')
          ]
        }
      },
      aiMcpManager: {
        getAllToolDefinitions() {
          return []
        }
      },
      store: {},
      appLogger: null
    })
  }

  it('keeps delegation tools in direct studio chat', () => {
    const access = createAccess()
    const projectPath = path.join(getWebAppsRoot(), 'demo-app', '0.1.0')
    const names = access.getToolsForChat({ projectPath }).map((t) => t.function.name)

    expect(names).toContain('sessions_spawn')
    expect(names).toContain('webapp_studio_invoke')
    expect(names).toContain('web_apps_create')
  })

  it('keeps full coding tools for studio subchat', () => {
    const access = createAccess()
    const projectPath = path.join(getWebAppsRoot(), 'demo-app', '0.1.0')
    const names = access.getToolsForSubChat({ projectPath, profile: null }).map((t) => t.function.name)

    expect(names).toContain('sessions_spawn')
    expect(names).toContain('webapp_studio_invoke')
    expect(names).toContain('web_apps_create')
    expect(names).not.toContain('feishu_send_message')
  })
})
