const { contextBridge, ipcRenderer } = require('electron')

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // 文件操作
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  
  // 统一 API 基地址（与 IPC 同数据源，浏览器/Node 可直连）
  getApiBaseUrl: () => ipcRenderer.invoke('get-api-base-url'),
  /** Gateway WebSocket URL（开发 28792 / 正式 28790，与主进程一致） */
  getGatewayWsUrl: () => ipcRenderer.invoke('get-gateway-ws-url'),

  /** 通用调用：与 HTTP /api/invoke 同数据源，便于浏览器侧用同一 API。args 可为 ...args 或 [args] */
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)),

  // 配置存储
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  getConfig: (key) => ipcRenderer.invoke('get-config', key),
  getAllConfigs: () => ipcRenderer.invoke('get-all-configs'),
  
  // 文件系统与命令
  executeCommand: (data) => ipcRenderer.invoke('execute-command', data),
  executeCommandRealtime: (data) => ipcRenderer.invoke('execute-command-realtime', data),
  killCommandProcess: (processId) => ipcRenderer.invoke('kill-command-process', { processId }),
  onCommandProcessId: (callback) => {
    ipcRenderer.on('command-process-id', (event, data) => callback(data))
  },
  removeCommandProcessIdListener: () => {
    ipcRenderer.removeAllListeners('command-process-id')
  },
  openCursor: (data) => ipcRenderer.invoke('open-cursor', data),
  openTerminal: (data) => ipcRenderer.invoke('open-terminal', data),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openInFinder: (data) => ipcRenderer.invoke('open-in-finder', data),
  
  // 配置管理
  getCurrentConfig: (data) => ipcRenderer.invoke('get-current-config', data),
  setCurrentConfig: (data) => ipcRenderer.invoke('set-current-config', data),
  saveSavedConfigs: (data) => ipcRenderer.invoke('save-saved-configs', data),
  getSavedConfigs: () => ipcRenderer.invoke('get-saved-configs'),
  deleteSavedConfig: (index) => ipcRenderer.invoke('delete-saved-config', index),
  setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),
  
  // 标签页管理
  onRefreshCurrentTab: (callback) => {
    ipcRenderer.on('refresh-current-tab', callback)
  },
  removeRefreshCurrentTabListener: (callback) => {
    ipcRenderer.removeListener('refresh-current-tab', callback)
  },
  
  // 实时Git输出监听
  onGitOutputUpdate: (callback) => {
    ipcRenderer.on('git-output-update', callback)
  },
  removeGitOutputUpdateListener: (callback) => {
    ipcRenderer.removeListener('git-output-update', callback)
  },
  
  // 窗口焦点事件监听（用于刷新待定文件检查）
  onRefreshOnFocus: (callback) => {
    ipcRenderer.on('refresh-on-focus', callback)
  },
  removeRefreshOnFocusListener: (callback) => {
    ipcRenderer.removeListener('refresh-on-focus', callback)
  },
  // 主动发送刷新请求（地址栏刷新按钮或 Command+R）
  sendRefreshOnFocus: () => {
    ipcRenderer.invoke('send-refresh-on-focus')
  },
  // 刷新完成通知监听
  onRefreshComplete: (callback) => {
    ipcRenderer.on('refresh-complete', callback)
  },
  removeRefreshCompleteListener: (callback) => {
    ipcRenderer.removeListener('refresh-complete', callback)
  },
  // 通知刷新完成
  notifyRefreshComplete: () => {
    ipcRenderer.invoke('notify-refresh-complete')
  },
  
  // 实时命令输出监听
  onRealtimeCommandOutput: (callback) => {
    ipcRenderer.on('realtime-command-output', callback)
  },
  removeRealtimeCommandOutputListener: (callback) => {
    ipcRenderer.removeListener('realtime-command-output', callback)
  },
  
  // 分支状态缓存更新监听
  onBranchStatusCacheUpdated: (callback) => {
    ipcRenderer.on('branch-status-cache-updated', callback)
  },
  removeBranchStatusCacheUpdatedListener: (callback) => {
    ipcRenderer.removeListener('branch-status-cache-updated', callback)
  },

  // 项目列表更新监听（后台扫描完成后通知）
  onProjectsUpdated: (callback) => {
    ipcRenderer.on('projects-updated', callback)
  },
  removeProjectsUpdatedListener: (callback) => {
    ipcRenderer.removeListener('projects-updated', callback)
  },

  // 前端调试日志
  logToFrontend: (message) => ipcRenderer.invoke('log-to-frontend', message),

  // 应用日志（设置-日志页 + 供 AI 分析）
  logs: {
    getPath: () => ipcRenderer.invoke('logs-get-path'),
    readTail: (lines) => ipcRenderer.invoke('logs-read-tail', lines),
    getForAi: (lines) => ipcRenderer.invoke('logs-get-for-ai', lines)
  },

  // 窗口操作（自定义标题栏）
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize'),
  
  // 浏览器功能
  getBrowserFavorites: () => ipcRenderer.invoke('get-browser-favorites'),
  addBrowserFavorite: (data) => ipcRenderer.invoke('add-browser-favorite', data),
  removeBrowserFavorite: (data) => ipcRenderer.invoke('remove-browser-favorite', data),
  updateBrowserFavorite: (data) => ipcRenderer.invoke('update-browser-favorite', data),
  saveBrowserFavoritesOrder: (orderedIds) => ipcRenderer.invoke('save-browser-favorites-order', orderedIds),
  exportBrowserFavorites: () => ipcRenderer.invoke('export-browser-favorites'),
  importBrowserFavorites: () => ipcRenderer.invoke('import-browser-favorites'),
  getBrowserPasswords: () => ipcRenderer.invoke('get-browser-passwords'),
  saveBrowserPassword: (data) => ipcRenderer.invoke('save-browser-password', data),
  getBrowserPassword: (data) => ipcRenderer.invoke('get-browser-password', data),
  updateBrowserPasswordUsed: (data) => ipcRenderer.invoke('update-browser-password-used', data),
  clearBrowserPasswords: () => ipcRenderer.invoke('clear-browser-passwords'),
  deleteBrowserPassword: (data) => ipcRenderer.invoke('delete-browser-password', data),
  deleteBrowserPasswordByDomain: (data) => ipcRenderer.invoke('delete-browser-password-by-domain', data),
  
  // 收藏导入导出事件监听
  onExportFavorites: (callback) => {
    ipcRenderer.on('export-favorites', callback)
  },
  removeExportFavoritesListener: (callback) => {
    ipcRenderer.removeListener('export-favorites', callback)
  },
  onImportFavorites: (callback) => {
    ipcRenderer.on('import-favorites', callback)
  },
  removeImportFavoritesListener: (callback) => {
    ipcRenderer.removeListener('import-favorites', callback)
  },
  
  // 监听主进程发来的新标签页打开请求
  onOpenUrlInNewTab: (callback) => {
    ipcRenderer.on('open-url-in-new-tab', (event, url) => callback(url))
  },
  removeOpenUrlInNewTabListener: () => {
    ipcRenderer.removeAllListeners('open-url-in-new-tab')
  },
  
  // 全局方法：在新标签页中打开 URL
  openUrlInNewTab: (url) => {
    ipcRenderer.send('request-open-url-in-new-tab', url)
  },
  
  // 读取图片文件并返回 base64
  readImageAsBase64: (filePath) => ipcRenderer.invoke('read-image-as-base64', filePath),

  // 文件保存对话框
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // 保存文件
  saveFile: (data) => ipcRenderer.invoke('save-file', data),

  // 读取文件
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  
  // 监听打开 webview DevTools 请求
  onOpenWebviewDevTools: (callback) => {
    ipcRenderer.on('open-webview-devtools', callback)
  },
  removeOpenWebviewDevToolsListener: () => {
    ipcRenderer.removeAllListeners('open-webview-devtools')
  },
  
  // ==================== 终端 ====================
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal-create', options),
    write: (data) => ipcRenderer.send('terminal-write', data),
    resize: (data) => ipcRenderer.send('terminal-resize', data),
    destroy: (data) => ipcRenderer.invoke('terminal-destroy', data),
    onOutput: (callback) => {
      ipcRenderer.on('terminal-output', (event, data) => callback(data))
    },
    removeOutputListener: () => {
      ipcRenderer.removeAllListeners('terminal-output')
    },
    onExit: (callback) => {
      ipcRenderer.on('terminal-exit', (event, data) => callback(data))
    },
    removeExitListener: () => {
      ipcRenderer.removeAllListeners('terminal-exit')
    },
    onTitleChange: (callback) => {
      ipcRenderer.on('terminal-title', (event, data) => callback(data))
    },
    removeTitleChangeListener: () => {
      ipcRenderer.removeAllListeners('terminal-title')
    }
  },

  // ==================== MCP 事件监听 ====================
  onMcpOpenFile: (cb) => { ipcRenderer.on('mcp-open-file', (e, d) => cb(d)) },
  removeMcpOpenFileListener: () => { ipcRenderer.removeAllListeners('mcp-open-file') },
  onMcpOpenDiff: (cb) => { ipcRenderer.on('mcp-open-diff', (e, d) => cb(d)) },
  removeMcpOpenDiffListener: () => { ipcRenderer.removeAllListeners('mcp-open-diff') },

  // ==================== 代码编辑器 ====================
  editor: {
    readDir: (data) => ipcRenderer.invoke('editor-read-dir', data),
    readFile: (data) => ipcRenderer.invoke('editor-read-file', data),
    writeFile: (data) => ipcRenderer.invoke('editor-write-file', data),
    searchFiles: (data) => ipcRenderer.invoke('editor-search-files', data),
    getSettings: () => ipcRenderer.invoke('editor-get-settings'),
    setSettings: (data) => ipcRenderer.invoke('editor-set-settings', data),
    watchStart: (data) => ipcRenderer.invoke('editor-watch-start', data),
    watchStop: (data) => ipcRenderer.invoke('editor-watch-stop', data),
    onFileChanged: (cb) => { ipcRenderer.on('editor-file-changed', (e, d) => cb(d)) },
    removeFileChangedListener: () => { ipcRenderer.removeAllListeners('editor-file-changed') },
    // AI 工具请求编辑器打开文件列表
    onGetOpenFiles: (cb) => { ipcRenderer.on('ai-get-editor-open-files', (e, d) => cb(d)) },
    respondOpenFiles: (data) => ipcRenderer.invoke('ai-editor-open-files-response', data)
  },

  // ==================== 工作区 ====================
  workspace: {
    getDefaults: () => ipcRenderer.invoke('workspace-get-defaults'),
    load: (data) => ipcRenderer.invoke('workspace-load', data),
    save: (data) => ipcRenderer.invoke('workspace-save', data),
    pickFolder: () => ipcRenderer.invoke('workspace-pick-folder'),
    /** 通过路径字符串解析目录，不弹系统选择框；传 { path: '绝对路径或 ~/xxx' } */
    resolvePath: (data) => ipcRenderer.invoke('workspace-resolve-path', data),
  },

  // 外部终端
  openTerminalApp: (data) => ipcRenderer.invoke('open-terminal', data),
  getAvailableTerminals: () => ipcRenderer.invoke('get-available-terminals'),

  // Chrome 扩展管理
  getExtensions: () => ipcRenderer.invoke('get-extensions'),
  loadExtensionFromFolder: () => ipcRenderer.invoke('load-extension-from-folder'),
  loadExtensionFromCrx: () => ipcRenderer.invoke('load-extension-from-crx'),
  loadExtensionFromChrome: () => ipcRenderer.invoke('load-extension-from-chrome'),
  loadExtensionById: (extensionId) => ipcRenderer.invoke('load-extension-by-id', extensionId),
  toggleExtension: (extensionId, enabled) => ipcRenderer.invoke('toggle-extension', extensionId, enabled),
  removeExtension: (extensionId) => ipcRenderer.invoke('remove-extension', extensionId),
  
  // ==================== AI Agent ====================
  ai: {
    getConfig: () => ipcRenderer.invoke('ai-get-config'),
    getOnboardingStatus: () => ipcRenderer.invoke('ai-get-onboarding-status'),
    saveConfig: (config) => ipcRenderer.invoke('ai-save-config', config),
    getConfigForBackup: () => ipcRenderer.invoke('ai-get-config-for-backup'),
    restoreConfigFromBackup: (payload) => ipcRenderer.invoke('ai-restore-config-from-backup', payload),
    fetchModels: (options) => ipcRenderer.invoke('ai-fetch-models', options),
    getModels: (providerBaseUrl) => ipcRenderer.invoke('ai-get-models', providerBaseUrl),
    getTools: () => ipcRenderer.invoke('ai-get-tools'),
    chatStart: (data) => ipcRenderer.invoke('ai-chat-start', data),
    chatStop: (data) => ipcRenderer.invoke('ai-chat-stop', data),
    generateCommitMessage: (data) => ipcRenderer.invoke('ai-generate-commit-message', data),
    readAgentMd: (data) => ipcRenderer.invoke('ai-read-agent-md', data),
    // 流式事件监听
    onToken: (cb) => { ipcRenderer.on('ai-chat-token', (e, d) => cb(d)) },
    onToolCall: (cb) => { ipcRenderer.on('ai-chat-tool-call', (e, d) => cb(d)) },
    onToolResult: (cb) => { ipcRenderer.on('ai-chat-tool-result', (e, d) => cb(d)) },
    onComplete: (cb) => { ipcRenderer.on('ai-chat-complete', (e, d) => cb(d)) },
    onError: (cb) => { ipcRenderer.on('ai-chat-error', (e, d) => cb(d)) },
    // 用户确认
    onConfirmRequest: (cb) => { ipcRenderer.on('ai-chat-confirm-request', (e, d) => cb(d)) },
    confirmResponse: (data) => ipcRenderer.invoke('ai-chat-confirm-response', data),
    onAIConfigUpdated: (cb) => ipcRenderer.on('ai-config-updated', () => cb()),
    removeAIConfigUpdatedListener: () => ipcRenderer.removeAllListeners('ai-config-updated'),
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('ai-chat-token')
      ipcRenderer.removeAllListeners('ai-chat-tool-call')
      ipcRenderer.removeAllListeners('ai-chat-tool-result')
      ipcRenderer.removeAllListeners('ai-chat-complete')
      ipcRenderer.removeAllListeners('ai-chat-error')
      ipcRenderer.removeAllListeners('ai-chat-confirm-request')
    },
    // 会话历史持久化（文件存储）
    saveChatHistory: (data) => ipcRenderer.invoke('ai-save-chat-history', data),
    loadChatHistory: (data) => ipcRenderer.invoke('ai-load-chat-history', data),
    clearChatHistory: (data) => ipcRenderer.invoke('ai-clear-chat-history', data),
    saveSessionSummary: (data) => ipcRenderer.invoke('ai-save-session-summary', data),
    listSessionSummaries: (data) => ipcRenderer.invoke('ai-list-session-summaries', data),
    evolveFromSession: (data) => ipcRenderer.invoke('ai-evolve-from-session', data),
    listConversations: (data) => ipcRenderer.invoke('ai-list-conversations', data),
    renameConversation: (data) => ipcRenderer.invoke('ai-rename-conversation', data),
    // 会话管理（独立 AI 助手）
    getSessions: () => ipcRenderer.invoke('ai-get-sessions'),
    listAllSessions: () => ipcRenderer.invoke('ai-list-all-sessions'),
    updateSessionStats: (data) => ipcRenderer.invoke('ai-update-session-stats', data),
    saveSession: (data) => ipcRenderer.invoke('ai-save-session', data),
    deleteSession: (data) => ipcRenderer.invoke('ai-delete-session', data),
    // 技能管理
    getSkills: () => ipcRenderer.invoke('ai-get-skills'),
    saveSkill: (skill) => ipcRenderer.invoke('ai-save-skill', skill),
    deleteSkill: (data) => ipcRenderer.invoke('ai-delete-skill', data),
    getSoulMdPath: () => ipcRenderer.invoke('ai-get-soul-md-path'),
    openSoulMd: () => ipcRenderer.invoke('ai-open-soul-md'),
    getIdentityMdPath: () => ipcRenderer.invoke('ai-get-identity-md-path'),
    openIdentityMd: () => ipcRenderer.invoke('ai-open-identity-md'),
    getAgentDisplayName: () => ipcRenderer.invoke('ai-get-agent-display-name'),
    getUserMdPath: () => ipcRenderer.invoke('ai-get-user-md-path'),
    openUserMd: () => ipcRenderer.invoke('ai-open-user-md'),
    getBootMdPath: () => ipcRenderer.invoke('ai-get-boot-md-path'),
    openBootMd: () => ipcRenderer.invoke('ai-open-boot-md'),
    // MCP Server 管理（JSON 格式）
    getMcpConfig: () => ipcRenderer.invoke('ai-get-mcp-config'),
    saveMcpConfig: (data) => ipcRenderer.invoke('ai-save-mcp-config', data),
    importClaudeMcp: () => ipcRenderer.invoke('ai-import-claude-mcp'),
    getMcpStatus: () => ipcRenderer.invoke('ai-get-mcp-status'),
    reconnectMcp: () => ipcRenderer.invoke('ai-reconnect-mcp'),
    getMcpDisabled: () => ipcRenderer.invoke('ai-get-mcp-disabled'),
    toggleMcpServer: (data) => ipcRenderer.invoke('ai-toggle-mcp-server', data),
    restartMcpServer: (data) => ipcRenderer.invoke('ai-restart-mcp-server', data),
    // 会话视图注册 / 注销（ChatPanel mount/unmount）
    sessionRegisterView: (data) => ipcRenderer.invoke('ai-session-register-view', data),
    sessionUnregisterView: (data) => ipcRenderer.invoke('ai-session-unregister-view', data),
    sessionUpdateMeta: (data) => ipcRenderer.invoke('ai-session-update-meta', data),
    sessionList: () => ipcRenderer.invoke('ai-session-list'),
    sessionPause: (data) => ipcRenderer.invoke('ai-session-pause', data),
    sessionResume: (data) => ipcRenderer.invoke('ai-session-resume', data),
    sessionStop: (data) => ipcRenderer.invoke('ai-session-stop', data),
    sessionInject: (data) => ipcRenderer.invoke('ai-session-inject', data),
    onSessionInjectToPanel: (cb) => { ipcRenderer.on('ai-session-inject-to-panel', (e, d) => cb(d)) },
    onFeishuSessionUpdated: (cb) => { ipcRenderer.on('feishu-session-updated', (e, d) => cb(d)) },
    onFeishuSessionUserMessage: (cb) => { ipcRenderer.on('feishu-session-user-message', (e, d) => cb(d)) },
    onGatewaySessionUpdated: (cb) => { ipcRenderer.on('gateway-session-updated', (e, d) => cb(d)) },
    onGatewayRemoteUserMessage: (cb) => { ipcRenderer.on('gateway-remote-user-message', (e, d) => cb(d)) },
    reportCurrentSession: (payload) => ipcRenderer.invoke('ai-report-current-session', payload),
    removeFeishuSessionListeners: () => {
      ipcRenderer.removeAllListeners('feishu-session-updated')
      ipcRenderer.removeAllListeners('feishu-session-user-message')
      ipcRenderer.removeAllListeners('gateway-session-updated')
      ipcRenderer.removeAllListeners('gateway-remote-user-message')
    },
    removeSessionListeners: () => {
      ipcRenderer.removeAllListeners('ai-session-inject-to-panel')
    },
    // 备份 & 恢复（旧 JSON 格式）
    exportBackup: () => ipcRenderer.invoke('ai-export-backup'),
    importBackup: (data) => ipcRenderer.invoke('ai-import-backup', data),
    // 备份 & 恢复（新 ZIP 格式）
    backupExport: (options) => ipcRenderer.invoke('ai-backup-export', { options }),
    backupPreview: () => ipcRenderer.invoke('ai-backup-preview'),
    backupRestore: (data) => ipcRenderer.invoke('ai-backup-restore', data),
    exportSkillsPack: (opts) => ipcRenderer.invoke('ai-export-skills-pack', opts || {}),
    importSkillsPack: (opts) => ipcRenderer.invoke('ai-import-skills-pack', opts || {}),
    // Token 用量 & 账单
    getUsage: (params) => ipcRenderer.invoke('ai-get-usage', params),
    getBilling: (params) => ipcRenderer.invoke('ai-get-billing', params),
  },

  // ==================== 飞书通知 ====================
  feishu: {
    getConfig: () => ipcRenderer.invoke('feishu-get-config'),
    setConfig: (payload) => ipcRenderer.invoke('feishu-set-config', payload),
    sendMessage: (options) => ipcRenderer.invoke('feishu-send-message', options),
    receiveStatus: () => ipcRenderer.invoke('feishu-receive-status'),
    receiveStart: () => ipcRenderer.invoke('feishu-receive-start'),
    receiveStop: () => ipcRenderer.invoke('feishu-receive-stop'),
  },

  // ==================== Telegram ====================
  telegram: {
    getConfig: () => ipcRenderer.invoke('get-telegram-config'),
    setConfig: (payload) => ipcRenderer.invoke('set-telegram-config', payload),
    receiveStatus: () => ipcRenderer.invoke('telegram-receive-status'),
  },

  // ==================== 钉钉 ====================
  dingtalk: {
    getConfig: () => ipcRenderer.invoke('get-dingtalk-config'),
    setConfig: (payload) => ipcRenderer.invoke('set-dingtalk-config', payload),
  },

  // ==================== 定时任务 Cron ====================
  cron: {
    list: () => ipcRenderer.invoke('cron-list'),
    add: (task) => ipcRenderer.invoke('cron-add', task),
    update: (taskId, updates) => ipcRenderer.invoke('cron-update', { taskId, updates }),
    remove: (taskId) => ipcRenderer.invoke('cron-remove', taskId),
    runNow: (taskId) => ipcRenderer.invoke('cron-run-now', taskId),
  },

  // ==================== 扣子 (Coze) AI API ====================
  coze: {
    // 获取配置
    getConfig: () => ipcRenderer.invoke('get-coze-config'),
    // 保存配置（API Token + Bot ID）
    saveConfig: (data) => ipcRenderer.invoke('save-coze-config', data),
    // 检查配置状态
    checkAuth: () => ipcRenderer.invoke('coze-check-auth'),
    // 清除配置
    logout: () => ipcRenderer.invoke('coze-logout'),
    // 生成提交信息
    generateCommitMessage: (data) => ipcRenderer.invoke('coze-generate-commit-message', data)
  }
})
