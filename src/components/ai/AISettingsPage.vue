<template>
  <div class="ai-settings-page">
    <div class="settings-header">
      <div class="header-left">
        <Settings :size="16" />
        <span>{{ t('aiSettings.title') }}</span>
      </div>
      <div class="header-right">
        <button class="btn primary" @click="saveConfig" :disabled="saving">
          <Save :size="14" />
          <span>{{ saving ? t('aiSettings.saving') : t('aiSettings.saveConfig') }}</span>
        </button>
        <span v-if="saveMsg" class="status-msg" :class="saveType">{{ saveMsg }}</span>
      </div>
    </div>

    <div class="settings-top">
      <!-- 左：API 连接 -->
      <div class="top-left">
        <h3>{{ t('aiSettings.apiConnection') }}</h3>
        <div class="provider-presets">
          <div
            v-for="p in providers"
            :key="p.baseUrl"
            class="provider-chip"
            :class="{ active: config.apiBaseUrl === p.baseUrl }"
            @click="selectProvider(p)"
          >
            <span>{{ p.name }}</span>
            <button
              v-if="isCustomProvider(p)"
              class="chip-remove"
              :title="t('aiSettings.removeCustomProvider')"
              @click.stop="removeProvider(p)"
            >
              <XCircle :size="12" />
            </button>
          </div>
          <button
            v-if="!showCustomForm"
            type="button"
            class="provider-chip add-custom"
            @click="showCustomForm = true"
          >
            <Plus :size="14" />
            <span>{{ t('aiSettings.customProvider') }}</span>
          </button>
        </div>
        <div v-if="showCustomForm" class="custom-provider-form">
          <div class="form-row">
            <input v-model="customName" :placeholder="t('aiSettings.customNamePh')" class="custom-input" />
            <input v-model="customBaseUrl" :placeholder="t('aiSettings.customApiUrlPh')" class="custom-input wide" />
          </div>
          <div class="form-row">
            <input v-model="customApiKey" type="password" placeholder="API Key" class="custom-input" />
            <input v-model="customDefaultModel" :placeholder="t('aiSettings.customDefaultModelPh')" class="custom-input" />
          </div>
          <div class="form-actions">
            <button type="button" class="btn primary" @click="addCustomProvider">{{ t('aiSettings.add') }}</button>
            <button type="button" class="btn" @click="cancelCustomForm">{{ t('aiSettings.cancel') }}</button>
          </div>
        </div>
        <div class="form-group">
          <label>{{ t('aiSettings.apiUrl') }}</label>
          <input
            type="text"
            v-model="config.apiBaseUrl"
            placeholder="https://api.openai.com/v1"
            @blur="onBaseUrlBlur"
          />
        </div>
        <div class="form-group">
          <label>API Key <span class="key-provider-hint" v-if="currentProviderName">（{{ currentProviderName }}）</span></label>
          <div class="input-with-action">
            <input
              :type="showKey ? 'text' : 'password'"
              v-model="config.apiKey"
              :placeholder="t('aiSettings.apiKeyPh')"
              @blur="onKeyBlur"
              @keydown.enter="onKeyBlur"
            />
            <button class="toggle-btn" @click="showKey = !showKey">
              <Eye v-if="!showKey" :size="14" />
              <EyeOff v-else :size="14" />
            </button>
          </div>
          <span class="hint">{{ t('aiSettings.keyHint') }}</span>
          <div class="connection-status" v-if="connectionState !== 'idle'">
            <Loader v-if="connectionState === 'testing'" :size="13" class="spin" />
            <CheckCircle2 v-else-if="connectionState === 'success'" :size="13" />
            <XCircle v-else-if="connectionState === 'error'" :size="13" />
            <span :class="connectionState">{{ connectionMsg }}</span>
            <button
              v-if="connectionState !== 'testing'"
              class="retest-btn"
              @click="retestConnection"
              :title="t('aiSettings.retest')"
            >
              <RefreshCw :size="12" />
            </button>
          </div>
        </div>
      </div>

      <!-- 右：高级参数 -->
      <div class="top-right">
        <h3>{{ t('aiSettings.advanced') }}</h3>
        <div class="form-group">
          <label>{{ t('aiSettings.currentModel') }}</label>
          <input
            type="text"
            v-model="config.defaultModel"
            :placeholder="t('aiSettings.modelPh')"
          />
          <span class="hint">{{ t('aiSettings.modelHint') }}</span>
        </div>
        <div class="params-row">
          <div class="form-group">
            <label>Temperature</label>
            <input type="number" v-model.number="config.temperature" min="0" max="2" step="0.1" />
            <span class="hint">{{ t('aiSettings.tempHint') }}</span>
          </div>
          <div class="form-group">
            <label>Max Tokens</label>
            <input type="number" v-model.number="config.maxTokens" min="0" max="131072" step="256" />
            <span class="hint">{{ t('aiSettings.maxTokenHint') }}</span>
          </div>
        </div>
        <div class="form-group">
          <label>{{ t('aiSettings.maxToolIterations') }}</label>
          <input type="number" v-model.number="config.maxToolIterations" min="0" max="500" />
          <span class="hint">{{ t('aiSettings.maxToolHint') }}</span>
        </div>
      </div>
    </div>

    <!-- 模型列表：平铺展开 -->
    <div class="models-section">
      <div class="models-header">
        <h3>
          {{ t('aiSettings.modelList') }}
          <span class="model-count" v-if="models.length">{{ filteredModels.length }} / {{ models.length }}</span>
        </h3>
        <div class="models-toolbar">
          <div v-if="models.length > 0" class="model-search">
            <Search :size="13" class="search-icon" />
            <input
              type="text"
              v-model="modelSearch"
              :placeholder="t('aiSettings.searchModelPh')"
              class="model-search-input"
            />
          </div>
          <button
            class="refresh-models-btn"
            @click="refreshModels"
            :disabled="fetchingModels"
            :title="t('aiSettings.refreshModelsTitle')"
          >
            <RefreshCw :size="13" :class="{ spin: fetchingModels }" />
            <span>{{ t('aiSettings.refreshModels') }}</span>
          </button>
        </div>
      </div>

      <div v-if="filteredModels.length > 0" class="model-grid">
        <div
          v-for="m in filteredModels"
          :key="m.id"
          class="model-card"
          :class="{ selected: config.defaultModel === m.id }"
          @click="config.defaultModel = m.id"
        >
          <div class="model-card-radio">
            <div class="radio-dot" v-if="config.defaultModel === m.id"></div>
          </div>
          <div class="model-card-info">
            <span class="model-name">{{ m.id }}</span>
            <div class="model-meta" v-if="m.owned_by || m.source === 'openrouter'">
              <span v-if="m.owned_by" class="model-owner">{{ m.owned_by }}</span>
              <span v-if="m.source === 'openrouter'" class="model-source-tag or">OpenRouter</span>
              <span v-else-if="m.source === 'anthropic'" class="model-source-tag claude">Anthropic</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="models.length > 0 && modelSearch" class="empty-models">
        <span>{{ t('aiSettings.noMatchedModel', { query: modelSearch }) }}</span>
      </div>
      <div v-else-if="connectionState === 'testing'" class="empty-models">
        <Loader :size="14" class="spin" />
        <span>{{ t('aiSettings.testingAndFetching') }}</span>
      </div>
      <div v-else-if="connectionState === 'success' && models.length === 0" class="empty-models">
        <span>{{ t('aiSettings.noModelsFromApi') }}</span>
      </div>
      <div v-else-if="connectionState === 'idle'" class="empty-models">
        <span>{{ t('aiSettings.emptyModelGuide') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { Settings, Eye, EyeOff, Save, RefreshCw, Loader, CheckCircle2, XCircle, Search, Plus } from 'lucide-vue-next'
import { useI18n } from '../../composables/useI18n'

const { t } = useI18n()

// 与 electron/openultron-config.js DEFAULT_AI.providers 保持一致（国内 + 国外主流）
const DEFAULT_PROVIDERS = [
  { name: '七牛 AI', baseUrl: 'https://api.qnaigc.com/v1', apiKey: '', defaultModel: 'deepseek-v3' },
  { name: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', defaultModel: 'glm-4-flash' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', defaultModel: 'qwen-turbo' },
  { name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', apiKey: '', defaultModel: 'ernie-4.0-turbo-8k' },
  { name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', apiKey: '', defaultModel: 'hunyuan-lite' },
  { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.ai/v1', apiKey: '', defaultModel: 'moonshot-v1-8k' },
  { name: '零一万物 Yi', baseUrl: 'https://api.lingyiwanwu.com/v1', apiKey: '', defaultModel: 'yi-large-turbo' },
  { name: 'Minimax', baseUrl: 'https://api.minimax.chat/v1', apiKey: '', defaultModel: '' },
  { name: '火山引擎豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: '', defaultModel: '' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', defaultModel: '' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', defaultModel: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '', defaultModel: 'gpt-4o-mini' },
  { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: '', defaultModel: 'claude-3-5-sonnet-20241022' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', defaultModel: '' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', defaultModel: 'llama-3.1-70b-versatile' },
  { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', apiKey: '', defaultModel: '' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: '', defaultModel: 'mistral-small-latest' },
  { name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiKey: '', defaultModel: 'grok-2-1212' },
]

const config = reactive({
  apiKey: '',
  apiBaseUrl: 'https://api.qnaigc.com/v1',
  defaultModel: 'deepseek-v3',
  temperature: 0,
  maxTokens: 0,
  maxToolIterations: 0
})

const providerKeys = reactive({})

// 完整配置（与 openultron.json 的 ai 字段一致），用于 load/save raw
const rawData = reactive({
  defaultProvider: 'https://api.qnaigc.com/v1',
  defaultModel: 'deepseek-v3',
  temperature: 0,
  maxTokens: 0,
  maxToolIterations: 0,
  providers: JSON.parse(JSON.stringify(DEFAULT_PROVIDERS)),
})

const providers = computed(() => (rawData.providers?.length ? rawData.providers : DEFAULT_PROVIDERS))

const defaultBaseUrls = new Set(DEFAULT_PROVIDERS.map(p => p.baseUrl))
function isCustomProvider(p) {
  return p && p.baseUrl && !defaultBaseUrls.has(p.baseUrl)
}

const showCustomForm = ref(false)
const customName = ref('')
const customBaseUrl = ref('')
const customApiKey = ref('')
const customDefaultModel = ref('')

function addCustomProvider() {
  const name = customName.value.trim()
  const baseUrl = customBaseUrl.value.trim().replace(/\/$/, '')
  if (!name || !baseUrl) return
  if (rawData.providers.some(p => p.baseUrl === baseUrl)) {
    return
  }
  const newProvider = {
    name,
    baseUrl,
    apiKey: customApiKey.value.trim(),
    defaultModel: customDefaultModel.value.trim() || ''
  }
  rawData.providers.push(newProvider)
  cancelCustomForm()
  selectProvider(newProvider)
  doSaveConfig().catch(() => {})
}

function cancelCustomForm() {
  showCustomForm.value = false
  customName.value = ''
  customBaseUrl.value = ''
  customApiKey.value = ''
  customDefaultModel.value = ''
}

function removeProvider(p) {
  if (!isCustomProvider(p)) return
  const idx = rawData.providers.findIndex(x => x.baseUrl === p.baseUrl)
  if (idx < 0) return
  const wasCurrent = config.apiBaseUrl === p.baseUrl
  rawData.providers.splice(idx, 1)
  if (wasCurrent && rawData.providers.length > 0) {
    selectProvider(rawData.providers[0])
  }
  doSaveConfig().catch(() => {})
}

const showKey = ref(false)
const saving = ref(false)
const saveMsg = ref('')
const saveType = ref('')

const connectionState = ref('idle')
const connectionMsg = ref('')

const models = ref([])
const fetchingModels = ref(false)
const modelSearch = ref('')

let lastTestedCombo = ''
const getCombo = () => `${config.apiBaseUrl}|||${config.apiKey}`

const currentProviderName = computed(() => {
  const p = providers.value.find(x => x.baseUrl === config.apiBaseUrl)
  return p ? p.name : ''
})

const filteredModels = computed(() => {
  if (!modelSearch.value) return models.value
  const q = modelSearch.value.toLowerCase()
  return models.value.filter(m =>
    m.id.toLowerCase().includes(q) ||
    (m.owned_by && m.owned_by.toLowerCase().includes(q)) ||
    (m.source && m.source.toLowerCase().includes(q))
  )
})

// 合并默认供应商与服务端返回的列表，确保页面上始终展示全部预设（含升级后新增的）
function mergeProvidersWithSaved(defaultList, savedList) {
  if (!Array.isArray(savedList) || savedList.length === 0) return defaultList.map(p => ({ ...p }))
  const byUrl = new Map(savedList.filter(p => p && p.baseUrl).map(p => [p.baseUrl, p]))
  const merged = defaultList.map(p => {
    const saved = byUrl.get(p.baseUrl)
    if (saved) {
      byUrl.delete(p.baseUrl)
      return { name: p.name, baseUrl: p.baseUrl, apiKey: saved.apiKey ?? '', defaultModel: saved.defaultModel ?? p.defaultModel ?? '' }
    }
    return { ...p }
  })
  byUrl.forEach((saved) => merged.push({ name: saved.name || saved.baseUrl, baseUrl: saved.baseUrl, apiKey: saved.apiKey ?? '', defaultModel: saved.defaultModel ?? '' }))
  return merged
}

function applyRawToState(raw) {
  if (!raw || !Array.isArray(raw.providers)) return
  rawData.defaultProvider = raw.defaultProvider ?? rawData.defaultProvider
  rawData.defaultModel = raw.defaultModel ?? rawData.defaultModel
  rawData.temperature = raw.temperature ?? 0
  rawData.maxTokens = raw.maxTokens ?? 0
  rawData.maxToolIterations = raw.maxToolIterations ?? 0
  rawData.providers = mergeProvidersWithSaved(DEFAULT_PROVIDERS, raw.providers)
  const cur = rawData.providers.find(p => p.baseUrl === rawData.defaultProvider)
  config.apiBaseUrl = rawData.defaultProvider
  config.apiKey = cur?.apiKey ?? ''
  config.defaultModel = cur?.defaultModel || rawData.defaultModel || 'deepseek-v3'
  config.temperature = rawData.temperature
  config.maxTokens = rawData.maxTokens
  config.maxToolIterations = rawData.maxToolIterations
  for (const p of rawData.providers) {
    if (p.baseUrl) providerKeys[p.baseUrl] = p.apiKey || ''
  }
}

// 从主进程拉取最新配置并应用到页面（含 AI 通过 ai_config_control 修改后的同步）
async function loadConfigFromBackend() {
  try {
    const res = await window.electronAPI?.ai?.getConfig?.()
    if (res?.success) {
      if (res.raw && res.raw.providers?.length) {
        applyRawToState(res.raw)
      } else {
        if (res.config) Object.assign(config, res.config)
        if (res.providerKeys) Object.assign(providerKeys, res.providerKeys)
        for (const p of rawData.providers) {
          if (p.baseUrl && providerKeys[p.baseUrl] !== undefined) {
            p.apiKey = providerKeys[p.baseUrl] || ''
          }
        }
      }
    }
  } catch { /* ignore */ }
}

onMounted(async () => {
  await loadConfigFromBackend()
  try {
    const res = await window.electronAPI.ai.getModels(config.apiBaseUrl)
    if (res.success && res.models?.length > 0) {
      models.value = res.models
      if (config.apiKey) {
        connectionState.value = 'success'
        connectionMsg.value = t('aiSettings.loadedCached', { count: models.value.length })
      }
    }
  } catch { /* ignore */ }

  window.electronAPI?.onAIConfigUpdated?.(async () => {
    await loadConfigFromBackend()
    try {
      const res = await window.electronAPI.ai.getModels(config.apiBaseUrl)
      if (res.success && res.models?.length > 0) {
        models.value = res.models
        connectionState.value = 'success'
        connectionMsg.value = t('aiSettings.syncedWithAi', { count: models.value.length })
      } else {
        models.value = []
      }
    } catch { /* ignore */ }
  })
})

onBeforeUnmount(() => {
  window.electronAPI?.removeAIConfigUpdatedListener?.()
})

const selectProvider = (p) => {
  const cur = rawData.providers.find(x => x.baseUrl === config.apiBaseUrl)
  if (cur && config.apiKey !== undefined) cur.apiKey = config.apiKey

  const changed = config.apiBaseUrl !== p.baseUrl
  rawData.defaultProvider = p.baseUrl
  rawData.defaultModel = p.defaultModel || rawData.defaultModel || 'deepseek-v3'
  config.apiBaseUrl = p.baseUrl
  config.apiKey = p.apiKey || ''
  config.defaultModel = p.defaultModel || rawData.defaultModel
  modelSearch.value = ''

  if (changed) {
    lastTestedCombo = ''
    connectionState.value = 'idle'
    connectionMsg.value = ''
    doSaveConfig().catch(() => {})
    if (config.apiKey) {
      window.electronAPI.ai.getModels(config.apiBaseUrl).then(res => {
        if (res.success && res.models?.length > 0) {
          models.value = res.models
          connectionState.value = 'success'
          connectionMsg.value = t('aiSettings.loadedCached', { count: models.value.length })
        } else {
          models.value = []
        }
      }).catch(() => { models.value = [] })
    } else {
      models.value = []
    }
  }
}

const onBaseUrlBlur = async () => {
  if (!config.apiKey) return
  await doSaveConfig()
  // 不自动拉取模型，仅保存配置；需要时用户点击「刷新模型列表」
}

const onKeyBlur = async () => {
  const key = config.apiKey.trim()
  const cur = rawData.providers.find(p => p.baseUrl === config.apiBaseUrl)
  if (cur) cur.apiKey = key
  if (!key) {
    connectionState.value = 'idle'
    connectionMsg.value = ''
    await doSaveConfig()
    return
  }
  providerKeys[config.apiBaseUrl] = key
  await doSaveConfig()
  try {
    const res = await window.electronAPI.ai.getModels(config.apiBaseUrl)
    if (res.success && res.models?.length > 0) {
      models.value = res.models
      connectionState.value = 'success'
      connectionMsg.value = t('aiSettings.loadedCached', { count: models.value.length })
    }
  } catch { /* ignore */ }
}

const retestConnection = async () => {
  if (!config.apiKey.trim()) return
  lastTestedCombo = ''
  await doSaveConfig()
  await testAndFetchModels(true)
}

const testAndFetchModels = async (forceRefresh = false) => {
  connectionState.value = 'testing'
  connectionMsg.value = t('aiSettings.testing')

  try {
    if (typeof window.electronAPI.ai.fetchModels !== 'function') {
      throw new Error(t('aiSettings.restartToLoad'))
    }
    const res = await window.electronAPI.ai.fetchModels({ forceRefresh })
    if (res.success) {
      models.value = res.models || []
      lastTestedCombo = getCombo()

      if (res.keyInvalid) {
        connectionState.value = 'error'
        connectionMsg.value = res.message || t('aiSettings.keyInvalid')
      } else {
        connectionState.value = 'success'
        const claudeInfo = res.claudeDiag ? ` (${res.claudeDiag})` : ''
        connectionMsg.value = t('aiSettings.connectOk', { count: models.value.length, extra: claudeInfo })
      }

      if (models.value.length > 0) {
        const ids = models.value.map(m => m.id)
        if (!ids.includes(config.defaultModel)) {
          config.defaultModel = models.value[0].id
        }
      }
    } else {
      connectionState.value = 'error'
      connectionMsg.value = res.message || t('aiSettings.connectFailed')
    }
  } catch (e) {
    connectionState.value = 'error'
    connectionMsg.value = e.message || t('aiSettings.connectFailed')
  }
}

const refreshModels = async () => {
  fetchingModels.value = true
  lastTestedCombo = ''
  await doSaveConfig()
  await testAndFetchModels(true)
  fetchingModels.value = false
}

function buildRawPayload() {
  // 基于副本更新当前供应商，避免误改其他供应商的 apiKey
  const providers = rawData.providers.map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.baseUrl === config.apiBaseUrl ? (config.apiKey ?? p.apiKey ?? '') : (p.apiKey ?? ''),
    defaultModel: p.baseUrl === config.apiBaseUrl ? (config.defaultModel || p.defaultModel || '') : (p.defaultModel ?? ''),
  }))
  return {
    defaultProvider: config.apiBaseUrl,
    defaultModel: config.defaultModel,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    maxToolIterations: config.maxToolIterations,
    providers,
  }
}

const doSaveConfig = async () => {
  try {
    const res = await window.electronAPI.ai.saveConfig({ raw: buildRawPayload() })
    if (res && res.success) {
      window.dispatchEvent(new CustomEvent('ai-config-updated'))
    } else if (res && !res.success) {
      saveMsg.value = res.message || t('aiSettings.saveFailed')
      saveType.value = 'error'
      setTimeout(() => { saveMsg.value = '' }, 4000)
    }
  } catch (e) {
    saveMsg.value = (e && e.message) || t('aiSettings.saveFailed')
    saveType.value = 'error'
    setTimeout(() => { saveMsg.value = '' }, 4000)
  }
}

const saveConfig = async () => {
  saving.value = true
  saveMsg.value = ''
  try {
    const raw = buildRawPayload()
    const res = await window.electronAPI.ai.saveConfig({ raw })
    if (res.success) {
      Object.assign(rawData, raw)
      saveMsg.value = t('aiSettings.saved')
      saveType.value = 'success'
      window.dispatchEvent(new CustomEvent('ai-config-updated'))
    } else {
      saveMsg.value = res.message || t('aiSettings.saveFailed')
      saveType.value = 'error'
    }
  } catch (e) {
    saveMsg.value = e.message
    saveType.value = 'error'
  } finally {
    saving.value = false
    setTimeout(() => { saveMsg.value = '' }, 3000)
  }
}
</script>

<style scoped>
.ai-settings-page {
  padding: 20px 24px;
  color: var(--ou-text);
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}
.ai-settings-page::-webkit-scrollbar { width: 6px; }
.ai-settings-page::-webkit-scrollbar-track { background: transparent; }
.ai-settings-page::-webkit-scrollbar-thumb { background: var(--ou-border); border-radius: 3px; }
.ai-settings-page::-webkit-scrollbar-thumb:hover { background: var(--ou-border); }

/* 头部：图标 + 标题 + 分割线（与日志/备份等子页一致） */
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ou-border);
  margin-bottom: 20px;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
}
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 上部两栏 */
.settings-top {
  display: flex;
  gap: 28px;
  margin-bottom: 24px;
}
.top-left {
  flex: 1;
  min-width: 0;
}
.top-right {
  width: 280px;
  flex-shrink: 0;
}
.settings-top h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text-muted);
  margin: 0 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ou-border);
}
.params-row {
  display: flex;
  gap: 10px;
}
.params-row .form-group {
  flex: 1;
}

.generic-search-section {
  margin-top: 20px;
}
.generic-search-section .section-desc {
  font-size: 12px;
  color: var(--ou-text-muted);
  margin: -4px 0 12px;
  line-height: 1.45;
}
.generic-search-section .hint a {
  color: var(--ou-link);
  text-decoration: none;
}
.generic-search-section .hint a:hover {
  text-decoration: underline;
}

/* 提供商 */
.provider-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.provider-chip {
  padding: 4px 11px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: var(--ou-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}
.provider-chip:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
  color: var(--ou-text);
}
.provider-chip.active {
  background: rgba(0, 122, 204, 0.15);
  border-color: var(--ou-primary);
  color: var(--ou-link);
}
.provider-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.provider-chip.add-custom {
  border-style: dashed;
  color: var(--ou-text-muted);
}
.provider-chip.add-custom:hover {
  color: var(--ou-link);
  border-color: var(--ou-primary);
}
.provider-chip .chip-remove {
  padding: 0;
  margin: 0;
  margin-left: 2px;
  width: 16px;
  height: 16px;
  min-width: 16px;
  border: none;
  background: transparent;
  color: var(--ou-text-secondary);
  cursor: pointer;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.provider-chip .chip-remove:hover {
  color: var(--ou-error);
  background: rgba(241, 76, 76, 0.15);
}
.custom-provider-form {
  margin-bottom: 8px;
  border: 1px dashed rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  padding: 12px 14px;
  background: rgba(0, 0, 0, 0.15);
}
.custom-provider-form .form-row {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
}
.custom-provider-form .custom-input {
  flex: 1;
  min-width: 0;
  background: var(--ou-bg-main);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: var(--ou-text);
  font-size: 12px;
  padding: 6px 10px;
}
.custom-provider-form .custom-input.wide {
  flex: 2;
}
.custom-provider-form .form-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.key-provider-hint {
  font-weight: 400;
  color: var(--ou-text-secondary);
  font-size: 11px;
}

/* 表单 */
.form-group {
  margin-bottom: 12px;
}
.form-group label {
  display: block;
  font-size: 12px;
  color: #999;
  margin-bottom: 4px;
}
.form-group input {
  width: 100%;
  background: var(--ou-bg-main);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: var(--ou-text);
  font-size: 13px;
  padding: 7px 10px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}
.form-group input:focus { border-color: var(--ou-primary); }
.form-group .hint {
  display: block;
  font-size: 11px;
  color: var(--ou-text-muted);
  margin-top: 3px;
}
.input-with-action {
  display: flex;
  gap: 4px;
}
.input-with-action input { flex: 1; }
.toggle-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: var(--ou-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}
.toggle-btn:hover { background: rgba(255, 255, 255, 0.1); color: var(--ou-text); }

/* 连接状态 */
.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
}
.connection-status .testing { color: var(--ou-warning); }
.connection-status .success { color: var(--ou-success); }
.connection-status .error { color: var(--ou-error); }
.connection-status svg { flex-shrink: 0; }
.connection-status .spin { animation: spin 1s linear infinite; }
.connection-status :deep(svg.lucide-check-circle-2) { color: var(--ou-success); }
.connection-status :deep(svg.lucide-x-circle) { color: var(--ou-error); }
.connection-status :deep(svg.lucide-loader) { color: var(--ou-warning); }
.retest-btn {
  background: transparent;
  border: none;
  color: var(--ou-text-muted);
  cursor: pointer;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  margin-left: 2px;
  transition: all 0.15s;
}
.retest-btn:hover { background: rgba(255,255,255,0.08); color: var(--ou-text); }

/* 模型区域 */
.models-section {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding-top: 16px;
}
.models-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.models-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-count {
  font-weight: 400;
  font-size: 11px;
  color: var(--ou-text-secondary);
}
.models-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-search {
  position: relative;
}
.search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--ou-text-muted);
  pointer-events: none;
}
.model-search-input {
  width: 220px;
  background: var(--ou-bg-main);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--ou-text);
  font-size: 12px;
  padding: 6px 10px 6px 28px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}
.model-search-input:focus { border-color: var(--ou-primary); }
.model-search-input::placeholder { color: var(--ou-text-muted); }
.refresh-models-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--ou-text-muted);
  cursor: pointer;
  min-width: 30px;
  height: 30px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-radius: 6px;
  font-size: 12px;
  transition: all 0.15s;
}
.refresh-models-btn:hover { background: rgba(255,255,255,0.08); color: var(--ou-text); }
.refresh-models-btn:disabled { opacity: 0.4; cursor: default; }

/* 模型网格 - 平铺展开，不嵌套滚动 */
.model-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.model-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  min-width: 0;
}
.model-card:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.12);
}
.model-card.selected {
  background: rgba(0, 122, 204, 0.1);
  border-color: var(--ou-primary);
}
.model-card-radio {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.2);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}
.model-card.selected .model-card-radio { border-color: var(--ou-primary); }
.radio-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ou-primary);
}
.model-card-info {
  flex: 1;
  min-width: 0;
}
.model-name {
  font-size: 12px;
  color: var(--ou-text);
  word-break: break-all;
  line-height: 1.4;
}
.model-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}
.model-owner {
  font-size: 10px;
  color: var(--ou-text-muted);
}
.model-source-tag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
}
.model-source-tag.or {
  color: var(--ou-warning);
  background: rgba(229, 192, 123, 0.1);
}
.model-source-tag.claude {
  color: #c9a0dc;
  background: rgba(201, 160, 220, 0.1);
}
.empty-models {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ou-text-muted);
  font-size: 12px;
  padding: 16px 0;
}

/* 按钮 */
.btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: var(--ou-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn:hover { background: rgba(255, 255, 255, 0.1); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary {
  background: var(--ou-primary);
  border-color: var(--ou-primary);
  color: var(--ou-accent-fg);
}
.btn.primary:hover { background: var(--ou-primary-hover); }
.status-msg {
  font-size: 12px;
}
.status-msg.success { color: var(--ou-success); }
.status-msg.error { color: var(--ou-error); }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
