<template>
  <div class="aopen-page">
    <div v-if="loadError" class="aopen-error">
      <p>{{ loadError }}</p>
      <button type="button" class="aopen-back" @click="goBack">返回</button>
    </div>
    <template v-else-if="previewUrl">
      <header class="aopen-head">
        <button type="button" class="aopen-back-outline" @click="goBack">返回应用库</button>
        <div class="aopen-title-block">
          <span class="aopen-title">{{ appName }}</span>
          <span class="aopen-meta">{{ appId }} · {{ appVersion }}</span>
        </div>
        <div class="aopen-actions">
          <button type="button" class="aopen-btn" @click="startService">启动服务</button>
          <button type="button" class="aopen-btn" @click="stopService">停止服务</button>
          <button type="button" class="aopen-btn secondary" @click="goStudio">工作室</button>
          <button type="button" class="aopen-btn" :disabled="!previewUrl" @click="refreshPreview">刷新</button>
        </div>
      </header>
      <webview
        ref="previewWebview"
        :key="previewKey"
        class="aopen-webview"
        partition="persist:ou-webapps"
        :src="previewSrc"
        @dom-ready="onPreviewDomReady"
        allowpopups
      />
    </template>
    <div v-else class="aopen-loading">加载中…</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTheme } from '../composables/useTheme.js'

defineOptions({ name: 'AppOpenView' })

const route = useRoute()
const router = useRouter()
const api = window.electronAPI?.ai
const { effectiveTheme } = useTheme()

const appName = ref('')
const appId = ref('')
const appVersion = ref('')
const previewUrl = ref('')
const loadError = ref('')
const previewKey = ref(0)
const previewWebview = ref(null)
const serviceBooting = ref(false)

const previewSrc = computed(() => {
  const u = previewUrl.value
  if (!u) return ''
  const sep = u.includes('?') ? '&' : '?'
  return `${u}${sep}_ou_refresh=${previewKey.value}&_ou_theme=${encodeURIComponent(effectiveTheme.value)}`
})

function getPreviewTheme() {
  return effectiveTheme.value === 'dark' ? 'dark' : 'light'
}

function syncPreviewTheme() {
  const wv = previewWebview.value
  if (!wv || typeof wv.executeJavaScript !== 'function') return
  const theme = getPreviewTheme()
  const script = `(() => {
    const t = ${JSON.stringify(theme)}
    try {
      const root = document.documentElement
      root.setAttribute('data-ou-host-theme', t)
      root.setAttribute('data-theme', t)
      root.classList.remove('theme-light', 'theme-dark')
      root.classList.add('theme-' + t)
      root.style.colorScheme = t
      if (document.body) {
        document.body.style.colorScheme = t
        if (t === 'dark' && !document.body.style.backgroundColor) document.body.style.backgroundColor = '#0f1419'
        if (t === 'light' && !document.body.style.backgroundColor) document.body.style.backgroundColor = '#ffffff'
      }
    } catch (_) {}
    return true
  })()`
  wv.executeJavaScript(script).catch(() => {})
}

function onPreviewDomReady() {
  syncPreviewTheme()
}

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
    const r = await api.getWebApp({ id, version, ensureService: true })
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

async function warmupService(id, version) {
  if (serviceBooting.value) return
  if (!api?.startWebAppService) return
  serviceBooting.value = true
  try {
    const r = await api.startWebAppService({ id, version })
    if (r?.success && r?.url) {
      previewUrl.value = r.url
      bumpPreview()
    }
  } catch (_) {
    // 静默失败：保持 local-resource 预览，避免首屏阻塞
  } finally {
    serviceBooting.value = false
  }
}

async function startService() {
  if (!api?.startWebAppService) return
  const id = String(route.query.appId || '').trim()
  const version = String(route.query.version || '').trim()
  if (!id || !version) return
  const r = await api.startWebAppService({ id, version })
  if (r?.success && r?.url) {
    previewUrl.value = r.url
    bumpPreview()
    return
  }
  await loadApp()
}

async function stopService() {
  if (!api?.stopWebAppService) return
  const id = String(route.query.appId || '').trim()
  const version = String(route.query.version || '').trim()
  if (!id || !version) return
  await api.stopWebAppService({ id, version })
  await loadApp()
}

async function refreshPreview() {
  await loadApp()
  bumpPreview()
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
watch(
  () => effectiveTheme.value,
  () => {
    syncPreviewTheme()
  }
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
.aopen-back-outline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 96px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  background: transparent;
  color: var(--ou-text-muted);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.aopen-back-outline:hover {
  border-color: var(--ou-text-muted);
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
  background: var(--ou-bg-main);
}
</style>
