/**
 * 浏览器环境完整 polyfill：无 Electron 时通过 HTTP 调用同一后端，与应用内 IPC 数据源一致。
 * 所有 invoke 类 API 均可用；事件类（onXxx、terminal 流式）在浏览器下为 no-op（需后端 WebSocket 才能实现推送）。
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
    saveGitlabConfig: (data) => invoke('save-gitlab-config', [data]),
    saveProjectGitlabConfig: (data) => invoke('save-project-gitlab-config', [data]),
    getProjectGitlabConfig: (projectPath) => invoke('get-project-gitlab-config', [projectPath]),
    deleteGitlabHistory: (index) => invoke('delete-gitlab-history', [index]),
    deleteSavedConfig: (index) => invoke('delete-saved-config', [index]),

    // Git
    gitClone: (data) => invoke('git-clone', [data]),
    gitStatus: (data) => invoke('git-status', [data]),
    gitBranch: (data) => invoke('git-branch', [data]),
    gitCommit: (data) => invoke('git-commit', [data]),
    gitPull: (data) => invoke('git-pull', [data]),
    gitPush: (data) => invoke('git-push', [data]),

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
    logToFrontend: (message) => invoke('log-to-frontend', [message]),
    toggleMaximize: () => invoke('toggle-maximize', []),

    // 浏览器收藏与密码
    getBrowserFavorites: () => invoke('get-browser-favorites', []),
    addBrowserFavorite: (data) => invoke('add-browser-favorite', [data]),
    removeBrowserFavorite: (data) => invoke('remove-browser-favorite', [data]),
    updateBrowserFavorite: (data) => invoke('update-browser-favorite', [data]),
    saveBrowserFavoritesOrder: (orderedIds) => invoke('save-browser-favorites-order', [orderedIds]),
    exportBrowserFavorites: () => invoke('export-browser-favorites', []),
    importBrowserFavorites: (data) => invoke('import-browser-favorites', [data]),
    getBrowserPasswords: () => invoke('get-browser-passwords', []),
    saveBrowserPassword: (data) => invoke('save-browser-password', [data]),
    getBrowserPassword: (data) => invoke('get-browser-password', [data]),
    updateBrowserPasswordUsed: (data) => invoke('update-browser-password-used', [data]),
    clearBrowserPasswords: () => invoke('clear-browser-passwords', []),
    deleteBrowserPassword: (data) => invoke('delete-browser-password', [data]),
    deleteBrowserPasswordByDomain: (data) => invoke('delete-browser-password-by-domain', [data]),

    openUrlInNewTab: (url) => { try { window.open(url) } catch (_) { noop() } },

    // 事件监听：浏览器下无 IPC 推送，提供 no-op 避免报错
    onCommandProcessId: (cb) => noopOn('command-process-id')(cb),
    removeCommandProcessIdListener: noopRemove,
    onRefreshCurrentTab: noopOn('refresh-current-tab'),
    removeRefreshCurrentTabListener: noopRemove,
    onGitOutputUpdate: noopOn('git-output-update'),
    removeGitOutputUpdateListener: noopRemove,
    onRefreshOnFocus: noopOn('refresh-on-focus'),
    removeRefreshOnFocusListener: noopRemove,
    onRefreshComplete: noopOn('refresh-complete'),
    removeRefreshCompleteListener: noopRemove,
    onRealtimeCommandOutput: noopOn('realtime-command-output'),
    removeRealtimeCommandOutputListener: noopRemove,
    onBranchStatusCacheUpdated: noopOn('branch-status-cache-updated'),
    removeBranchStatusCacheUpdatedListener: noopRemove,
    onProjectsUpdated: noopOn('projects-updated'),
    removeProjectsUpdatedListener: noopRemove,
    onExportFavorites: noopOn('export-favorites'),
    removeExportFavoritesListener: noopRemove,
    onImportFavorites: noopOn('import-favorites'),
    removeImportFavoritesListener: noopRemove,
    onOpenUrlInNewTab: noopOn('open-url-in-new-tab'),
    removeOpenUrlInNewTabListener: noopRemove,
    onOpenWebviewDevTools: noopOn('open-webview-devtools'),
    removeOpenWebviewDevToolsListener: noopRemove,
    onMcpOpenFile: (cb) => noopOn('mcp-open-file')(cb),
    removeMcpOpenFileListener: noopRemove,
    onMcpOpenDiff: (cb) => noopOn('mcp-open-diff')(cb),
    removeMcpOpenDiffListener: noopRemove,

    // 终端（create/destroy 可 invoke；write/resize 为 send，浏览器下 no-op）
    terminal: {
      create: (options) => invoke('terminal-create', [options]),
      write: (data) => { /* send-only, no-op in browser */ },
      resize: (data) => { /* send-only, no-op in browser */ },
      destroy: (data) => invoke('terminal-destroy', [data]),
      onOutput: noopOn('terminal-output'),
      removeOutputListener: noopRemove,
      onExit: noopOn('terminal-exit'),
      removeExitListener: noopRemove,
      onTitleChange: noopOn('terminal-title'),
      removeTitleChangeListener: noopRemove
    },

    editor: {
      readDir: (data) => invoke('editor-read-dir', [data]),
      readFile: (data) => invoke('editor-read-file', [data]),
      writeFile: (data) => invoke('editor-write-file', [data]),
      searchFiles: (data) => invoke('editor-search-files', [data]),
      getSettings: () => invoke('editor-get-settings', []),
      setSettings: (data) => invoke('editor-set-settings', [data]),
      watchStart: (data) => invoke('editor-watch-start', [data]),
      watchStop: (data) => invoke('editor-watch-stop', [data]),
      onFileChanged: (cb) => noopOn('editor-file-changed')(cb),
      removeFileChangedListener: noopRemove,
      onGetOpenFiles: (cb) => noopOn('ai-get-editor-open-files')(cb),
      respondOpenFiles: (data) => invoke('ai-editor-open-files-response', [data])
    },

    workspace: {
      getDefaults: () => invoke('workspace-get-defaults', []),
      load: (data) => invoke('workspace-load', [data]),
      save: (data) => invoke('workspace-save', [data]),
      pickFolder: () => invoke('workspace-pick-folder', []),
      resolvePath: (data) => invoke('workspace-resolve-path', [data])
    },

    getExtensions: () => invoke('get-extensions', []),
    loadExtensionFromFolder: () => invoke('load-extension-from-folder', []),
    loadExtensionFromCrx: () => invoke('load-extension-from-crx', []),
    loadExtensionFromChrome: () => invoke('load-extension-from-chrome', []),
    loadExtensionById: (extensionId) => invoke('load-extension-by-id', [extensionId]),
    toggleExtension: (extensionId, enabled) => invoke('toggle-extension', [extensionId, enabled]),
    removeExtension: (extensionId) => invoke('remove-extension', [extensionId]),

    // GitLab / GitHub / Gitee
    gitlabTest: (data) => invoke('gitlab-test', [data]),
    gitlabGroups: (data) => invoke('gitlab-groups', [data]),
    gitlabGroupDetails: (data) => invoke('gitlab-group-details', [data]),
    gitlabGroupProjects: (data) => invoke('gitlab-group-projects', [data]),
    gitlabClone: (data) => invoke('gitlab-clone', [data]),
    gitlabCreateMR: (data) => invoke('gitlab-create-mr', [data]),
    gitlabProjectMRs: (data) => invoke('gitlab-project-mrs', [data]),
    gitlabSearchProjects: (data) => invoke('gitlab-search-projects', [data]),
    githubTest: (data) => invoke('github-test', [data]),
    githubOrgs: (data) => invoke('github-orgs', [data]),
    githubUserRepos: (data) => invoke('github-user-repos', [data]),
    githubOrgRepos: (data) => invoke('github-org-repos', [data]),
    githubClone: (data) => invoke('github-clone', [data]),
    githubSearchRepos: (data) => invoke('github-search-repos', [data]),
    giteeTest: (data) => invoke('gitee-test', [data]),
    giteeOrgs: (data) => invoke('gitee-orgs', [data]),
    giteeUserRepos: (data) => invoke('gitee-user-repos', [data]),
    giteeOrgRepos: (data) => invoke('gitee-org-repos', [data]),
    giteeClone: (data) => invoke('gitee-clone', [data]),
    giteeSearchRepos: (data) => invoke('gitee-search-repos', [data]),

    // AI
    ai: {
      getConfig: () => invoke('ai-get-config', []),
      getOnboardingStatus: () => invoke('ai-get-onboarding-status', []),
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
      listConversations: (data) => invoke('ai-list-conversations', [data]),
      renameConversation: (data) => invoke('ai-rename-conversation', [data]),
      getSessions: () => invoke('ai-get-sessions', []),
      listAllSessions: () => invoke('ai-list-all-sessions', []),
      updateSessionStats: (data) => invoke('ai-update-session-stats', [data]),
      saveSession: (data) => invoke('ai-save-session', [data]),
      deleteSession: (data) => invoke('ai-delete-session', [data]),
      getSkills: () => invoke('ai-get-skills', []),
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
      getUsage: (params) => invoke('ai-get-usage', [params]),
      getBilling: (params) => invoke('ai-get-billing', [params]),
      onToken: noopOn('ai-chat-token'),
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
      sendMessage: (options) => invoke('feishu-send-message', [options]),
      receiveStatus: () => invoke('feishu-receive-status', []),
      receiveStart: () => invoke('feishu-receive-start', []),
      receiveStop: () => invoke('feishu-receive-stop', [])
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
