<template>
  <div class="settings-logs-view">
    <div class="page-header">
      <FileText :size="16" />
      <span>{{ t('logs.title') }}</span>
    </div>
    <p class="page-desc">{{ t('logs.desc') }}</p>

    <template v-if="isElectron">
      <div class="logs-path">
        <span class="path-label">{{ t('logs.file') }}</span>
        <code class="path-value">{{ logPath || '…' }}</code>
        <button type="button" class="btn secondary" @click="openLogDir" :disabled="!logPath">{{ t('logs.openDir') }}</button>
      </div>
      <div class="logs-toolbar">
        <button type="button" class="btn primary" @click="loadTail" :disabled="loading">{{ t('common.refresh') }}</button>
        <button type="button" class="btn secondary" @click="copyAll" :disabled="!logContent">{{ t('common.copyAll') }}</button>
        <span v-if="copySuccess" class="copy-success">{{ t('logs.copySuccess') }}</span>
        <span class="tail-hint">{{ t('logs.lastLines') }} <input v-model.number="tailLines" type="number" min="100" max="10000" step="100" class="lines-input" /> {{ t('logs.lines') }}</span>
      </div>
      <div class="logs-content-wrap">
        <pre class="logs-content" ref="preRef">{{ logContent || t('logs.empty') }}</pre>
      </div>
    </template>
    <template v-else>
      <p class="no-electron">{{ t('logs.browserOnly') }}</p>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { FileText } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'

const { t } = useI18n()

const isElectron = computed(() => typeof window !== 'undefined' && typeof window.electronAPI?.logs === 'object')

const logPath = ref('')
const logContent = ref('')
const tailLines = ref(2000)
const loading = ref(false)
const copySuccess = ref(false)
const preRef = ref(null)
let copySuccessTimer = null

async function loadPath() {
  if (!window.electronAPI?.logs?.getPath) return
  try {
    logPath.value = await window.electronAPI.logs.getPath()
  } catch (e) {
    logPath.value = ''
  }
}

async function loadTail() {
  if (!window.electronAPI?.logs?.readTail) return
  loading.value = true
  try {
    const lines = Math.max(100, Math.min(10000, tailLines.value || 2000))
    logContent.value = await window.electronAPI.logs.readTail(lines)
  } catch (e) {
    logContent.value = t('logs.readFailed') + (e?.message || e)
  } finally {
    loading.value = false
  }
}

async function openLogDir() {
  if (!logPath.value || !window.electronAPI?.openInFinder) return
  try {
    await window.electronAPI.openInFinder({ path: logPath.value })
  } catch (e) {
    console.error(e)
  }
}

async function copyAll() {
  if (!logContent.value) return
  try {
    await navigator.clipboard.writeText(logContent.value)
    copySuccess.value = true
    if (copySuccessTimer) clearTimeout(copySuccessTimer)
    copySuccessTimer = setTimeout(() => { copySuccess.value = false }, 2000)
  } catch (e) {
    console.error(e)
  }
}

onMounted(async () => {
  if (!isElectron.value) return
  await loadPath()
  await loadTail()
})
</script>

<style scoped>
.settings-logs-view {
  padding: 20px 24px 24px;
  color: var(--ou-text);
  height: 100%;
  overflow-y: auto;
}
.page-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ou-border);
  margin-bottom: 16px;
}
.page-desc { font-size: 13px; color: var(--ou-text-muted); margin: 0 0 16px; }

.logs-path {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.path-label { font-size: 13px; color: var(--ou-text-muted); }
.path-value {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  background: var(--ou-bg-subtle);
  padding: 6px 10px;
  border-radius: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-subtle);
  color: var(--ou-text);
}
.btn.primary { background: var(--ou-accent); color: var(--ou-accent-fg); border-color: var(--ou-accent); }
.btn:hover:not(:disabled) { filter: brightness(1.05); }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }

.logs-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.lines-input { width: 72px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ou-border); background: var(--ou-bg-subtle); color: var(--ou-text); }
.tail-hint { font-size: 12px; color: var(--ou-text-muted); }

.logs-content-wrap {
  background: var(--ou-bg-subtle);
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  overflow: auto;
  max-height: 60vh;
  padding: 12px;
}
.logs-content {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ou-text);
}

.copy-success { font-size: 12px; color: var(--ou-accent, #0ea5e9); }
.no-electron { color: var(--ou-text-muted); }
</style>
