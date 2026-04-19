<template>
  <div class="web-apps-manager">
    <header class="wam-toolbar">
      <div class="wam-page-hero">
        <div class="wam-page-hero-text">
          <h1 class="wam-page-title">应用</h1>
          <p class="wam-page-desc">
            沙箱内运行的迷你前端，安装目录在 <code>~/.openultron/web-apps/</code>。
            <strong>打开</strong>为全屏预览；<strong>工作室</strong>为左侧预览 + 右侧 AI，边改边调试。
            manifest.aiTools 与模型工具合并请在<strong>配置 → Web 应用</strong>中设置。
          </p>
        </div>
        <div class="wam-actions wam-actions-hero">
          <button
            type="button"
            class="wam-btn primary"
            :disabled="loading || creating"
            @click="openCreateModal"
          >
            新建应用
          </button>
          <button type="button" class="wam-btn" :disabled="loading || installLoading" @click="openInstallModal">
            安装应用
          </button>
          <button type="button" class="wam-btn" :disabled="loading || updateLoading" @click="openUpdateModal">
            检查更新
          </button>
          <button type="button" class="wam-btn" :disabled="loading || creating" @click="importZip">
            从 ZIP 安装
          </button>
        </div>
      </div>
    </header>

    <p v-if="errorMsg" class="wam-error">{{ errorMsg }}</p>

    <div v-if="loading && !apps.length" class="wam-loading">加载中…</div>

    <div v-else-if="!apps.length" class="wam-empty">
      <p class="wam-empty-title">暂无应用</p>
      <p class="wam-empty-hint">点击「新建应用」生成空白项目并进入工作室，或安装示例 / 导入 ZIP。</p>
      <button type="button" class="wam-btn primary" :disabled="creating" @click="openCreateModal">
        新建应用
      </button>
    </div>

    <ul v-else class="wam-list">
      <li v-for="a in apps" :key="a.id + '@' + a.version" class="wam-row">
        <div class="wam-meta">
          <span class="wam-name">
            {{ a.name }}
            <em class="wam-source-badge" :class="isCatalogApp(a) ? 'catalog' : 'local'">{{ isCatalogApp(a) ? '远端' : '本地' }}</em>
          </span>
          <span class="wam-id">{{ a.id }}</span>
          <span class="wam-ver">
            {{ a.version }}
            <em v-if="updatesByAppId[a.id]?.hasUpdate" class="wam-update-badge">可更新到 {{ updatesByAppId[a.id]?.latestVersion }}</em>
          </span>
        </div>
        <div class="wam-row-actions">
          <button type="button" class="wam-btn" @click="openOnly(a)">打开</button>
          <button type="button" class="wam-btn primary" @click="openStudio(a)">工作室</button>
          <button
            v-if="!isCatalogApp(a)"
            type="button"
            class="wam-btn"
            :disabled="publishState(a) !== 'idle'"
            @click="publishApp(a)"
          >
            {{ publishButtonLabel(a) }}
          </button>
          <button type="button" class="wam-btn ghost" @click="exportZip(a)">导出 ZIP</button>
          <button type="button" class="wam-btn danger" @click="deleteApp(a)">删除</button>
        </div>
      </li>
    </ul>

    <div v-if="installModalOpen" class="wam-modal-backdrop" role="presentation" @click.self="closeInstallModal">
      <div class="wam-modal wam-modal-wide" role="dialog" aria-labelledby="wam-install-title" @keydown.esc.stop="closeInstallModal">
        <h3 id="wam-install-title" class="wam-modal-title">安装应用</h3>
        <p class="wam-modal-desc">从远端 catalog 读取列表，可单个安装或全部安装。</p>
        <div class="wam-modal-actions wam-modal-actions-start">
          <button type="button" class="wam-btn" :disabled="installLoading || installingAll" @click="loadRemoteApps">
            刷新列表
          </button>
          <button type="button" class="wam-btn primary" :disabled="installLoading || installingAll || !remoteApps.length" @click="installAllRemoteApps">
            {{ installingAll ? '安装中…' : '全部安装' }}
          </button>
        </div>
        <p v-if="installLoading" class="wam-modal-desc">加载中…</p>
        <div class="wam-catalog-list">
          <div v-for="item in remoteApps" :key="item.appId" class="wam-catalog-item">
            <span class="wam-catalog-name">{{ item.appId }}</span>
            <span class="wam-catalog-meta">
              最新: {{ item.latestVersion || '无正式版' }}
              <em v-if="item.installedVersion" class="wam-installed-badge">已安装 {{ item.installedVersion }}</em>
            </span>
            <button
              type="button"
              class="wam-btn"
              :disabled="installLoading || !item.hasOfficialRelease || installingAppIds.includes(item.appId) || isAlreadyInstalledLatest(item)"
              @click="installOneRemoteApp(item.appId)"
            >
              {{
                installingAppIds.includes(item.appId)
                  ? '安装中…'
                  : (isAlreadyInstalledLatest(item) ? '已安装' : '安装')
              }}
            </button>
          </div>
          <p v-if="!remoteApps.length && !installLoading" class="wam-modal-desc">暂无可安装应用。</p>
        </div>
      </div>
    </div>

    <div v-if="updateModalOpen" class="wam-modal-backdrop" role="presentation" @click.self="closeUpdateModal">
      <div class="wam-modal wam-modal-wide" role="dialog" aria-labelledby="wam-update-title" @keydown.esc.stop="closeUpdateModal">
        <h3 id="wam-update-title" class="wam-modal-title">检查更新</h3>
        <p class="wam-modal-desc">展示已安装应用的远端正式版状态，可单个更新或全部更新。</p>
        <div class="wam-modal-actions wam-modal-actions-start">
          <button type="button" class="wam-btn" :disabled="updateLoading || updatingAll" @click="refreshUpdates">
            刷新状态
          </button>
          <button type="button" class="wam-btn primary" :disabled="updateLoading || updatingAll || !updatableItems.length" @click="updateAllRemoteApps">
            {{ updatingAll ? '更新中…' : '全部更新' }}
          </button>
        </div>
        <p v-if="updateLoading" class="wam-modal-desc">加载中…</p>
        <div class="wam-catalog-list">
          <div v-for="item in updateItems" :key="item.appId" class="wam-catalog-item">
            <span class="wam-catalog-name">{{ item.appId }}</span>
            <span class="wam-catalog-meta">已装: {{ item.installedVersion || '-' }} / 最新: {{ item.latestVersion || '-' }}</span>
            <button
              type="button"
              class="wam-btn"
              :disabled="updateLoading || !item.hasUpdate || updatingAppIds.includes(item.appId)"
              @click="updateOneRemoteApp(item.appId)"
            >
              {{ updatingAppIds.includes(item.appId) ? '更新中…' : (item.hasUpdate ? '更新' : '已是最新') }}
            </button>
          </div>
          <p v-if="!updateItems.length && !updateLoading" class="wam-modal-desc">暂无可检查项目。</p>
        </div>
      </div>
    </div>

    <div v-if="createModalOpen" class="wam-modal-backdrop" role="presentation" @click.self="closeCreateModal">
      <div class="wam-modal" role="dialog" aria-labelledby="wam-create-title" @keydown.esc.stop="closeCreateModal">
        <h3 id="wam-create-title" class="wam-modal-title">新建应用</h3>
        <p class="wam-modal-desc">请填写名称、描述和英文项目名（用于目录创建，必须唯一）。</p>
        <label class="wam-modal-field">
          <span class="wam-modal-label">显示名称</span>
          <input
            v-model="createNameInput"
            type="text"
            class="wam-modal-input"
            placeholder="例如：邮件批量发送工具"
            maxlength="80"
          />
        </label>
        <label class="wam-modal-field">
          <span class="wam-modal-label">应用描述</span>
          <input
            v-model="createDescriptionInput"
            type="text"
            class="wam-modal-input"
            placeholder="一句话描述该应用用途"
            maxlength="80"
          />
        </label>
        <label class="wam-modal-field">
          <span class="wam-modal-label">英文项目名（目录）</span>
          <input
            v-model="createProjectNameInput"
            type="text"
            class="wam-modal-input"
            placeholder="mail-batch-sender"
            maxlength="64"
            @keydown.enter.prevent="submitCreate"
          />
        </label>
        <div class="wam-modal-actions">
          <button type="button" class="wam-btn ghost" :disabled="creating" @click="closeCreateModal">取消</button>
          <button type="button" class="wam-btn primary" :disabled="creating" @click="submitCreate">
            {{ creating ? '创建中…' : '创建并打开工作室' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirm } from '../../composables/useConfirm.js'

const router = useRouter()

const api = window.electronAPI?.ai
const loading = ref(false)
const creating = ref(false)
const installLoading = ref(false)
const updateLoading = ref(false)
const installingAll = ref(false)
const updatingAll = ref(false)
const installingAppIds = ref([])
const updatingAppIds = ref([])
const publishingAppIds = ref([])
const publishPendingAppIds = ref([])
const apps = ref([])
const remoteApps = ref([])
const updateItems = ref([])
const updatesByAppId = ref({})
const errorMsg = ref('')

const createModalOpen = ref(false)
const createNameInput = ref('')
const createDescriptionInput = ref('')
const createProjectNameInput = ref('')
const installModalOpen = ref(false)
const updateModalOpen = ref(false)
const updatableItems = computed(() => updateItems.value.filter((x) => x?.hasUpdate))

function isCatalogApp(a) {
  return a?.sourceMeta?.source === 'catalog'
}

function isAlreadyInstalledLatest(item) {
  if (!item) return false
  const installed = String(item.installedVersion || '').trim()
  const latest = String(item.latestVersion || '').trim()
  return !!installed && !!latest && installed === latest
}

function publishState(a) {
  const key = `${a?.id || ''}@${a?.version || ''}`
  const localState = String(a?.sourceMeta?.publishState || '').trim()
  if (localState === 'published') return 'published'
  if (publishingAppIds.value.includes(key)) return 'publishing'
  const latest = updatesByAppId.value?.[a?.id || '']?.latestVersion || ''
  if (latest && latest === (a?.version || '')) return 'published'
  if (localState === 'reviewing') return 'reviewing'
  if (publishPendingAppIds.value.includes(key)) return 'reviewing'
  return 'idle'
}

function publishButtonLabel(a) {
  const st = publishState(a)
  if (st === 'publishing') return '发布中…'
  if (st === 'reviewing') return '审核中'
  if (st === 'published') return '已发布'
  return '发布'
}

async function load() {
  if (!api?.listWebApps) {
    errorMsg.value = '当前版本未暴露应用 API（请更新应用）'
    return
  }
  loading.value = true
  errorMsg.value = ''
  try {
    const r = await api.listWebApps()
    apps.value = r?.apps || []
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

async function loadRemoteApps() {
  if (!api?.listRemoteWebApps) return
  installLoading.value = true
  try {
    const r = await api.listRemoteWebApps()
    if (!r?.success) {
      errorMsg.value = r?.error || '读取远端应用失败'
      remoteApps.value = []
      return
    }
    remoteApps.value = Array.isArray(r.apps) ? r.apps : []
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    installLoading.value = false
  }
}

async function refreshUpdates() {
  if (!api?.checkRemoteWebAppUpdates) return
  updateLoading.value = true
  try {
    const r = await api.checkRemoteWebAppUpdates({})
    if (!r?.success) {
      errorMsg.value = r?.error || '检查更新失败'
      updateItems.value = []
      updatesByAppId.value = {}
      return
    }
    const items = Array.isArray(r.items) ? r.items : []
    updateItems.value = items.filter((x) => x?.installedVersion)
    const map = {}
    for (const item of items) {
      if (item?.appId) map[item.appId] = item
    }
    updatesByAppId.value = map
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    updateLoading.value = false
  }
}

async function refreshUpdatesInBackground() {
  if (!api?.checkRemoteWebAppUpdates) return
  try {
    const r = await api.checkRemoteWebAppUpdates({})
    if (!r?.success) return
    const items = Array.isArray(r.items) ? r.items : []
    const map = {}
    for (const item of items) {
      if (item?.appId) map[item.appId] = item
    }
    updatesByAppId.value = map
  } catch (_) {
    // ignore background errors to keep first paint smooth
  }
}

function openInstallModal() {
  installModalOpen.value = true
  errorMsg.value = ''
  loadRemoteApps()
}

function closeInstallModal() {
  installModalOpen.value = false
}

function openUpdateModal() {
  updateModalOpen.value = true
  errorMsg.value = ''
  refreshUpdates()
}

function closeUpdateModal() {
  updateModalOpen.value = false
}

function openCreateModal() {
  createNameInput.value = ''
  createDescriptionInput.value = ''
  createProjectNameInput.value = ''
  createModalOpen.value = true
}

function closeCreateModal() {
  if (creating.value) return
  createModalOpen.value = false
}

async function submitCreate() {
  if (!api?.createWebApp) {
    errorMsg.value = '当前版本不支持新建应用 API'
    return
  }
  errorMsg.value = ''
  creating.value = true
  try {
    const name = createNameInput.value.trim()
    const description = createDescriptionInput.value.trim()
    const projectName = createProjectNameInput.value.trim().toLowerCase()
    if (!name) {
      errorMsg.value = '请填写应用名称'
      return
    }
    if (!description) {
      errorMsg.value = '请填写应用描述'
      return
    }
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(projectName)) {
      errorMsg.value = '英文项目名仅允许小写字母、数字、短横线，且需字母开头（2-64）'
      return
    }
    const r = await api.createWebApp({ name, description, projectName })
    if (!r?.success) {
      errorMsg.value = r?.error || '创建失败'
      return
    }
    createModalOpen.value = false
    await load()
    router.push({
      path: '/web-app-studio',
      query: { appId: r.id, version: r.version }
    })
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    creating.value = false
  }
}

async function installOneRemoteApp(appId) {
  if (!api?.installRemoteWebApps || !appId) return
  const set = new Set(installingAppIds.value)
  set.add(appId)
  installingAppIds.value = [...set]
  errorMsg.value = ''
  try {
    const r = await api.installRemoteWebApps({ appIds: [appId], all: false })
    if (!r?.success) {
      errorMsg.value = r?.error || `安装 ${appId} 失败`
      return
    }
    const failed = (r.items || []).find((x) => x?.success === false)
    if (failed) {
      errorMsg.value = failed.error || `安装 ${failed.appId || appId} 失败`
    } else {
      await load()
      await refreshUpdates()
      await loadRemoteApps()
    }
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    installingAppIds.value = installingAppIds.value.filter((x) => x !== appId)
  }
}

async function installAllRemoteApps() {
  if (!api?.installRemoteWebApps) return
  installingAll.value = true
  errorMsg.value = ''
  try {
    const r = await api.installRemoteWebApps({ all: true })
    if (!r?.success) {
      errorMsg.value = r?.error || '全部安装失败'
      return
    }
    const failed = (r.items || []).filter((x) => x?.success === false)
    if (failed.length > 0) {
      errorMsg.value = `部分安装失败：${failed.map((x) => x.appId).join(', ')}`
    }
    await load()
    await refreshUpdates()
    await loadRemoteApps()
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    installingAll.value = false
  }
}

async function importZip() {
  if (!api?.importWebAppZip) {
    errorMsg.value = '当前版本不支持 ZIP 安装 API'
    return
  }
  errorMsg.value = ''
  try {
    const r = await api.importWebAppZip({})
    if (r?.message === 'canceled') return
    if (!r?.success) {
      errorMsg.value = r?.error || r?.message || 'ZIP 安装失败'
      return
    }
    await load()
    await refreshUpdatesInBackground()
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  }
}

async function updateOneRemoteApp(appId) {
  if (!api?.updateRemoteWebApps || !appId) return
  const set = new Set(updatingAppIds.value)
  set.add(appId)
  updatingAppIds.value = [...set]
  errorMsg.value = ''
  try {
    const r = await api.updateRemoteWebApps({ appIds: [appId], all: false })
    if (!r?.success) {
      errorMsg.value = r?.error || `更新 ${appId} 失败`
      return
    }
    const failed = (r.items || []).find((x) => x?.success === false)
    if (failed) {
      errorMsg.value = failed.error || `更新 ${failed.appId || appId} 失败`
    } else {
      await load()
      await refreshUpdates()
    }
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    updatingAppIds.value = updatingAppIds.value.filter((x) => x !== appId)
  }
}

async function updateAllRemoteApps() {
  if (!api?.updateRemoteWebApps) return
  updatingAll.value = true
  errorMsg.value = ''
  try {
    const r = await api.updateRemoteWebApps({ all: true })
    if (!r?.success) {
      errorMsg.value = r?.error || '全部更新失败'
      return
    }
    const failed = (r.items || []).filter((x) => x?.success === false)
    if (failed.length > 0) {
      errorMsg.value = `部分更新失败：${failed.map((x) => x.appId).join(', ')}`
    }
    await load()
    await refreshUpdates()
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    updatingAll.value = false
  }
}

async function publishApp(a) {
  if (!api?.publishWebApp) {
    errorMsg.value = '当前版本不支持发布 API'
    return
  }
  const key = `${a.id}@${a.version}`
  if (publishState(a) !== 'idle') return
  publishingAppIds.value = [...publishingAppIds.value, key]
  errorMsg.value = ''
  try {
    const r = await api.publishWebApp({ id: a.id, version: a.version })
    if (!r?.success) {
      errorMsg.value = r?.error || '发布失败'
      return
    }
    if (!publishPendingAppIds.value.includes(key)) {
      publishPendingAppIds.value = [...publishPendingAppIds.value, key]
    }
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  } finally {
    publishingAppIds.value = publishingAppIds.value.filter((x) => x !== key)
  }
}

function openOnly(a) {
  router.push({
    path: '/app-open',
    query: { appId: a.id, version: a.version }
  })
}

function openStudio(a) {
  router.push({
    path: '/web-app-studio',
    query: { appId: a.id, version: a.version }
  })
}

async function exportZip(a) {
  errorMsg.value = ''
  try {
    const r = await api.exportWebAppZip({ id: a.id, version: a.version })
    if (r?.message === 'canceled') return
    if (!r?.success) {
      errorMsg.value = r?.error || r?.message || '导出失败'
    }
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  }
}

async function deleteApp(a) {
  errorMsg.value = ''
  if (!api?.deleteWebApp) {
    errorMsg.value = '当前版本不支持删除应用 API'
    return
  }
  const ok = await showConfirm({
    title: '删除应用',
    message: `确定删除「${a.name || a.id}」吗？`,
    detail: `${a.id}@${a.version}\n此操作不可恢复。`,
    type: 'danger',
    confirmText: '删除',
    cancelText: '取消'
  })
  if (!ok) return

  try {
    const r = await api.deleteWebApp({ id: a.id, version: a.version })
    if (!r?.success) {
      errorMsg.value = r?.error || '删除失败'
      return
    }
    await load()
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  }
}

onMounted(() => {
  load()
  setTimeout(() => {
    refreshUpdatesInBackground()
  }, 1200)
})

defineExpose({ load, refreshUpdates, openInstallModal, openUpdateModal })
</script>

<style scoped>
.web-apps-manager {
  max-width: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
}
.wam-toolbar {
  margin-bottom: 0;
  padding: 20px 20px 20px;
  border-bottom: 1px solid var(--ou-border);
  background: linear-gradient(180deg, var(--ou-bg-elevated, var(--ou-bg-main)) 0%, var(--ou-bg-main) 100%);
}
.wam-page-hero {
  width: 100%;
}
.wam-page-title {
  font-size: 1.35rem;
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--ou-text);
  letter-spacing: -0.02em;
}
.wam-page-desc {
  font-size: 13px;
  color: var(--ou-text-muted);
  margin: 0 0 16px;
  line-height: 1.55;
  max-width: 56rem;
}
.wam-page-desc code {
  font-size: 12px;
}
.wam-actions-hero {
  flex-wrap: wrap;
}
.wam-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.wam-error {
  color: var(--ou-danger, #f85149);
  font-size: 13px;
  margin-bottom: 12px;
  padding: 0 20px;
}
.wam-loading {
  color: var(--ou-text-muted);
  font-size: 13px;
  padding: 0 20px;
}
.wam-empty {
  margin: 0 20px;
  padding: 32px 20px 48px;
  text-align: center;
  border: 1px dashed var(--ou-border);
  border-radius: 12px;
  background: var(--ou-bg-elevated, transparent);
}
.wam-empty-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--ou-text);
}
.wam-empty-hint {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--ou-text-muted);
  line-height: 1.5;
}
.wam-list {
  list-style: none;
  margin: 0;
  padding: 0 0 24px;
  border-top: 1px solid var(--ou-border);
}
.wam-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--ou-border);
  background: var(--ou-bg-elevated, var(--ou-bg-main));
}
.wam-row:last-child {
  border-bottom: none;
}
.wam-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.wam-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--ou-text);
}
.wam-source-badge {
  display: inline-block;
  margin-left: 8px;
  font-size: 11px;
  font-style: normal;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--ou-border);
  color: var(--ou-text-muted);
}
.wam-source-badge.catalog {
  color: var(--ou-accent);
  border-color: color-mix(in srgb, var(--ou-accent) 45%, var(--ou-border));
}
.wam-source-badge.local {
  color: #16a34a;
  border-color: color-mix(in srgb, #16a34a 45%, var(--ou-border));
}
.wam-id,
.wam-ver {
  font-size: 12px;
  color: var(--ou-text-muted);
  font-family: ui-monospace, monospace;
}
.wam-update-badge {
  margin-left: 8px;
  font-style: normal;
  color: var(--ou-accent);
}
.wam-row-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.wam-btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-card);
  color: var(--ou-text);
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.wam-btn:hover:not(:disabled) {
  background: var(--ou-bg-hover);
  border-color: color-mix(in srgb, var(--ou-text-muted) 35%, var(--ou-border));
}
.wam-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.wam-btn.ghost {
  background: transparent;
}
.wam-btn.primary {
  border-color: var(--ou-accent);
  background: var(--ou-accent);
  color: var(--ou-accent-fg);
}
.wam-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ou-accent) 90%, #000 10%);
  border-color: color-mix(in srgb, var(--ou-accent) 88%, #000 12%);
}
.wam-btn.danger {
  border-color: var(--ou-danger, #f85149);
  color: var(--ou-danger, #f85149);
  background: transparent;
}
.wam-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ou-danger, #f85149) 14%, transparent);
  filter: none;
}

.wam-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.wam-modal {
  width: 100%;
  max-width: 400px;
  padding: 20px 22px;
  border-radius: 10px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-elevated, var(--ou-bg-main));
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.wam-modal.wam-modal-wide {
  max-width: 760px;
}
.wam-modal-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--ou-text);
}
.wam-modal-desc {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--ou-text-muted);
  line-height: 1.45;
}
.wam-modal-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}
.wam-modal-label {
  font-size: 12px;
  color: var(--ou-text-muted);
}
.wam-modal-input {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
  color: var(--ou-text);
  font-size: 14px;
}
.wam-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.wam-modal-actions-start {
  justify-content: flex-start;
  margin-bottom: 10px;
}
.wam-catalog-list {
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  max-height: 320px;
  overflow: auto;
  padding: 6px 8px;
}
.wam-catalog-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 2px;
}
.wam-catalog-name {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, monospace;
  color: var(--ou-text);
}
.wam-catalog-meta {
  font-size: 12px;
  color: var(--ou-text-muted);
}
.wam-installed-badge {
  margin-left: 8px;
  font-style: normal;
  color: #16a34a;
}
</style>
