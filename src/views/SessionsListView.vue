<template>
  <div class="sessions-list-view">
    <div class="sl-header">
      <MessageSquare :size="16" />
      <span>{{ t('sessions.title') }}</span>
    </div>
    <div class="sl-list" v-if="sessions.length">
      <div
        v-for="s in sessions"
        :key="(s.projectPath || '') + s.id"
        class="sl-item"
        :class="{ active: currentSessionId === s.id && currentProjectPath === (s.projectPath || '') }"
        @click="openChat(s)"
      >
        <MessageSquare :size="14" class="sl-item-icon" />
        <div class="sl-item-body">
          <span class="sl-item-title">{{ sessionTitle(s) }}</span>
          <span class="sl-item-subtitle" v-if="s.lastMessage">{{ s.lastMessage }}</span>
          <span class="sl-item-meta">{{ formatTime(s.updatedAt || s.createdAt) }}</span>
        </div>
        <span class="sl-item-source">{{ sourceLabel(s.source) }}</span>
        <button
          v-if="s.source !== 'main'"
          type="button"
          class="sl-item-delete"
          :title="t('sessions.deleteTitle')"
          @click.stop="confirmDelete(s)"
        >
          <Trash2 :size="14" />
        </button>
        <ChevronRight :size="14" class="sl-item-arrow" />
      </div>
    </div>
    <div v-else class="sl-empty">
      <img :src="logoUrl" alt="" class="sl-empty-icon" />
      <p>{{ t('sessions.empty') }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { MessageSquare, ChevronRight, Trash2 } from 'lucide-vue-next'
import { useLogoUrl } from '../composables/useLogoUrl.js'
import { useI18n } from '../composables/useI18n.js'

const router = useRouter()
const route = useRoute()
const logoUrl = useLogoUrl()
const { t, locale } = useI18n()
const sessions = ref([])
const currentSessionId = computed(() => route.query.sessionId || null)
const currentProjectPath = computed(() => route.query.projectPath || '__main_chat__')

const sessionTitle = (s) => {
  return s.title || (s.source === 'feishu' ? t('sessions.sourceFeishuSession') : s.source === 'telegram' ? t('sessions.sourceTelegramSession') : s.source === 'dingtalk' ? t('sessions.sourceDingtalkSession') : s.source === 'gateway' ? t('sessions.sourceGatewaySession') : t('sessions.newChat'))
}

const sourceLabel = (source) => {
  return source === 'feishu' ? t('sessions.sourceFeishu') : source === 'telegram' ? 'Telegram' : source === 'dingtalk' ? t('sessions.sourceDingtalk') : source === 'main' ? t('sessions.sourceMain') : source === 'gateway' ? 'Gateway' : source || ''
}

const formatTime = (t) => {
  const raw = t || ''
  if (!raw) return '--'
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return '--'
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const localeCode = locale.value === 'en-US' ? 'en-US' : 'zh-CN'
  if (sameDay) return d.toLocaleTimeString(localeCode, { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(localeCode, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const loadSessions = async () => {
  try {
    const res = await window.electronAPI.ai.getSessions()
    if (res.success) sessions.value = res.sessions || []
  } catch { /* ignore */ }
}

const openChat = (s) => {
  router.push({ path: '/chat', query: { sessionId: s.id, projectPath: s.projectPath || '__main_chat__' } })
}

const confirmDelete = async (s) => {
  if (!confirm(t('sessions.deleteConfirm', { title: sessionTitle(s) }))) return
  try {
    await window.electronAPI.ai.deleteSession({
      projectPath: s.projectPath || '__main_chat__',
      id: s.id
    })
    if (currentSessionId.value === s.id && currentProjectPath.value === (s.projectPath || '__main_chat__')) {
      router.push('/chat')
    }
    await loadSessions()
  } catch { /* ignore */ }
}

watch(() => route.path, (path) => {
  if (path === '/sessions') loadSessions()
}, { immediate: true })

onMounted(() => {
  window.electronAPI?.ai?.onGatewaySessionUpdated?.(() => loadSessions())
  window.electronAPI?.ai?.onFeishuSessionUpdated?.(() => loadSessions())
})
</script>

<style scoped>
.sessions-list-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ou-bg-main);
  min-height: 0;
  padding: 20px 24px 0;
}
.sl-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ou-border);
  color: var(--ou-text);
  font-size: 15px;
  font-weight: 700;
}
.sl-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0 0;
}
.sl-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  cursor: pointer;
  color: var(--ou-text);
  transition: background 0.15s;
}
.sl-item:hover { background: var(--ou-bg-hover); }
.sl-item.active { background: color-mix(in srgb, var(--ou-success) 15%, transparent); color: var(--ou-success); }
.sl-item-icon { flex-shrink: 0; color: var(--ou-text-muted); }
.sl-item.active .sl-item-icon { color: inherit; }
.sl-item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sl-item-title {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-item-subtitle {
  font-size: 12px;
  color: var(--ou-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}
.sl-item-meta {
  font-size: 11px;
  color: var(--ou-text-secondary);
}
.sl-item.active .sl-item-meta { color: var(--ou-success); }
.sl-item-source {
  font-size: 10px;
  color: var(--ou-text-muted);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--ou-bg-hover);
  flex-shrink: 0;
}
.sl-item.active .sl-item-source { background: color-mix(in srgb, var(--ou-success) 18%, transparent); color: var(--ou-success); }
.sl-item-delete {
  flex-shrink: 0;
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--ou-text-secondary);
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sl-item-delete:hover { color: var(--ou-error); background: color-mix(in srgb, var(--ou-error) 15%, transparent); }
.sl-item-arrow { flex-shrink: 0; color: var(--ou-text-secondary); }
.sl-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--ou-text-muted);
  font-size: 14px;
}
.sl-empty-icon { width: 48px; height: 48px; opacity: 0.5; }
</style>
