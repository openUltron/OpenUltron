<template>
  <div class="feishu-page">
    <div class="feishu-header">
      <Send :size="16" />
      <span>{{ t('notify.title') }}</span>
    </div>
    <p class="feishu-desc">{{ t('notify.desc') }}</p>

    <!-- 平台切换 -->
    <div class="notify-platform-tabs">
      <button
        v-for="p in platforms"
        :key="p.key"
        class="notify-tab"
        :class="{ active: activePlatform === p.key }"
        @click="activePlatform = p.key"
      >
        {{ p.label }}
      </button>
    </div>

    <!-- 飞书 -->
    <template v-if="activePlatform === 'feishu'">

    <div v-if="!receiveRunning && receiveEnabled" class="feishu-tip">
      <strong>{{ t('notify.longConnectionTipTitle') }}</strong>{{ t('notify.longConnectionTip') }}
    </div>

    <section class="feishu-section">
      <h3 class="feishu-section-title">{{ t('notify.feishuAppConfig') }}</h3>
      <div class="feishu-form">
        <div class="feishu-row">
          <label>App ID</label>
          <input
            v-model="appId"
            type="text"
            class="feishu-input"
            :placeholder="t('notify.appIdPh')"
            @blur="saveConfigDebounced"
          />
        </div>
        <div class="feishu-row">
          <label>App Secret</label>
          <input
            v-model="appSecret"
            type="password"
            class="feishu-input"
            :placeholder="t('notify.appSecretPh')"
            @blur="saveConfigDebounced"
          />
        </div>
        <div class="feishu-row">
          <label>{{ t('notify.defaultSessionId') }}</label>
          <input
            v-model="defaultChatId"
            type="text"
            class="feishu-input"
            :placeholder="t('notify.defaultSessionIdPh')"
            @blur="saveConfigDebounced"
          />
        </div>
        <div class="feishu-row">
          <label>{{ t('notify.testChatId') }}</label>
          <input
            v-model="testChatId"
            type="text"
            class="feishu-input"
            :placeholder="t('notify.testChatIdPh')"
          />
        </div>
        <div class="feishu-row feishu-row-check">
          <label class="feishu-check-label">
            <input v-model="notifyOnComplete" type="checkbox" @change="saveConfigDebounced" />
            <span>{{ t('notify.notifyOnComplete') }}</span>
          </label>
        </div>
        <div class="feishu-row feishu-row-check">
          <label class="feishu-check-label">
            <input v-model="receiveEnabled" type="checkbox" @change="saveConfigDebounced" />
            <span>{{ t('notify.receiveFeishu') }}</span>
          </label>
        </div>
      </div>
      <div class="feishu-actions">
        <button class="feishu-btn primary" :disabled="saving" @click="saveConfig">
          <Loader v-if="saving" :size="13" class="spin" />
          {{ saving ? t('notify.saving') : t('notify.saveConfig') }}
        </button>
        <button
          class="feishu-btn"
          :disabled="sending || !sendTestChatId"
          @click="sendTest"
          :title="t('notify.testSendRequirement')"
        >
          <Loader v-if="sending" :size="13" class="spin" />
          <Send v-else :size="13" />
          {{ sending ? t('notify.sending') : t('notify.testSend') }}
        </button>
        <button
          v-if="receiveEnabled"
          class="feishu-btn"
          :disabled="receiveStarting"
          @click="toggleReceive"
        >
          <Loader v-if="receiveStarting" :size="13" class="spin" />
          <Wifi v-else :size="13" />
          {{ receiveRunning ? t('notify.connectedClickToDisconnect') : t('notify.enableReceive') }}
        </button>
      </div>
      <div v-if="result" class="feishu-result" :class="result.ok ? 'ok' : 'err'">
        {{ result.message }}
      </div>
      <div v-if="receiveError" class="feishu-result err">
        {{ receiveError }}
        <span v-if="receiveError.includes('npm install')" class="feishu-err-hint">{{ t('notify.npmInstallHint') }}</span>
      </div>
    </section>
    </template>

    <!-- Telegram -->
    <template v-else-if="activePlatform === 'telegram'">
    <section class="feishu-section">
      <h3 class="feishu-section-title">{{ t('notify.telegramConfig') }}</h3>
      <p class="telegram-desc">{{ t('notify.telegramDesc') }}</p>
      <div class="feishu-form">
        <div class="feishu-row">
          <label>Bot Token</label>
          <input
            v-model="telegramBotToken"
            type="password"
            class="feishu-input"
            :placeholder="t('notify.telegramTokenPh')"
            @blur="saveTelegramDebounced"
          />
        </div>
        <div class="feishu-row feishu-row-check">
          <label class="feishu-check-label">
            <input v-model="telegramEnabled" type="checkbox" @change="saveTelegramDebounced" />
            <span>{{ t('notify.receiveTelegram') }}</span>
          </label>
        </div>
      </div>
      <div class="feishu-actions">
        <button class="feishu-btn primary" :disabled="telegramSaving" @click="saveTelegram">
          <Loader v-if="telegramSaving" :size="13" class="spin" />
          {{ telegramSaving ? t('notify.saving') : t('notify.saveConfig') }}
        </button>
      </div>
      <div v-if="telegramStatusLoaded" class="feishu-result" :class="telegramRunning ? 'ok' : ''">
        {{ t('notify.receiveStatus') }}{{ telegramRunning ? t('notify.running') : t('notify.disconnected') }}
        <span v-if="!telegramRunning && telegramError" class="feishu-result err-inline">{{ telegramError }}</span>
      </div>
    </section>
    </template>

    <!-- 钉钉 -->
    <template v-else-if="activePlatform === 'dingtalk'">
    <section class="feishu-section">
      <h3 class="feishu-section-title">{{ t('notify.dingtalkConfig') }}</h3>
      <p class="dingtalk-desc">{{ t('notify.dingtalkDesc') }}</p>
      <div class="feishu-form">
        <div class="feishu-row">
          <label>AppKey</label>
          <input
            v-model="dingtalkAppKey"
            type="text"
            class="feishu-input"
            :placeholder="t('notify.dingtalkAppKeyPh')"
            @blur="saveDingtalkDebounced"
          />
        </div>
        <div class="feishu-row">
          <label>AppSecret</label>
          <input
            v-model="dingtalkAppSecret"
            type="password"
            class="feishu-input"
            :placeholder="t('notify.dingtalkAppSecretPh')"
            @blur="saveDingtalkDebounced"
          />
        </div>
        <div class="feishu-row">
          <label>{{ t('notify.defaultSessionId') }}</label>
          <input
            v-model="dingtalkDefaultChatId"
            type="text"
            class="feishu-input"
            :placeholder="t('notify.dingtalkDefaultChatIdPh')"
            @blur="saveDingtalkDebounced"
          />
        </div>
        <div class="feishu-row">
          <label>{{ t('notify.dingtalkRobotCode') }}</label>
          <input
            v-model="dingtalkDefaultRobotCode"
            type="text"
            class="feishu-input"
            :placeholder="t('notify.dingtalkRobotCodePh')"
            @blur="saveDingtalkDebounced"
          />
        </div>
        <div class="feishu-row feishu-row-check">
          <label class="feishu-check-label">
            <input v-model="dingtalkReceiveEnabled" type="checkbox" @change="saveDingtalkDebounced" />
            <span>{{ t('notify.receiveDingtalk') }}</span>
          </label>
        </div>
        <div class="feishu-row feishu-row-check">
          <label class="feishu-check-label">
            <input v-model="dingtalkVoiceReplyEnabled" type="checkbox" @change="saveDingtalkDebounced" />
            <span>{{ t('notify.dingtalkVoiceReply') }}</span>
          </label>
        </div>
      </div>
      <div class="feishu-actions">
        <button class="feishu-btn primary" :disabled="dingtalkSaving" @click="saveDingtalk">
          <Loader v-if="dingtalkSaving" :size="13" class="spin" />
          {{ dingtalkSaving ? t('notify.saving') : t('notify.saveConfig') }}
        </button>
      </div>
      <div v-if="dingtalkStatusLoaded" class="feishu-result" :class="dingtalkRunning ? 'ok' : ''">
        {{ t('notify.receiveStatus') }}{{ dingtalkRunning ? t('notify.running') : t('notify.disconnected') }}
        <span v-if="!dingtalkRunning && dingtalkError" class="feishu-result err-inline">{{ dingtalkError }}</span>
      </div>
      <div v-if="dingtalkResult" class="feishu-result" :class="dingtalkResult.ok ? 'ok' : 'err'">
        {{ dingtalkResult.message }}
      </div>
    </section>
    </template>

    <!-- 其他 -->
    <section v-else class="feishu-section notify-placeholder">
      <h3 class="feishu-section-title">{{ t('notify.otherPlatforms') }}</h3>
      <p class="notify-placeholder-text">{{ t('notify.otherPlatformsDesc') }}</p>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { Send, Loader, Wifi } from 'lucide-vue-next'
import { useI18n } from '../../composables/useI18n'

const { t } = useI18n()

const platforms = computed(() => ([
  { key: 'feishu', label: t('notify.platformFeishu') },
  { key: 'telegram', label: t('notify.platformTelegram') },
  { key: 'dingtalk', label: t('notify.platformDingtalk') },
  { key: 'other', label: t('notify.platformOther') }
]))
const activePlatform = ref('feishu')

const appId = ref('')
const appSecret = ref('')
const defaultChatId = ref('')
const notifyOnComplete = ref(false)
const receiveEnabled = ref(false)
const receiveRunning = ref(false)
const receiveStarting = ref(false)
const receiveError = ref('')
const saving = ref(false)
const sending = ref(false)
const result = ref(null)

const defaultChatIdTrimmed = computed(() => (defaultChatId.value || '').trim())
const testChatId = ref('')
const sendTestChatId = computed(() => defaultChatIdTrimmed.value || (testChatId.value || '').trim())

// Telegram（消息通知内子平台）
const telegramBotToken = ref('')
const telegramEnabled = ref(false)
const telegramSaving = ref(false)
const telegramStatusLoaded = ref(false)
const telegramRunning = ref(false)
const telegramError = ref('')

// 钉钉
const dingtalkAppKey = ref('')
const dingtalkAppSecret = ref('')
const dingtalkDefaultChatId = ref('')
const dingtalkDefaultRobotCode = ref('')
const dingtalkReceiveEnabled = ref(false)
const dingtalkVoiceReplyEnabled = ref(false)
const dingtalkSaving = ref(false)
const dingtalkResult = ref(null)
const dingtalkStatusLoaded = ref(false)
const dingtalkRunning = ref(false)
const dingtalkError = ref('')

const api = () => window.electronAPI?.feishu
const telegramApi = () => window.electronAPI?.telegram
const dingtalkApi = () => window.electronAPI?.dingtalk

async function loadConfig() {
  const res = await api()?.getConfig?.()
  if (res?.success) {
    appId.value = res.app_id || ''
    appSecret.value = res.app_secret || ''
    defaultChatId.value = res.default_chat_id || ''
    notifyOnComplete.value = res.notify_on_complete === true
    receiveEnabled.value = res.receive_enabled === true
  }
  const status = await api()?.receiveStatus?.()
  if (status) {
    receiveRunning.value = !!status.running
    receiveError.value = status.error || ''
  }
  // 冷启动：若配置为开启接收但当前未连接，自动尝试连接一次
  if (receiveEnabled.value && !receiveRunning.value && api()?.receiveStart) {
    receiveStarting.value = true
    try {
      const startRes = await api().receiveStart()
      receiveRunning.value = !!startRes?.running
      if (startRes?.error) receiveError.value = startRes.error
      else receiveError.value = ''
    } catch (_) { /* 保持 receiveRunning/receiveError 由上面 status 决定 */ }
    finally { receiveStarting.value = false }
  }
}

async function loadTelegramConfig() {
  const c = await telegramApi()?.getConfig?.()
  if (c) {
    telegramBotToken.value = c.bot_token || ''
    telegramEnabled.value = !!c.enabled
  }
  const status = await telegramApi()?.receiveStatus?.()
  if (status) {
    telegramRunning.value = !!status.running
    telegramError.value = status.error || ''
  }
  telegramStatusLoaded.value = true
}

async function saveTelegram() {
  if (!telegramApi()) return
  telegramSaving.value = true
  try {
    await telegramApi().setConfig?.({ bot_token: telegramBotToken.value, enabled: telegramEnabled.value })
    await loadTelegramConfig()
  } finally {
    telegramSaving.value = false
  }
}

let saveTelegramDebounceTimer = null
function saveTelegramDebounced() {
  clearTimeout(saveTelegramDebounceTimer)
  saveTelegramDebounceTimer = setTimeout(saveTelegram, 400)
}

async function loadDingtalkConfig() {
  const c = await dingtalkApi()?.getConfig?.()
  if (c) {
    dingtalkAppKey.value = c.app_key || ''
    dingtalkAppSecret.value = c.app_secret || ''
    dingtalkDefaultChatId.value = c.default_chat_id || ''
    dingtalkDefaultRobotCode.value = c.default_robot_code || ''
    dingtalkReceiveEnabled.value = !!c.receive_enabled
    dingtalkVoiceReplyEnabled.value = !!c.voice_reply_enabled
  }
  const status = await dingtalkApi()?.receiveStatus?.()
  if (status) {
    dingtalkRunning.value = !!status.running
    dingtalkError.value = status.error || ''
  }
  dingtalkStatusLoaded.value = true
}

async function saveDingtalk() {
  if (!dingtalkApi()) return
  dingtalkSaving.value = true
  dingtalkResult.value = null
  try {
    await dingtalkApi().setConfig?.({
      app_key: dingtalkAppKey.value?.trim() || '',
      app_secret: dingtalkAppSecret.value?.trim() || '',
      default_chat_id: (dingtalkDefaultChatId.value || '').trim(),
      default_robot_code: (dingtalkDefaultRobotCode.value || '').trim(),
      receive_enabled: dingtalkReceiveEnabled.value,
      voice_reply_enabled: dingtalkVoiceReplyEnabled.value
    })
    await loadDingtalkConfig()
    dingtalkResult.value = { ok: true, message: t('notify.saved') }
  } catch (e) {
    dingtalkResult.value = { ok: false, message: e?.message || t('notify.saveFailed') }
  } finally {
    dingtalkSaving.value = false
  }
}

let saveDingtalkDebounceTimer = null
function saveDingtalkDebounced() {
  clearTimeout(saveDingtalkDebounceTimer)
  saveDingtalkDebounceTimer = setTimeout(saveDingtalk, 400)
}

async function saveConfig() {
  if (!api()) return
  saving.value = true
  result.value = null
  try {
    const res = await api().setConfig({
      app_id: appId.value?.trim() || '',
      app_secret: appSecret.value?.trim() || '',
      default_chat_id: defaultChatIdTrimmed.value,
      notify_on_complete: notifyOnComplete.value,
      receive_enabled: receiveEnabled.value
    })
    if (res?.success) {
      result.value = { ok: true, message: t('notify.saved') }
    } else {
      result.value = { ok: false, message: res?.message || t('notify.saveFailed') }
    }
  } finally {
    saving.value = false
  }
}

let saveDebounceTimer = null
function saveConfigDebounced() {
  clearTimeout(saveDebounceTimer)
  saveDebounceTimer = setTimeout(saveConfig, 400)
}

async function sendTest() {
  const chatId = sendTestChatId.value
  if (!api() || !chatId) return
  sending.value = true
  result.value = null
  try {
    const res = await api().sendMessage({
      chat_id: chatId,
      text: t('notify.testMessage')
    })
    result.value = { ok: !!res?.success, message: res?.message || (res?.success ? t('notify.sendOk') : t('notify.sendFailed')) }
  } catch (e) {
    result.value = { ok: false, message: e?.message || t('notify.sendFailed') }
  } finally {
    sending.value = false
  }
}

async function toggleReceive() {
  if (!api()) return
  receiveStarting.value = true
  receiveError.value = ''
  try {
    if (receiveRunning.value) {
      await api().receiveStop()
      receiveRunning.value = false
      // 断开时持久化状态，下次启动不再自动连接
      await api().setConfig({ receive_enabled: false })
      receiveEnabled.value = false
    } else {
      const res = await api().receiveStart()
      receiveRunning.value = !!res?.running
      if (res?.error) receiveError.value = res.error
      else if (res?.running) {
        // 连接成功时持久化状态，下次启动自动连接
        await api().setConfig({ receive_enabled: true })
        receiveEnabled.value = true
      }
    }
  } catch (e) {
    receiveError.value = e?.message || t('notify.connectFailed')
  } finally {
    receiveStarting.value = false
  }
}

onMounted(() => {
  loadConfig()
  loadTelegramConfig()
  loadDingtalkConfig()
})
</script>

<style scoped>
.feishu-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: var(--ou-bg-main);
  color: var(--ou-text);
  padding: 20px 24px;
  gap: 24px;
}

.feishu-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ou-border);
}

.feishu-desc {
  font-size: 12px;
  color: var(--ou-text-muted);
  margin: 0;
}

.notify-platform-tabs {
  display: flex;
  gap: 4px;
}
.notify-tab {
  padding: 6px 14px;
  border: 1px solid var(--ou-border);
  border-radius: 6px;
  background: var(--ou-bg-hover);
  color: var(--ou-text-muted);
  font-size: 12px;
  cursor: pointer;
}
.notify-tab:hover { color: var(--ou-text); }
.notify-tab.active {
  background: color-mix(in srgb, var(--ou-primary) 25%, transparent);
  border-color: color-mix(in srgb, var(--ou-primary) 45%, transparent);
  color: var(--ou-link);
}

.telegram-desc { font-size: 12px; color: var(--ou-text-muted); margin: 0 0 12px 0; }
.telegram-desc code { font-size: 11px; color: var(--ou-link); padding: 0 4px; }
.dingtalk-desc { font-size: 12px; color: var(--ou-text-muted); margin: 0 0 12px 0; }
.feishu-result.err-inline { margin-left: 8px; }

.notify-placeholder { margin-top: 8px; }
.notify-placeholder-text { font-size: 12px; color: var(--ou-text-muted); margin: 0; }

.feishu-tip {
  font-size: 12px;
  color: var(--ou-text);
  background: color-mix(in srgb, var(--ou-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ou-warning) 35%, transparent);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 16px;
}
.feishu-tip strong { color: var(--ou-warning); }

.feishu-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.feishu-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
  margin: 0;
}

.feishu-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.feishu-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.feishu-row label {
  font-size: 12px;
  color: var(--ou-text-muted);
}
.feishu-row-check { margin-top: 4px; }
.feishu-check-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ou-text);
  cursor: pointer;
}
.feishu-check-label input[type="checkbox"] { cursor: pointer; }
.feishu-check-label code { font-size: 11px; color: var(--ou-link); padding: 0 4px; }

.feishu-input {
  max-width: 420px;
  padding: 8px 12px;
  border: 1px solid var(--ou-border);
  border-radius: 5px;
  background: var(--ou-bg-hover);
  color: var(--ou-text);
  font-size: 12px;
}
.feishu-input::placeholder { color: var(--ou-text-muted); }
.feishu-input:focus {
  outline: none;
  border-color: var(--ou-primary);
}

.feishu-actions {
  display: flex;
  gap: 8px;
}

.feishu-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--ou-border);
  border-radius: 5px;
  background: var(--ou-bg-hover);
  color: var(--ou-text);
  font-size: 12px;
  cursor: pointer;
}
.feishu-btn.primary {
  background: color-mix(in srgb, var(--ou-primary) 35%, transparent);
  border-color: var(--ou-primary);
  color: var(--ou-link);
}
.feishu-btn.primary:hover:not(:disabled),
.feishu-btn:hover:not(:disabled) { opacity: 0.9; }
.feishu-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.feishu-result {
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 5px;
}
.feishu-result.ok { background: color-mix(in srgb, var(--ou-success) 15%, transparent); color: var(--ou-success); border: 1px solid color-mix(in srgb, var(--ou-success) 30%, transparent); }
.feishu-result.err { background: color-mix(in srgb, var(--ou-error) 15%, transparent); color: var(--ou-error); border: 1px solid color-mix(in srgb, var(--ou-error) 30%, transparent); }
.feishu-err-hint { display: block; margin-top: 6px; font-size: 11px; opacity: 0.9; }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
