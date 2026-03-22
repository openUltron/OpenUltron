'use strict'

/**
 * 飞书/Telegram/钉钉 同会话多 run 的队列状态，以及 stop_previous_task / wait_for_previous_run 工具依赖。
 * 由 main 在 aiOrchestrator 初始化之后创建。
 */
function createChannelRunState(deps) {
  const { aiOrchestrator } = deps
  const channelCurrentRun = new Map() // key -> Array<{ runId, runSessionId, promise, startTime }>
  const channelKeyByRunSessionId = new Map() // runSessionId -> key
  const runStartTimeBySessionId = new Map() // runSessionId -> startTime
  const abortedRunSessionIds = new Set() // 被 stop_previous_task 停掉的 run
  const completedRunSessionIds = new Set() // run 已完成（抑制长耗时安抚消息竞态）

  function stopPreviousRunsForChannel(currentRunSessionId) {
    const key = channelKeyByRunSessionId.get(currentRunSessionId)
    if (!key) return 0
    const runs = channelCurrentRun.get(key) || []
    let affected = 0
    for (const r of runs) {
      if (r.runSessionId !== currentRunSessionId) {
        abortedRunSessionIds.add(r.runSessionId)
        aiOrchestrator.stopChat(r.runSessionId)
        affected++
      }
    }
    return affected
  }

  async function waitForPreviousRuns(currentRunSessionId) {
    const key = channelKeyByRunSessionId.get(currentRunSessionId)
    const currentStart = runStartTimeBySessionId.get(currentRunSessionId)
    if (!key || currentStart == null) return 0
    const runs = (channelCurrentRun.get(key) || []).filter(
      (r) => r.runSessionId !== currentRunSessionId && r.startTime < currentStart
    )
    if (runs.length === 0) return 0
    await Promise.all(runs.map((r) => r.promise.catch(() => {})))
    return runs.length
  }

  return {
    channelCurrentRun,
    channelKeyByRunSessionId,
    runStartTimeBySessionId,
    abortedRunSessionIds,
    completedRunSessionIds,
    stopPreviousRunsForChannel,
    waitForPreviousRuns
  }
}

module.exports = { createChannelRunState }
