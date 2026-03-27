const chatChannelRegistry = require('../extensions/chat-channel-registry')
const { createFeishuAdapter } = require('../extensions/adapters/feishu')
const { createTelegramAdapter } = require('../extensions/adapters/telegram')
const { createDingtalkAdapter } = require('../extensions/adapters/dingtalk')
const openultronConfigChannels = require('../openultron-config')
const feishuWsReceive = require('../ai/feishu-ws-receive')
const { registerImChannelMessagePipeline } = require('./im-channel-message-pipeline')
const { registerChannelsSessionCompletedSend } = require('./ipc/channels-session-completed-send')
const { registerChannelsImIpc } = require('./ipc/channels-im-ipc')

/**
 * 注册飞书/Telegram/钉钉适配器、入站管线、会话完成回发、channels IPC
 */
function setupImChannels(deps) {
  const {
    eventBus,
    path,
    fs,
    FEISHU_PROJECT,
    TELEGRAM_PROJECT,
    DINGTALK_PROJECT,
    getMainWindow,
    feishuNotify,
    appLogger,
    conversationFile,
    artifactRegistry,
    sessionRegistry,
    getWorkspaceRoot,
    getAIConfigLegacy,
    stripToolExecutionFromMessages,
    parseInboundModelCommand,
    applyGlobalDefaultModel,
    registerArtifactsFromItems,
    registerReferenceArtifactsFromMessages,
    normalizeArtifactsFromItems,
    attachArtifactsToLatestAssistant,
    triggerAutoEvolveFromSession,
    runMainAgentDirectRetry,
    getToolsForCoordinatorChat,
    getCoordinatorSystemPrompt,
    aiGateway,
    extractLocalResourceScreenshots,
    extractLocalFilesFromText,
    isImageFilePath,
    getCurrentRoundMessages,
    extractScreenshotsFromMessages,
    parseScreenshotFromToolResult,
    stripFeishuScreenshotMisfireText,
    stripFalseDeliveredClaims,
    getAssistantText,
    extractLatestSessionsSpawnResult,
    compactSpawnResultText,
    extractLatestVisibleText,
    overwriteLatestAssistantText,
    looksLikeNoResultPlaceholderText,
    hasUsefulVisibleResult,
    stripToolProtocolAndJsonNoise,
    redactSensitiveText,
    looksLikeGenericGreeting,
    stripDispatchBoilerplateText,
    hasScreenshotClaimText,
    registerChannel,
    rememberSessionArtifacts,
    getAppRoot,
    hardwareRegistry,
    getToolsForChat,
    shell,
    cronScheduler,
    channelCurrentRun,
    channelKeyByRunSessionId,
    runStartTimeBySessionId,
    abortedRunSessionIds,
    completedRunSessionIds
  } = deps

  function getChannelConfig(key) {
    if (key === 'feishu') return openultronConfigChannels.getFeishu()
    if (key === 'telegram') return openultronConfigChannels.getTelegram()
    if (key === 'dingtalk') return openultronConfigChannels.getDingtalk()
    return null
  }

  chatChannelRegistry.register(createFeishuAdapter(eventBus, getChannelConfig))
  chatChannelRegistry.register(createTelegramAdapter(eventBus, getChannelConfig))
  chatChannelRegistry.register(createDingtalkAdapter(eventBus, getChannelConfig))

  registerImChannelMessagePipeline({
    eventBus,
    path,
    fs,
    FEISHU_PROJECT,
    TELEGRAM_PROJECT,
    DINGTALK_PROJECT,
    channelCurrentRun,
    channelKeyByRunSessionId,
    runStartTimeBySessionId,
    abortedRunSessionIds,
    completedRunSessionIds,
    getMainWindow,
    feishuNotify,
    appLogger,
    conversationFile,
    artifactRegistry,
    sessionRegistry,
    getWorkspaceRoot,
    getAIConfigLegacy,
    stripToolExecutionFromMessages,
    parseInboundModelCommand,
    applyGlobalDefaultModel,
    registerArtifactsFromItems,
    registerReferenceArtifactsFromMessages,
    normalizeArtifactsFromItems,
    attachArtifactsToLatestAssistant,
    triggerAutoEvolveFromSession,
    runMainAgentDirectRetry,
    getToolsForCoordinatorChat,
    getCoordinatorSystemPrompt,
    aiGateway,
    extractLocalResourceScreenshots,
    extractLocalFilesFromText,
    isImageFilePath,
    getCurrentRoundMessages,
    extractScreenshotsFromMessages,
    parseScreenshotFromToolResult,
    stripFeishuScreenshotMisfireText,
    stripFalseDeliveredClaims,
    getAssistantText,
    extractLatestSessionsSpawnResult,
    compactSpawnResultText,
    extractLatestVisibleText,
    overwriteLatestAssistantText,
    looksLikeNoResultPlaceholderText,
    hasUsefulVisibleResult,
    stripToolProtocolAndJsonNoise,
    redactSensitiveText,
    looksLikeGenericGreeting,
    stripDispatchBoilerplateText,
    hasScreenshotClaimText
  })

  registerChannelsSessionCompletedSend({
    eventBus,
    chatChannelRegistry,
    registerArtifactsFromItems,
    rememberSessionArtifacts,
    appLogger,
    feishuNotify
  })

  function getConfigForChannels(key) {
    if (key === 'feishu') return feishuNotify.getConfig()
    if (key === 'telegram') return openultronConfigChannels.getTelegram()
    if (key === 'dingtalk') return openultronConfigChannels.getDingtalk()
    return null
  }

  function startFeishuReceive() {
    return chatChannelRegistry.startAll(getConfigForChannels).catch((e) => {
      console.warn('[Feishu] 接收启动失败:', e.message)
      throw e
    })
  }

  registerChannelsImIpc({
    registerChannel,
    chatChannelRegistry,
    feishuWsReceive,
    startFeishuReceive,
    aiGateway,
    getAppRoot,
    fs,
    hardwareRegistry,
    getToolsForChat,
    appLogger,
    shell,
    cronScheduler,
    feishuNotify
  })

  return { startFeishuReceive }
}

module.exports = { setupImChannels }
