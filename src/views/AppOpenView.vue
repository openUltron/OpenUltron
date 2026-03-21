<template>
  <div class="aopen-page">
    <div v-if="loadError" class="aopen-error">
      <p>{{ loadError }}</p>
      <button type="button" class="aopen-back" @click="goBack">返回</button>
    </div>
    <template v-else-if="previewUrl">
      <header class="aopen-head">
        <button type="button" class="aopen-back ghost" @click="goBack">← 应用库</button>
        <div class="aopen-title-block">
          <span class="aopen-title">{{ appName }}</span>
          <span class="aopen-meta">{{ appId }} · {{ appVersion }}</span>
          <p class="aopen-tagline">仅预览 · 全屏沙盒渲染</p>
        </div>
        <div class="aopen-actions">
          <button type="button" class="aopen-btn secondary" @click="goStudio">工作室</button>
          <button type="button" class="aopen-btn" :disabled="!previewUrl" @click="bumpPreview">刷新</button>
        </div>
      </header>
      <webview
        :key="previewKey"
        class="aopen-webview"
        partition="persist:ou-webapps"
        :src="previewSrc"
        allowpopups
      />
    </template>
    <div v-else class="aopen-loading">加载中…</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

defineOptions({ name: 'AppOpenView' })

const route = useRoute()
const router = useRouter()
const api = window.electronAPI?.ai

const appName = ref('')
const appId = ref('')
const appVersion = ref('')
const previewUrl = ref('')
const loadError = ref('')
const previewKey = ref(0)

const previewSrc = computed(() => {
  const u = previewUrl.value
  if (!u) return ''
  const sep = u.includes('?') ? '&' : '?'
  return `${u}${sep}_ou_refresh=${previewKey.value}`
})

function bumpPreview() {
  previewKey.value += 1
}

async function loadApp() {
  loadError.value = ''
  previewUrl.value = ''
  const id = String(route.query.appId || '').trim()
  const version = String(route.query.version || '').trim()
  if (!id || !version) {
    loadError.value = '缺少 appId 或 version 参数'
    return
  }
  if (!api?.getWebApp) {
    loadError.value = '当前环境不支持应用 API'
    return
  }
  try {
    const r = await api.getWebApp({ id, version })
    if (!r?.success) {
      loadError.value = r?.error || '无法加载应用'
      return
    }
    previewUrl.value = r.previewUrl || ''
    appId.value = id
    appVersion.value = version
    appName.value = r.manifest?.name || id
  } catch (e) {
    loadError.value = e?.message || String(e)
  }
}

function goBack() {
  router.push({ path: '/web-apps' })
}

function goStudio() {
  const id = String(route.query.appId || '').trim()
  const version = String(route.query.version || '').trim()
  if (!id || !version) return
  router.push({ path: '/web-app-studio', query: { appId: id, version } })
}

onMounted(() => loadApp())
watch(
  () => [route.query.appId, route.query.version],
  () => loadApp()
)
</script>

<style scoped>
.aopen-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--ou-bg-main);
}
.aopen-error {
  padding: 24px;
  color: var(--ou-text);
}
.aopen-back {
  margin-top: 12px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-elevated);
  cursor: pointer;
}
.aopen-loading {
  padding: 24px;
  color: var(--ou-text-muted);
}
.aopen-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ou-border);
  flex-shrink: 0;
  background: var(--ou-bg-elevated, var(--ou-bg-main));
}
.aopen-back.ghost {
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--ou-text-muted);
  cursor: pointer;
  font-size: 13px;
}
.aopen-back.ghost:hover {
  color: var(--ou-text);
}
.aopen-title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.aopen-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--ou-text);
}
.aopen-meta {
  font-size: 11px;
  color: var(--ou-text-muted);
  font-family: ui-monospace, monospace;
  word-break: break-all;
}
.aopen-tagline {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--ou-text-muted);
}
.aopen-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.aopen-btn {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
  color: var(--ou-text);
  cursor: pointer;
}
.aopen-btn.secondary {
  border-color: var(--ou-accent);
  background: var(--ou-accent);
  color: var(--ou-accent-fg);
}
.aopen-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.aopen-webview {
  flex: 1;
  min-height: 0;
  width: 100%;
}
</style>
