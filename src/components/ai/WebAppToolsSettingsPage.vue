<template>
  <div class="wat-settings-page">
    <div class="wat-header">
      <LayoutGrid :size="16" />
      <span>{{ t('webappAi.title') }}</span>
    </div>

    <p class="wat-desc">{{ t('webappAi.desc') }}</p>

    <section class="wat-section">
      <label class="wat-row">
        <input v-model="enabled" type="checkbox" :disabled="!hasApi" />
        <span>{{ t('webappAi.enable') }}</span>
      </label>
    </section>

    <section v-if="enabled" class="wat-section">
      <h3 class="wat-section-title">{{ t('webappAi.scopeTitle') }}</h3>
      <label class="wat-radio">
        <input v-model="scopeMode" type="radio" value="all" />
        <span>{{ t('webappAi.scopeAll') }}</span>
      </label>
      <label class="wat-radio">
        <input v-model="scopeMode" type="radio" value="restricted" />
        <span>{{ t('webappAi.scopeRestricted') }}</span>
      </label>

      <div v-if="scopeMode === 'restricted'" class="wat-app-box">
        <p class="wat-hint">{{ t('webappAi.scopeHint') }}</p>
        <div v-if="appsLoading" class="wat-muted">{{ t('webappAi.loadingApps') }}</div>
        <p v-else-if="appsError" class="wat-err">{{ appsError }}</p>
        <p v-else-if="!uniqueApps.length" class="wat-muted">{{ t('webappAi.emptyApps') }}</p>
        <template v-else>
          <div class="wat-app-actions">
            <button type="button" class="wat-link-btn" @click="selectAllIds">{{ t('webappAi.selectAll') }}</button>
            <button type="button" class="wat-link-btn" @click="selectNoIds">{{ t('webappAi.selectNone') }}</button>
          </div>
          <ul class="wat-app-list" role="list">
            <li v-for="row in uniqueApps" :key="row.id" class="wat-app-item">
              <label class="wat-app-label">
                <input
                  type="checkbox"
                  :checked="selectedIds.has(row.id)"
                  @change="toggleId(row.id, $event.target.checked)"
                />
                <span class="wat-app-name">{{ row.name }}</span>
                <code class="wat-app-id">{{ row.id }}</code>
              </label>
            </li>
          </ul>
        </template>
      </div>
    </section>

    <div class="wat-footer">
      <button type="button" class="wat-btn primary" :disabled="saving || !hasApi" @click="save">
        <Loader v-if="saving" :size="14" class="spin" />
        {{ saving ? t('webappAi.saving') : t('webappAi.save') }}
      </button>
      <span v-if="saveMsg" class="wat-save-msg" :class="saveOk ? 'ok' : 'err'">{{ saveMsg }}</span>
    </div>

    <p class="wat-footer-link">
      <router-link to="/web-apps">{{ t('webappAi.goLibrary') }}</router-link>
    </p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { LayoutGrid, Loader } from 'lucide-vue-next'
import { useI18n } from '../../composables/useI18n.js'

const { t } = useI18n()
const api = window.electronAPI?.ai

const hasApi = computed(() => !!(api?.getWebAppAiSettings && api?.setWebAppAiSettings))

const enabled = ref(true)
/** 全部应用 vs 仅勾选列表 */
const scopeMode = ref('all')
/** manifest.id 集合 */
const selectedIds = ref(new Set())

const appsLoading = ref(false)
const appsError = ref('')
const appsRaw = ref([])

const saving = ref(false)
const saveMsg = ref('')
const saveOk = ref(true)

const uniqueApps = computed(() => {
  const map = new Map()
  for (const a of appsRaw.value) {
    const id = String(a?.id || '').trim()
    if (!id) continue
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: String(a?.name || id).trim() || id
      })
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
})

async function loadApps() {
  if (!api?.listWebApps) {
    appsError.value = ''
    appsRaw.value = []
    return
  }
  appsLoading.value = true
  appsError.value = ''
  try {
    const r = await api.listWebApps()
    appsRaw.value = r?.apps || []
  } catch (e) {
    appsError.value = e?.message || String(e)
    appsRaw.value = []
  } finally {
    appsLoading.value = false
  }
}

async function loadSettings() {
  if (!api?.getWebAppAiSettings) return
  try {
    const r = await api.getWebAppAiSettings()
    if (r?.success) {
      enabled.value = r.aiWebAppToolsEnabled !== false
      const allow = Array.isArray(r.aiWebAppToolsAllowlist) ? r.aiWebAppToolsAllowlist : []
      const scope = r.aiWebAppToolsScope === 'allowlist' ? 'allowlist' : 'all'
      if (scope === 'allowlist') {
        scopeMode.value = 'restricted'
        selectedIds.value = new Set(allow.map((x) => String(x || '').trim()).filter(Boolean))
      } else {
        scopeMode.value = 'all'
        selectedIds.value = new Set()
      }
    }
  } catch {
    /* ignore */
  }
}

function toggleId(id, checked) {
  const next = new Set(selectedIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedIds.value = next
}

function selectAllIds() {
  selectedIds.value = new Set(uniqueApps.value.map((u) => u.id))
}

function selectNoIds() {
  selectedIds.value = new Set()
}

async function save() {
  if (!api?.setWebAppAiSettings) return
  saveMsg.value = ''
  saving.value = true
  try {
    let allowlist = []
    if (enabled.value && scopeMode.value === 'restricted') {
      allowlist = [...selectedIds.value]
    }
    const r = await api.setWebAppAiSettings({
      aiWebAppToolsEnabled: enabled.value,
      aiWebAppToolsScope: scopeMode.value === 'all' ? 'all' : 'allowlist',
      aiWebAppToolsAllowlist: allowlist
    })
    if (r?.success) {
      saveMsg.value = t('webappAi.saveDone')
      saveOk.value = true
    } else {
      saveMsg.value = r?.error || t('webappAi.saveFail')
      saveOk.value = false
    }
  } catch (e) {
    saveMsg.value = e?.message || String(e)
    saveOk.value = false
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadSettings(), loadApps()])
})

defineExpose({ reload: loadApps })
</script>

<style scoped>
.wat-settings-page {
  padding: 20px 28px 32px;
  max-width: 720px;
}
.wat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--ou-text);
  margin-bottom: 10px;
}
.wat-desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--ou-text-muted);
  line-height: 1.55;
}
.wat-section {
  margin-bottom: 18px;
}
.wat-section-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
}
.wat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ou-text);
  cursor: pointer;
}
.wat-row input {
  cursor: pointer;
}
.wat-radio {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--ou-text);
  cursor: pointer;
}
.wat-radio input {
  margin-top: 2px;
  cursor: pointer;
}
.wat-app-box {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-elevated, var(--ou-bg-main));
}
.wat-hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--ou-text-muted);
  line-height: 1.45;
}
.wat-muted {
  font-size: 13px;
  color: var(--ou-text-muted);
}
.wat-err {
  color: var(--ou-danger, #c00);
  font-size: 13px;
  margin: 0;
}
.wat-app-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}
.wat-link-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--ou-link);
  cursor: pointer;
  text-decoration: underline;
}
.wat-link-btn:hover {
  opacity: 0.85;
}
.wat-app-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 280px;
  overflow-y: auto;
}
.wat-app-item {
  margin-bottom: 6px;
}
.wat-app-label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  cursor: pointer;
}
.wat-app-label input {
  cursor: pointer;
}
.wat-app-name {
  font-weight: 500;
  color: var(--ou-text);
}
.wat-app-id {
  font-size: 11px;
  color: var(--ou-text-muted);
  background: color-mix(in srgb, var(--ou-text-muted) 12%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
}
.wat-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.wat-btn {
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.wat-btn.primary {
  background: var(--ou-primary, #2563eb);
  color: #fff;
  border-color: transparent;
}
.wat-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.wat-save-msg {
  font-size: 12px;
}
.wat-save-msg.ok {
  color: var(--ou-success, #22c55e);
}
.wat-save-msg.err {
  color: var(--ou-danger, #ef4444);
}
.wat-footer-link {
  margin: 16px 0 0;
  font-size: 12px;
}
.wat-footer-link a {
  color: var(--ou-link);
}
.spin {
  animation: wat-spin 0.8s linear infinite;
}
@keyframes wat-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
