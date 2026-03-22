/**
 * 将若干配置类 IPC 直接转发到 invokeRegistry（与 registerConfigHandlers 注册的 HTTP 同源）
 */
function registerInvokeConfigForwardingIpc(deps) {
  const { ipcMain, invokeRegistry } = deps

  ipcMain.handle('get-config', (event, key) => invokeRegistry.invoke('get-config', [key]))
  ipcMain.handle('set-config', (event, key, value) => invokeRegistry.invoke('set-config', [key, value]))
  ipcMain.handle('get-all-configs', () => invokeRegistry.invoke('get-all-configs', []))
  ipcMain.handle('save-config', (event, payload) => invokeRegistry.invoke('save-config', [payload]))
  ipcMain.handle('save-saved-configs', (event, data) => invokeRegistry.invoke('save-saved-configs', [data]))
  ipcMain.handle('get-saved-configs', () => invokeRegistry.invoke('get-saved-configs', []))
}

module.exports = { registerInvokeConfigForwardingIpc }
