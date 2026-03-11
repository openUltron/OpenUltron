<template>
  <div class="mcp-manager">
    <div class="mm-header">
      <div class="mm-title">
        <Plug :size="16" />
        <span>MCP</span>
      </div>
      <div class="mm-header-actions">
        <button class="mm-btn-ghost" @click="refreshStatus" :disabled="refreshing" :title="t('mcp.reconnectTitle')">
          <RefreshCw :size="13" :class="{ spin: refreshing }" />
          <span>{{ refreshing ? t('mcp.connecting') : t('mcp.reconnect') }}</span>
        </button>
        <button class="mm-btn-ghost" @click="view = view === 'json' ? 'list' : 'json'">
          <Code :size="13" />
          <span>{{ view === 'json' ? t('mcp.serverList') : t('mcp.editJson') }}</span>
        </button>
        <button v-if="view === 'json'" class="mm-btn-primary" @click="saveConfig" :disabled="saving">
          <Save :size="13" />
          <span>{{ saving ? t('mcp.saving') : t('mcp.saveAndRestart') }}</span>
        </button>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="mm-error">
      <AlertCircle :size="13" />
      <span>{{ errorMsg }}</span>
    </div>

    <!-- 服务器列表视图 -->
    <div v-if="view === 'list'" class="mm-list-view">
      <div v-if="serverEntries.length === 0" class="mm-empty">
        <Plug :size="36" class="mm-empty-icon" />
        <p>{{ t('mcp.empty') }}</p>
        <p class="mm-empty-hint">{{ t('mcp.emptyHint') }}</p>
      </div>

      <div v-for="entry in serverEntries" :key="entry.name" class="mm-server-card" :class="{ disabled: entry.disabled }">
        <!-- 卡片头部 -->
        <div class="mm-server-header">
          <span class="mm-status-dot" :class="serverStatus[entry.name]?.ready ? 'running' : 'stopped'"></span>
          <span class="mm-server-name">{{ entry.name }}</span>
          <span class="mm-type-tag" :class="entry.url ? 'sse' : 'stdio'">
            {{ entry.url ? 'SSE' : 'stdio' }}
          </span>
          <span class="mm-spacer"></span>
          <!-- 重启（仅非禁用且当前已配置的服务器；chrome-devtools 被占用时可点此杀掉并清除锁后重启） -->
          <button
            v-if="!entry.disabled"
            class="mm-restart-btn"
            :disabled="restartingServer === entry.name"
            :title="entry.name === 'chrome-devtools' ? t('mcp.restartChrome') : t('mcp.restartServer')"
            @click="restartServer(entry.name)"
          >
            <RefreshCw :size="12" :class="{ spin: restartingServer === entry.name }" />
          </button>
          <!-- 启用开关 -->
          <label class="mm-toggle" :title="entry.disabled ? t('mcp.disabled') : t('mcp.enabled')">
            <input type="checkbox" :checked="!entry.disabled" @change="toggleServer(entry.name, $event.target.checked)" />
            <span class="mm-toggle-track"></span>
          </label>
          <!-- 删除按钮 -->
          <button class="mm-delete-btn" @click="deleteServer(entry.name)" :title="t('mcp.delete')">
            <Trash2 :size="12" />
          </button>
        </div>

        <!-- 连接命令 / URL -->
        <div class="mm-server-cmd">
          <template v-if="entry.url">
            <span class="mm-cmd-label">URL</span>
            <code>{{ entry.url }}</code>
          </template>
          <template v-else>
            <span class="mm-cmd-label">CMD</span>
            <code>{{ entry.command }} {{ (entry.args || []).join(' ') }}</code>
          </template>
        </div>

        <!-- 工具列表 -->
        <div class="mm-tools-section">
          <template v-if="entry.disabled">
            <span class="mm-tools-hint disabled-hint">{{ t('mcp.disabled') }}</span>
          </template>
          <template v-else-if="serverStatus[entry.name]?.ready">
            <div class="mm-tools-header">
              <Wrench :size="10" />
              <span>{{ t('mcp.toolsCount', { count: serverStatus[entry.name].toolCount }) }}</span>
            </div>
            <div class="mm-tools-list">
              <span
                v-for="tool in serverStatus[entry.name].tools"
                :key="tool.name"
                class="mm-tool-pill"
                :title="tool.description"
              >{{ tool.name }}</span>
            </div>
          </template>
          <template v-else-if="serverStatus[entry.name]?.error">
            <div class="mm-tools-hint error-hint" :title="serverStatus[entry.name].error">
              <span class="error-label">{{ t('mcp.connectFailed') }}</span>
              <pre class="error-detail">{{ serverStatus[entry.name].error }}</pre>
              <span v-if="entry.name === 'chrome-devtools'" class="error-tip">{{ t('mcp.chromeTip') }}</span>
            </div>
          </template>
          <template v-else>
            <span class="mm-tools-hint">{{ t('mcp.disconnected') }}</span>
          </template>
        </div>
      </div>
    </div>

    <!-- JSON 编辑器视图 -->
    <div v-else class="mm-json-view">
      <div class="mm-editor-panel">
        <div class="mm-editor-hint">
          <span class="mm-hint-text">{{ t('mcp.configCompat') }} <code>mcpServers</code></span>
        </div>
        <textarea
          ref="editorRef"
          v-model="configText"
          class="mm-json-editor"
          spellcheck="false"
          @keydown.tab.prevent="onTab"
        ></textarea>
      </div>

      <!-- 示例说明 -->
      <div class="mm-example">
        <div class="mm-example-title">{{ t('mcp.configExample') }}</div>
        <pre class="mm-example-code">{{ EXAMPLE_CONFIG }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { Plug, RefreshCw, Save, AlertCircle, Code, Wrench, Trash2 } from 'lucide-vue-next'
import { useI18n } from '../../composables/useI18n'

const { t } = useI18n()

const EXAMPLE_CONFIG = `{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
  },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
  },
  "remote-server": {
    "url": "http://localhost:3000/mcp",
    "headers": { "Authorization": "Bearer token" }
  }
}`

const view = ref('list')
const configText = ref('{}')
const serverStatus = ref({})
const disabledServers = ref([])
const refreshing = ref(false)
const saving = ref(false)
const restartingServer = ref(null)
const errorMsg = ref('')
const editorRef = ref(null)

// 从 configText 解析服务器列表，兼容 mcpServers 包装格式
const serverEntries = computed(() => {
  try {
    let obj = JSON.parse(configText.value)
    if (obj.mcpServers && typeof obj.mcpServers === 'object') obj = obj.mcpServers
    return Object.entries(obj).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args || [],
      env: cfg.env || {},
      url: cfg.url,
      headers: cfg.headers || {},
      disabled: disabledServers.value.includes(name)
    }))
  } catch { return [] }
})

const loadConfig = async () => {
  try {
    const [cfgRes, disRes] = await Promise.all([
      window.electronAPI.ai.getMcpConfig(),
      window.electronAPI.ai.getMcpDisabled()
    ])
    if (cfgRes.success) {
      try {
        configText.value = JSON.stringify(JSON.parse(cfgRes.config || '{}'), null, 2)
      } catch {
        configText.value = cfgRes.config || '{}'
      }
    }
    if (disRes.success) disabledServers.value = disRes.disabled || []
  } catch { /* ignore */ }
}

// 只拉取当前状态，不重连（页面初始化时用）
const loadStatus = async () => {
  try {
    const res = await window.electronAPI.ai.getMcpStatus()
    if (res.success) serverStatus.value = res.status || {}
  } catch { /* ignore */ }
}

// 重连所有 MCP 并刷新状态（刷新按钮、保存配置后用）
const refreshStatus = async () => {
  refreshing.value = true
  errorMsg.value = ''
  try {
    await window.electronAPI.ai.reconnectMcp()
    const res = await window.electronAPI.ai.getMcpStatus()
    if (res.success) serverStatus.value = res.status || {}
  } catch { /* ignore */ } finally {
    refreshing.value = false
  }
}

// 单服务器重启（chrome-devtools 会先清 profile 锁再启动，解决「被占用」）
const restartServer = async (name) => {
  if (!window.electronAPI?.ai?.restartMcpServer) return
  restartingServer.value = name
  errorMsg.value = ''
  try {
    const res = await window.electronAPI.ai.restartMcpServer({ name })
    if (res.success) {
      const statusRes = await window.electronAPI.ai.getMcpStatus()
      if (statusRes.success) serverStatus.value = statusRes.status || {}
    } else {
      errorMsg.value = res.message || t('mcp.restartFailed')
    }
  } catch (e) {
    errorMsg.value = e.message || t('mcp.restartFailed')
  } finally {
    restartingServer.value = null
  }
}

const saveConfig = async () => {
  errorMsg.value = ''
  try {
    JSON.parse(configText.value)
  } catch (e) {
    errorMsg.value = t('mcp.jsonFormatError', { message: e.message })
    return
  }
  saving.value = true
  try {
    const res = await window.electronAPI.ai.saveMcpConfig({ config: configText.value })
    if (res.success) {
      await refreshStatus()
    } else {
      errorMsg.value = res.message || t('mcp.saveFailed')
    }
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    saving.value = false
  }
}

// 切换服务器启用状态（独立于 JSON 配置）
const toggleServer = async (name, enabled) => {
  errorMsg.value = ''
  try {
    const res = await window.electronAPI.ai.toggleMcpServer({ name, enabled })
    if (res.success) {
      if (enabled) {
        disabledServers.value = disabledServers.value.filter(n => n !== name)
      } else {
        if (!disabledServers.value.includes(name)) disabledServers.value.push(name)
      }
      await refreshStatus()
    } else {
      errorMsg.value = res.message || t('mcp.operationFailed')
    }
  } catch (e) {
    errorMsg.value = e.message
  }
}

const deleteServer = async (name) => {
  try {
    let obj = JSON.parse(configText.value)
    const hasWrapper = obj.mcpServers && typeof obj.mcpServers === 'object'
    const servers = hasWrapper ? obj.mcpServers : obj
    delete servers[name]
    configText.value = JSON.stringify(hasWrapper ? obj : servers, null, 2)
    // 停止并从禁用列表移除
    await window.electronAPI.ai.toggleMcpServer({ name, enabled: false }).catch(() => {})
    disabledServers.value = disabledServers.value.filter(n => n !== name)
    // 保存配置
    await window.electronAPI.ai.saveMcpConfig({ config: configText.value })
    await refreshStatus()
  } catch (e) {
    errorMsg.value = e.message
  }
}

// Tab 键插入两个空格
const onTab = () => {
  const el = editorRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  configText.value = configText.value.substring(0, start) + '  ' + configText.value.substring(end)
  setTimeout(() => {
    el.selectionStart = el.selectionEnd = start + 2
  }, 0)
}

onMounted(async () => {
  await loadConfig()
  await loadStatus()  // 只读状态，不重连；重连由用户点刷新按钮触发
})
</script>

<style scoped>
.mcp-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--ou-bg-main);
  padding: 20px 24px;
}

.mm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 12px 0;
  border-bottom: 1px solid var(--ou-border);
  flex-shrink: 0;
  gap: 10px;
}

.mm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
  flex-shrink: 0;
}

.mm-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mm-btn-ghost {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 5px;
  background: transparent;
  color: var(--ou-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.mm-btn-ghost:hover { background: rgba(255,255,255,0.07); color: var(--ou-text); border-color: rgba(255,255,255,0.18); }

.mm-btn-primary {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border: none;
  border-radius: 5px;
  background: var(--ou-primary);
  color: var(--ou-accent-fg);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.mm-btn-primary:hover { background: #0090e7; }
.mm-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.mm-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 20px;
  background: rgba(241,76,76,0.1);
  border-bottom: 1px solid rgba(241,76,76,0.2);
  color: var(--ou-error);
  font-size: 12px;
  flex-shrink: 0;
}

/* ── 列表视图 ── */
.mm-list-view {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mm-list-view::-webkit-scrollbar { width: 6px; }
.mm-list-view::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

.mm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--ou-text-muted);
  gap: 8px;
}
.mm-empty-icon { color: #3a3a3a; }
.mm-empty p { margin: 0; font-size: 14px; }
.mm-empty-hint { font-size: 12px !important; color: var(--ou-text-secondary); }

/* ── 服务器卡片 ── */
.mm-server-card {
  background: var(--ou-bg-sidebar);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s;
}
.mm-server-card:hover { border-color: rgba(255,255,255,0.13); }
.mm-server-card.disabled { opacity: 0.55; }

.mm-server-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mm-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.mm-status-dot.running { background: #4ec955; box-shadow: 0 0 6px rgba(78,201,85,0.5); }
.mm-status-dot.stopped { background: #555; }

.mm-server-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-type-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  flex-shrink: 0;
}
.mm-type-tag.stdio { background: rgba(59,142,234,0.12); color: var(--ou-link); border: 1px solid rgba(59,142,234,0.25); }
.mm-type-tag.sse   { background: rgba(13,188,121,0.12); color: #0dbc79; border: 1px solid rgba(13,188,121,0.25); }

.mm-spacer { flex: 1; }

/* ── 删除按钮 ── */
.mm-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--ou-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.mm-delete-btn:hover { background: rgba(241,76,76,0.15); color: var(--ou-error); }

.mm-restart-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--ou-text-muted);
  cursor: pointer;
  flex-shrink: 0;
}
.mm-restart-btn:hover:not(:disabled) { background: var(--ou-bg-hover); color: var(--ou-text); }
.mm-restart-btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* ── 开关 ── */
.mm-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}
.mm-toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.mm-toggle-track {
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background: #3a3a3a;
  transition: background 0.2s;
  position: relative;
}
.mm-toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #666;
  transition: transform 0.2s, background 0.2s;
}
.mm-toggle input:checked + .mm-toggle-track {
  background: rgba(0,122,204,0.4);
}
.mm-toggle input:checked + .mm-toggle-track::after {
  transform: translateX(14px);
  background: var(--ou-primary);
}

/* ── 命令行 ── */
.mm-server-cmd {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
}
.mm-cmd-label {
  font-size: 10px;
  color: var(--ou-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}
.mm-server-cmd code {
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 11px;
  color: var(--ou-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* ── 工具列表 ── */
.mm-tools-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.mm-tools-header {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--ou-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.mm-tools-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mm-tool-pill {
  font-size: 10px;
  padding: 1px 7px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  color: #777;
  cursor: default;
  transition: all 0.12s;
  font-family: 'Monaco', 'Menlo', monospace;
}
.mm-tool-pill:hover { background: rgba(255,255,255,0.07); color: #aaa; }
.mm-tools-hint { font-size: 11px; color: var(--ou-text-secondary); }
.mm-tools-hint.disabled-hint { color: var(--ou-text-muted); font-style: italic; }
.mm-tools-hint.error-hint {
  color: var(--ou-error);
  font-size: 11px;
  max-width: 100%;
  cursor: help;
  white-space: pre-wrap;
  word-break: break-word;
}
.mm-tools-hint.error-hint .error-label { font-weight: 600; }
.mm-tools-hint.error-hint .error-detail {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: rgba(241,76,76,0.08);
  border-radius: 6px;
  font-size: 10px;
  max-height: 80px;
  overflow-y: auto;
  white-space: pre-wrap;
  border: 1px solid rgba(241,76,76,0.2);
}
.mm-tools-hint.error-hint .error-tip {
  display: block;
  margin-top: 6px;
  color: var(--ou-text-muted);
  font-size: 10px;
  white-space: normal;
}

/* ── JSON 视图 ── */
.mm-json-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.mm-editor-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.mm-editor-hint {
  padding: 6px 12px;
  background: rgba(255,255,255,0.02);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  flex-shrink: 0;
}
.mm-hint-text {
  font-size: 11px;
  color: var(--ou-text-secondary);
}
.mm-hint-text code {
  font-family: 'Monaco', 'Menlo', monospace;
  color: #ce9178;
  background: rgba(255,255,255,0.06);
  padding: 1px 4px;
  border-radius: 3px;
}

.mm-json-editor {
  flex: 1;
  width: 100%;
  background: var(--ou-bg-main);
  border: none;
  color: var(--ou-text);
  font-size: 13px;
  font-family: 'Monaco', 'Menlo', 'Fira Code', monospace;
  line-height: 1.6;
  padding: 14px 16px;
  resize: none;
  outline: none;
  box-sizing: border-box;
  overflow-y: auto;
}
.mm-json-editor::-webkit-scrollbar { width: 6px; }
.mm-json-editor::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }

.mm-example {
  flex-shrink: 0;
  border-top: 1px solid rgba(255,255,255,0.06);
  background: var(--ou-bg-sidebar);
  max-height: 150px;
  overflow-y: auto;
}
.mm-example::-webkit-scrollbar { width: 4px; }
.mm-example::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

.mm-example-title {
  font-size: 10px;
  color: var(--ou-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 16px 4px;
}
.mm-example-code {
  font-size: 10.5px;
  font-family: 'Monaco', 'Menlo', monospace;
  color: var(--ou-text-secondary);
  padding: 0 16px 10px;
  margin: 0;
  white-space: pre;
  line-height: 1.5;
}

.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
