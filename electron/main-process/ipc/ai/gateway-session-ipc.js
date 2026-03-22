/**
 * Gateway WebSocket URL 与当前打开会话（供 Gateway getCurrentOpenSession）
 */

let currentOpenSession = null

function getCurrentOpenSession () {
  return currentOpenSession
}

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {boolean} deps.isDev
 * @param {number} deps.gatewayPortProd
 * @param {number} deps.gatewayPortDev
 */
function registerGatewaySessionIpc (deps) {
  const { registerChannel, isDev, gatewayPortProd, gatewayPortDev } = deps

  registerChannel('ai-report-current-session', (event, { projectPath, sessionId }) => {
    currentOpenSession = (projectPath != null && sessionId != null)
      ? { projectPath: String(projectPath), sessionId: String(sessionId) }
      : null
    return { ok: true }
  })

  registerChannel('ai-get-current-session', () => {
    return {
      success: true,
      projectPath: currentOpenSession?.projectPath ?? null,
      sessionId: currentOpenSession?.sessionId ?? null
    }
  })

  registerChannel('get-gateway-ws-url', () => {
    const port = isDev ? gatewayPortDev : gatewayPortProd
    return `ws://127.0.0.1:${port}`
  })
}

module.exports = { registerGatewaySessionIpc, getCurrentOpenSession }
