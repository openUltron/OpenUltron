/**
 * 浏览器环境完整 polyfill：无 Electron 时通过 HTTP 调用同一后端，与应用内 IPC 数据源一致。
 * 所有 invoke 类 API 均可用；事件类（onXxx）在浏览器下多为 no-op（需后端 WebSocket 才能实现推送）。
 * 需先启动 OpenUltron 桌面应用，API 默认 http://127.0.0.1:38472
 */

const DEFAULT_API_BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE) || 'http://127.0.0.1:38472'

async function httpInvoke(baseUrl, channel, args = []) {
  const res = await fetch(`${baseUrl}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args: Array.isArray(args) ? args : [args] })
  })
  const json = await res.json()
  if (!json.success) throw new Error(json.error || 'API error')
  return json.data
}

function noop() {}
function noopListener(name) {
  return () => console.warn('[OpenUltron polyfill] 事件在浏览器下不可用:', name)
}

export function installBrowserPolyfill(baseUrl = DEFAULT_API_BASE) {
  if (typeof window === 'undefined' || window.electronAPI) return

  const invoke = (channel, ...args) =>
    httpInvoke(baseUrl, channel, args.length === 1 && Array.isArray(args[0]) ? args[0] : args)

  const noopOn = (name) => (cb) => { noopListener(name)(cb); return noop }
  const noopRemove = () => {}

  // Gateway WebSocket 端口（与主进程 gateway.js 一致，28790 与 UI 端口 28789 分离）
  const GATEWAY_WS_PORT = 28790
  const gatewayWsUrl = `ws://127.0.0.1:${GATEWAY_WS_PORT}`

  window.electronAPI = {
    getApiBaseUrl: () => Promise.resolve({ url: baseUrl, port: (baseUrl.match(/:(\d+)$/) || [])[1] || '38472' }),
    isBrowserMode: true,
    gatewayWsUrl,
    invoke,

    // 配置与存储
    getConfig: (key) => invoke('get-config', [key]),
    setConfig: (key, value) => invoke('set-config', [key, value]),
    getAllConfigs: () => invoke('get-all-configs', []),
    saveConfig: (data) => invoke('save-config', [data]),
    getSavedConfigs: () => invoke('get-saved-configs', []),
    saveSavedConfigs: (data) => invoke('save-saved-configs', [data]),
    getCurrentConfig: (data) => invoke('get-current-config', [data]),
    setCurrentConfig: (data) => invoke('set-current-config', [data]),
    deleteSavedConfig: (index) => invoke('delete-saved-config', [index]),

    // 文件与对话框
    showOpenDialog: (options) => invoke('show-open-dialog', [options]),
    showSaveDialog: (options) => invoke('show-save-dialog', [options]),
    readImageAsBase64: (filePath) => invoke('read-image-as-base64', [filePath]),
    saveFile: (data) => invoke('save-file', [data]),
    readFile: (filePath) => invoke('read-file', [filePath]),

    // 命令与外部
    executeCommand: (data) => invoke('execute-command', [data]),
    executeCommandRealtime: (data) => invoke('execute-command-realtime', [data]),
    killCommandProcess: (processId) => invoke('kill-command-process', [{ processId }]),
    openCursor: (data) => invoke('open-cursor', [data]),
    openTerminal: (data) => invoke('open-terminal', [data]),
    openExternal: (url) => invoke('open-external', [url]),
    openInFinder: (data) => invoke('open-in-finder', [data]),
    getAvailableTerminals: () => invoke('get-available-terminals', []),
    openTerminalApp: (data) => invoke('open-terminal', [data]),

    // 标签/刷新/窗口（事件类在浏览器下 no-op）
    sendRefreshOnFocus: () => invoke('send-refresh-on-focus', []),
    notifyRefreshComplete: () => invoke('notify-refresh-complete', []),
    showSystemNotification: () => Promise.resolve({ success: false, error: 'browser' }),
    logToFrontend: (message) => invoke('log-to-frontend', [message]),
    toggleMaximize: () => invoke('toggle-maximize', []),

    openUrlInNewTab: (url) => { try { window.open(url) } catch (_) { noop() } },

    // 事件监听：浏览器下无 IPC 推送，提供 no-op 避免报错
    onCommandProcessId: (cb) => noopOn('command-process-id')(cb),
    removeCommandProcessIdListener: noopRemove,
    onRefreshCurrentTab: noopOn('refresh-current-tab'),
    removeRefreshCurrentTabListener: noopRemove,
    onRefreshOnFocus: noopOn('refresh-on-focus'),
    removeRefreshOnFocusListener: noopRemove,
    onRefreshComplete: noopOn('refresh-complete'),
    removeRefreshCompleteListener: noopRemove,
    onRealtimeCommandOutput: noopOn('realtime-command-output'),
    removeRealtimeCommandOutputListener: noopRemove,
    onOpenUrlInNewTab: noopOn('open-url-in-new-tab'),
    removeOpenUrlInNewTabListener: noopRemove,
    onOpenWebviewDevTools: noopOn('open-webview-devtools'),
    removeOpenWebviewDevToolsListener: noopRemove,
    onMcpOpenFile: (cb) => noopOn('mcp-open-file')(cb),
    removeMcpOpenFileListener: noopRemove,
    onMcpOpenDiff: (cb) => noopOn('mcp-open-diff')(cb),
    removeMcpOpenDiffListener: noopRemove,

    workspace: {
      getDefaults: () => invoke('workspace-get-defaults', []),
      load: (data) => invoke('workspace-load', [data]),
      save: (data) => invoke('workspace-save', [data]),
      pickFolder: () => invoke('workspace-pick-folder', []),
      resolvePath: (data) => invoke('workspace-resolve-path', [data]),
      searchFiles: (data) => invoke('workspace-search-files', [data])
    },

    getExtensions: () => invoke('get-extensions', []),
    loadExtensionFromFolder: () => invoke('load-extension-from-folder', []),
    loadExtensionFromCrx: () => invoke('load-extension-from-crx', []),
    loadExtensionFromChrome: () => invoke('load-extension-from-chrome', []),
    loadExtensionById: (extensionId) => invoke('load-extension-by-id', [extensionId]),
    toggleExtension: (extensionId, enabled) => invoke('toggle-extension', [extensionId, enabled]),
    removeExtension: (extensionId) => invoke('remove-extension', [extensionId]),

    // AI
    ai: {
      getConfig: () => invoke('ai-get-config', []),
      getOnboardingStatus: () => invoke('ai-get-onboarding-status', []),
      getProxyConfig: () => invoke('proxy-get-config', []),
      saveProxyConfig: (data) => invoke('proxy-save-config', [data]),
      saveConfig: (config) => invoke('ai-save-config', [config]),
      getConfigForBackup: () => invoke('ai-get-config-for-backup', []),
      restoreConfigFromBackup: (payload) => invoke('ai-restore-config-from-backup', [payload]),
      fetchModels: (options) => invoke('ai-fetch-models', [options]),
      getModels: (providerBaseUrl) => invoke('ai-get-models', [providerBaseUrl]),
      verifyModel: (data) => invoke('ai-verify-model', [data]),
      modelSupportsVision: (data) => invoke('ai-model-supports-vision', [data]),
      getTools: () => invoke('ai-get-tools', []),
      // 浏览器模式下 chatStart 由 useAIChat 走 Gateway WebSocket，此处仅作兜底（会阻塞到完整响应）
      chatStart: (data) => invoke('ai-chat-start', [data]),
      chatStop: (data) => invoke('ai-chat-stop', [data]),
      uploadAttachments: (data) => invoke('ai-upload-attachments', [data]),
      generateCommitMessage: (data) => invoke('ai-generate-commit-message', [data]),
      readAgentMd: (data) => invoke('ai-read-agent-md', [data]),
      confirmResponse: (data) => invoke('ai-chat-confirm-response', [data]),
      saveChatHistory: (data) => invoke('ai-save-chat-history', [data]),
      loadChatHistory: (data) => invoke('ai-load-chat-history', [data]),
      clearChatHistory: (data) => invoke('ai-clear-chat-history', [data]),
      saveSessionSummary: (data) => invoke('ai-save-session-summary', [data]),
      listSessionSummaries: (data) => invoke('ai-list-session-summaries', [data]),
      evolveFromSession: (data) => invoke('ai-evolve-from-session', [data]).catch(() => ({ success: true })),
      consolidateLessonsLearned: () => invoke('ai-consolidate-lessons-learned', []).catch(() => ({ success: false })),
      listConversations: (data) => invoke('ai-list-conversations', [data]),
      renameConversation: (data) => invoke('ai-rename-conversation', [data]),
      getSessions: () => invoke('ai-get-sessions', []),
      listAllSessions: () => invoke('ai-list-all-sessions', []),
      updateSessionStats: (data) => invoke('ai-update-session-stats', [data]),
      saveSession: (data) => invoke('ai-save-session', [data]),
      deleteSession: (data) => invoke('ai-delete-session', [data]),
      getSkills: (opts) => invoke('ai-get-skills', [opts || {}]),
      saveSkill: (skill) => invoke('ai-save-skill', [skill]),
      deleteSkill: (data) => invoke('ai-delete-skill', [data]),
      getSoulMdPath: () => invoke('ai-get-soul-md-path', []),
      openSoulMd: () => invoke('ai-open-soul-md', []),
      getIdentityMdPath: () => invoke('ai-get-identity-md-path', []),
      openIdentityMd: () => invoke('ai-open-identity-md', []),
      getAgentDisplayName: () => invoke('ai-get-agent-display-name', []).then(r => r?.name ?? null),
      getUserMdPath: () => invoke('ai-get-user-md-path', []),
      openUserMd: () => invoke('ai-open-user-md', []),
      getBootMdPath: () => invoke('ai-get-boot-md-path', []),
      openBootMd: () => invoke('ai-open-boot-md', []),
      getMcpConfig: () => invoke('ai-get-mcp-config', []),
      saveMcpConfig: (data) => invoke('ai-save-mcp-config', [data]),
      importClaudeMcp: () => invoke('ai-import-claude-mcp', []),
      getMcpStatus: () => invoke('ai-get-mcp-status', []),
      reconnectMcp: () => invoke('ai-reconnect-mcp', []),
      getMcpDisabled: () => invoke('ai-get-mcp-disabled', []),
      toggleMcpServer: (data) => invoke('ai-toggle-mcp-server', [data]),
      restartMcpServer: (data) => invoke('ai-restart-mcp-server', [data]),
      sessionRegisterView: (data) => invoke('ai-session-register-view', [data]),
      sessionUnregisterView: (data) => invoke('ai-session-unregister-view', [data]),
      sessionUpdateMeta: (data) => invoke('ai-session-update-meta', [data]),
      sessionList: () => invoke('ai-session-list', []),
      sessionPause: (data) => invoke('ai-session-pause', [data]),
      sessionResume: (data) => invoke('ai-session-resume', [data]),
      sessionStop: (data) => invoke('ai-session-stop', [data]),
      sessionInject: (data) => invoke('ai-session-inject', [data]),
      exportBackup: () => invoke('ai-export-backup', []),
      importBackup: (data) => invoke('ai-import-backup', [data]),
      backupExport: (options) => invoke('ai-backup-export', [{ options }]),
      backupPreview: () => invoke('ai-backup-preview', []),
      backupRestore: (data) => invoke('ai-backup-restore', [data]),
      exportSkillsPack: (opts) => invoke('ai-export-skills-pack', [opts || {}]),
      importSkillsPack: (opts) => invoke('ai-import-skills-pack', [opts || {}]),
      listWebApps: () => invoke('web-apps-list', []),
      getWebApp: (data) => invoke('web-apps-get', [data]),
      previewWebApp: (data) => invoke('web-apps-preview-url', [data]),
      importWebAppZip: (data) => invoke('web-apps-import-zip', [data || {}]),
      exportWebAppZip: (data) => invoke('web-apps-export-zip', [data]),
      deleteWebApp: (data) => invoke('web-apps-delete', [data || {}]),
      installWebAppSample: () => invoke('web-apps-install-sample', []),
      createWebApp: (data) => invoke('web-apps-create', [data || {}]),
      updateWebAppName: (data) => invoke('web-apps-update-name', [data || {}]),
      startWebAppService: (data) => invoke('web-apps-service-start', [data || {}]),
      stopWebAppService: (data) => invoke('web-apps-service-stop', [data || {}]),
      getWebAppServiceStatus: (data) => invoke('web-apps-service-status', [data || {}]),
      getWebAppServiceLogs: (data) => invoke('web-apps-service-logs', [data || {}]),
      getWebAppAiSettings: () => invoke('web-apps-get-ai-settings', []),
      setWebAppAiSettings: (data) => invoke('web-apps-set-ai-settings', [data || {}]),
      getUsage: (params) => invoke('ai-get-usage', [params]),
      getBilling: (params) => invoke('ai-get-billing', [params]),
      onToken: noopOn('ai-chat-token'),
      onUsage: noopOn('ai-chat-usage'),
      onToolCall: noopOn('ai-chat-tool-call'),
      onToolResult: noopOn('ai-chat-tool-result'),
      onComplete: noopOn('ai-chat-complete'),
      onError: noopOn('ai-chat-error'),
      onConfirmRequest: noopOn('ai-chat-confirm-request'),
      onAIConfigUpdated: noopOn('ai-config-updated'),
      removeAIConfigUpdatedListener: noopRemove,
      removeAllListeners: noopRemove,
      onSessionInjectToPanel: noopOn('ai-session-inject-to-panel'),
      onFeishuSessionUpdated: noopOn('feishu-session-updated'),
      onGatewaySessionUpdated: noopOn('gateway-session-updated'),
      onGatewayRemoteUserMessage: noopOn('gateway-remote-user-message'),
      reportCurrentSession: () => Promise.resolve({ ok: true }),
      onFeishuSessionUserMessage: noopOn('feishu-session-user-message'),
      removeFeishuSessionListeners: noopRemove,
      removeSessionListeners: noopRemove
    },

    feishu: {
      getConfig: () => invoke('feishu-get-config', []),
      setConfig: (payload) => invoke('feishu-set-config', [payload]),
      authorizeUserToken: () => invoke('feishu-authorize-user-token', []),
      sendMessage: (options) => invoke('feishu-send-message', [options]),
      receiveStatus: () => invoke('feishu-receive-status', []),
      receiveStart: () => invoke('feishu-receive-start', []),
      receiveStop: () => invoke('feishu-receive-stop', [])
    },

    imCoordinator: {
      getConfig: () => invoke('im-coordinator-get-config', []),
      setConfig: (payload) => invoke('im-coordinator-set-config', [payload || {}])
    },

    cron: {
      list: () => invoke('cron-list', []),
      add: (task) => invoke('cron-add', [task]),
      update: (taskId, updates) => invoke('cron-update', [{ taskId, updates }]),
      remove: (taskId) => invoke('cron-remove', [taskId]),
      runNow: (taskId) => invoke('cron-run-now', [taskId])
    },

    coze: {
      getConfig: () => invoke('get-coze-config', []),
      saveConfig: (data) => invoke('save-coze-config', [data]),
      checkAuth: () => invoke('coze-check-auth', []),
      logout: () => invoke('coze-logout', []),
      generateCommitMessage: (data) => invoke('coze-generate-commit-message', [data])
    }
  }

  console.log('[OpenUltron] 浏览器模式：所有 invoke 类 API 通过 HTTP 可用，事件类为 no-op', baseUrl)
}
