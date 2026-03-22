/**
 * 定时任务 Cron IPC
 */

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.cronScheduler ./ai/cron-scheduler 单例
 * @param {object} deps.feishuNotify
 * @param {object} deps.appLogger
 */
function registerCronIpc (deps) {
  const { registerChannel, cronScheduler, feishuNotify, appLogger } = deps

  registerChannel('cron-list', () => {
    const tasks = cronScheduler.listTasks()
    appLogger.info('[Cron] cron-list', { taskCount: tasks.length, cronPath: cronScheduler.CRON_JSON_PATH, types: tasks.map((t) => t.type) })
    return { success: true, tasks }
  })

  registerChannel('cron-ensure-feishu-refresh-task', () => {
    try {
      const cfg = feishuNotify.getConfig()
      const hasUserToken = String(cfg?.user_access_token || '').trim() || String(cfg?.user_refresh_token || '').trim()
      const tasks = cronScheduler.listTasks()
      const alreadyHas = tasks.some((t) => t.type === 'feishu_refresh_token')
      appLogger.info('[Cron] cron-ensure-feishu-refresh-task 被调用', { hasUserToken: !!hasUserToken, taskCount: tasks.length, alreadyHas })
      if (!hasUserToken) return { success: true, added: false }
      if (alreadyHas) return { success: true, added: false }
      cronScheduler.addTask({
        name: '飞书 User Token 刷新',
        schedule: '0 */1 * * *',
        type: 'feishu_refresh_token',
        enabled: true
      })
      appLogger.info('[Cron] 已添加飞书 Token 刷新任务', { cronPath: cronScheduler.CRON_JSON_PATH })
      return { success: true, added: true }
    } catch (e) {
      appLogger.warn('[Cron] cron-ensure-feishu-refresh-task 失败', { message: e?.message, stack: e?.stack })
      return { success: false, added: false, message: e.message }
    }
  })

  registerChannel('cron-add', (event, task) => {
    try {
      const t = cronScheduler.addTask(task)
      return { success: true, task: t }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('cron-update', (event, { taskId, updates }) => {
    try {
      const t = cronScheduler.updateTask(taskId, updates)
      return { success: true, task: t }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('cron-remove', (event, taskId) => {
    try {
      const ok = cronScheduler.removeTask(taskId)
      return { success: ok }
    } catch (e) {
      return { success: false, message: e.message }
    }
  })

  registerChannel('cron-run-now', async (event, taskId) => {
    try {
      const tasks = cronScheduler.listTasks()
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return { success: false, message: '任务不存在' }
      const result = await cronScheduler.runTask(task)
      return result
    } catch (e) {
      return { success: false, message: e.message }
    }
  })
}

module.exports = { registerCronIpc }
