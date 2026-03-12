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
          <label>主模型</label>
          <div class="primary-model-input">
            <template v-if="config.defaultModel">
              <button type="button" class="pool-chip primary" @click="setPrimaryFromPool(config.defaultModel)">
                <span>{{ config.defaultModel }}</span>
                <em>主</em>
                <i class="chip-del" @click.stop="removeModelFromPool(config.defaultModel)">×</i>
              </button>
            </template>
            <button type="button" class="custom-model-btn" @click="openManualModelDialog('primary')">
              <Plus :size="12" />
              <span>设置自定义主模型</span>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label>模型池</label>
          <div class="model-pool-input">
            <template v-for="id in normalizePool(config.modelPool)" :key="id">
              <button
                v-if="id !== config.defaultModel"
                type="button"
                class="pool-chip"
                @click="setPrimaryFromPool(id)"
                :title="'点击设为主模型'"
              >
                <span>{{ id }}</span>
                <i class="chip-del" @click.stop="removeModelFromPool(id)">×</i>
              </button>
            </template>
            <button type="button" class="custom-model-btn" @click="openManualModelDialog('pool')">
              <Plus :size="12" />
              <span>添加自定义模型</span>
            </button>
          </div>
          <span class="hint">列表首选模型会成为主模型，后续点击加入模型池；已选模型可在标签中删除。</span>
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
          :class="{ selected: isInModelPool(m.id), primary: config.defaultModel === m.id }"
          @click="onModelCardClick(m.id)"
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
  <div v-if="showManualModelDialog" class="manual-model-mask">
    <div class="manual-model-dialog">
      <h4>{{ manualDialog.mode === 'primary' ? '设置自定义主模型' : '添加自定义模型' }}</h4>
      <div class="form-group">
        <label>模型 ID</label>
        <input v-model="manualDialog.modelId" type="text" />
      </div>
      <div class="form-group">
        <label>API Base URL</label>
        <input v-model="manualDialog.baseUrl" type="text" placeholder="https://api.openai.com/v1" />
      </div>
      <div class="form-group">
        <label>API Key</label>
        <input v-model="manualDialog.apiKey" type="password" placeholder="sk-..." />
      </div>
      <div class="manual-actions">
        <button class="btn" @click="cancelManualDialog">取消</button>
        <button class="btn primary" @click="confirmManualDialog">确认</button>
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
  { name: '七牛 AI', baseUrl: 'https://api.qnaigc.com/v1', apiKey: '' },
  { name: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '' },
  { name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', apiKey: '' },
  { name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', apiKey: '' },
  { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.ai/v1', apiKey: '' },
  { name: '零一万物 Yi', baseUrl: 'https://api.lingyiwanwu.com/v1', apiKey: '' },
  { name: 'Minimax', baseUrl: 'https://api.minimax.chat/v1', apiKey: '' },
  { name: '火山引擎豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: '' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '' },
  { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: '' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '' },
  { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', apiKey: '' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: '' },
  { name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiKey: '' },
]

const config = reactive({
  apiKey: '',
  apiBaseUrl: 'https://api.qnaigc.com/v1',
  defaultModel: 'deepseek-v3',
  modelPool: ['deepseek-v3'],
  modelBindings: { 'deepseek-v3': 'https://api.qnaigc.com/v1' },
  temperature: 0,
  maxTokens: 0,
  maxToolIterations: 0
})

const providerKeys = reactive({})

// 完整配置（与 openultron.json 的 ai 字段一致），用于 load/save raw
const rawData = reactive({
  defaultProvider: 'https://api.qnaigc.com/v1',
  defaultModel: 'deepseek-v3',
  modelPool: ['deepseek-v3'],
  modelBindings: { 'deepseek-v3': 'https://api.qnaigc.com/v1' },
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
    apiKey: customApiKey.value.trim()
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
const verifiedModels = new Set()
const verifiedModelProvider = new Map()
const showManualModelDialog = ref(false)
const manualDialog = reactive({
  mode: 'pool',
  modelId: '',
  baseUrl: '',
  apiKey: ''
})

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
      return { name: p.name, baseUrl: p.baseUrl, apiKey: saved.apiKey ?? '' }
    }
    return { ...p }
  })
  byUrl.forEach((saved) => merged.push({ name: saved.name || saved.baseUrl, baseUrl: saved.baseUrl, apiKey: saved.apiKey ?? '' }))
  return merged
}

function applyRawToState(raw) {
  if (!raw || !Array.isArray(raw.providers)) return
  rawData.defaultProvider = raw.defaultProvider ?? rawData.defaultProvider
  rawData.defaultModel = raw.defaultModel ?? rawData.defaultModel
  rawData.modelPool = Array.isArray(raw.modelPool) ? [...new Set(raw.modelPool.map(x => String(x || '').trim()).filter(Boolean))] : [rawData.defaultModel]
  rawData.modelBindings = raw.modelBindings && typeof raw.modelBindings === 'object' ? { ...raw.modelBindings } : {}
  rawData.temperature = raw.temperature ?? 0
  rawData.maxTokens = raw.maxTokens ?? 0
  rawData.maxToolIterations = raw.maxToolIterations ?? 0
  rawData.providers = mergeProvidersWithSaved(DEFAULT_PROVIDERS, raw.providers)
  const cur = rawData.providers.find(p => p.baseUrl === rawData.defaultProvider)
  config.apiBaseUrl = rawData.defaultProvider
  config.apiKey = cur?.apiKey ?? ''
  config.defaultModel = rawData.defaultModel || 'deepseek-v3'
  config.modelPool = [...new Set((rawData.modelPool || []).filter(Boolean))]
  if (!config.modelPool.includes(config.defaultModel)) config.modelPool.unshift(config.defaultModel)
  config.modelBindings = { ...rawData.modelBindings }
  if (config.defaultModel && config.apiBaseUrl && !config.modelBindings[config.defaultModel]) {
    config.modelBindings[config.defaultModel] = config.apiBaseUrl
  }
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
  config.apiBaseUrl = p.baseUrl
  config.apiKey = p.apiKey || ''
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

const normalizePool = (arr) => {
  const list = Array.isArray(arr) ? arr.map(x => String(x || '').trim()).filter(Boolean) : []
  return [...new Set(list)]
}

const isInModelPool = (modelId) => normalizePool(config.modelPool).includes(String(modelId || '').trim())

const verifyModelAvailability = async (modelId, providerBaseUrl = '') => {
  const id = String(modelId || '').trim()
  if (!id) return false
  const key = `${id}@@${providerBaseUrl || '*'}`
  if (verifiedModels.has(key)) return true
  try {
    const payload = providerBaseUrl ? { model: id, provider: providerBaseUrl } : { model: id }
    const res = await window.electronAPI.ai.verifyModel(payload)
    if (res?.success) {
      verifiedModels.add(key)
      if (res.provider) verifiedModelProvider.set(id, res.provider)
      else if (providerBaseUrl) verifiedModelProvider.set(id, providerBaseUrl)
      return true
    }
    saveMsg.value = (res && (res.error || res.message)) || '模型不可用'
    saveType.value = 'error'
    setTimeout(() => { saveMsg.value = '' }, 4000)
    return false
  } catch (e) {
    saveMsg.value = e?.message || '模型校验失败'
    saveType.value = 'error'
    setTimeout(() => { saveMsg.value = '' }, 4000)
    return false
  }
}

const validatePoolBeforeSave = async () => {
  const candidates = [...new Set([config.defaultModel, ...normalizePool(config.modelPool)].filter(Boolean))]
  for (const id of candidates) {
    const provider = config.modelBindings[id] || ''
    // eslint-disable-next-line no-await-in-loop
    const ok = await verifyModelAvailability(id, provider)
    if (!ok) return false
  }
  return true
}

const setPrimaryFromPool = (modelId) => {
  const id = String(modelId || '').trim()
  if (!id) return
  const pool = normalizePool(config.modelPool)
  if (!pool.includes(id)) return
  config.defaultModel = id
  config.modelPool = pool
  const bound = config.modelBindings[id]
  if (bound) {
    config.apiBaseUrl = bound
    rawData.defaultProvider = bound
    const p = rawData.providers.find(x => x.baseUrl === bound)
    if (p) config.apiKey = p.apiKey || ''
  }
  rawData.modelPool = [...pool]
}

const removeModelFromPool = (modelId) => {
  const id = String(modelId || '').trim()
  if (!id) return
  const pool = normalizePool(config.modelPool).filter(x => x !== id)
  config.modelPool = pool
  if (config.modelBindings[id]) delete config.modelBindings[id]
  if (config.defaultModel === id) {
    config.defaultModel = pool[0] || ''
  }
  rawData.modelPool = [...pool]
}

const addToPoolWithRule = async (modelId) => {
  const id = String(modelId || '').trim()
  if (!id) return
  if (!(await verifyModelAvailability(id, config.apiBaseUrl))) return
  const pool = normalizePool(config.modelPool)
  if (!config.defaultModel || pool.length === 0) {
    config.defaultModel = id
    config.modelBindings[id] = config.apiBaseUrl
    config.modelPool = [id]
    rawData.modelPool = [id]
    return
  }
  config.modelBindings[id] = config.apiBaseUrl
  if (!pool.includes(id)) pool.push(id)
  if (!pool.includes(config.defaultModel)) pool.unshift(config.defaultModel)
  config.modelPool = pool
  rawData.modelPool = [...pool]
}

const onModelCardClick = async (modelId) => {
  const id = String(modelId || '').trim()
  if (!id) return
  const exists = isInModelPool(id)
  if (!exists) {
    const prevPool = normalizePool(config.modelPool)
    const prevPrimary = config.defaultModel
    const prevBindings = { ...(config.modelBindings || {}) }
    if (!prevPrimary || prevPool.length === 0) {
      config.defaultModel = id
      config.modelBindings[id] = config.apiBaseUrl
      config.modelPool = [id]
      rawData.modelPool = [id]
    } else {
      const nextPool = [...prevPool, id]
      config.modelBindings[id] = config.apiBaseUrl
      config.modelPool = normalizePool(nextPool)
      rawData.modelPool = [...config.modelPool]
    }
    const ok = await verifyModelAvailability(id, config.apiBaseUrl)
    if (!ok) {
      config.defaultModel = prevPrimary
      config.modelBindings = prevBindings
      config.modelPool = prevPool
      rawData.modelPool = [...prevPool]
    }
    return
  }
  if (id !== config.defaultModel) {
    removeModelFromPool(id)
  }
}

const openManualModelDialog = (mode = 'pool') => {
  manualDialog.mode = mode === 'primary' ? 'primary' : 'pool'
  manualDialog.modelId = ''
  manualDialog.baseUrl = config.apiBaseUrl || ''
  manualDialog.apiKey = String(config.apiKey || providerKeys[config.apiBaseUrl] || '').trim()
  showManualModelDialog.value = true
}

const cancelManualDialog = () => {
  showManualModelDialog.value = false
  manualDialog.mode = 'pool'
  manualDialog.modelId = ''
  manualDialog.baseUrl = ''
  manualDialog.apiKey = ''
}

const ensureProviderByBaseUrl = (baseUrl, apiKey = '') => {
  const b = String(baseUrl || '').trim().replace(/\/$/, '')
  if (!b) return null
  let p = rawData.providers.find(x => x.baseUrl === b)
  if (!p) {
    let name = b
    try { name = new URL(b).hostname } catch (_) {}
    p = { name, baseUrl: b, apiKey: '' }
    rawData.providers.push(p)
  }
  if (apiKey) p.apiKey = apiKey
  return p
}

const confirmManualDialog = async () => {
  const modelId = String(manualDialog.modelId || '').trim()
  const baseUrl = String(manualDialog.baseUrl || '').trim().replace(/\/$/, '')
  const apiKey = String(manualDialog.apiKey || '').trim()
  if (!modelId || !baseUrl || !apiKey) return
  const provider = ensureProviderByBaseUrl(baseUrl, apiKey)
  if (!provider) return
  const ok = await verifyModelAvailability(modelId, baseUrl)
  if (!ok) return
  config.modelBindings[modelId] = baseUrl
  const pool = normalizePool(config.modelPool)
  if (!pool.includes(modelId)) pool.push(modelId)
  if (manualDialog.mode === 'primary' || !config.defaultModel) {
    config.defaultModel = modelId
    const idx = pool.indexOf(modelId)
    if (idx > 0) {
      pool.splice(idx, 1)
      pool.unshift(modelId)
    }
  }
  if (config.defaultModel && !pool.includes(config.defaultModel)) pool.unshift(config.defaultModel)
  config.modelPool = pool
  rawData.modelPool = [...pool]
  cancelManualDialog()
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
        if (!config.defaultModel) {
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
  }))
  const modelPool = normalizePool(config.modelPool)
  if (config.defaultModel && !modelPool.includes(config.defaultModel)) modelPool.unshift(config.defaultModel)
  const modelBindings = { ...(config.modelBindings || {}) }
  if (config.defaultModel && !modelBindings[config.defaultModel] && config.apiBaseUrl) {
    modelBindings[config.defaultModel] = config.apiBaseUrl
  }
  const defaultProvider = modelBindings[config.defaultModel] || config.apiBaseUrl
  return {
    defaultProvider,
    defaultModel: config.defaultModel,
    modelPool,
    modelBindings,
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
    const ok = await validatePoolBeforeSave()
    if (!ok) {
      saveType.value = 'error'
      return
    }
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
.model-card.primary {
  box-shadow: inset 0 0 0 1px rgba(0, 122, 204, 0.5);
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
.primary-model-input,
.model-pool-input {
  min-height: 38px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: var(--ou-bg-main);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
}
.pool-chip {
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: var(--ou-text-muted);
  border-radius: 999px;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pool-chip em {
  font-style: normal;
  font-size: 10px;
  opacity: 0.9;
}
.chip-del {
  font-style: normal;
  font-size: 12px;
  opacity: 0.85;
}
.pool-chip.primary {
  border-color: var(--ou-primary);
  color: var(--ou-link);
  background: rgba(0, 122, 204, 0.14);
}
.custom-model-btn {
  border: 1px dashed rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.03);
  color: var(--ou-text-muted);
  border-radius: 999px;
  font-size: 11px;
  padding: 4px 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.custom-model-btn:hover {
  border-color: var(--ou-primary);
  color: var(--ou-link);
}
.model-actions {
  margin-top: 0;
}
.empty-models {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ou-text-muted);
  font-size: 12px;
  padding: 16px 0;
}

.manual-model-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.manual-model-dialog {
  width: 420px;
  max-width: calc(100vw - 32px);
  background: var(--ou-bg-main);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  padding: 14px;
}
.manual-model-dialog h4 {
  margin: 0 0 12px;
  font-size: 14px;
}
.manual-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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
