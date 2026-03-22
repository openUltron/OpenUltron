/**
 * electron-store：已保存配置列表、按路径的「当前配置」快照（与 invokeRegistry 的 get-config 不同）。
 */

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.store electron-store 实例
 */
function registerStoreConfigSnapshotIpc (deps) {
  const { registerChannel, store } = deps

  registerChannel('delete-saved-config', async (event, index) => {
    try {
      const savedConfigs = store.get('savedConfigs', [])
      if (index >= 0 && index < savedConfigs.length) {
        const deletedConfig = savedConfigs[index]
        savedConfigs.splice(index, 1)
        store.set('savedConfigs', savedConfigs)
        console.log(`✅ 已删除保存配置: ${deletedConfig.path}`)
        return { success: true, message: '删除成功' }
      }
      console.error('❌ 无效的保存配置索引:', index)
      return { success: false, message: '无效的索引' }
    } catch (error) {
      console.error('❌ 删除保存配置失败:', error.message)
      return { success: false, message: `删除失败: ${error.message}` }
    }
  })

  registerChannel('get-current-config', async (event, data) => {
    try {
      const configKey = data && data.path ? data.path : 'default'
      const currentConfig = store.get(`current-config-${configKey}`, null)
      console.log(`📖 获取当前配置${configKey}:`, currentConfig ? '已存在' : 'null')
      return { success: true, config: currentConfig }
    } catch (error) {
      console.error('❌ 获取当前配置失败:', error.message)
      return { success: false, message: `获取失败: ${error.message}`, config: null }
    }
  })

  registerChannel('set-current-config', async (event, data) => {
    try {
      const configKey = data.path || 'default'
      store.set(`current-config-${configKey}`, data.config)
      console.log(`💾 保存当前配置${configKey}:`, data.config)
      return { success: true }
    } catch (error) {
      console.error('❌ 保存当前配置失败:', error.message)
      return { success: false, message: `保存失败: ${error.message}` }
    }
  })
}

module.exports = { registerStoreConfigSnapshotIpc }
