const {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  ipcMain,
  session,
  protocol,
  net,
  Notification: SystemNotification
} = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')
const https = require('https')
const http = require('http')
const { URL, pathToFileURL } = require('url')
const os = require('os')
const Store = (require('electron-store')).default || require('electron-store')
const invokeRegistry = require('./api/invokeRegistry')
const { createRegisterChannel } = require('./main-process/register-channel')
const { registerConfigHandlers } = require('./api/registerConfigHandlers')
const { createApiServer, DEFAULT_PORT: API_DEFAULT_PORT } = require('./api/server')
const { getAppRoot, getAppRootPath, getWorkspaceRoot, getWorkspacePath, ensureWorkspaceDirs } = require('./app-root')
const { ingestRoundAttachments } = require('./ai/attachment-ingest')
const artifactRegistry = require('./ai/artifact-registry')
const { resolveCapabilityRoute, detectRequestedExternalRuntime } = require('./ai/capability-router')
const { getLogPath, readTail, getForAi, logger: appLogger, patchConsole } = require('./app-logger')
const { registerWindowLogsAndNotificationsIpc } = require('./main-process/ipc/window-logs-notifications')
const { registerStoreConfigSnapshotIpc } = require('./main-process/ipc/store-config-snapshot')
const { registerFsDialogBasicIpc } = require('./main-process/ipc/fs-dialog-basic')
const { registerShellSpawnCommandIpc } = require('./main-process/ipc/shell-spawn-command')
const { registerExternalOpenIpc } = require('./main-process/ipc/external-open')
const { registerBrowserExtensionsIpc } = require('./main-process/ipc/browser-extensions')
const { registerCozeIpc } = require('./main-process/ipc/coze-ipc')
const { registerWorkspaceIpc } = require('./main-process/ipc/workspace-ipc')
const { registerWebAppsSettingsIpc } = require('./main-process/ipc/web-apps-settings-ipc')
const { registerCronIpc } = require('./main-process/ipc/cron-ipc')
const { createMcpHttpBridge } = require('./main-process/mcp-http-bridge')
const { createMainWindowController } = require('./main-process/main-window')
const {
  mergeContextCompressionFromLegacy,
  mergeToolDefinitionsFromLegacy,
  applyProxyEnvFromConfig
} = require('./main-process/proxy-and-ai-config-helpers')
const { registerLocalResourceProtocol } = require('./main-process/local-resource-protocol')
const {
  EXTERNAL_SUBAGENT_SPECS,
  createExternalSubagentCli,
  getExternalEnvVariants
} = require('./main-process/external-subagent-cli')
const { stripRawToolCallXml } = require('./main-process/ipc/ai/chat-history-helpers')
const { registerAiToolsAttachmentsIpc } = require('./main-process/ipc/ai/ai-tools-attachments-ipc')
const { registerAiChatSessionIpc } = require('./main-process/ipc/ai/ai-chat-session-ipc')
const { FEISHU_PROJECT, TELEGRAM_PROJECT, DINGTALK_PROJECT } = require('./main-process/ipc/ai/session-constants')
const { stopAllWebAppServices } = require('./web-apps/process-manager')
const cronScheduler = require('./ai/cron-scheduler')
const feishuNotify = require('./ai/feishu-notify')
const { setupImChannels } = require('./main-process/im-channels-bootstrap')
const { createImChannelArtifactHandlers } = require('./main-process/im-channel-artifacts')
const { bootstrapAiCoreStack } = require('./main-process/ai-core-stack-bootstrap')
const { registerInvokeConfigForwardingIpc } = require('./main-process/invoke-config-ipc')
const { createSafeConsoleLoggers } = require('./main-process/safe-console')

// 将主进程 console 同时写入 ~/.openultron/logs/app.log，便于全局排查与 AI 分析
patchConsole()

const {
  runCliCommand,
  scanExternalSubAgents,
  normalizeExternalLogChunk,
  isExternalNetworkTimeoutChunk
} = createExternalSubagentCli({ spawn, getWorkspaceRoot, appLogger })

/** 统一注册：同一 handler 同时供 IPC（应用内）与 HTTP /api/invoke（浏览器/Node）调用，数据源一致 */
const registerChannel = createRegisterChannel(ipcMain, invokeRegistry)

const { createInboundMessageTextHelpers } = require('./ai/inbound-message-text')
const {
  extractLocalResourceScreenshots,
  extractLocalFilesFromText,
  isImageFilePath,
  getCurrentRoundMessages,
  extractScreenshotsFromMessages,
  parseScreenshotFromToolResult,
  redactSensitiveText,
  stripToolProtocolAndJsonNoise,
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
  hasScreenshotClaimText
} = createInboundMessageTextHelpers({
  path,
  fs,
  getAppRoot,
  getAppRootPath,
  stripRawToolCallXml
})

const inboundText = {
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
}

const {
  rememberSessionArtifacts,
  normalizeArtifactsFromItems,
  registerArtifactsFromItems,
  registerReferenceArtifactsFromMessages,
  attachArtifactsToLatestAssistant
} = createImChannelArtifactHandlers({
  path,
  fs,
  artifactRegistry,
  appLogger,
  getAssistantText
})

const { createEventBus } = require('./core/events')
const eventBus = createEventBus()

// 注册自定义协议（必须在 app ready 之前调用）
// local-resource:// 用于安全地向渲染进程提供应用数据根目录下的本地文件
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-resource', privileges: { secure: true, standard: true, supportFetchAPI: true, bypassCSP: false } }
])

const { safeLog, safeError } = createSafeConsoleLoggers()

// 保持对窗口对象的全局引用
let mainWindow
/** IM 管线在脚本末尾 setupImChannels 中赋值；此处占位避免 createMainWindowController 闭包引用 TDZ */
let startFeishuReceive = async () => {}
/** invokeRegistry API 监听端口；在 app.ready 内赋值，供 window-logs-notifications 与 before-quit 共用 */
const apiServerHolder = { server: null, port: null }
const mcpHttpBridge = createMcpHttpBridge({ http, path, fs, getMainWindow: () => mainWindow })

// 初始化 electron-store
const store = new Store({
  defaults: {
    savedConfigs: []
  }
})

// 统一数据源：注册到 invokeRegistry，供 IPC 与 HTTP API 共用（Node 直连 + 浏览器访问）
registerConfigHandlers(store)

// 开发环境判断
const isDev = process.env.NODE_ENV === 'development'

// 正式包 UI 端口 28789；开发环境 Vite 用 28791，与正式包同机不冲突
const APP_UI_PORT = 28789
const DEV_UI_PORT = 28791

const { startAppUiServer, createWindow, closeAppUiServer } = createMainWindowController({
  app,
  BrowserWindow,
  Menu,
  shell,
  path,
  fs,
  isDev,
  APP_UI_PORT,
  DEV_UI_PORT,
  safeLog,
  safeError,
  preloadPath: path.join(__dirname, 'preload.js'),
  distPath: path.join(__dirname, '../dist'),
  getMainWindow: () => mainWindow,
  assignMainWindow: (w) => { mainWindow = w },
  onDidFinishLoad: () => startFeishuReceive()
})

const { registerMainWindowTabForwarding } = require('./main-process/main-window-tab-forwarding')
registerMainWindowTabForwarding({ app, ipcMain, getMainWindow: () => mainWindow })

// 当 Electron 完成初始化并准备创建浏览器窗口时调用此方法
console.log('Electron app starting...')

registerWindowLogsAndNotificationsIpc({
  registerChannel,
  getLogPath,
  readTail,
  getForAi,
  BrowserWindow,
  SystemNotification,
  getMainWindow: () => mainWindow,
  getApiServerPort: () => apiServerHolder.port
})

registerInvokeConfigForwardingIpc({ ipcMain, invokeRegistry })

registerStoreConfigSnapshotIpc({ registerChannel, store })

registerFsDialogBasicIpc({
  registerChannel,
  dialog,
  getMainWindow: () => mainWindow
})

registerShellSpawnCommandIpc({ registerChannel })

registerExternalOpenIpc({
  registerChannel,
  shell,
  getAppRoot
})

registerWorkspaceIpc({
  registerChannel,
  store,
  dialog,
  getMainWindow: () => mainWindow,
  ensureWorkspaceDirs,
  getWorkspaceRoot,
  getWorkspacePath
})

registerWebAppsSettingsIpc({ registerChannel, store })

// Git 项目/分支/远程 UI 已移除，get-branch-*、refresh-remote 等 IPC 已删除


// app.whenReady / before-quit / activate：见文件末尾 registerAppWhenReady、registerAppQuitActivate

// Git/GitLab/GitHub/Gitee/editor-git、嵌入式 terminal/editor 预加载 API 已移除

registerBrowserExtensionsIpc({
  registerChannel,
  session,
  dialog,
  store,
  getMainWindow: () => mainWindow
})

registerCozeIpc({ registerChannel, store, https })

// ==================== AI Agent（Orchestrator / Gateway / 工具）— `main-process/ai-core-stack-bootstrap.js` ====================
const {
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
} = bootstrapAiCoreStack({
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
  getMainWindow: () => mainWindow,
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
})

registerAiToolsAttachmentsIpc({
  registerChannel,
  getToolsForChat,
  modelSupportsVision,
  ingestRoundAttachments,
  path,
  fs,
  artifactRegistry,
  appLogger
})
registerAiChatSessionIpc({ registerChannel, aiGateway })

// ==================== 飞书/Telegram/钉钉：适配器 + 入站管线 + channels IPC（见 im-channels-bootstrap.js） ====================
;({ startFeishuReceive } = setupImChannels({
  eventBus,
  path,
  fs,
  FEISHU_PROJECT,
  TELEGRAM_PROJECT,
  DINGTALK_PROJECT,
  getMainWindow: () => mainWindow,
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
}))

// Web 应用（~/.openultron/web-apps/）— docs/WEB-APPS-SANDBOX-DESIGN.md
try {
  require('./web-apps/registry').registerWebAppsIpc(registerChannel)
} catch (e) {
  console.warn('[web-apps] IPC 注册失败:', e.message)
}


registerCronIpc({ registerChannel, cronScheduler, feishuNotify, appLogger })

const { registerAppWhenReady } = require('./main-process/app-ready-bootstrap')
const { registerAppQuitActivate } = require('./main-process/app-quit-activate')

registerAppQuitActivate({
  app,
  session,
  BrowserWindow,
  getMainWindow: () => mainWindow,
  stopAllWebAppServices,
  mcpHttpBridge,
  apiServerHolder,
  aiGateway,
  closeAppUiServer,
  createWindow,
  skillsRt
})

registerAppWhenReady({
  app,
  session,
  registerLocalResourceProtocol,
  getAppRoot,
  path,
  fs,
  net,
  pathToFileURL,
  URL,
  createWindow,
  startAppUiServer,
  mcpHttpBridge,
  createApiServer,
  API_DEFAULT_PORT,
  aiGateway,
  startSavedMcpServers,
  appLogger,
  startHeartbeat,
  runHeartbeat,
  cronScheduler,
  startFeishuReceive,
  skillsRt,
  apiServerHolder
})
