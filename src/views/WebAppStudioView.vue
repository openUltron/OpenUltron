<template>
  <div class="was-page">
    <div v-if="loadError" class="was-error">
      <p>{{ loadError }}</p>
      <button type="button" class="was-back" @click="goBack">返回</button>
    </div>
    <template v-else-if="appPath && previewUrl">
      <div class="was-studio">
        <section class="was-sandbox" aria-label="沙盒预览">
          <header class="was-sandbox-head">
            <button type="button" class="was-back-outline" @click="goBack">返回应用库</button>
            <div class="was-title-block">
              <div class="was-headline-row">
                <span class="was-headline">应用工作室</span>
                <span class="was-crumb-pill">工作室</span>
              </div>
              <span class="was-meta">{{ appId }} · {{ appVersion }}</span>
            </div>
            <div class="was-actions">
              <button type="button" class="was-refresh ghost" @click="startService">启动服务</button>
              <button type="button" class="was-refresh ghost" @click="stopService">停止服务</button>
              <button type="button" class="was-refresh" :disabled="!previewUrl" @click="refreshPreview">刷新预览</button>
            </div>
          </header>
          <webview
            ref="previewWebview"
            :key="previewKey"
            class="was-webview"
            partition="persist:ou-webapps"
            :src="previewSrc"
            @dom-ready="onPreviewDomReady"
            allowpopups
          />
        </section>
        <aside class="was-chat" aria-label="AI 编辑与调试">
          <div class="was-chat-head">
            AI 助手 · 工作区为下方「当前应用」目录；保存相关文件后将尝试自动刷新左侧预览
          </div>
          <div class="was-chat-panel-wrap">
            <ChatPanel
              :key="appPath"
              :project-path="appPath"
              :initial-session-id="null"
              :session-type-label="studioSessionLabel"
              :system-prompt="studioSystemPrompt"
              :model="''"
              :enable-mention="true"
              :after-tool-result="onStudioToolResult"
              :studio-sandbox-mode="true"
            />
          </div>
        </aside>
      </div>
    </template>
    <div v-else class="was-loading">加载中…</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatPanel from '../components/ai/ChatPanel.vue'
import { saveLastWebAppStudio } from '../composables/useLastWebAppStudio.js'
import { useTheme } from '../composables/useTheme.js'

defineOptions({ name: 'WebAppStudioView' })

const route = useRoute()
const router = useRouter()
const api = window.electronAPI?.ai
const { effectiveTheme } = useTheme()

const appPath = ref('')
const previewUrl = ref('')
const appName = ref('')
const appId = ref('')
const appVersion = ref('')
const entryHtml = ref('index.html')
const loadError = ref('')
const previewKey = ref(0)
const previewWebview = ref(null)
const serviceRunning = ref(false)
const serviceMode = ref('')
let previewRefreshTimer = null

const studioSessionLabel = computed(() =>
  appName.value ? `应用 · ${appName.value}` : '应用'
)

const serviceModeText = computed(() => {
  const m = String(serviceMode.value || '').trim()
  if (m === 'managed') return '自定义命令'
  if (m === 'static') return '默认静态服务'
  return '未知模式'
})

/** 带版本戳，避免 webview/协议层对同一 URL 强缓存导致「已写入磁盘但画面不更新」 */
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

/** 注入模型：明确「当前只改这一沙箱应用」，避免与其它项目混淆 */
const studioSystemPrompt = computed(() => {
  const root = appPath.value.replace(/\\/g, '/').replace(/\/+$/, '')
  const id = appId.value
  const ver = appVersion.value
  const name = appName.value || id
  const entry = entryHtml.value || 'index.html'
  const prev = previewUrl.value || ''
  if (!root || !id) return ''
  return [
    '## 应用工作室（当前唯一编辑目标）',
    `你正在协助用户开发与调试 **一个** OpenUltron 沙箱应用。本轮会话的 **projectPath / 工作区** 即下方目录；**所有** file_operation、apply_patch 等涉及路径的操作，必须针对 **该应用**，不要改到 OpenUltron 主程序目录或其它无关项目。`,
    '',
    `- **应用名称**（来自 \`manifest.json\` 的 \`name\`）：${name}`,
    `- **应用 ID**：\`${id}\``,
    `- **版本**：\`${ver}\``,
    `- **应用根目录（绝对路径）**：\`${root}\``,
    `- **入口 HTML（相对应用根）**：\`${entry}\``,
    `- **左侧沙箱预览 URL**：\`${prev}\``,
    '',
    '**路径规则**：优先使用 **绝对路径**（以应用根目录开头）。也可使用 **相对应用根** 的路径（如 `index.html`、`styles.css`），宿主会自动拼接到应用根目录。**不要**把文件写到 OpenUltron 安装目录或其它项目。修改 `index.html`、`.css`、`manifest.json` 等会直接影响左侧预览；保存成功后界面会尝试 **自动刷新预览**，用户也可随时点「刷新预览」。',
    '**回复时**若提及「当前应用」，请用上述 **名称 / id**，避免与其它仓库混淆。'
  ].join('\n')
})

function bumpPreview() {
  previewKey.value += 1
}

async function refreshPreview() {
  await loadApp()
  bumpPreview()
}

function onStudioPreviewRefreshEvent() {
  bumpPreview()
}

function pathUnderApp(absPath) {
  if (!absPath || !appPath.value) return false
  try {
    const root = appPath.value.replace(/\\/g, '/').replace(/\/+$/, '')
    const p = String(absPath).replace(/\\/g, '/')
    return p === root || p.startsWith(`${root}/`)
  } catch {
    return false
  }
}

/** file_operation / apply_patch / execute_command 成功写入应用目录后，防抖刷新 webview */
function onStudioToolResult(data) {
  const name = String(data?.name || '')
  if (!/^(file_operation|apply_patch|execute_command)$/.test(name)) return
  let parsed
  try {
    parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  if (parsed.partial === true || parsed.running === true) return

  let shouldRefresh = false
  if (name === 'file_operation') {
    const act = String(parsed.action || '')
    if (act === 'write' && parsed.success && pathUnderApp(parsed.path)) {
      shouldRefresh = true
    }
  } else if (name === 'apply_patch') {
    if (parsed.success && Array.isArray(parsed.results)) {
      const any = parsed.results.some(
        (r) => r && r.success && r.path && pathUnderApp(r.path)
      )
      if (any) shouldRefresh = true
    }
  } else if (name === 'execute_command') {
    const ok = parsed.success === true
    const cwd = String(parsed.cwd || '').trim()
    if (ok && cwd && pathUnderApp(cwd)) {
      shouldRefresh = true
    }
  }

  if (!shouldRefresh) return
  if (previewRefreshTimer) clearTimeout(previewRefreshTimer)
  previewRefreshTimer = setTimeout(() => {
    previewRefreshTimer = null
    bumpPreview()
  }, 450)
}

async function loadApp() {
  loadError.value = ''
  appPath.value = ''
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
    appPath.value = r.path || ''
    previewUrl.value = r.previewUrl || ''
    serviceRunning.value = !!r?.service?.running
    serviceMode.value = String(r?.service?.mode || '')
    appId.value = id
    appVersion.value = version
    appName.value = r.manifest?.name || id
    const ent = r.manifest?.entry && typeof r.manifest.entry === 'object' ? r.manifest.entry.html : ''
    entryHtml.value = String(ent || 'index.html').trim() || 'index.html'
    saveLastWebAppStudio({ appId: id, version })
  } catch (e) {
    loadError.value = e?.message || String(e)
  }
}

async function startService() {
  if (!api?.startWebAppService) return
  if (!appId.value || !appVersion.value) return
  const r = await api.startWebAppService({ id: appId.value, version: appVersion.value })
  if (r?.success && r?.url) {
    previewUrl.value = r.url
    serviceRunning.value = true
    serviceMode.value = String(r.mode || '')
    bumpPreview()
    return
  }
  await loadApp()
}

async function stopService() {
  if (!api?.stopWebAppService) return
  if (!appId.value || !appVersion.value) return
  await api.stopWebAppService({ id: appId.value, version: appVersion.value })
  serviceRunning.value = false
  serviceMode.value = ''
  await loadApp()
}

function goBack() {
  router.push({ path: '/web-apps' })
}

onMounted(() => {
  loadApp()
  window.addEventListener('ou-webapp-studio-preview-refresh', onStudioPreviewRefreshEvent)
})
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

onBeforeUnmount(() => {
  window.removeEventListener('ou-webapp-studio-preview-refresh', onStudioPreviewRefreshEvent)
  if (previewRefreshTimer) {
    clearTimeout(previewRefreshTimer)
    previewRefreshTimer = null
  }
})
</script>

<style scoped>
.was-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--ou-bg-main);
}
.was-error {
  padding: 24px;
  color: var(--ou-text);
}
.was-error .was-back {
  margin-top: 12px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-elevated);
  cursor: pointer;
}
.was-loading {
  padding: 24px;
  color: var(--ou-text-muted);
}
.was-studio {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}
.was-sandbox {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--ou-border);
}
.was-sandbox-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ou-border);
  flex-shrink: 0;
  background: var(--ou-bg-elevated, var(--ou-bg-main));
}
.was-back-outline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 96px;
  height: 38px;
  padding: 0 14px;
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  background: transparent;
  color: var(--ou-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 500;
}
.was-back-outline:hover {
  border-color: var(--ou-text-muted);
  color: var(--ou-text);
}
.was-title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.was-headline-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.was-headline {
  font-size: 22px;
  line-height: 1.1;
  font-weight: 700;
  color: var(--ou-text);
}
.was-crumb-pill {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--ou-accent);
  color: var(--ou-accent-fg);
}
.was-meta {
  font-size: 13px;
  color: var(--ou-text-muted);
  font-family: ui-monospace, monospace;
  word-break: break-all;
}
.was-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.was-refresh {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
  color: var(--ou-text);
  cursor: pointer;
}
.was-refresh.ghost {
  background: transparent;
}
.was-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.was-webview {
  flex: 1;
  min-height: 0;
  width: 100%;
  background: var(--ou-bg-main);
}
.was-chat {
  width: min(440px, 42vw);
  flex-shrink: 0;
  min-width: 320px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ou-bg-main);
}
.was-chat-head {
  padding: 10px 14px;
  font-size: 12px;
  color: var(--ou-text-muted);
  border-bottom: 1px solid var(--ou-border);
  flex-shrink: 0;
}
.was-chat-panel-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.was-chat-panel-wrap :deep(.chat-panel) {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
}
</style>
