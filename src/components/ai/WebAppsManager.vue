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
          <button type="button" class="wam-btn" :disabled="loading" @click="installSample">
            安装示例（Hello）
          </button>
          <button type="button" class="wam-btn" :disabled="loading" @click="importZip">
            从 ZIP 导入
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
          <span class="wam-name">{{ a.name }}</span>
          <span class="wam-id">{{ a.id }}</span>
          <span class="wam-ver">{{ a.version }}</span>
        </div>
        <div class="wam-row-actions">
          <button type="button" class="wam-btn" @click="openOnly(a)">打开</button>
          <button type="button" class="wam-btn primary" @click="openStudio(a)">工作室</button>
          <button type="button" class="wam-btn ghost" @click="exportZip(a)">导出 ZIP</button>
        </div>
      </li>
    </ul>

    <div v-if="createModalOpen" class="wam-modal-backdrop" role="presentation" @click.self="closeCreateModal">
      <div class="wam-modal" role="dialog" aria-labelledby="wam-create-title" @keydown.esc.stop="closeCreateModal">
        <h3 id="wam-create-title" class="wam-modal-title">新建应用</h3>
        <p class="wam-modal-desc">将创建 <code>manifest.json</code> 与空白 <code>index.html</code>（版本 0.1.0），并进入工作室。</p>
        <label class="wam-modal-field">
          <span class="wam-modal-label">显示名称</span>
          <input
            v-model="createNameInput"
            type="text"
            class="wam-modal-input"
            placeholder="未命名应用"
            maxlength="80"
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
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

const api = window.electronAPI?.ai
const loading = ref(false)
const creating = ref(false)
const apps = ref([])
const errorMsg = ref('')

const createModalOpen = ref(false)
const createNameInput = ref('')

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

function openCreateModal() {
  createNameInput.value = ''
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
    const r = await api.createWebApp(name ? { name } : {})
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

async function installSample() {
  errorMsg.value = ''
  try {
    const r = await api.installWebAppSample()
    if (!r?.success) {
      errorMsg.value = r?.error || '安装失败'
      return
    }
    await load()
  } catch (e) {
    errorMsg.value = e?.message || String(e)
  }
}

async function importZip() {
  errorMsg.value = ''
  try {
    const r = await api.importWebAppZip({})
    if (r?.message === 'canceled') return
    if (!r?.success) {
      errorMsg.value = r?.error || r?.message || '导入失败'
      return
    }
    await load()
  } catch (e) {
    errorMsg.value = e?.message || String(e)
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

onMounted(() => {
  load()
})

defineExpose({ load, installSample, importZip })
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
  padding: 20px 28px 20px;
  border-bottom: 1px solid var(--ou-border);
  background: linear-gradient(180deg, var(--ou-bg-elevated, var(--ou-bg-main)) 0%, var(--ou-bg-main) 100%);
}
.wam-page-hero {
  max-width: 920px;
  margin: 0 auto;
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
  max-width: 920px;
  margin-left: auto;
  margin-right: auto;
  padding: 0 28px;
}
.wam-loading {
  color: var(--ou-text-muted);
  font-size: 13px;
  padding: 0 28px;
}
.wam-empty {
  max-width: 920px;
  margin: 0 auto;
  padding: 32px 28px 48px;
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
  padding: 0 28px 24px;
  border-top: 1px solid var(--ou-border);
}
.wam-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
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
.wam-id,
.wam-ver {
  font-size: 12px;
  color: var(--ou-text-muted);
  font-family: ui-monospace, monospace;
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
  background: var(--ou-bg-elevated, #2d333b);
  color: var(--ou-text);
  font-size: 13px;
  cursor: pointer;
}
.wam-btn:hover:not(:disabled) {
  filter: brightness(1.08);
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
  filter: brightness(1.06);
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
</style>
