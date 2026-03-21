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
            <button type="button" class="was-back ghost" @click="goBack">← 应用库</button>
            <div class="was-title-block">
              <nav class="was-crumb" aria-label="面包屑">
                <router-link to="/web-apps" class="was-crumb-link">应用</router-link>
                <span class="was-crumb-sep" aria-hidden="true">/</span>
                <span class="was-crumb-current">{{ appName }}</span>
                <span class="was-crumb-pill">工作室</span>
              </nav>
              <div class="was-name-row" role="group" aria-label="应用展示名称">
                <label class="was-name-label" for="was-display-name">展示名称</label>
                <input
                  id="was-display-name"
                  v-model.trim="displayNameDraft"
                  type="text"
                  class="was-name-input"
                  maxlength="120"
                  placeholder="应用列表中显示的名称"
                  :disabled="nameSaving"
                  @keydown.enter.prevent="saveDisplayName"
                />
                <button
                  type="button"
                  class="was-name-save"
                  :disabled="nameSaving || !displayNameDraft || displayNameDraft === appName"
                  @click="saveDisplayName"
                >
                  {{ nameSaving ? '保存中…' : '保存' }}
                </button>
              </div>
              <p v-if="nameSaveError" class="was-name-error" role="alert">{{ nameSaveError }}</p>
              <span class="was-meta">{{ appId }} · {{ appVersion }}</span>
              <p class="was-tagline">沙盒预览 · 展示名称写入 manifest.json · 右侧 AI 可读写本应用目录下文件</p>
            </div>
            <button type="button" class="was-refresh" :disabled="!previewUrl" @click="bumpPreview">刷新预览</button>
          </header>
          <webview
            :key="previewKey"
            class="was-webview"
            partition="persist:ou-webapps"
            :src="previewSrc"
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

defineOptions({ name: 'WebAppStudioView' })

const route = useRoute()
const router = useRouter()
const api = window.electronAPI?.ai

const appPath = ref('')
const previewUrl = ref('')
const appName = ref('')
const displayNameDraft = ref('')
const nameSaving = ref(false)
const nameSaveError = ref('')
const appId = ref('')
const appVersion = ref('')
const entryHtml = ref('index.html')
const loadError = ref('')
const previewKey = ref(0)
let previewRefreshTimer = null
/** AI 写入 manifest.json 后需从磁盘同步展示名称到输入框 */
let studioManifestNeedsSync = false

const studioSessionLabel = computed(() =>
  appName.value ? `应用 · ${appName.value}` : '应用'
)

/** 带版本戳，避免 webview/协议层对同一 URL 强缓存导致「已写入磁盘但画面不更新」 */
const previewSrc = computed(() => {
  const u = previewUrl.value
  if (!u) return ''
  const sep = u.includes('?') ? '&' : '?'
  return `${u}${sep}_ou_refresh=${previewKey.value}`
})

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
    `- **展示名称**（应用库列表标题，与 \`manifest.json\` 的 \`name\` 一致；可在工作室顶部修改并保存）：${name}`,
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

function onStudioPreviewRefreshEvent() {
  bumpPreview()
}

async function syncStudioManifestFromDisk() {
  if (!api?.getWebApp || !appId.value || !appVersion.value) return
  try {
    const r = await api.getWebApp({ id: appId.value, version: appVersion.value })
    if (r?.success && r.manifest?.name) {
      appName.value = r.manifest.name
      displayNameDraft.value = r.manifest.name
    }
  } catch {
    /* ignore */
  }
}

async function saveDisplayName() {
  const id = appId.value
  const version = appVersion.value
  const next = String(displayNameDraft.value || '').trim()
  nameSaveError.value = ''
  if (!next) {
    nameSaveError.value = '名称不能为空'
    return
  }
  if (next === appName.value) return
  if (!api?.updateWebAppName) {
    nameSaveError.value = '当前环境不支持修改名称'
    return
  }
  nameSaving.value = true
  try {
    const r = await api.updateWebAppName({ id, version, name: next })
    if (!r?.success) {
      nameSaveError.value = r?.error || '保存失败'
      return
    }
    appName.value = r.manifest?.name || next
    displayNameDraft.value = appName.value
    if (r.previewUrl) previewUrl.value = r.previewUrl
    bumpPreview()
  } catch (e) {
    nameSaveError.value = e?.message || String(e)
  } finally {
    nameSaving.value = false
  }
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
      const p = String(parsed.path || '').replace(/\\/g, '/')
      if (/manifest\.json$/i.test(p)) studioManifestNeedsSync = true
    }
  } else if (name === 'apply_patch') {
    if (parsed.success && Array.isArray(parsed.results)) {
      const any = parsed.results.some(
        (r) => r && r.success && r.path && pathUnderApp(r.path)
      )
      if (any) shouldRefresh = true
      const touchedManifest = parsed.results.some(
        (r) =>
          r &&
          r.success &&
          r.path &&
          pathUnderApp(r.path) &&
          /manifest\.json$/i.test(String(r.path).replace(/\\/g, '/'))
      )
      if (touchedManifest) studioManifestNeedsSync = true
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
    if (studioManifestNeedsSync) {
      studioManifestNeedsSync = false
      void syncStudioManifestFromDisk()
    }
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
    appId.value = id
    appVersion.value = version
    appName.value = r.manifest?.name || id
    displayNameDraft.value = appName.value
    nameSaveError.value = ''
    const ent = r.manifest?.entry && typeof r.manifest.entry === 'object' ? r.manifest.entry.html : ''
    entryHtml.value = String(ent || 'index.html').trim() || 'index.html'
    saveLastWebAppStudio({ appId: id, version })
  } catch (e) {
    loadError.value = e?.message || String(e)
  }
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
  padding: 10px 14px;
  border-bottom: 1px solid var(--ou-border);
  flex-shrink: 0;
  background: var(--ou-bg-elevated, var(--ou-bg-main));
}
.was-back.ghost {
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--ou-text-muted);
  cursor: pointer;
  font-size: 13px;
}
.was-back.ghost:hover {
  color: var(--ou-text);
}
.was-title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.was-crumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 14px;
  line-height: 1.3;
}
.was-crumb-link {
  color: var(--ou-text-muted);
  text-decoration: none;
}
.was-crumb-link:hover {
  color: var(--ou-accent);
}
.was-crumb-sep {
  color: var(--ou-border);
  user-select: none;
}
.was-crumb-current {
  font-weight: 600;
  color: var(--ou-text);
}
.was-crumb-pill {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--ou-accent);
  color: var(--ou-accent-fg);
}
.was-name-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.was-name-label {
  font-size: 12px;
  color: var(--ou-text-muted);
  flex-shrink: 0;
}
.was-name-input {
  flex: 1;
  min-width: 140px;
  max-width: 320px;
  padding: 6px 10px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
  color: var(--ou-text);
}
.was-name-input:focus {
  outline: none;
  border-color: var(--ou-accent);
}
.was-name-save {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
  color: var(--ou-text);
  cursor: pointer;
  flex-shrink: 0;
}
.was-name-save:hover:not(:disabled) {
  border-color: var(--ou-accent);
  color: var(--ou-accent);
}
.was-name-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.was-name-error {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--ou-danger, #e5534b);
}
.was-meta {
  font-size: 11px;
  color: var(--ou-text-muted);
  font-family: ui-monospace, monospace;
  word-break: break-all;
}
.was-tagline {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--ou-text-muted);
  line-height: 1.35;
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
.was-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.was-webview {
  flex: 1;
  min-height: 0;
  width: 100%;
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
