<template>
  <div class="proxy-page">
    <div class="settings-header">
      <div class="header-left">
        <h3>全局代理</h3>
      </div>
      <div class="header-right">
        <button class="btn primary" :disabled="saving" @click="save">
          <span>{{ saving ? '保存中…' : '保存代理配置' }}</span>
        </button>
        <span v-if="statusMsg" class="status-msg" :class="statusType">{{ statusMsg }}</span>
      </div>
    </div>

    <label class="proxy-switch">
      <input v-model="form.enabled" type="checkbox" />
      <span>启用全局代理（用于应用内网络请求）</span>
    </label>

    <div class="form-grid">
      <label>
        <span>HTTP Proxy</span>
        <input v-model.trim="form.http_proxy" type="text" placeholder="http://127.0.0.1:7890" />
      </label>
      <label>
        <span>HTTPS Proxy</span>
        <input v-model.trim="form.https_proxy" type="text" placeholder="http://127.0.0.1:7890" />
      </label>
      <label>
        <span>ALL Proxy</span>
        <input v-model.trim="form.all_proxy" type="text" placeholder="socks5://127.0.0.1:7890" />
      </label>
      <label>
        <span>NO Proxy</span>
        <input v-model.trim="form.no_proxy" type="text" placeholder="127.0.0.1,localhost" />
      </label>
    </div>

    <div class="proxy-help">
      <p>推荐环境变量：</p>
      <pre>export https_proxy={{ form.https_proxy || 'http://127.0.0.1:7890' }} http_proxy={{ form.http_proxy || 'http://127.0.0.1:7890' }} all_proxy={{ form.all_proxy || 'socks5://127.0.0.1:7890' }}</pre>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'

const form = reactive({
  enabled: false,
  http_proxy: 'http://127.0.0.1:7890',
  https_proxy: 'http://127.0.0.1:7890',
  all_proxy: 'socks5://127.0.0.1:7890',
  no_proxy: '127.0.0.1,localhost'
})

const saving = ref(false)
const statusMsg = ref('')
const statusType = ref('')

async function load() {
  try {
    const res = await window.electronAPI?.ai?.getProxyConfig?.()
    if (res?.success && res.data) {
      form.enabled = !!res.data.enabled
      form.http_proxy = String(res.data.http_proxy || form.http_proxy)
      form.https_proxy = String(res.data.https_proxy || form.https_proxy)
      form.all_proxy = String(res.data.all_proxy || form.all_proxy)
      form.no_proxy = String(res.data.no_proxy || form.no_proxy)
    }
  } catch (e) {
    statusType.value = 'error'
    statusMsg.value = e?.message || '读取代理配置失败'
  }
}

async function save() {
  saving.value = true
  statusMsg.value = ''
  try {
    const payload = {
      enabled: !!form.enabled,
      http_proxy: String(form.http_proxy || '').trim(),
      https_proxy: String(form.https_proxy || '').trim(),
      all_proxy: String(form.all_proxy || '').trim(),
      no_proxy: String(form.no_proxy || '').trim()
    }
    const res = await window.electronAPI?.ai?.saveProxyConfig?.(payload)
    if (!res?.success) throw new Error(res?.message || '保存失败')
    statusType.value = 'ok'
    statusMsg.value = form.enabled ? '已启用代理并应用到全局环境变量' : '已关闭代理并清理全局环境变量'
  } catch (e) {
    statusType.value = 'error'
    statusMsg.value = e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.proxy-page {
  padding: 20px 24px;
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  color: var(--ou-text);
}
.proxy-page::-webkit-scrollbar { width: 6px; }
.proxy-page::-webkit-scrollbar-track { background: transparent; }
.proxy-page::-webkit-scrollbar-thumb { background: var(--ou-border); border-radius: 3px; }

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ou-border);
  margin-bottom: 16px;
}
.header-left h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
}
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.proxy-switch {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 14px;
  font-size: 13px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.form-grid label { display: flex; flex-direction: column; gap: 6px; }
.form-grid span { font-size: 12px; color: var(--ou-text-muted); }
.form-grid input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--ou-border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--ou-bg-main);
  color: var(--ou-text);
}
.proxy-help { margin-top: 14px; }
.proxy-help p { margin: 0 0 8px 0; font-size: 12px; color: var(--ou-text-muted); }
.proxy-help pre {
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  background: var(--ou-bg-elevated);
  border: 1px solid var(--ou-border);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: var(--ou-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn:hover { background: rgba(255, 255, 255, 0.1); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary {
  background: var(--ou-primary);
  border-color: var(--ou-primary);
  color: var(--ou-accent-fg);
}
.btn.primary:hover { background: var(--ou-primary-hover); }

.status-msg {
  font-size: 12px;
}
.status-msg.ok { color: var(--ou-success); }
.status-msg.error { color: var(--ou-error); }
</style>
