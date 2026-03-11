<template>
  <div class="ai-backup-page">
    <div class="abp-header">
      <Archive :size="16" />
      <span>{{ t('backup.title') }}</span>
    </div>

    <!-- 备份区 -->
    <section class="abp-section">
      <h3 class="abp-section-title">{{ t('backup.exportTitle') }}</h3>
      <p class="abp-desc">{{ t('backup.exportDesc') }}</p>

      <div class="abp-actions">
        <button class="abp-btn primary" :disabled="exporting" @click="doExport">
          <Loader v-if="exporting" :size="13" class="spin" />
          <Download v-else :size="13" />
          {{ exporting ? t('backup.exporting') : t('backup.exportZip') }}
        </button>
      </div>

      <div v-if="exportResult" class="abp-result" :class="exportResult.ok ? 'ok' : 'err'">
        <template v-if="exportResult.ok">
          {{ t('backup.savedTo', { path: exportResult.savePath, size: formatSize(exportResult.fileSize) }) }}
        </template>
        <template v-else>{{ t('backup.exportFailed', { message: exportResult.message }) }}</template>
      </div>
    </section>

    <!-- 恢复区 -->
    <section class="abp-section">
      <h3 class="abp-section-title">{{ t('backup.restoreTitle') }}</h3>
      <p class="abp-desc">{{ t('backup.restoreDesc') }}</p>

      <div class="abp-actions">
        <button class="abp-btn" :disabled="previewing" @click="doPreview">
          <FolderOpen :size="13" />
          {{ t('backup.chooseFile') }}
        </button>
      </div>

      <!-- 备份信息 -->
      <div v-if="previewMeta" class="abp-meta-card">
        <div class="abp-meta-row">
          <span class="abp-meta-label">{{ t('backup.backupTime') }}</span>
          <span>{{ formatDate(previewMeta.exportedAt) }}</span>
        </div>
        <div class="abp-meta-row">
          <span class="abp-meta-label">{{ t('backup.file') }}</span>
          <code class="abp-meta-path">{{ previewFilePath }}</code>
        </div>
        <div class="abp-meta-stats">
          <span v-if="previewMeta.mode === 'full_app_root'">{{ t('backup.fullBackup') }}</span>
          <span v-if="previewMeta.stats.fileCount">{{ previewMeta.stats.fileCount }} files</span>
          <span v-if="previewMeta.stats.dirCount">{{ previewMeta.stats.dirCount }} dirs</span>
          <span v-if="previewMeta.stats.totalBytes">{{ formatSize(previewMeta.stats.totalBytes) }}</span>
          <span v-if="previewMeta.mode !== 'full_app_root'">{{ t('backup.legacyBackup') }}</span>
        </div>

        <div class="abp-actions mt8">
          <button class="abp-btn danger" :disabled="restoring" @click="doRestore">
            <Loader v-if="restoring" :size="13" class="spin" />
            <RotateCcw v-else :size="13" />
            {{ restoring ? t('backup.restoring') : t('backup.restoreNow') }}
          </button>
        </div>
      </div>

      <div v-if="restoreResult" class="abp-result" :class="restoreResult.ok ? 'ok' : 'err'">
        <template v-if="restoreResult.ok">
          <template v-if="restoreResult.summary.mode === 'full_app_root'">
            {{ t('backup.restoreDone', { count: restoreResult.summary.restoredFiles || 0 }) }}
            <span v-if="restoreResult.summary.rollbackPath">{{ t('backup.rollback') }}<code>{{ restoreResult.summary.rollbackPath }}</code></span>
          </template>
          <template v-else>
            恢复完成：技能 {{ restoreResult.summary.skillsRestored }} 个，
            对话 {{ restoreResult.summary.conversationsRestored }} 个
            {{ restoreResult.summary.memoriesRestored ? '，记忆已恢复' : '' }}
            {{ restoreResult.summary.aiConfigRestored ? '，AI配置已恢复' : '' }}
            {{ restoreResult.summary.mcpRestored ? '，MCP已恢复' : '' }}
          </template>
        </template>
        <template v-else>{{ t('backup.restoreFailed', { message: restoreResult.message }) }}</template>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { Archive, Download, FolderOpen, RotateCcw, Loader } from 'lucide-vue-next'
import { useI18n } from '../../composables/useI18n.js'

const { t, locale } = useI18n()

const exporting = ref(false)
const exportResult = ref(null)
const previewing = ref(false)
const previewMeta = ref(null)
const previewFilePath = ref('')
const restoring = ref(false)
const restoreResult = ref(null)

async function doExport() {
  exporting.value = true
  exportResult.value = null
  try {
    const res = await window.electronAPI.ai.backupExport({ mode: 'full_app_root' })
    if (res.success) {
      exportResult.value = { ok: true, savePath: res.savePath, fileSize: res.fileSize }
    } else if (res.message !== 'canceled') {
      exportResult.value = { ok: false, message: res.message }
    }
  } finally {
    exporting.value = false
  }
}

async function doPreview() {
  previewing.value = true
  previewMeta.value = null
  restoreResult.value = null
  try {
    const res = await window.electronAPI.ai.backupPreview()
    if (res.success) {
      previewMeta.value = res.meta
      previewFilePath.value = res.filePath
    }
  } finally {
    previewing.value = false
  }
}

async function doRestore() {
  restoring.value = true
  restoreResult.value = null
  try {
    const res = await window.electronAPI.ai.backupRestore({
      filePath: previewFilePath.value
    })
    if (res.success) {
      restoreResult.value = { ok: true, summary: res.summary }
    } else {
      restoreResult.value = { ok: false, message: res.message }
    }
  } finally {
    restoring.value = false
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function formatDate(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString(locale.value === 'en-US' ? 'en-US' : 'zh-CN')
}
</script>

<style scoped>
.ai-backup-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: var(--ou-bg-main);
  color: var(--ou-text);
  padding: 20px 24px;
  gap: 24px;
}

.abp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ou-border);
}

.abp-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.abp-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
  margin: 0;
}

.abp-desc {
  font-size: 12px;
  color: var(--ou-text-muted);
  margin: 0;
}

.abp-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.abp-option {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
}

.abp-opt-name {
  color: var(--ou-text);
  min-width: 80px;
}

.abp-opt-desc {
  color: var(--ou-text-muted);
  font-size: 11px;
}

.abp-actions {
  display: flex;
  gap: 8px;
}

.abp-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--ou-border);
  border-radius: 5px;
  background: var(--ou-bg-hover);
  color: var(--ou-text);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s;
}

.abp-btn:hover:not(:disabled) { background: var(--ou-border); }
.abp-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.abp-btn.primary {
  background: color-mix(in srgb, var(--ou-primary) 35%, transparent);
  border-color: var(--ou-primary);
  color: var(--ou-link);
}
.abp-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--ou-primary) 50%, transparent); }

.abp-btn.danger {
  background: color-mix(in srgb, var(--ou-error) 25%, transparent);
  border-color: var(--ou-error);
  color: var(--ou-error);
}
.abp-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--ou-error) 40%, transparent); }

.abp-result {
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 5px;
}
.abp-result.ok { background: color-mix(in srgb, var(--ou-success) 15%, transparent); color: var(--ou-success); border: 1px solid color-mix(in srgb, var(--ou-success) 30%, transparent); }
.abp-result.err { background: color-mix(in srgb, var(--ou-error) 15%, transparent); color: var(--ou-error); border: 1px solid color-mix(in srgb, var(--ou-error) 30%, transparent); }
.abp-result code { font-size: 11px; opacity: 0.9; word-break: break-all; }

.abp-meta-card {
  background: var(--ou-bg-hover);
  border: 1px solid var(--ou-border);
  border-radius: 6px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.abp-meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.abp-meta-label {
  color: var(--ou-text-muted);
  min-width: 60px;
}

.abp-meta-path {
  font-size: 11px;
  color: var(--ou-link);
  word-break: break-all;
}

.abp-meta-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.abp-meta-stats span {
  font-size: 11px;
  padding: 2px 8px;
  background: color-mix(in srgb, var(--ou-primary) 18%, transparent);
  color: var(--ou-link);
  border-radius: 3px;
}

.mt8 { margin-top: 8px; }

.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
