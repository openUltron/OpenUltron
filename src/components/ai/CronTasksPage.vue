<template>
  <div class="cron-page">
    <div class="cron-header">
      <Clock :size="16" />
      <span>{{ t('cron.title') }}</span>
      <button class="cron-refresh-btn" :title="t('cron.refreshTitle')" @click="loadTasks">{{ t('common.refresh') }}</button>
    </div>
    <p class="cron-desc">{{ t('cron.desc') }}</p>

    <section class="cron-section">
      <h3 class="cron-section-title">{{ t('cron.listTitle') }}</h3>
      <p class="cron-list-hint">{{ t('cron.listHint') }}</p>
      <div v-if="tasks.length === 0" class="cron-empty">{{ t('cron.empty') }}</div>
      <div v-else class="cron-list">
        <div
          v-for="t in tasks"
          :key="t.id"
          class="cron-item"
          :class="{ disabled: !t.enabled }"
        >
          <div class="cron-item-main">
            <span class="cron-item-name">{{ t.name }}</span>
            <code class="cron-item-schedule">{{ t.schedule }}</code>
            <span class="cron-item-type">{{ t.type === 'heartbeat' ? 'Heartbeat' : t('cron.command') }}</span>
            <span v-if="t.lastRun" class="cron-item-last">{{ t('cron.lastRun') }}: {{ formatTime(t.lastRun) }} {{ t.lastResult ? `(${t.lastResult})` : '' }}</span>
          </div>
          <div class="cron-item-actions">
            <button
              class="cron-item-btn cron-toggle"
              :class="{ on: t.enabled, off: !t.enabled }"
              :title="t.enabled ? t('cron.clickDisable') : t('cron.clickEnable')"
              @click="toggleEnabled(t)"
            >
              <ToggleRight v-if="t.enabled" :size="14" />
              <ToggleLeft v-else :size="14" />
              <span>{{ t.enabled ? t('cron.enabled') : t('cron.disabled') }}</span>
            </button>
            <button
              class="cron-item-btn"
              :class="{ running: runningTaskId === t.id }"
              :title="runningTaskId === t.id ? t('cron.running') : t('cron.runNow')"
              :disabled="runningTaskId !== null"
              @click="runNow(t.id)"
            >
              <Loader v-if="runningTaskId === t.id" :size="14" class="spin" />
              <Play v-else :size="14" />
              <span class="cron-run-label">{{ runningTaskId === t.id ? t('cron.running') : t('cron.runNow') }}</span>
            </button>
            <button class="cron-item-btn danger" :title="t('cron.delete')" @click="removeTask(t.id)">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
      <div v-if="runResult" class="cron-result" :class="runResult.ok ? 'ok' : 'err'" role="status">
        {{ runResult.ok ? '✓ ' : '✗ ' }}{{ runResult.message }}
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { Clock, Play, Trash2, ToggleRight, ToggleLeft, Loader } from 'lucide-vue-next'
import { useI18n } from '../../composables/useI18n.js'

const tasks = ref([])
const runResult = ref(null)
const runningTaskId = ref(null)
let refreshTimer = null
const { t, locale } = useI18n()

const api = () => window.electronAPI?.cron

function formatTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString(locale.value === 'en-US' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

async function loadTasks() {
  const res = await api()?.list?.()
  if (res?.success && Array.isArray(res.tasks)) {
    tasks.value = res.tasks
  }
}


async function toggleEnabled(t) {
  if (!api()) return
  const res = await api().update(t.id, { enabled: !t.enabled })
  if (res?.success) await loadTasks()
}

async function runNow(taskId) {
  if (!api()) return
  runResult.value = null
  runningTaskId.value = taskId
  try {
    const res = await api().runNow(taskId)
    runResult.value = { ok: !!res?.success, message: res?.message || (res?.success ? t('cron.executed') : t('cron.failed')) }
    await loadTasks()
  } catch (e) {
    runResult.value = { ok: false, message: e?.message || t('cron.failed') }
  } finally {
    runningTaskId.value = null
  }
}

/** 直接删除任务 */
async function removeTask(taskId) {
  if (!api()) return
  if (!confirm(t('cron.deleteConfirm'))) return
  const res = await api().remove(taskId)
  if (res?.success) {
    runResult.value = null
    await loadTasks()
  }
}

onMounted(() => {
  loadTasks()
  refreshTimer = setInterval(loadTasks, 15000)
})
onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
})
</script>

<style scoped>
.cron-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: var(--ou-bg-main);
  color: var(--ou-text);
  padding: 20px 24px;
  gap: 24px;
}

.cron-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ou-border);
}
.cron-refresh-btn {
  margin-left: auto;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--ou-border);
  border-radius: 4px;
  background: var(--ou-bg-hover);
  color: var(--ou-text-muted);
  cursor: pointer;
}
.cron-refresh-btn:hover { color: var(--ou-text); background: var(--ou-border); }

.cron-desc {
  font-size: 12px;
  color: var(--ou-text-muted);
  margin: 0;
}
.cron-desc code {
  font-size: 11px;
  color: var(--ou-link);
  padding: 0 4px;
}

.cron-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cron-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
  margin: 0;
}
.cron-list-hint {
  font-size: 12px;
  color: var(--ou-text-muted);
  margin: 0 0 10px 0;
}

.cron-empty {
  font-size: 12px;
  color: var(--ou-text-secondary);
  padding: 12px 0;
}

.cron-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cron-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--ou-bg-hover);
  border: 1px solid var(--ou-border);
}
.cron-item.disabled { opacity: 0.65; }

.cron-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 58px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid;
}
.cron-toggle.on {
  background: color-mix(in srgb, var(--ou-success) 20%, transparent);
  border-color: var(--ou-success);
  color: var(--ou-success);
}
.cron-toggle.off {
  background: var(--ou-bg-hover);
  border-color: var(--ou-border);
  color: var(--ou-text-muted);
}
.cron-toggle:hover.on { background: color-mix(in srgb, var(--ou-success) 28%, transparent); }
.cron-toggle:hover.off { color: var(--ou-text); border-color: var(--ou-text-muted); }

.cron-item-main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.cron-item-name { font-weight: 600; font-size: 13px; }
.cron-item-schedule {
  font-size: 11px;
  color: var(--ou-text-muted);
  padding: 2px 6px;
  background: var(--ou-bg-hover);
  border-radius: 4px;
}
.cron-item-type {
  font-size: 11px;
  color: var(--ou-text-muted);
}
.cron-item-last {
  font-size: 11px;
  color: var(--ou-text-secondary);
}

.cron-item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.cron-item-btn {
  padding: 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--ou-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cron-item-btn:hover {
  background: var(--ou-bg-hover);
  color: var(--ou-text);
}
.cron-item-btn.danger:hover {
  background: color-mix(in srgb, var(--ou-error) 25%, transparent);
  color: var(--ou-error);
}
.cron-item-btn .cron-run-label { font-size: 11px; margin-left: 2px; }
.cron-item-btn.running { opacity: 0.9; cursor: wait; }
.cron-item-btn .spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.cron-result {
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 5px;
}
.cron-result.ok { background: color-mix(in srgb, var(--ou-success) 15%, transparent); color: var(--ou-success); border: 1px solid color-mix(in srgb, var(--ou-success) 30%, transparent); }
.cron-result.err { background: color-mix(in srgb, var(--ou-error) 15%, transparent); color: var(--ou-error); border: 1px solid color-mix(in srgb, var(--ou-error) 30%, transparent); }
</style>
