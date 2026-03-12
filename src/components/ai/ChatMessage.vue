<template>
  <!-- 用户消息（右侧） -->
  <div v-if="message.role === 'user'" class="user-row">
    <div class="chat-bubble user">
      <div class="bubble-avatar user-avatar"><User :size="14" /></div>
      <div class="bubble-body">
        <div class="bubble-name">{{ t('chatMessage.me') }}</div>
        <div class="bubble-text user-text">{{ message.content }}</div>
      </div>
    </div>
  </div>

  <!-- assistant：拆分为文字块 + 工具调用块 -->
  <template v-else-if="message.role === 'assistant'">
    <div
      v-for="tc in toolCallsToRender"
      :key="tc.id"
      class="tool-card"
      :class="tcStatus(tc)"
    >
      <div class="tc-header" @click="tc._expanded = !tc._expanded">
        <div class="tc-left">
          <div class="tc-status-dot"></div>
          <component :is="toolIcon(tc.name)" :size="12" class="tc-type-icon" />
          <span class="tc-name">{{ toolLabel(tc.name) }}</span>
          <!-- 执行命令时始终在标题行显示命令内容，执行过程中也能看到 -->
          <span v-if="tc.name === 'execute_command' && (commandOf(tc) || cwdOf(tc))" class="tc-summary-text tc-command-inline">
            <code v-if="commandOf(tc)" class="tc-cmd-inline">{{ commandOf(tc) }}</code>
            <span v-if="cwdOf(tc)" class="tc-cwd-inline"> ({{ cwdOf(tc) }})</span>
          </span>
          <span v-else class="tc-summary-text">{{ toolSummary(tc) }}</span>
        </div>
        <div class="tc-right">
          <span v-if="tc.name === 'execute_command'" class="tc-metrics-compact">
            {{ elapsedSecondsOf(tc) }}s / {{ timeoutSecondsOf(tc) }}s
          </span>
          <span v-if="isToolRunning(tc)" class="tc-spinner"></span>
          <template v-else>
            <span class="tc-result-badge" :class="tcResultClass(tc)">{{ tcResultText(tc) }}</span>
            <ChevronRight :size="11" class="tc-chevron" :class="{ rotated: tc._expanded }" />
          </template>
        </div>
      </div>
      <!-- 展开详情：执行中也可展开看命令；有 result 时显示截图或输出 -->
      <div v-if="tc._expanded && (tc.result || tc.name === 'execute_command')" class="tc-detail">
        <template v-if="tc.result && screenshotFromResult(tc.result)">
          <img
            v-if="screenshotFromResult(tc.result).url"
            class="chat-image tc-screenshot"
            :src="screenshotFromResult(tc.result).url"
            :alt="t('chatMessage.screenshot')"
          />
          <img
            v-else-if="screenshotFromResult(tc.result).base64"
            class="chat-image tc-screenshot"
            :src="'data:image/png;base64,' + screenshotFromResult(tc.result).base64"
            :alt="t('chatMessage.screenshot')"
          />
        </template>
        <div v-if="tc.name === 'execute_command'" class="tc-command-meta">
          <div class="tc-command-line" v-if="commandOf(tc)">
            <span class="tc-command-label">{{ t('chatMessage.command') }}</span>
            <code class="tc-command-code">{{ commandOf(tc) }}</code>
          </div>
          <div class="tc-command-line" v-if="cwdOf(tc)">
            <span class="tc-command-label">{{ t('chatMessage.cwd') }}</span>
            <code class="tc-command-code">{{ cwdOf(tc) }}</code>
          </div>
          <div class="tc-command-line">
            <span class="tc-command-label">{{ t('chatMessage.timeout') }}</span>
            <code class="tc-command-code">{{ timeoutSecondsOf(tc) }}s</code>
          </div>
          <div class="tc-command-line">
            <span class="tc-command-label">{{ t('chatMessage.elapsed') }}</span>
            <code class="tc-command-code">{{ elapsedSecondsOf(tc) }}s</code>
          </div>
        </div>
        <template v-if="tc.name === 'execute_command'">
          <pre v-if="tc.result" class="tc-pre">{{ formatResult(tc.result, tc.name) }}</pre>
          <pre v-else class="tc-pre tc-running">{{ t('chatMessage.running') }}</pre>
        </template>
        <pre v-else-if="tc.result" class="tc-pre">{{ formatResult(tc.result, tc.name) }}</pre>
      </div>
    </div>

    <!-- 本条消息中的截图直接展示在列表里（不依赖展开） -->
    <div v-if="screenshotsInMessage.length" class="message-screenshots">
      <img
        v-for="(src, idx) in screenshotsInMessage"
        :key="idx"
        class="chat-image message-screenshot-img"
        :src="src"
        :alt="t('chatMessage.screenshot')"
      />
    </div>

    <!-- AI 文字回复（有内容才显示） -->
    <div v-if="message.content?.trim()" class="chat-bubble assistant">
      <div class="bubble-avatar ai-avatar"><img :src="logoUrl" :alt="agentDisplayName || 'Ultron'" class="avatar-logo" /></div>
      <div class="bubble-body">
        <div class="bubble-name">
          {{ agentDisplayName || 'Ultron' }}
          <button class="copy-btn" :class="{ copied }" @click="copyContent" :title="copied ? t('chatMessage.copied') : t('chatMessage.copy')">
            <Check v-if="copied" :size="11" />
            <Copy v-else :size="11" />
          </button>
        </div>
        <!-- 思维链（<think> 块） -->
        <div v-if="thinkContent" class="think-block">
          <div class="think-header" @click="thinkExpanded = !thinkExpanded">
            <ChevronRight :size="12" class="think-chevron" :class="{ rotated: thinkExpanded }" />
            <span>{{ t('chatMessage.thinkingProcess') }}</span>
          </div>
          <div v-if="thinkExpanded" class="think-body" v-html="renderThink(thinkContent)"></div>
        </div>
        <div v-if="mainContent" class="bubble-text ai-text" @click="onBubbleLinkClick" v-html="renderedContent"></div>
      </div>
    </div>
  </template>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { User, Wrench, ChevronRight, Terminal, GitBranch, FileText, Shield, Search, CheckCircle, XCircle, Copy, Check } from 'lucide-vue-next'
import { useLogoUrl } from '../../composables/useLogoUrl.js'
import { useI18n } from '../../composables/useI18n'

const logoUrl = useLogoUrl()
const { t } = useI18n()
const MAX_VISIBLE_TOOL_CALLS = 8
const props = defineProps({
  message: { type: Object, required: true },
  agentDisplayName: { type: String, default: '' }
})

const copied = ref(false)
const thinkExpanded = ref(false)
const nowMs = ref(Date.now())
let nowTimer = null

onMounted(() => {
  nowTimer = setInterval(() => { nowMs.value = Date.now() }, 1000)
})

onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer)
  nowTimer = null
})

const copyContent = async () => {
  try {
    await navigator.clipboard.writeText(props.message.content || '')
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* ignore */ }
}

// 点击消息中的链接时在新标签页打开（应用内 BrowserTab）
function onBubbleLinkClick(e) {
  // 点击截图：在 Finder 中显示文件
  const img = e.target?.closest?.('img.chat-image')
  if (img) {
    const src = img.getAttribute('src') || ''
    if (src.startsWith('file://')) {
      const filePath = src.replace('file://', '')
      try { window.electronAPI?.openInFinder?.({ path: filePath }) } catch { /* ignore */ }
    } else if (src.startsWith('local-resource://')) {
      try { window.electronAPI?.openInFinder?.({ path: src }) } catch { /* ignore */ }
    }
    return
  }
  const a = e.target?.closest?.('a.chat-link')
  if (!a || !a.href) return
  e.preventDefault()
  const url = a.getAttribute('href') || a.href
  if (url && url.startsWith('http')) {
    try {
      window.electronAPI?.openUrlInNewTab?.(url)
    } catch { /* ignore */ }
  }
}

// 从 content 中拆分出 <think>...</think> 思维链和正文
const splitContent = computed(() => {
  const raw = (props.message.content || '').trim()
  // 支持多个 <think> 块，全部收集到 thinkContent，剩余为 mainContent
  let thinkParts = []
  let main = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => {
    thinkParts.push(inner.trim())
    return ''
  }).trim()
  return { thinkContent: thinkParts.join('\n\n'), mainContent: main }
})

const thinkContent = computed(() => splitContent.value.thinkContent)
const mainContent = computed(() => splitContent.value.mainContent)

const toolCallsAll = computed(() => props.message.toolCalls || [])

const showAllToolCalls = ref(false)

const toolCallsToRender = computed(() => {
  const list = toolCallsAll.value
  if (showAllToolCalls.value || list.length <= MAX_VISIBLE_TOOL_CALLS) return list
  const start = Math.max(0, list.length - MAX_VISIBLE_TOOL_CALLS)
  return list.slice(start)
})

const hiddenToolCallCount = computed(() => {
  const list = toolCallsAll.value
  if (showAllToolCalls.value || list.length <= MAX_VISIBLE_TOOL_CALLS) return 0
  return list.length - MAX_VISIBLE_TOOL_CALLS
})

const toolIcon = (name) => {
  const map = { execute_command: Terminal, git_operation: GitBranch, file_operation: FileText, analyze_project: Search, user_confirmation: Shield }
  return map[name] || Wrench
}

const toolLabel = (name) => {
  const map = {
    execute_command: t('chatMessage.executeCommand'),
    git_operation: t('chatMessage.gitOperation'),
    file_operation: t('chatMessage.fileOperation'),
    analyze_project: t('chatMessage.analyzeProject'),
    user_confirmation: t('chatMessage.requestConfirmation'),
    webview_control: t('chatMessage.browser'),
    feishu_send_message: t('chatMessage.feishuSend')
  }
  return map[name] || name
}

const toolSummary = (tc) => {
  try {
    const args = JSON.parse(tc.arguments)
    if (tc.name === 'execute_command') {
      const cmd = args.command || ''
      return cmd.length > 100 ? cmd.substring(0, 100) + '…' : cmd
    }
    if (tc.name === 'git_operation') {
      return `git ${args.operation}${args.branch ? ' ' + args.branch : ''}`
    }
    if (tc.name === 'file_operation') {
      const fname = (args.path || '').split('/').pop()
      return `${args.action} ${fname}`
    }
    if (tc.name === 'analyze_project') {
      return (args.projectPath || args.project_path || '').split('/').pop()
    }
    if (tc.name === 'user_confirmation') {
      return args.message || t('chatMessage.requestConfirm')
    }
    if (tc.name === 'webview_control') {
      const a = args.action || ''
      if (a === 'take_screenshot') return t('chatMessage.capture')
      if (a === 'navigate') return (args.url || '').slice(0, 40) + (args.url?.length > 40 ? '…' : '')
      return a || t('chatMessage.action')
    }
    if (tc.name === 'feishu_send_message') return args.text ? t('chatMessage.sendText') : args.image_base64 || args.image_key ? t('chatMessage.sendImage') : args.file_key || args.file_path ? t('chatMessage.sendFile') : t('chatMessage.send')
    if (tc.name === 'sessions_spawn') return args.role_name ? `${t('chatMessage.childAgent')}（${args.role_name}）` : t('chatMessage.childAgent')
    return ''
  } catch {
    return ''
  }
}

const tcStatus = (tc) => {
  if (!tc.result) return 'running'
  try {
    const r = JSON.parse(tc.result)
    if (r && (r.partial === true || r.running === true)) return 'running'
    if (r.success === false || (r.exitCode !== undefined && r.exitCode !== 0)) return 'failed'
  } catch { /* ignore */ }
  return 'done'
}

const isToolRunning = (tc) => tcStatus(tc) === 'running'

const tcResultClass = (tc) => {
  return tcStatus(tc) === 'failed' ? 'badge-fail' : 'badge-ok'
}

const tcResultText = (tc) => {
  const s = tcStatus(tc)
  if (s === 'running') return t('chatMessage.running')
  return s === 'failed' ? t('chatMessage.failed') : t('chatMessage.done')
}

const commandOf = (tc) => {
  try {
    const args = JSON.parse(tc.arguments)
    return args.command || ''
  } catch {
    return ''
  }
}

const cwdOf = (tc) => {
  try {
    const args = JSON.parse(tc.arguments)
    return args.cwd || ''
  } catch {
    return ''
  }
}

const timeoutMsOf = (tc) => {
  const normalize = (val) => {
    const n = Number(val)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.min(600000, Math.max(1000, Math.floor(n)))
  }
  try {
    const obj = tc.result ? JSON.parse(tc.result) : null
    const t = normalize(obj?.timeout)
    if (t != null) return t
  } catch { /* ignore */ }
  try {
    const args = JSON.parse(tc.arguments)
    const t = normalize(args?.timeout)
    if (t != null) return t
  } catch { /* ignore */ }
  return 600000
}

const elapsedSecondsOf = (tc) => {
  const start = Number(tc?._startedAt || 0)
  if (!start) return 0
  const end = Number(tc?._endedAt || nowMs.value)
  return Math.max(0, Math.floor((end - start) / 1000))
}

const timeoutSecondsOf = (tc) => Math.max(1, Math.floor(timeoutMsOf(tc) / 1000))

const formatResult = (resultStr, toolName) => {
  try {
    const obj = JSON.parse(resultStr)
    if (obj.stdout !== undefined || obj.stderr !== undefined || obj.exitCode !== undefined) {
      let header = ''
      if (toolName === 'execute_command') {
        if (obj.command) header += `$ ${obj.command}\n`
        if (obj.cwd) header += `(cwd: ${obj.cwd})\n`
        if (obj.exitCode !== undefined) header += `(exitCode: ${obj.exitCode})\n`
        if (header) header += '\n'
      }
      let out = obj.stdout || ''
      if (obj.stderr) out += (out ? '\n' : '') + obj.stderr
      if (!out) out = obj.success !== false ? t('chatMessage.successNoOutput') : t('chatMessage.failedWithCode', { exitCode: obj.exitCode })
      return header + out
    }
    return JSON.stringify(obj, null, 2)
  } catch {
    return resultStr
  }
}

// 本条 assistant 消息中所有 take_screenshot 的图片 URL/base64，用于在列表里直接展示
const screenshotsInMessage = computed(() => {
  const list = []
  const toolCalls = props.message.toolCalls || []
  for (const tc of toolCalls) {
    const info = screenshotFromResult(tc.result)
    if (info?.url) list.push(info.url)
    else if (info?.base64) list.push('data:image/png;base64,' + info.base64)
  }
  return list
})

// take_screenshot 类工具结果：提取 file_url 或 image_base64 用于在会话中展示截图（支持被截断的 JSON）
function screenshotFromResult(resultStr) {
  if (!resultStr || typeof resultStr !== 'string') return null
  try {
    const obj = JSON.parse(resultStr)
    if (!obj || typeof obj !== 'object') return null
    const url = obj.file_url
    if (url && typeof url === 'string' && (url.startsWith('local-resource://screenshots/') || url.startsWith('http'))) {
      return { url }
    }
    if (obj.image_base64 && typeof obj.image_base64 === 'string') {
      return { base64: obj.image_base64 }
    }
    return null
  } catch {
    const urlMatch = resultStr.match(/"file_url"\s*:\s*"(local-resource:\/\/screenshots\/[^"]+)"/)
    if (urlMatch) return { url: urlMatch[1] }
    return null
  }
}

// Markdown 渲染（公共函数，供正文和思维链复用）
const renderMarkdown = (raw) => {
  let text = raw.trim()
  if (!text) return ''

  // 图片语法先提取（在 HTML 转义之前），避免 URL 中的 & 被转义
  const imagePlaceholders = []
  text = text.replace(/!\[([^\]]*)\]\(((https?|file|local-resource):\/\/[^)]+)\)/g, (_, alt, url) => {
    const idx = imagePlaceholders.length
    imagePlaceholders.push({ alt, url })
    return `__IMG_PLACEHOLDER_${idx}__`
  })

  // 链接 [text](url) 先提取，避免被转义；渲染为可点击，点击在新标签页打开
  const linkPlaceholders = []
  text = text.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    const idx = linkPlaceholders.length
    linkPlaceholders.push({ label: label.trim(), url })
    return `__LINK_PLACEHOLDER_${idx}__`
  })

  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="code-block"><code class="lang-${lang}">${code.trim()}</code></pre>`
  })
  text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
  text = text.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>')
  text = text.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>')
  text = text.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>')
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/^&gt; (.+)$/gm, '<div class="md-blockquote">$1</div>')
  text = text.replace(/^[*-] (.+)$/gm, '<div class="md-list-item"><span class="md-bullet">•</span>$1</div>')
  text = text.replace(/^\d+\. (.+)$/gm, '<div class="md-list-item md-ordered">$1</div>')
  text = text.replace(/^---$/gm, '<hr class="md-hr">')
  text = text.replace(/\n+(<(?:div|pre|hr)\b)/g, '$1')
  text = text.replace(/((?:<\/div>|<\/pre>|<hr[^>]*>))\n+/g, '$1')
  text = text.replace(/\n{2,}/g, '<br>')
  text = text.replace(/\n/g, '<br>')

  // 还原图片占位符为 <img> 标签
  if (imagePlaceholders.length) {
    text = text.replace(/__IMG_PLACEHOLDER_(\d+)__/g, (_, idx) => {
      const { alt, url } = imagePlaceholders[parseInt(idx)]
      return `<img class="chat-image" src="${url}" alt="${alt}" title="${alt}" />`
    })
  }

  // 还原链接占位符为可点击 <a>（新标签页打开）
  if (linkPlaceholders.length) {
    const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    text = text.replace(/__LINK_PLACEHOLDER_(\d+)__/g, (_, idx) => {
      const { label, url } = linkPlaceholders[parseInt(idx)]
      const safeUrl = escapeAttr(url)
      const safeLabel = escapeAttr(label) || safeUrl
      return `<a class="chat-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`
    })
  }

  // 纯 URL 文本（如「链接：http://...」）也转为可点击（URL 中可能已含 &amp;）
  text = text.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (_, before, url) => {
    const href = url.replace(/&amp;/g, '&')
    const safe = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `${before}<a class="chat-link" href="${safe}" target="_blank" rel="noopener noreferrer">${url}</a>`
  })

  return text
}

const renderedContent = computed(() => renderMarkdown(mainContent.value))
const renderThink = (text) => renderMarkdown(text)
</script>

<style scoped>
/* ── 气泡（用户 & AI 文字）── */
.user-row {
  display: flex;
  justify-content: flex-end;
  padding: 2px 0;
  margin-right: 12px;
}
.user-row .chat-bubble.user {
  flex-direction: row-reverse;
  max-width: 85%;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ou-primary) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--ou-primary) 30%, transparent);
}
.chat-bubble {
  display: flex;
  gap: 10px;
  padding: 8px 16px;
}
/* ── 思维链块 ── */
.think-block {
  margin-bottom: 6px;
  border: 1px solid var(--ou-border);
  border-radius: 6px;
  overflow: hidden;
}
.think-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--ou-text-muted);
  cursor: pointer;
  background: var(--ou-bg-hover);
  user-select: none;
}
.think-header:hover { background: var(--ou-bg-hover); color: var(--ou-text); }
.think-chevron { transition: transform 0.15s; flex-shrink: 0; }
.think-chevron.rotated { transform: rotate(90deg); }
.think-body {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--ou-text-muted);
  border-top: 1px solid var(--ou-border);
  background: var(--ou-bg-hover);
  line-height: 1.6;
  max-height: 300px;
  overflow-y: auto;
}
.bubble-avatar {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ou-accent-fg);
  margin-top: 2px;
}
.user-avatar { background: var(--ou-primary); }
.ai-avatar   { background: transparent; }
.ai-avatar .avatar-logo { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.bubble-body { flex: 1; min-width: 0; }
.bubble-name {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  margin-bottom: 3px;
}
.chat-bubble.user .bubble-name  { color: var(--ou-link); }
.chat-bubble.assistant .bubble-name { color: var(--ou-success); }
.bubble-name {
  display: flex;
  align-items: center;
  gap: 6px;
}
.copy-btn {
  opacity: 0;
  background: transparent;
  border: none;
  color: var(--ou-text-muted);
  cursor: pointer;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  transition: all 0.15s;
  padding: 0;
}
.chat-bubble.assistant:hover .copy-btn { opacity: 1; }
.copy-btn:hover { background: var(--ou-bg-hover); color: var(--ou-text); }
.copy-btn:has(> svg[data-lucide="check"]) { opacity: 1; color: var(--ou-success); }
.copy-btn.copied { opacity: 1; color: var(--ou-success); }
.bubble-text {
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
  color: var(--ou-text);
}
.user-text { color: var(--ou-text); }

/* ── 工具调用卡片 ── */
.tool-card {
  margin: 3px 16px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-hover);
  transition: border-color 0.2s;
}
.tool-card.running { border-color: color-mix(in srgb, var(--ou-warning) 30%, transparent); background: color-mix(in srgb, var(--ou-warning) 8%, transparent); }
.tool-card.done    { border-color: color-mix(in srgb, var(--ou-success) 25%, transparent); background: color-mix(in srgb, var(--ou-success) 6%, transparent); }
.tool-card.failed  { border-color: color-mix(in srgb, var(--ou-error) 30%, transparent); background: color-mix(in srgb, var(--ou-error) 8%, transparent); }

.tc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  gap: 8px;
}
.tc-header:hover { background: var(--ou-bg-hover); }
.tc-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.tc-right {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.tc-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tool-card.running .tc-status-dot { background: var(--ou-warning); animation: pulse 1.2s ease-in-out infinite; }
.tool-card.done    .tc-status-dot { background: var(--ou-success); }
.tool-card.failed  .tc-status-dot { background: var(--ou-error); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

.tc-type-icon { color: var(--ou-text-muted); flex-shrink: 0; }
.tool-card.running .tc-type-icon { color: var(--ou-warning); }
.tool-card.done    .tc-type-icon { color: var(--ou-success); }
.tool-card.failed  .tc-type-icon { color: var(--ou-error); }

.tc-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--ou-text-muted);
  flex-shrink: 0;
}
.tool-card.running .tc-name { color: var(--ou-warning); }
.tool-card.done    .tc-name { color: var(--ou-success); }
.tool-card.failed  .tc-name { color: var(--ou-error); }

.tc-summary-text {
  font-size: 11px;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  color: var(--ou-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tc-command-inline {
  white-space: pre-wrap;
  word-break: break-all;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
}
.tc-command-inline .tc-cmd-inline { color: var(--ou-text); }
.tc-command-inline .tc-cwd-inline { color: var(--ou-text-muted); font-size: 10px; }
.tc-metrics-compact {
  font-size: 10px;
  color: var(--ou-text-muted);
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
}

.tc-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid color-mix(in srgb, var(--ou-warning) 40%, transparent);
  border-top-color: var(--ou-warning);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.tc-result-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
}
.badge-ok   { background: color-mix(in srgb, var(--ou-success) 18%, transparent); color: var(--ou-success); }
.badge-fail { background: color-mix(in srgb, var(--ou-error) 18%, transparent);  color: var(--ou-error); }

.tc-chevron { color: var(--ou-text-muted); transition: transform 0.15s; flex-shrink: 0; }
.tc-chevron.rotated { transform: rotate(90deg); }

/* 展开详情 */
.tc-detail { border-top: 1px solid var(--ou-border); padding-top: 8px; }
.tc-screenshot { max-width: 100%; height: auto; border-radius: 6px; display: block; margin-bottom: 8px; }
.message-screenshots { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.message-screenshot-img { max-width: 100%; max-height: 320px; width: auto; height: auto; border-radius: 8px; object-fit: contain; cursor: pointer; }
.tc-command-meta {
  margin: 0 0 6px 0;
  padding: 6px 8px;
  border: 1px solid var(--ou-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ou-bg-hover) 70%, transparent);
}
.tc-command-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 2px 0;
}
.tc-command-label {
  font-size: 10px;
  color: var(--ou-text-muted);
  min-width: 40px;
}
.tc-command-code {
  font-size: 10px;
  line-height: 1.35;
  color: var(--ou-text);
  background: transparent;
  padding: 0;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  word-break: break-all;
}
.tc-pre {
  margin: 0;
  padding: 8px 12px;
  background: var(--ou-code-bg);
  font-size: 11px;
  color: var(--ou-text-muted);
  overflow-x: auto;
  max-height: 240px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  line-height: 1.5;
}
.tc-pre.tc-running { color: var(--ou-warning); }

/* ── Markdown ── */
.bubble-text :deep(.code-block) {
  background: var(--ou-code-bg);
  border: 1px solid var(--ou-code-border);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 6px 0;
  overflow-x: auto;
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  line-height: 1.5;
  color: var(--ou-text);
}
.bubble-text :deep(.inline-code) {
  background: var(--ou-bg-hover);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  color: var(--ou-warning);
}
.bubble-text :deep(.chat-link) {
  color: var(--ou-link);
  text-decoration: none;
  cursor: pointer;
}
.bubble-text :deep(.chat-link:hover) {
  text-decoration: underline;
}
.bubble-text :deep(.md-h1) { font-size: 16px; font-weight: 700; color: var(--ou-text); margin: 12px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--ou-border); }
.bubble-text :deep(.md-h2) { font-size: 14px; font-weight: 600; color: var(--ou-text); margin: 10px 0 5px; }
.bubble-text :deep(.md-h3) { font-size: 13px; font-weight: 600; color: var(--ou-text); margin: 8px 0 4px; }
.bubble-text :deep(.md-blockquote) { border-left: 3px solid var(--ou-border); padding: 2px 0 2px 10px; margin: 3px 0; color: var(--ou-text-muted); font-style: italic; }
.bubble-text :deep(.md-list-item)  { display: flex; gap: 6px; padding: 1px 0; line-height: 1.6; }
.bubble-text :deep(.md-bullet)     { color: var(--ou-text-muted); flex-shrink: 0; width: 12px; text-align: center; }
.bubble-text :deep(.md-list-item.md-ordered) { padding-left: 18px; }
.bubble-text :deep(.md-hr)  { border: none; border-top: 1px solid var(--ou-border); margin: 6px 0; }
.bubble-text :deep(strong)  { color: var(--ou-text); font-weight: 600; }

/* ── 聊天内联图片 ── */
.bubble-text :deep(.chat-image) {
  max-width: 100%;
  max-height: 400px;
  border-radius: 8px;
  cursor: pointer;
  cursor: zoom-in;
  display: block;
  margin: 8px 0;
  object-fit: contain;
  border: 1px solid var(--ou-border);
  transition: opacity 0.15s;
}
.bubble-text :deep(.chat-image):hover { opacity: 0.9; }
</style>
