<template>
  <div class="chat-view">
    <ChatPanel
      :key="projectPath"
      :project-path="projectPath"
      :initial-session-id="currentSessionId"
      :system-prompt="''"
      :model="''"
      :enable-mention="false"
      @first-message="(payload) => payload?.sessionId && updateSessionTitle(payload.sessionId, payload.text)"
      @session-loaded="onSessionLoaded"
      @session-created="onSessionCreated"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onActivated } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatPanel from '../components/ai/ChatPanel.vue'
import { useLastChatSession } from '../composables/useLastChatSession.js'
import { useI18n } from '../composables/useI18n.js'

defineOptions({ name: 'ChatView' })

const MAIN_CHAT_PROJECT = '__main_chat__'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { lastProjectPath, lastSessionId, setLast } = useLastChatSession()

// 优先用 URL，无则用「上次聊天会话」——避免侧栏 to="/chat" 导致 key 变化、ChatPanel 被销毁
const projectPath = computed(() =>
  route.query.projectPath || lastProjectPath.value || MAIN_CHAT_PROJECT
)
const currentSessionId = ref(
  route.query.sessionId ?? lastSessionId.value ?? null
)

const ensureSession = () => {
  if (route.query.sessionId) currentSessionId.value = route.query.sessionId
  else if (lastSessionId.value != null) currentSessionId.value = lastSessionId.value
}

const onSessionLoaded = (sessionId) => {
  if (sessionId && currentSessionId.value !== sessionId) {
    currentSessionId.value = sessionId
    setLast(projectPath.value, sessionId)
    router.replace({ path: '/chat', query: { sessionId, projectPath: projectPath.value } })
  }
}
const onSessionCreated = (sessionId) => {
  if (sessionId) {
    currentSessionId.value = sessionId
    setLast(projectPath.value, sessionId)
    router.replace({ path: '/chat', query: { sessionId, projectPath: projectPath.value } })
  } else {
    currentSessionId.value = null
    setLast(projectPath.value, null)
    router.replace({ path: '/chat', query: projectPath.value !== MAIN_CHAT_PROJECT ? { projectPath: projectPath.value } : {} })
  }
}

const updateSessionTitle = async (sessionId, firstMessage) => {
  if (!sessionId || !firstMessage) return
  const title = firstMessage.slice(0, 24).trim() || t('sessions.newChat')
  try {
    await window.electronAPI.ai.saveSession({
      projectPath: projectPath.value,
      id: sessionId,
      title,
      updatedAt: Date.now()
    })
  } catch { /* ignore */ }
}

// URL 有 sessionId 时跟 URL；无时保留 last（避免切回页面时 key 变掉）
watch(() => route.query.sessionId, (id) => {
  currentSessionId.value = id ?? lastSessionId.value ?? null
}, { immediate: true })

onMounted(ensureSession)

// keep-alive 切回时：若 URL 无 session 则用上次会话并同步到 URL，避免 ChatPanel key 变化
onActivated(() => {
  if (route.path !== '/chat') return
  const q = route.query
  if (q.sessionId != null || (q.projectPath != null && q.projectPath !== MAIN_CHAT_PROJECT)) return
  if (lastSessionId.value != null || lastProjectPath.value !== MAIN_CHAT_PROJECT) {
    router.replace({
      path: '/chat',
      query: {
        ...(lastSessionId.value ? { sessionId: lastSessionId.value } : {}),
        ...(lastProjectPath.value !== MAIN_CHAT_PROJECT ? { projectPath: lastProjectPath.value } : {})
      }
    })
  }
})
</script>

<style scoped>
.chat-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ou-bg-main);
}
.chat-view > :deep(.chat-panel) {
  flex: 1;
  min-height: 0;
}
</style>
