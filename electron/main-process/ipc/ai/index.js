/**
 * AI 相关 IPC 子模块聚合导出（按阶段继续扩充）。
 * 多数 `ai-*` channel 已由 main 调用本目录下 `registerAi*`；主进程模块化收尾进度见 docs/MAIN-PROCESS-MODULARIZATION.md。
 */
const { registerGatewaySessionIpc, getCurrentOpenSession } = require('./gateway-session-ipc')

module.exports = {
  registerGatewaySessionIpc,
  getCurrentOpenSession
}
