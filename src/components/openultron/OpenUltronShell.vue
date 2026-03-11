<template>
  <div class="openultron-shell" :class="themeClass">
    <!-- 仅 Electron：预留系统窗口控制区 + 拖拽区域（浏览器环境不显示） -->
    <header v-if="isElectron" class="app-title-bar">
      <div class="title-bar-drag-spacer" v-if="isMac"></div>
      <div class="title-bar-drag"></div>
      <div v-if="isWin" class="title-bar-controls">
        <button type="button" class="tb-btn minimize" title="Minimize" @click="onMinimize">−</button>
        <button type="button" class="tb-btn maximize" title="Maximize / Restore" @click="onMaximize">□</button>
        <button type="button" class="tb-btn close" title="Close" @click="onClose">×</button>
      </div>
    </header>
    <div class="shell-body">
    <!-- 左侧导航 -->
    <aside class="shell-sidebar">
      <div class="sidebar-brand">
        <div class="brand-logo">
          <img :src="logoUrl" alt="OpenUltron" class="brand-logo-img" />
        </div>
        <span class="brand-name">OpenUltron</span>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-group">
          <div class="nav-group-label">{{ t('shell.groupChat') }}</div>
          <router-link to="/chat" class="nav-item" active-class="active">
            <MessageSquare :size="16" />
            <span>{{ t('shell.chat') }}</span>
          </router-link>
          <router-link to="/sessions" class="nav-item" active-class="active">
            <Radio :size="16" />
            <span>{{ t('shell.sessions') }}</span>
          </router-link>
        </div>
        <div class="nav-group">
          <div class="nav-group-label">{{ t('shell.groupControl') }}</div>
          <router-link to="/control/cron" class="nav-item" active-class="active">
            <Clock :size="16" />
            <span>{{ t('shell.cron') }}</span>
          </router-link>
        </div>
        <div class="nav-group">
          <div class="nav-group-label">Skills</div>
          <router-link to="/skills" class="nav-item" active-class="active">
            <Zap :size="16" />
            <span>Skills</span>
          </router-link>
        </div>
        <div class="nav-group">
          <div class="nav-group-label">{{ t('shell.groupSettings') }}</div>
          <router-link to="/settings/config" class="nav-item" active-class="active">
            <Settings :size="16" />
            <span>{{ t('shell.config') }}</span>
          </router-link>
          <router-link to="/settings/logs" class="nav-item" active-class="active">
            <FileText :size="16" />
            <span>{{ t('shell.logs') }}</span>
          </router-link>
        </div>
      </nav>
      <div class="sidebar-footer">
        <button class="lang-btn" :title="isEnglish ? t('shell.switchToChinese') : t('shell.switchToEnglish')" @click="toggleLocale">
          {{ isEnglish ? t('common.zh') : t('common.en') }}
        </button>
        <button class="theme-btn" :title="themeButtonTitle" @click="cycleTheme">
          <Sun v-if="effectiveTheme === 'light'" :size="18" />
          <Moon v-else :size="18" />
        </button>
        <div v-if="healthLabel" class="health-status" :class="healthStatus" :title="`${t('shell.health')} ${healthLabel}`">
          <span class="health-dot"></span>
          <span class="health-label">{{ t('shell.health') }} {{ healthLabel }}</span>
        </div>
      </div>
    </aside>
    <!-- 主内容区：聊天页用 keep-alive 缓存，切换 Skills/Sessions 等再回来时状态与流式回复不丢失 -->
    <main class="shell-main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <keep-alive :include="['ChatView']">
            <component :is="Component" />
          </keep-alive>
        </transition>
      </router-view>
    </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import {
  MessageSquare,
  Radio,
  Clock,
  Zap,
  Settings,
  FileText,
  Sun,
  Moon
} from 'lucide-vue-next'
import { useTheme } from '../../composables/useTheme.js'
import { useLogoUrl } from '../../composables/useLogoUrl.js'
import { useHealthCheck } from '../../composables/useHealthCheck.js'
import { useI18n } from '../../composables/useI18n.js'

const logoUrl = useLogoUrl()
const { status: healthStatus, label: healthLabel } = useHealthCheck()
const { t, isEnglish, toggleLocale } = useI18n()
const { theme, effectiveTheme, setTheme, cycleTheme } = useTheme()
const themeClass = computed(() => `theme-${effectiveTheme.value}`)

const isElectron = computed(() => typeof window !== 'undefined' && typeof window.electronAPI?.platform === 'string')
const isMac = computed(() => isElectron.value && window.electronAPI?.platform === 'darwin')
const isWin = computed(() => isElectron.value && (window.electronAPI?.platform === 'win32' || window.electronAPI?.platform === 'linux'))

const onMinimize = () => window.electronAPI?.windowMinimize?.()
const onMaximize = () => window.electronAPI?.toggleMaximize?.()
const onClose = () => window.electronAPI?.windowClose?.()
const themeButtonTitle = computed(() => {
  const eff = effectiveTheme.value
  return eff === 'light' ? t('shell.lightToDark') : t('shell.darkToLight')
})

onMounted(() => {
  // 主题从持久化恢复已在 useTheme 中处理
})
</script>

<style scoped>
.openultron-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  background: var(--ou-bg-main);
  color: var(--ou-text);
}

/* 顶部标题栏：预留系统窗口控制区，支持拖拽窗口 */
.app-title-bar {
  flex-shrink: 0;
  height: calc(32px + env(safe-area-inset-top, 0px));
  min-height: 32px;
  display: flex;
  align-items: stretch;
  background: var(--ou-bg-sidebar);
  border-bottom: 1px solid var(--ou-border);
  -webkit-app-region: drag;
  user-select: none;
}
.title-bar-drag-spacer {
  width: 72px;
  min-width: 72px;
  -webkit-app-region: no-drag;
}
.title-bar-drag {
  flex: 1;
  min-width: 0;
}
.title-bar-controls {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: stretch;
}
.tb-btn {
  width: 46px;
  border: none;
  background: transparent;
  color: var(--ou-text);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.tb-btn:hover {
  background: var(--ou-bg-hover);
}
.tb-btn.close:hover {
  background: #e81123;
  color: #fff;
}

.shell-body {
  flex: 1;
  min-height: 0;
  display: flex;
  width: 100%;
}

/* ── 左侧边栏 ── */
.shell-sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--ou-bg-sidebar);
  border-right: 1px solid var(--ou-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--ou-border);
}

.brand-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand-logo-img { width: 24px; height: 24px; object-fit: contain; border-radius: 6px; }

.brand-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--ou-text);
}

.sidebar-nav {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
}

.nav-group {
  margin-bottom: 8px;
}

.nav-group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ou-text-muted);
  padding: 8px 16px 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  margin: 0 8px;
  border-radius: 6px;
  color: var(--ou-text);
  text-decoration: none;
  font-size: 13px;
  transition: background 0.15s, color 0.15s;
}

.nav-item:hover {
  background: var(--ou-bg-hover);
  color: var(--ou-text);
}

.nav-item.active {
  background: var(--ou-accent);
  color: var(--ou-accent-fg);
}

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--ou-border);
  display: flex;
  align-items: center;
  gap: 8px;
}

.health-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ou-text-muted);
}
.health-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.health-status.ok .health-dot { background: #22c55e; }
.health-status.error .health-dot { background: #ef4444; }
.health-status.checking .health-dot {
  background: #eab308;
  animation: health-pulse 1s ease-in-out infinite;
}
@keyframes health-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.health-label { white-space: nowrap; }

.lang-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 46px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--ou-border);
  background: transparent;
  color: var(--ou-text);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}

.theme-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--ou-text);
  cursor: pointer;
  transition: background 0.15s;
}

.theme-btn:hover {
  background: var(--ou-bg-hover);
}
.lang-btn:hover {
  background: var(--ou-bg-hover);
}

/* ── 主内容 ──（无 padding，与侧栏分割线对齐） */
.shell-main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  box-sizing: border-box;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
