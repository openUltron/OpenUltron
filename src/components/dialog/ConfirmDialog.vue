<template>
  <Teleport to="body">
    <div v-if="visible" class="confirm-dialog-overlay" @click.self="handleCancel">
      <div class="confirm-dialog">
        <div class="confirm-dialog-header">
          <span class="confirm-icon" :class="type">
            <span v-if="type === 'warning'">⚠️</span>
            <span v-else-if="type === 'danger'">🗑️</span>
            <span v-else-if="type === 'info'">ℹ️</span>
            <span v-else>❓</span>
          </span>
          <h3>{{ title }}</h3>
        </div>
        <div class="confirm-dialog-body">
          <p class="confirm-message">{{ message }}</p>
          <p v-if="detail" class="confirm-detail">{{ detail }}</p>
        </div>
        <div class="confirm-dialog-footer">
          <button class="btn-cancel" @click="handleCancel">
            {{ cancelText }}
          </button>
          <button class="btn-confirm" :class="type" @click="handleConfirm">
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from '../../composables/useI18n.js'

const { t } = useI18n()

const visible = ref(false)
const title = ref(t('dialog.confirm'))
const message = ref('')
const detail = ref('')
const type = ref('warning') // warning, danger, info
const confirmText = ref(t('dialog.ok'))
const cancelText = ref(t('dialog.cancel'))

let resolvePromise = null

const show = (options) => {
  return new Promise((resolve) => {
    title.value = options.title || t('dialog.confirm')
    message.value = options.message || ''
    detail.value = options.detail || ''
    type.value = options.type || 'warning'
    confirmText.value = options.confirmText || t('dialog.ok')
    cancelText.value = options.cancelText || t('dialog.cancel')
    visible.value = true
    resolvePromise = resolve
  })
}

const handleConfirm = () => {
  visible.value = false
  if (resolvePromise) {
    resolvePromise(true)
    resolvePromise = null
  }
}

const handleCancel = () => {
  visible.value = false
  if (resolvePromise) {
    resolvePromise(false)
    resolvePromise = null
  }
}

defineExpose({ show })
</script>

<style scoped>
.confirm-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--ou-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.15s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.confirm-dialog {
  background: var(--ou-bg-card);
  border-radius: 12px;
  box-shadow: 0 8px 32px var(--ou-shadow);
  min-width: 360px;
  max-width: 480px;
  animation: slideIn 0.2s ease-out;
  border: 1px solid var(--ou-border);
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(-10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.confirm-dialog-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px 12px;
}

.confirm-icon {
  font-size: 24px;
}

.confirm-dialog-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--ou-text);
}

.confirm-dialog-body {
  padding: 8px 24px 20px;
}

.confirm-message {
  margin: 0;
  font-size: 14px;
  color: var(--ou-text);
  line-height: 1.6;
}

.confirm-detail {
  margin: 12px 0 0;
  padding: 12px;
  background: var(--ou-bg-hover);
  border-radius: 6px;
  font-size: 13px;
  color: var(--ou-text-muted);
  font-family: 'Monaco', 'Menlo', monospace;
  word-break: break-all;
}

.confirm-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--ou-border);
}

.btn-cancel,
.btn-confirm {
  padding: 10px 20px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.btn-cancel {
  background: var(--ou-bg-hover);
  color: var(--ou-text);
}

.btn-cancel:hover {
  background: var(--ou-border);
  color: var(--ou-text);
}

.btn-confirm {
  background: var(--ou-primary);
  color: var(--ou-accent-fg);
}

.btn-confirm:hover {
  background: var(--ou-primary-hover);
}

.btn-confirm.danger {
  background: var(--ou-error);
}

.btn-confirm.danger:hover {
  opacity: 0.9;
}

.btn-confirm.warning {
  background: var(--ou-warning);
  color: var(--ou-bg-main);
}

.btn-confirm.warning:hover {
  opacity: 0.9;
}
</style>
