/**
 * 统一注册：同一 handler 同时供 IPC 与 HTTP /api/invoke 调用
 * @param {import('electron').IpcMain} ipcMain
 * @param {object} invokeRegistry — electron/api/invokeRegistry
 */
function createRegisterChannel (ipcMain, invokeRegistry) {
  return function registerChannel (channel, handler) {
    ipcMain.handle(channel, (event, ...args) => handler(event, ...args))
    invokeRegistry.register(channel, (args) => handler(null, ...(Array.isArray(args) ? args : [args])))
  }
}

module.exports = { createRegisterChannel }
