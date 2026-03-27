/**
 * Skills / AI 配置 / MCP / Orchestrator / Gateway / 工具注册 / Heartbeat 运行器
 * 依赖 main 已就绪的 registerChannel、eventBus、入站文本 helpers 等。
 */
const { Orchestrator } = require('../ai/orchestrator')
const { McpManager } = require('../ai/mcp-client')
const { createDefaultRegistry } = require('../ai/tool-registry')
const { BUILTIN_SKILLS, REMOVED_BUILTIN_SKILL_IDS } = require('../ai/builtin-skills')
const { createSkillsRuntime } = require('./skills-runtime')
const aiConfigFile = require('../ai/ai-config-file')
const { ensurePromptsDirAndDefaults } = require('../ai/system-prompts')
const mcpConfigFile = require('../ai/mcp-config-file')
const conversationFile = require('../ai/conversation-file')
const { createChatHistoryHelpers } = require('./ipc/ai/chat-history-helpers')
const { createSessionPageTargetHelpers } = require('./im-channel-session-page-target')
const memoryStore = require('../ai/memory-store')
const commandExecutionLog = require('../ai/command-execution-log')
const sessionRegistry = require('../ai/session-registry')
const { finalizeAiModelFields } = require('../ai/ai-config-normalize')
const { createInboundModelCommandHandlers } = require('./inbound-model-command')
const { registerAgentMdIpc } = require('./ipc/agent-md-ipc')
const { registerSkillsIpc } = require('./ipc/skills-ipc')
const { registerMcpAdminIpc } = require('./ipc/mcp-admin-ipc')
const { registerBackupIpc } = require('./ipc/backup-ipc')
const { createMcpJsonConfigParsers } = require('./mcp-json-config')
const { createStartSavedMcpServers } = require('./mcp-start-saved')
const executorRegistry = require('../extensions/executor-registry')
const hardwareRegistry = require('../extensions/hardware-registry')
const { createAiChatArtifactRegistrars } = require('./ai-chat-artifacts')
const { createChannelRunState } = require('./channel-run-state')
const { createSubagentDispatch } = require('./subagent-dispatch')
const { registerGatewaySessionIpc, getCurrentOpenSession } = require('./ipc/ai')
const { createGateway } = require('../ai/gateway')
const { registerAiHistoryIpc } = require('./ipc/ai/ai-history-ipc')
const { registerAiVerifyModelIpc } = require('./ipc/ai/ai-verify-model-ipc')
const { registerAiConfigProxyIpc } = require('./ipc/ai/ai-config-proxy-ipc')
const { registerAiModelsIpc } = require('./ipc/ai/ai-models-ipc')
const { registerAiExternalSubagentsIpc } = require('./ipc/ai/ai-external-subagents-ipc')
const { createAiChatToolsAccess } = require('./ai-chat-tools-access')
const { createImChannelMasterAgentFallbacks } = require('./im-channel-master-agent-fallbacks')
const { createGatewaySideEffectHandlers } = require('./ipc/ai/gateway-side-effects')
const { createAiResolvedConfig } = require('./ai-resolved-config')
const { createVerifyProviderModel } = require('./verify-provider-model')
const { createConfiguredProviderHelpers } = require('./ai-configured-providers')
const { createVisionModelSupport } = require('./vision-model-support')
const { createHeartbeatRunner } = require('./heartbeat-runner')
const skillPack = require('../ai/skill-pack')
const { filterSessionsList, isRunSessionId } = require('../ai/sessions-list-filter')
const { FEISHU_PROJECT } = require('./ipc/ai/session-constants')
const { registerMidStackAiTools, registerPostGatewayAiTools } = require('./ai-core-register-late-tools')

executorRegistry.register(require('../extensions/executors/shell'))
executorRegistry.register(require('../extensions/executors/python'))
executorRegistry.register(require('../extensions/executors/node'))

hardwareRegistry.register(require('../extensions/hardware/screen'))
hardwareRegistry.register(require('../extensions/hardware/notify'))

function bootstrapAiCoreStack(deps) {
  const {
    registerChannel,
    app,
    store,
    BrowserWindow,
    path,
    fs,
    getAppRoot,
    getAppRootPath,
    getWorkspaceRoot,
    https,
    http,
    URL,
    os,
    dialog,
    shell,
    artifactRegistry,
    cronScheduler,
    eventBus,
    isDev,
    appLogger,
    getMainWindow,
    mergeContextCompressionFromLegacy,
    mergeToolDefinitionsFromLegacy,
    applyProxyEnvFromConfig,
    ensureWorkspaceDirs,
    inboundText,
    runCliCommand,
    normalizeExternalLogChunk,
    isExternalNetworkTimeoutChunk,
    getExternalEnvVariants,
    scanExternalSubAgents,
    EXTERNAL_SUBAGENT_SPECS,
    resolveCapabilityRoute,
    detectRequestedExternalRuntime,
    registerReferenceArtifactsFromMessages,
    normalizeArtifactsFromItems
  } = deps

  const {
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
    extractLatestVisibleText,
    overwriteLatestAssistantText,
    looksLikeNoResultPlaceholderText,
    hasUsefulVisibleResult,
    compactSpawnResultText,
    looksLikeGenericGreeting,
    stripDispatchBoilerplateText,
    hasScreenshotClaimText,
    stripToolProtocolAndJsonNoise,
    redactSensitiveText
  } = inboundText

  const skillsRt = createSkillsRuntime({
    path,
    fs,
    getAppRootPath,
    store,
    BUILTIN_SKILLS,
    REMOVED_BUILTIN_SKILL_IDS,
    getMainWindow
  })
  skillsRt.bootstrap()
  registerSkillsIpc({
    registerChannel,
    store,
    path,
    fs,
    BUILTIN_SKILLS,
    skillsDir: skillsRt.skillsDir,
    readAllSkills: skillsRt.readAllSkills,
    writeSkillFile: skillsRt.writeSkillFile,
    ensureSkillsDir: skillsRt.ensureSkillsDir,
    getSkillsCache: skillsRt.getSkillsCache,
    setSkillsCache: skillsRt.setSkillsCache
  })

  const {
    persistToolArtifactsToRegistry,
    stripToolExecutionFromMessages,
    mergeCompactedConversationMessages
  } = createChatHistoryHelpers({ path, fs, getAppRoot, getAppRootPath, artifactRegistry, conversationFile })

  const { findRecentPageTarget } = createSessionPageTargetHelpers({
    conversationFile,
    path,
    fs,
    getWorkspaceRoot,
    getAssistantText,
    extractLocalFilesFromText
  })

  registerAgentMdIpc({ registerChannel, getAppRootPath, memoryStore, shell })

  const { parseInboundModelCommand, applyGlobalDefaultModel } = createInboundModelCommandHandlers({
    app,
    store,
    BrowserWindow,
    aiConfigFile
  })

  function getAIConfigLegacy() {
    const data = aiConfigFile.readAIConfig(app, store)
    return aiConfigFile.toLegacyConfig(data)
  }

  const { modelSupportsVision } = createVisionModelSupport({ getAIConfigLegacy, store })

  const { getResolvedAIConfig, getResolvedAIConfigForProvider } = createAiResolvedConfig({
    getAIConfigLegacy,
    store,
    mergeContextCompressionFromLegacy,
    mergeToolDefinitionsFromLegacy
  })
  const { verifyProviderModel } = createVerifyProviderModel({
    https,
    http,
    URL,
    getResolvedAIConfig,
    getResolvedAIConfigForProvider
  })
  const { getConfiguredProvidersWithKey, orderProvidersForModel } = createConfiguredProviderHelpers({ getAIConfigLegacy })

  aiConfigFile.ensureAIConfigFile(app, store)
  ensurePromptsDirAndDefaults()
  ensureWorkspaceDirs()

  applyProxyEnvFromConfig()

  function writeAIConfigFromTool(data) {
    aiConfigFile.writeAIConfig(app, data)
    BrowserWindow.getAllWindows().forEach((win) => {
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('ai-config-updated')
      }
    })
  }

  const aiMcpManager = new McpManager()
  const { BUILTIN_CHROME_DEVTOOLS_MCP, parseMcpJsonConfig } = createMcpJsonConfigParsers({
    path,
    os,
    getAppRootPath
  })

  registerMcpAdminIpc({
    registerChannel,
    store,
    path,
    fs,
    os,
    mcpConfigFile,
    builtinChromeDevtoolsMcp: BUILTIN_CHROME_DEVTOOLS_MCP,
    aiMcpManager,
    parseMcpJsonConfig
  })
  registerBackupIpc({
    registerChannel,
    path,
    fs,
    os,
    app,
    store,
    dialog,
    getAppRoot,
    mcpConfigFile,
    aiMcpManager,
    parseMcpJsonConfig,
    aiConfigFile,
    BrowserWindow,
    ensureSkillsDir: skillsRt.ensureSkillsDir,
    skillsDir: skillsRt.skillsDir,
    readAllSkills: skillsRt.readAllSkills,
    setSkillsCache: skillsRt.setSkillsCache
  })

  const startSavedMcpServers = createStartSavedMcpServers({
    mcpConfigFile,
    store,
    parseMcpJsonConfig,
    aiMcpManager,
    appLogger
  })

  const aiToolRegistry = createDefaultRegistry({
    store,
    getAIConfig: getAIConfigLegacy,
    writeAIConfig: writeAIConfigFromTool,
    getValidatedModelsForBaseUrl: (baseUrl) => {
      const v = store.get('aiModelsValidatedByProvider', {})
      return v[baseUrl] || []
    },
    mcpManager: aiMcpManager,
    skillsDir: skillsRt.skillsDir,
    getSkills: (opts) => {
      skillsRt.setSkillsCache(skillsRt.readAllSkills(opts || {}))
      return skillsRt.getSkillsCache()
    },
    getSandboxSkills: () => skillsRt.readSandboxSkills(),
    getSkillsSources: () => require('../openultron-config').getSkillsSources(),
    onSkillChanged: () => skillsRt.refreshSkillsCacheAndNotify()
  })

  const { registerImageBase64ForChat, registerScreenshotFilePathForChat } = createAiChatArtifactRegistrars({
    path,
    fs,
    getAppRoot,
    getAppRootPath,
    artifactRegistry,
    appLogger
  })

  const aiOrchestrator = new Orchestrator(getAIConfigLegacy, aiToolRegistry, aiMcpManager, {
    registerImageBase64: registerImageBase64ForChat,
    registerScreenshotPath: registerScreenshotFilePathForChat,
    getSkillsForPrompt: (projectPath) => {
      try {
        return skillPack.filterSkillsForModelPrompt(skillsRt.readAllSkills({ projectPath }))
      } catch {
        return []
      }
    }
  })

  const {
    channelCurrentRun,
    channelKeyByRunSessionId,
    runStartTimeBySessionId,
    abortedRunSessionIds,
    completedRunSessionIds,
    stopPreviousRunsForChannel,
    waitForPreviousRuns
  } = createChannelRunState({ aiOrchestrator })

  const subagentChatToolsRef = { getToolsForSubChat: null }
  const { runSubChat } = createSubagentDispatch({
    path,
    fs,
    getWorkspaceRoot,
    runCliCommand,
    normalizeExternalLogChunk,
    isExternalNetworkTimeoutChunk,
    getExternalEnvVariants,
    appLogger,
    findRecentPageTarget,
    conversationFile,
    getAssistantText,
    getResolvedAIConfigForProvider,
    getResolvedAIConfig,
    aiOrchestrator,
    getToolsForSubChat: () =>
      typeof subagentChatToolsRef.getToolsForSubChat === 'function' ? subagentChatToolsRef.getToolsForSubChat() : [],
    extractLatestVisibleText,
    stripToolProtocolAndJsonNoise,
    looksLikeNoResultPlaceholderText,
    resolveCapabilityRoute,
    detectRequestedExternalRuntime,
    scanExternalSubAgents,
    EXTERNAL_SUBAGENT_SPECS,
    sessionRegistry
  })

  const GATEWAY_PORT_PROD = 28790
  const GATEWAY_PORT_DEV = 28792
  registerGatewaySessionIpc({
    registerChannel,
    isDev,
    gatewayPortProd: GATEWAY_PORT_PROD,
    gatewayPortDev: GATEWAY_PORT_DEV
  })

  const { triggerAutoEvolveFromSession } = registerAiHistoryIpc({
    registerChannel,
    conversationFile,
    persistToolArtifactsToRegistry,
    stripToolExecutionFromMessages,
    memoryStore,
    commandExecutionLog,
    getResolvedAIConfig,
    aiOrchestrator,
    appLogger,
    getWorkspaceRoot,
    filterSessionsList
  })

  registerAiConfigProxyIpc({
    registerChannel,
    app,
    store,
    BrowserWindow,
    aiConfigFile,
    getAIConfigLegacy,
    applyProxyEnvFromConfig,
    finalizeAiModelFields,
    path,
    fs,
    os,
    aiOrchestrator
  })
  registerAiModelsIpc({ registerChannel, getAIConfigLegacy, store, https, http })

  registerAiVerifyModelIpc({
    registerChannel,
    verifyProviderModel,
    orderProvidersForModel,
    getConfiguredProvidersWithKey
  })

  registerAiExternalSubagentsIpc({ registerChannel, scanExternalSubAgents })

  registerMidStackAiTools({
    aiToolRegistry,
    runSubChat,
    getResolvedAIConfig,
    aiOrchestrator,
    appLogger,
    getAIConfigLegacy,
    store,
    verifyProviderModel
  })

  const {
    getToolsForChat,
    getToolsForChatWithWait,
    getToolsForSubChat,
    getToolsForCoordinatorChat,
    getCoordinatorSystemPrompt
  } = createAiChatToolsAccess({ aiToolRegistry, aiMcpManager, store, appLogger })
  subagentChatToolsRef.getToolsForSubChat = getToolsForSubChat

  const { runMainAgentDirectRetry } = createImChannelMasterAgentFallbacks({
    stripToolProtocolAndJsonNoise,
    parseScreenshotFromToolResult,
    getToolsForSubChat,
    path,
    getWorkspaceRoot,
    getAssistantText,
    getCurrentRoundMessages,
    extractLatestVisibleText,
    extractLocalResourceScreenshots,
    extractScreenshotsFromMessages,
    stripFeishuScreenshotMisfireText,
    extractLocalFilesFromText,
    isImageFilePath
  })

  const gatewaySideEffects = createGatewaySideEffectHandlers({
    BrowserWindow,
    eventBus,
    conversationFile,
    parseScreenshotFromToolResult,
    extractLocalResourceScreenshots,
    extractLatestSessionsSpawnResult,
    extractLatestVisibleText,
    stripFeishuScreenshotMisfireText,
    extractLocalFilesFromText,
    isImageFilePath,
    getWorkspaceRoot,
    registerReferenceArtifactsFromMessages,
    stripToolProtocolAndJsonNoise,
    hasUsefulVisibleResult,
    stripFalseDeliveredClaims,
    normalizeArtifactsFromItems,
    stripToolExecutionFromMessages,
    getMainWindow,
    appLogger,
    redactSensitiveText,
    persistToolArtifactsToRegistry,
    mergeCompactedConversationMessages,
    isRunSessionId
  })

  const aiGateway = createGateway({
    port: isDev ? GATEWAY_PORT_DEV : GATEWAY_PORT_PROD,
    getOrchestrator: () => aiOrchestrator,
    getResolvedConfig: getResolvedAIConfig,
    getToolDefinitions: (params) =>
      getToolsForChatWithWait({
        excludeChannelSend: !params?.feishuChatId && params?.projectPath !== FEISHU_PROJECT,
        projectPath: params?.projectPath != null ? String(params.projectPath) : ''
      }),
    getCurrentOpenSession,
    getConfigForGateway: () => {
      const c = getResolvedAIConfig()
      return { defaultModel: c.defaultModel, apiBaseUrl: c.apiBaseUrl, temperature: c.temperature, maxTokens: c.maxTokens }
    },
    getCronStatus: () => ({ tasks: cronScheduler.listTasks() }),
    ...gatewaySideEffects
  })

  const { startHeartbeat, runHeartbeat } = createHeartbeatRunner({
    getAppRootPath,
    fs,
    getAIConfigLegacy,
    aiGateway,
    getToolsForChat,
    getWorkspaceRoot
  })

  registerPostGatewayAiTools({
    aiToolRegistry,
    aiGateway,
    stopPreviousRunsForChannel,
    waitForPreviousRuns
  })

  return {
    skillsRt,
    getAIConfigLegacy,
    modelSupportsVision,
    conversationFile,
    sessionRegistry,
    parseInboundModelCommand,
    applyGlobalDefaultModel,
    stripToolExecutionFromMessages,
    triggerAutoEvolveFromSession,
    runMainAgentDirectRetry,
    getToolsForCoordinatorChat,
    getCoordinatorSystemPrompt,
    aiGateway,
    getToolsForChat,
    hardwareRegistry,
    channelCurrentRun,
    channelKeyByRunSessionId,
    runStartTimeBySessionId,
    abortedRunSessionIds,
    completedRunSessionIds,
    startSavedMcpServers,
    startHeartbeat,
    runHeartbeat
  }
}

module.exports = { bootstrapAiCoreStack }
