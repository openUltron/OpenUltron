function registerAiExternalSubagentsIpc (deps) {
  const { registerChannel, scanExternalSubAgents } = deps
  registerChannel('ai-list-external-subagents', async (event, { force } = {}) => {
    try {
      const agents = await scanExternalSubAgents(!!force)
      return { success: true, agents }
    } catch (e) {
      return { success: false, error: e.message || String(e), agents: [] }
    }
  })
}

module.exports = { registerAiExternalSubagentsIpc }
