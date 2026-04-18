<template>
  <div class="chat-panel" ref="panelRef">
    <!-- Context Tokens：顶栏细条，不参与消息列表滚动 -->
    <div v-if="usageCard" class="chat-usage-strip" role="status" aria-live="polite">
      <div class="chat-usage-strip-inner">
        <span class="chat-usage-strip-label">Context Tokens</span>
        <span class="chat-usage-strip-total">≈ {{ usageCard.total.toLocaleString() }}</span>
        <span class="chat-usage-strip-sep" aria-hidden="true">·</span>
        <span class="chat-usage-strip-parts" :title="usageStripTitle">
          Active {{ usageCard.compressible.toLocaleString() }} / {{ usageCard.threshold.toLocaleString() }}
          <span class="chat-usage-strip-sep" aria-hidden="true">·</span>
          {{ usageCard.thresholdPct }}%
          <template v-if="usageCard.compression.lastSaved > 0">
            <span class="chat-usage-strip-sep" aria-hidden="true">·</span>
            Saved {{ usageCard.compression.lastSaved.toLocaleString() }}
          </template>
        </span>
        <span class="chat-usage-strip-sep" aria-hidden="true">·</span>
        <span class="chat-usage-strip-iter">#{{ usageCard.iteration }}</span>
      </div>
      <div class="chat-usage-strip-meta">
        <span class="chat-usage-meta-item" :title="`Prompt ${usageCard.systemPrompt.toLocaleString()} + Summary ${usageCard.systemSummary.toLocaleString()}`">
          System {{ usageCard.system.toLocaleString() }}
        </span>
        <span class="chat-usage-meta-item">User {{ usageCard.user.toLocaleString() }}</span>
        <span class="chat-usage-meta-item">Assistant {{ usageCard.assistant.toLocaleString() }}</span>
        <span class="chat-usage-meta-item">Tool {{ usageCard.tool.toLocaleString() }}</span>
        <span v-if="usageCard.compressionSummaryCount > 0" class="chat-usage-meta-item">
          Summary {{ usageCard.compressionSummaryCount }}
        </span>
        <span v-if="usageCard.compression.totalSaved > 0" class="chat-usage-meta-item">
          Total Saved {{ usageCard.compression.totalSaved.toLocaleString() }}
        </span>
      </div>
      <div class="chat-usage-strip-bar" aria-hidden="true">
        <span class="chat-usage-seg chat-usage-seg-sys" :style="{ width: `${usageCard.systemPromptPct}%` }" />
        <span class="chat-usage-seg chat-usage-seg-summary" :style="{ width: `${usageCard.systemSummaryPct}%` }" />
        <span class="chat-usage-seg chat-usage-seg-user" :style="{ width: `${usageCard.userPct}%` }" />
        <span class="chat-usage-seg chat-usage-seg-assistant" :style="{ width: `${usageCard.assistantPct}%` }" />
        <span class="chat-usage-seg chat-usage-seg-tool" :style="{ width: `${usageCard.toolPct}%` }" />
      </div>
    </div>
    <!-- 消息列表 -->
    <div class="chat-messages" ref="messagesRef">
      <!-- 当前会话类型：主 / 飞书 · chat_id 片段 -->
      <div v-if="sessionTypeLabel" class="chat-session-type-bar">
        <span class="chat-session-type-label">{{ sessionTypeLabel }}</span>
      </div>
      <!-- 被压缩过的会话：始终展示摘要块（若有），再展示最近几条可见对话 -->
      <div v-if="compressionSummaryText" class="chat-compression-notice">
        <div class="compression-notice-head">
          <Info :size="16" />
          <span>{{ t('chat.compressedHint') }}</span>
        </div>
        <pre class="compression-notice-body">{{ compressionSummaryText }}</pre>
      </div>
      <div v-if="displayMessages.length === 0 && !compressionSummaryText" class="chat-empty">
        <img :src="logoUrl" alt="" class="empty-icon avatar-logo-large" />
        <p>{{ t('chat.emptyWelcome', { name: agentDisplayName || 'Ultron' }) }}</p>
        <button type="button" class="chat-empty-edit-role" @click="openIdentityMd">{{ t('chat.editRole') }}</button>
        <p v-if="identityPathForHint" class="chat-empty-path-hint">{{ t('chat.nameFrom') }}{{ identityPathForHint }}</p>
      </div>
      <ChatMessage
        v-for="(msg, idx) in displayMessages"
        :key="messageRenderKey(msg, idx)"
        :message="msg"
        :agent-display-name="agentDisplayName"
        @regenerate-audio="handleRegenerateAudio"
      />
      <!-- 没有工具卡片时才显示纯思考指示器 -->
      <div v-if="isStreaming && !lastAssistantHasActivity" class="streaming-indicator">
        <Loader :size="14" class="spin" />
        <span>{{ t('chat.thinking') }}</span>
      </div>
      <!-- 用户确认对话框 -->
      <div v-if="pendingConfirm" class="confirm-dialog" :class="pendingConfirm.severity">
        <div class="confirm-icon">
          <AlertTriangle v-if="pendingConfirm.severity === 'danger'" :size="16" />
          <AlertCircle v-else-if="pendingConfirm.severity === 'warning'" :size="16" />
          <Info v-else :size="16" />
        </div>
        <div class="confirm-body">
          <div class="confirm-title">
            {{ pendingConfirm.severity === 'danger' ? t('chat.dangerConfirm') : pendingConfirm.severity === 'warning' ? t('chat.operationConfirm') : t('chat.confirm') }}
          </div>
          <div class="confirm-message">{{ pendingConfirm.message }}</div>
          <textarea
            v-if="pendingConfirm.inputDefault !== null"
            v-model="confirmInputText"
            class="confirm-input"
            rows="3"
          ></textarea>
          <div class="confirm-actions">
            <button class="confirm-btn cancel" @click="respondConfirm(false)">{{ t('chat.cancel') }}</button>
            <button
              v-if="pendingConfirm.allowPush"
              class="confirm-btn ok push"
              @click="handleConfirmPush"
            >{{ t('chat.confirmAndPush') }}</button>
            <button class="confirm-btn ok" :class="pendingConfirm.severity" @click="handleConfirmOk">{{ t('chat.confirm') }}</button>
          </div>
        </div>
      </div>
      <div v-if="error" class="chat-error">
        <AlertCircle :size="14" />
        <span class="chat-error-text">{{ error }}</span>
        <button type="button" class="chat-error-dismiss" @click="clearChatError" :title="t('chat.close')">×</button>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="chat-input-area">
      <div v-if="slashSystemPromptCheck.enabled" class="slash-prompt-check" :class="{ 'slash-prompt-check--danger': slashSystemPromptCheck.hasRisk }">
        <div class="slash-prompt-check-head">
          <AlertTriangle v-if="slashSystemPromptCheck.hasRisk" :size="14" />
          <Info v-else :size="14" />
          <span>斜杠系统提示词（{{ slashSystemPromptCheck.truncated ? '已截断' : '可发送' }}）</span>
          <span class="slash-prompt-check-length">
            {{ slashSystemPromptCheck.length }} / {{ SLASH_SYSTEM_PROMPT_MAX_LENGTH }}
          </span>
        </div>
        <pre class="slash-prompt-check-body">{{ slashSystemPromptCheck.previewText }}</pre>
        <p v-if="slashSystemPromptCheck.hasRisk || slashSystemPromptCheck.truncated || slashSystemPromptCheck.warning" class="slash-prompt-check-note">
          <template v-if="slashSystemPromptCheck.hasRisk">{{ slashSystemPromptCheck.warning }}</template>
          <template v-else-if="slashSystemPromptCheck.truncated">提示：系统提示词过长，发送时将按上限截断。</template>
          <template v-else>{{ slashSystemPromptCheck.warning }}</template>
        </p>
      </div>
      <div class="input-row">
        <!-- 斜杠命令面板 -->
        <SlashPalette
          ref="slashPaletteRef"
          :show="showSlash"
          :category="slashCategory"
          :query="slashQuery"
          :items="slashItems"
          @select="onSlashSelect"
          @back="onSlashBack"
          @close="clearSlash"
        />
        <!-- @ 文件提及面板 -->
        <MentionPalette
          ref="mentionPaletteRef"
          :show="showMention"
          :query="mentionQuery"
          :items="mentionItems"
          :loading="mentionLoading"
          @select="onMentionSelect"
          @close="clearMention"
        />
        <!-- 已选中的 @ 文件标签 + 输入行（指令标签 + textarea） -->
        <div class="textarea-wrap" @dragover="onInputDragOver" @drop="onInputDrop">
          <div v-if="mentionedFiles.length > 0" class="mention-tags">
            <span
              v-for="f in mentionedFiles"
              :key="f._key || f.path"
              class="mention-tag"
              :class="{ 'mention-tag-snippet': f.type === 'snippet' }"
            >
              <Code v-if="f.type === 'snippet'" :size="10" />
              <FileCode v-else :size="10" />
              <span>{{ f.type === 'snippet' ? `${f.name}:${f.lineStart}-${f.lineEnd}` : f.name }}</span>
              <button class="mention-tag-remove" @click="removeMentionedFile(f)">×</button>
            </span>
          </div>
          <div v-if="pendingAttachments.length > 0" class="attachment-tags">
            <span
              v-for="a in pendingAttachments"
              :key="a.id"
              class="attachment-tag"
              :class="{
                'attachment-tag-rejected': a.status === 'rejected',
                'attachment-tag-degraded': a.status === 'degraded'
              }"
            >
              <Paperclip :size="10" />
              <span>{{ a.name }}</span>
              <em>{{ formatAttachmentSize(a.size) }}</em>
              <button class="attachment-tag-remove" @click="removePendingAttachment(a.id)">×</button>
            </span>
          </div>
          <!-- 输入行：左侧技能标签 + 右侧输入框 -->
          <div class="input-inner">
            <template v-if="activeSlashSkills.length">
              <div
                v-for="s in activeSlashSkills"
                :key="s.id"
                class="slash-tag-inline slash-skill"
              >
                <Zap :size="11" />
                <span>{{ s.name }}</span>
                <button class="slash-tag-remove" @click="removeSlashSkill(s)" :title="t('chat.remove')">×</button>
              </div>
            </template>
            <div class="input-inner-field">
              <textarea
                ref="inputRef"
                v-model="inputText"
                :placeholder="hasActiveSlash ? t('chat.inputHintWithSlash') : isStreaming ? t('chat.aiReplying') : ''"
                :disabled="false"
                @keydown="onKeyDown"
                @input="onInput"
                @paste="onInputPaste"
                @compositionstart="isComposing = true"
                @compositionend="isComposing = false"
                rows="1"
              ></textarea>
              <div v-show="!inputText.trim() && !isStreaming && !hasActiveSlash" class="marquee-hint">
                {{ marqueeHint }}
              </div>
            </div>
          </div>
        </div>
        <input
          ref="fileInputRef"
          type="file"
          multiple
          class="file-input-hidden"
          @change="onFileInputChange"
        />
        <button
          v-if="!isStreaming"
          class="attach-btn"
          :title="t('chat.attach')"
          @click="openFilePicker"
        >
          <Paperclip :size="14" />
        </button>
        <!-- 发送 / 暂停共用一个位置：流式时显示暂停，否则显示发送 -->
        <button
          v-if="isStreaming"
          class="send-btn stop"
          @click="stopChat"
          :title="t('chat.stop')"
        >
          <Square :size="14" />
        </button>
        <button
          v-else
          class="send-btn"
          :disabled="!inputText.trim() && !hasActiveSlash && pendingAttachments.length === 0"
          @click="handleSend"
          :title="t('chat.send')"
        >
          <Send :size="14" />
        </button>
      </div>
    </div>
  </div>

  <!-- 大图预览 -->
  <ImageViewer
    :src="previewImageSrc"
    :alt="previewImageAlt"
    :visible="showImageViewer"
    @close="showImageViewer = false"
  />
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onActivated, onUnmounted } from 'vue'
import { Loader, AlertCircle, AlertTriangle, Info, Send, Square, Zap, FileCode, Code, Paperclip } from 'lucide-vue-next'
import ChatMessage from './ChatMessage.vue'
import SlashPalette from './SlashPalette.vue'
import MentionPalette from './MentionPalette.vue'
import ImageViewer from './ImageViewer.vue'
import { useAIChat } from '../../composables/useAIChat'
import { useLogoUrl } from '../../composables/useLogoUrl.js'
import { useI18n } from '../../composables/useI18n'
import { buildRendererSystemSupplement } from '../../shared/prompt/renderer-system-supplement.js'

const logoUrl = useLogoUrl()
const { t } = useI18n()
const props = defineProps({
  systemPrompt: { type: String, default: '' },
  model: { type: String, default: '' },
  projectPath: { type: String, default: '' },
  enableMention: { type: Boolean, default: true },  // 是否支持 @ 文件提及（非项目页面禁用）
  initialSessionId: { type: String, default: null },  // 主会话传入的当前会话 id，用于加载指定会话或与 URL 同步
  sessionTypeLabel: { type: String, default: '' },    // 当前会话类型展示（主/飞书 · chat_id 片段），由 ChatView 传入
  /** 应用工作室等：工具结果落盘后回调（如刷新左侧预览），仅非流式 chunk */
  afterToolResult: { type: Function, default: null },
  /** 沙箱应用工作室：为 true 时优先注入沙箱说明，避免全局「OpenUltron/IDENTITY」提示误导模型改错目录 */
  studioSandboxMode: { type: Boolean, default: false }
})

const emit = defineEmits(['first-message', 'model-change', 'provider-change', 'session-loaded', 'session-created'])

const studioWriteToolTouched = ref(false)
const studioRunInFlight = ref(false)

function studioHasWriteToolResult(data) {
  if (!props.studioSandboxMode) return false
  const name = String(data?.name || '')
  if (!/^(file_operation|apply_patch|execute_command)$/.test(name)) return false
  let parsed
  try {
    parsed = typeof data?.result === 'string' ? JSON.parse(data.result) : data?.result
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  if (parsed.partial === true || parsed.running === true) return false

  if (name === 'file_operation') {
    return parsed.success === true && String(parsed.action || '') === 'write'
  }
  if (name === 'apply_patch') {
    if (parsed.success === true) return true
    if (Array.isArray(parsed.results)) return parsed.results.some((r) => r && r.success === true)
    return false
  }
  if (name === 'execute_command') {
    if (parsed.success !== true) return false
    const cwd = String(parsed.cwd || '').trim()
    const root = String(props.projectPath || '').trim()
    if (!cwd || !root) return false
    const a = cwd.replace(/\\/g, '/')
    const b = root.replace(/\\/g, '/').replace(/\/+$/, '')
    return a === b || a.startsWith(`${b}/`)
  }
  return false
}

const useAIChatInstance = useAIChat({
  afterToolResult: (data) => {
    if (studioHasWriteToolResult(data)) studioWriteToolTouched.value = true
    props.afterToolResult?.(data)
  }
})
const { messages, isStreaming, error, tokenUsage, pendingConfirm, sendMessage, stopChat, loadMessages, respondConfirm } = useAIChatInstance
const seenFeishuMessageIds = new Set()
const lastFeishuSessionUpdate = new Map()
const feishuReloadPending = ref(false)
const lastGatewaySessionUpdate = new Map()
const lastGatewayRemoteUserMessage = new Map()
const FEISHU_UPDATE_DEDUPE_TTL_MS = 2500
const GATEWAY_UPDATE_DEDUPE_TTL_MS = 2500
const GATEWAY_REMOTE_USER_DEDUPE_TTL_MS = 2500

const canonicalRunTokenForFeishuUpdate = (runSessionId, runId) => {
  const raw = String(runId || runSessionId || '').trim()
  if (!raw) return ''
  const marker = '-run-'
  const idx = raw.indexOf(marker)
  if (idx < 0) return raw
  const suffix = raw.slice(idx + marker.length)
  return suffix || raw
}

const pruneFeishuSessionUpdateDedupe = (now = Date.now()) => {
  if (lastFeishuSessionUpdate.size <= 100) return
  for (const [k, ts] of lastFeishuSessionUpdate.entries()) {
    if (now - ts > FEISHU_UPDATE_DEDUPE_TTL_MS * 4) {
      lastFeishuSessionUpdate.delete(k)
    }
  }
}

const shouldProcessFeishuSessionUpdate = (data) => {
  const sessionId = String(data?.sessionId || '').trim()
  if (!sessionId) return true
  const runToken = canonicalRunTokenForFeishuUpdate(data?.runSessionId, data?.runId)
  if (!runToken) return true
  const token = `${sessionId}|${runToken}`
  const now = Date.now()
  const last = lastFeishuSessionUpdate.get(token) || 0
  if (now - last < FEISHU_UPDATE_DEDUPE_TTL_MS) return false
  lastFeishuSessionUpdate.set(token, now)
  pruneFeishuSessionUpdateDedupe(now)
  return true
}

const pruneGatewaySessionUpdateDedupe = (now = Date.now()) => {
  if (lastGatewaySessionUpdate.size <= 100) return
  for (const [k, ts] of lastGatewaySessionUpdate.entries()) {
    if (now - ts > GATEWAY_UPDATE_DEDUPE_TTL_MS * 4) {
      lastGatewaySessionUpdate.delete(k)
    }
  }
}

const shouldProcessGatewaySessionUpdate = (data) => {
  const sessionId = String(data?.sessionId || '').trim()
  if (!sessionId) return true

  const runToken = canonicalRunTokenForFeishuUpdate(data?.runSessionId, data?.runId)
  const token = runToken ? `${sessionId}|${runToken}` : `session-only|${sessionId}`
  const now = Date.now()
  const last = lastGatewaySessionUpdate.get(token) || 0
  if (now - last < GATEWAY_UPDATE_DEDUPE_TTL_MS) return false
  lastGatewaySessionUpdate.set(token, now)
  pruneGatewaySessionUpdateDedupe(now)
  return true
}

const pruneGatewayRemoteUserMessageDedupe = (now = Date.now()) => {
  if (lastGatewayRemoteUserMessage.size <= 200) return
  for (const [k, ts] of lastGatewayRemoteUserMessage.entries()) {
    if (now - ts > GATEWAY_REMOTE_USER_DEDUPE_TTL_MS * 4) {
      lastGatewayRemoteUserMessage.delete(k)
    }
  }
}

const normalizeRemoteContent = (s) => String(s || '')
  .replace(/\r/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const shouldProcessGatewayRemoteUserMessage = (data) => {
  const sessionId = String(data?.sessionId || '').trim()
  if (!sessionId) return true
  const remoteText = normalizeRemoteContent(data?.userContent || '')
  const messageId = String(data?.messageId || '').trim()
  const token = messageId
    ? `gw-msgid:${sessionId}|${messageId}`
    : `gw-content:${sessionId}|${remoteText}`
  if (!remoteText) return true
  const now = Date.now()
  const last = lastGatewayRemoteUserMessage.get(token) || 0
  if (now - last < GATEWAY_REMOTE_USER_DEDUPE_TTL_MS) return false
  lastGatewayRemoteUserMessage.set(token, now)
  pruneGatewayRemoteUserMessageDedupe(now)
  return true
}

// 带输入框的确认弹框
const confirmInputText = ref('')
watch(pendingConfirm, (val) => {
  if (val?.inputDefault !== null && val?.inputDefault !== undefined) {
    confirmInputText.value = val.inputDefault
  }
})
const handleConfirmOk = () => {
  const hasInput = pendingConfirm.value?.inputDefault !== null
  respondConfirm(true, hasInput ? confirmInputText.value : '')
}

const handleConfirmPush = () => {
  const hasInput = pendingConfirm.value?.inputDefault !== null
  respondConfirm(true, hasInput ? confirmInputText.value : '', true)
}

const lastAssistantHasActivity = computed(() => {
  const last = messages.value[messages.value.length - 1]
  if (!last || last.role !== 'assistant') return false
  return !!(last.content?.trim() || last.toolCalls?.length)
})

// 仅展示 user/assistant，且过滤掉后端注入的「仅给模型看的」提示，避免 [系统] 提示词出现在用户侧
const displayMessages = computed(() =>
  messages.value.filter((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') return false
    if (m._hideInUI || (m.meta && m.meta.hideInUI)) return false
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim().startsWith('[系统]')) return false
    return true
  })
)

const messageRenderKey = (msg, idx) => {
  if (!msg || typeof msg !== 'object') return `msg-${idx}`
  if (msg._uiKey) return msg._uiKey
  const base = [
    msg.role || 'msg',
    msg.messageId || msg.msgId || '',
    msg.tool_call_id || '',
    typeof msg.content === 'string' ? msg.content.slice(0, 32) : ''
  ].join('|')
  const key = `${base}|${Date.now()}|${Math.random().toString(36).slice(2, 7)}`
  msg._uiKey = key
  return key
}

// 被压缩过的会话：从 system 消息里取出「对话摘要」内容，供无 user/assistant 时展示
const compressionSummaryText = computed(() => {
  const parts = []
  for (const m of messages.value) {
    if (m.role !== 'system' || !m.content) continue
    const s = typeof m.content === 'string' ? m.content : ''
    if (s.includes('对话摘要') || s.includes('早期消息已压缩')) {
      parts.push(s.trim())
    }
  }
  return parts.length ? parts.join('\n\n') : ''
})

const LOCAL_TOKEN_THRESHOLD = 24000

const estimateMessageTokens = (message) => {
  if (!message) return 0
  const content = typeof message.content === 'string'
    ? message.content
    : (Array.isArray(message.content)
      ? message.content.map((c) => (typeof c === 'string' ? c : c?.text || JSON.stringify(c || ''))).join('')
      : JSON.stringify(message.content || ''))
  const toolCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls
    : (Array.isArray(message.tool_calls) ? message.tool_calls : [])
  const toolStr = toolCalls.length > 0 ? JSON.stringify(toolCalls) : ''
  return Math.ceil((String(content || '').length + toolStr.length) / 3)
}

const analyzeLocalTokenUsage = (list) => {
  const buckets = {
    total: 0,
    system: 0,
    systemPrompt: 0,
    systemSummary: 0,
    user: 0,
    assistant: 0,
    tool: 0,
    other: 0,
    compressionSummaryCount: 0
  }
  for (const message of Array.isArray(list) ? list : []) {
    const one = estimateMessageTokens(message)
    buckets.total += one
    if (message?.role === 'system') {
      buckets.system += one
      if (String(message.content || '').startsWith('[对话摘要（早期消息已压缩）]')) {
        buckets.systemSummary += one
        buckets.compressionSummaryCount += 1
      } else {
        buckets.systemPrompt += one
      }
    } else if (message?.role === 'user') {
      buckets.user += one
    } else if (message?.role === 'assistant') {
      buckets.assistant += one
    } else if (message?.role === 'tool') {
      buckets.tool += one
    } else {
      buckets.other += one
    }
  }
  const compressible = buckets.user + buckets.assistant + buckets.tool + buckets.other
  const ratio = (n, d = buckets.total) => d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0
  return {
    total: buckets.total,
    system: buckets.system,
    dialog: buckets.user + buckets.assistant,
    tool: buckets.tool,
    other: buckets.other,
    systemPct: ratio(buckets.system),
    dialogPct: ratio(buckets.user + buckets.assistant),
    toolPct: ratio(buckets.tool),
    otherPct: ratio(buckets.other),
    systemPrompt: buckets.systemPrompt,
    systemSummary: buckets.systemSummary,
    systemPromptPct: ratio(buckets.systemPrompt),
    systemSummaryPct: ratio(buckets.systemSummary),
    user: buckets.user,
    userPct: ratio(buckets.user),
    assistant: buckets.assistant,
    assistantPct: ratio(buckets.assistant),
    compressible,
    threshold: LOCAL_TOKEN_THRESHOLD,
    thresholdPct: buckets.total > 0 ? Number(((compressible / LOCAL_TOKEN_THRESHOLD) * 100).toFixed(1)) : 0,
    overThreshold: compressible > LOCAL_TOKEN_THRESHOLD,
    compressionSummaryCount: buckets.compressionSummaryCount,
    compressiblePctOfTotal: ratio(compressible),
    compression: {
      count: 0,
      totalSaved: 0,
      lastSaved: 0
    }
  }
}

const usageCard = computed(() => {
  const item = tokenUsage.value
  const usage = item?.usage && Number(item?.usage?.total) > 0 ? item.usage : analyzeLocalTokenUsage(messages.value)
  return {
    iteration: Number(item?.iteration) || 0,
    total: Number(usage.total) || 0,
    system: Number(usage.system) || 0,
    dialog: Number(usage.dialog) || 0,
    tool: Number(usage.tool) || 0,
    systemPct: Number(usage.systemPct) || 0,
    dialogPct: Number(usage.dialogPct) || 0,
    toolPct: Number(usage.toolPct) || 0,
    systemPrompt: Number(usage.systemPrompt) || 0,
    systemSummary: Number(usage.systemSummary) || 0,
    user: Number(usage.user) || 0,
    assistant: Number(usage.assistant) || 0,
    compressible: Number(usage.compressible) || 0,
    threshold: Number(usage.threshold) || 0,
    thresholdPct: Number(usage.thresholdPct) || 0,
    overThreshold: !!usage.overThreshold,
    compressionSummaryCount: Number(usage.compressionSummaryCount) || 0,
    systemPromptPct: Number(usage.systemPromptPct) || 0,
    systemSummaryPct: Number(usage.systemSummaryPct) || 0,
    userPct: Number(usage.userPct) || 0,
    assistantPct: Number(usage.assistantPct) || 0,
    compression: {
      count: Number(usage?.compression?.count) || 0,
      totalSaved: Number(usage?.compression?.totalSaved) || 0,
      lastSaved: Number(usage?.compression?.lastSaved) || 0
    }
  }
})

const usageStripTitle = computed(() => {
  const u = usageCard.value
  if (!u) return ''
  const parts = [
    `System ${u.system} = Prompt ${u.systemPrompt} + Summary ${u.systemSummary}`,
    `User ${u.user}`,
    `Assistant ${u.assistant}`,
    `Tool ${u.tool}`,
    `Active ${u.compressible}/${u.threshold} (${u.thresholdPct}%)`
  ]
  if (u.compression.count > 0) parts.push(`Compression ${u.compression.count}x, saved ${u.compression.totalSaved}`)
  return parts.join(' · ')
})

// ---- 模型：/model 与设置页共用全局 defaultModel（openultron.json），非按会话存储 ----
const currentModel = ref('')
const defaultModelId = ref('')
const modelPoolList = ref([])

/** 主模型 + 模型池去重后的全部可选 id（用于 /model 列表与标签展示） */
const allSelectableModelIds = computed(() => {
  const d = String(defaultModelId.value || '').trim()
  const pool = modelPoolList.value || []
  const seen = new Set()
  const out = []
  if (d) {
    seen.add(d)
    out.push(d)
  }
  for (const m of pool) {
    if (!m || seen.has(m)) continue
    seen.add(m)
    out.push(m)
  }
  return out
})

function ensureCurrentModelInPool () {
  const ids = allSelectableModelIds.value
  if (!ids.length) return
  const cur = String(currentModel.value || '').trim()
  if (!cur || !ids.includes(cur)) {
    currentModel.value = ids[0]
  }
}

const loadModels = async () => {
  try {
    const configRes = await window.electronAPI.ai.getConfig()
    if (configRes.success && configRes.config) {
      const cfg = configRes.config
      const defaultModel = String(cfg.defaultModel || '').trim()
      const pool = Array.isArray(cfg.modelPool) ? cfg.modelPool.map((x) => String(x || '').trim()).filter(Boolean) : []
      defaultModelId.value = defaultModel
      modelPoolList.value = pool

      if (props.model) {
        currentModel.value = String(props.model).trim()
        return
      }
      currentModel.value = defaultModel || pool[0] || ''
      ensureCurrentModelInPool()
    }
  } catch { /* ignore */ }
}

// 当父组件传入 model 变化时（例如工作室固定模型）
watch(() => props.model, (val) => {
  if (val && String(val).trim() !== '' && String(val).trim() !== currentModel.value) {
    currentModel.value = String(val).trim()
  }
}, { immediate: true })

watch(() => props.projectPath, () => {
  loadSkills()
  loadModels()
})

// ---- 技能（自动注入，无需手动选择）----
const skills = ref([])

const loadSkills = async () => {
  try {
    const projectPath = props.projectPath && String(props.projectPath).trim() && !String(props.projectPath).startsWith('__')
      ? String(props.projectPath).trim()
      : undefined
    const res = await window.electronAPI.ai.getSkills(projectPath ? { projectPath } : {})
    if (res.success) skills.value = res.skills || []
  } catch { /* ignore */ }
}
/** 与 SkillManager 一致：安装/更新技能后主进程会发 ai-skills-changed，否则会话里 skills 仍为空，模型看不到技能列表 */
let unsubscribeSkillsChanged = null

// ---- 斜杠命令 ----
const slashPaletteRef = ref(null)
const showSlash = ref(false)
const slashCategory = ref('')   // '' | 'skills' | 'mcp' | 'model'
const slashQuery = ref('')
// 斜杠选择：多技能
const activeSlashSkills = ref([])
const hasActiveSlash = computed(() => activeSlashSkills.value.length > 0)
const SLASH_SYSTEM_PROMPT_MAX_LENGTH = 5000
const SLASH_SYSTEM_PROMPT_RISK_PATTERNS = [
  /\b(ignore|disregard|override|bypass)\b\s+.*\b(previous|prior|earlier|all|everything)\b\s+.*\b(instruction|instructions|rule|rules|constraint|constraints|prompt|directive)\b/i,
  /(你|您|请)?\s*(必须|应该|请)?\s*(忽略|无视|绕过|跳过)\s+(上面|之前|前面|先前|既有)\s*(的?)\s*(所有|全部|既有)?\s*(约束|规则|指令|提示|系统)\b/i,
  /(ignore|ignore all|bypass|override)\s*[:：]?\s*(previous|prior|above|earlier|existing)\s+(instructions?|constraints?|rules?)/i
]

const getActiveSlashSystemPrompt = (skills = activeSlashSkills.value) =>
  skills
    .map(item => (item && item.type === 'skill' ? String(item.raw?.prompt || '').trim() : ''))
    .filter(Boolean)
    .join('\n\n')

const sanitizeSlashSystemPrompt = (text) => String(text || '')
  .replace(/\r/g, '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .trim()

const evaluateSlashSystemPrompt = (text) => {
  const normalized = sanitizeSlashSystemPrompt(text)
  const base = {
    enabled: false,
    length: 0,
    truncated: false,
    hasRisk: false,
    canSend: true,
    warning: '',
    value: '',
    previewText: ''
  }

  if (!normalized) return base

  if (SLASH_SYSTEM_PROMPT_RISK_PATTERNS.some((p) => p.test(normalized))) {
    return {
      ...base,
      enabled: true,
      hasRisk: true,
      canSend: false,
      warning: '检测到潜在越权注入短语（如“忽略既有规则/override previous instructions”），本次将阻断发送，请修改斜杠内容后重试。',
      value: '',
      previewText: normalized.slice(0, 1200),
      length: normalized.length
    }
  }

  let previewText = normalized
  let value = normalized
  const isTruncated = normalized.length > SLASH_SYSTEM_PROMPT_MAX_LENGTH
  if (normalized.length > SLASH_SYSTEM_PROMPT_MAX_LENGTH) {
    value = `${normalized.slice(0, SLASH_SYSTEM_PROMPT_MAX_LENGTH)}\n\n[已截断：系统提示过长，超过上限 ${SLASH_SYSTEM_PROMPT_MAX_LENGTH} 字]`
    previewText = value
  }
  return {
    ...base,
    enabled: true,
    length: normalized.length,
    truncated: isTruncated,
    hasRisk: false,
    canSend: true,
    value,
    previewText: previewText.length > 1200 ? `${previewText.slice(0, 1200)}\n…（后续已省略）` : previewText,
    warning: normalized.length > SLASH_SYSTEM_PROMPT_MAX_LENGTH
      ? `当前长度 ${normalized.length}，超出上限 ${SLASH_SYSTEM_PROMPT_MAX_LENGTH}，已按系统规则截断。`
      : ''
  }
}

const slashSystemPromptCheck = computed(() => evaluateSlashSystemPrompt(getActiveSlashSystemPrompt()))

// MCP 服务器列表
const mcpServers = ref([])
const loadMcpServers = async () => {
  try {
    const res = await window.electronAPI.ai.getMcpStatus()
    if (res?.success && res.status) {
      mcpServers.value = Object.entries(res.status).map(([name, info]) => ({
        id: name, name, description: `${info.toolCount || 0} tools`, type: 'mcp', raw: { name, ...info }
      }))
    }
  } catch { /* ignore */ }
}

// 跑马灯快捷指令提示（轮播，随语言切换）
const marqueeHints = computed(() => [
  t('chat.marqueeHintSlash1'),
  t('chat.marqueeHintSlash3'),
  t('chat.marqueeHintSlash2'),
])
const marqueeHintIndex = ref(0)
const marqueeHint = computed(() => {
  const hints = marqueeHints.value
  if (!hints.length) return ''
  return hints[marqueeHintIndex.value % hints.length] ?? hints[0]
})
let marqueeTimer = null
function startMarquee() {
  if (marqueeTimer) return
  marqueeTimer = setInterval(() => {
    const n = marqueeHints.value.length || 1
    marqueeHintIndex.value = (marqueeHintIndex.value + 1) % n
  }, 2800)
}
function stopMarquee() {
  if (marqueeTimer) {
    clearInterval(marqueeTimer)
    marqueeTimer = null
  }
}

// 一级菜单：分类（自进化由后台自动执行，不再提供 /evolve 指令）
const slashRootCategories = computed(() => {
  const cats = [
    { id: 'skills', name: 'skills', description: t('chat.slashCategorySkills'), type: 'category' },
    { id: 'mcp', name: 'mcp', description: t('chat.slashCategoryMcp'), type: 'category' },
  ]
  if (!props.model && allSelectableModelIds.value.length > 1) {
    cats.push({ id: 'model', name: 'model', description: t('chat.slashCategoryModel'), type: 'category' })
  }
  return cats
})

// 根据当前分类和 query 计算候选列表
const slashItems = computed(() => {
  const q = slashQuery.value.toLowerCase()

  if (!slashCategory.value) {
    return slashRootCategories.value.filter(c =>
      !q ||
      c.id.includes(q) ||
      (c.description && c.description.toLowerCase().includes(q))
    )
  }

  let items = []
  if (slashCategory.value === 'skills') {
    items = skills.value.map(s => ({
      id: s.id, name: s.name, description: s.description, type: 'skill', raw: s
    }))
  } else if (slashCategory.value === 'mcp') {
    items = mcpServers.value
  } else if (slashCategory.value === 'model') {
    const d = String(defaultModelId.value || '').trim()
    items = allSelectableModelIds.value.map((mid) => ({
      id: mid,
      name: mid,
      description: mid === d ? t('chat.modelPrimaryGroup') : t('chat.modelPoolGroup'),
      type: 'model',
      raw: { id: mid }
    }))
  }

  if (!q) return items
  return items.filter(i =>
    i.name?.toLowerCase().includes(q) ||
    (i.description && i.description.toLowerCase().includes(q))
  )
})

const onSlashBack = () => {
  slashCategory.value = ''
  slashQuery.value = ''
  inputText.value = '/'
  nextTick(() => inputRef.value?.focus())
}

const onSlashSelect = (item) => {
  if (item.type === 'category') {
    slashCategory.value = item.id
    slashQuery.value = ''
    inputText.value = `/${item.id} `
    if (item.id === 'mcp') loadMcpServers()
    nextTick(() => inputRef.value?.focus())
    return
  }
  // 模型：写入全局 defaultModel（与设置页主模型一致）
  if (item.type === 'model') {
    const id = String(item.id || '').trim()
    ;(async () => {
      try {
        const res = await window.electronAPI.ai.saveConfig({ raw: { defaultModel: id } })
        if (!res?.success) {
          error.value = res?.message || '保存模型失败'
          return
        }
        await loadModels()
        showSlash.value = false
        slashCategory.value = ''
        slashQuery.value = ''
        inputText.value = ''
        nextTick(() => inputRef.value?.focus())
      } catch (e) {
        error.value = e?.message || '保存模型失败'
      }
    })()
    return
  }
  // 技能：可多选
  if (!activeSlashSkills.value.some(s => s.id === item.id)) {
    activeSlashSkills.value = [...activeSlashSkills.value, item]
  }
  showSlash.value = false
  slashCategory.value = ''
  slashQuery.value = ''
  inputText.value = ''
  nextTick(() => inputRef.value?.focus())
}

const removeSlashSkill = (skill) => {
  activeSlashSkills.value = activeSlashSkills.value.filter(s => s.id !== skill.id)
}

const clearSlash = () => {
  activeSlashSkills.value = []
  showSlash.value = false
  slashCategory.value = ''
  slashQuery.value = ''
}

// 输入 / 出现技能选择时，点击其他区域关闭
const onSlashPaletteClickOutside = (e) => {
  if (!showSlash.value) return
  const el = slashPaletteRef.value?.$el
  if (el && typeof el.contains === 'function' && el.contains(e.target)) return
  clearSlash()
}
watch(showSlash, (visible) => {
  if (visible) {
    nextTick(() => document.addEventListener('mousedown', onSlashPaletteClickOutside))
  } else {
    document.removeEventListener('mousedown', onSlashPaletteClickOutside)
  }
})

// 输入框多行时高度自适应（单行默认高度不变）
const adjustTextareaHeight = () => {
  nextTick(() => {
    const ta = inputRef.value
    if (!ta) return
    ta.style.height = 'auto'
    const minH = 36
    const maxH = 114
    const h = Math.min(maxH, Math.max(minH, ta.scrollHeight))
    ta.style.height = `${h}px`
  })
}

// 监听输入框变化，检测 / 和 @ 触发
const onInput = () => {
  const val = inputText.value

  // 检测 @ 提及（优先，可与 / 共存）
  detectMention()

  adjustTextareaHeight()

  if (!val.startsWith('/')) {
    showSlash.value = false
    slashCategory.value = ''
    slashQuery.value = ''
    return
  }

  const rest = val.slice(1).trimStart()  // 去掉开头 /
  // /new 不展示为指令，当作普通文本输入，发送时再处理
  if (/^new\s*$/i.test(rest)) {
    showSlash.value = false
    slashCategory.value = ''
    slashQuery.value = ''
    return
  }

  showSlash.value = true

  // 检测是否已进入二级：/category<空格>query
  const spaceIdx = rest.indexOf(' ')
  if (spaceIdx !== -1) {
    const cat = rest.slice(0, spaceIdx).toLowerCase()
    const knownCats = ['skills', 'mcp', 'model']
    if (knownCats.includes(cat)) {
      slashCategory.value = cat
      slashQuery.value = rest.slice(spaceIdx + 1)
      if (cat === 'mcp' && mcpServers.value.length === 0) loadMcpServers()
      return
    }
  }

  // 一级：按 rest 过滤分类
  slashCategory.value = ''
  slashQuery.value = rest
}

// 构建最终 systemPrompt：大段规则由主进程 orchestrator 注入；此处仅父组件/工作室附加说明
const buildSystemPrompt = () =>
  buildRendererSystemSupplement({
    studioSandboxMode: props.studioSandboxMode,
    parentSystemPrompt: props.systemPrompt
  })

// ---- @ 文件提及 ----
const mentionPaletteRef = ref(null)
const showMention = ref(false)
const mentionQuery = ref('')
const mentionItems = ref([])
const mentionLoading = ref(false)
const mentionedFiles = ref([])   // 已选中的文件列表
let mentionSearchTimer = null
let mentionAtStart = -1          // @ 符号在 textarea 中的位置

// 工作区根目录列表（通过全局事件同步）
const workspaceRoots = ref([])
const onWorkspaceRootsChanged = (e) => { workspaceRoots.value = e.detail || [] }

const onAddFileToAI = (e) => {
  const item = e.detail
  if (!item?.path) return
  if (!mentionedFiles.value.find(f => f.path === item.path && f.type !== 'snippet')) {
    mentionedFiles.value.push({ type: 'file', ...item })
  }
}

const onAddSnippetToAI = (e) => {
  const item = e.detail
  if (!item?.path) return
  const key = `${item.path}:${item.lineStart}-${item.lineEnd}`
  if (!mentionedFiles.value.find(f => f._key === key)) {
    mentionedFiles.value.push({ type: 'snippet', _key: key, ...item })
  }
}

// 从绝对路径生成相对路径（支持多工作区根目录）
const toRelativeWithProject = (absPath) => {
  const roots = workspaceRoots.value
  if (roots.length > 0) {
    for (const root of roots) {
      if (absPath.startsWith(root.path + '/')) {
        return `${root.name}/${absPath.slice(root.path.length + 1)}`
      }
    }
  }
  // 回退到原有逻辑
  const base = props.projectPath
  if (base && absPath.startsWith(base)) {
    return absPath.slice(base.length).replace(/^\//, '')
  }
  return absPath
}

// 从绝对路径生成相对路径
const toRelative = (absPath) => {
  const base = props.projectPath
  if (base && absPath.startsWith(base)) {
    return absPath.slice(base.length).replace(/^\//, '')
  }
  return absPath
}

const searchMentionFiles = async (q) => {
  const roots = workspaceRoots.value.length > 0
    ? workspaceRoots.value
    : (props.projectPath ? [{ path: props.projectPath, name: props.projectPath.split('/').pop() }] : [])

  if (!roots.length) return

  const query = String(q || '').trim()
  if (!query) {
    mentionItems.value = []
    return
  }

  mentionLoading.value = true
  try {
    const search = window.electronAPI?.workspace?.searchFiles
    if (typeof search !== 'function') {
      mentionItems.value = []
      return
    }
    // 并发搜索所有根目录（主进程 workspace-search-files）
    const results = await Promise.all(
      roots.map(root =>
        search({ rootPath: root.path, query, maxFiles: 50 })
          .then(res => ({ root, res }))
          .catch(() => ({ root, res: null }))
      )
    )
    const all = []
    for (const { root, res } of results) {
      if (res?.success) {
        for (const p of (res.matches || []).slice(0, 30)) {
          all.push({
            path: p,
            name: p.split('/').pop(),
            relativePath: `${root.name}/${p.slice(root.path.length + 1)}`,
            type: 'file'
          })
        }
      }
    }
    mentionItems.value = all.slice(0, 50)
  } catch { /* ignore */ }
  mentionLoading.value = false
}

watch(mentionQuery, (q) => {
  clearTimeout(mentionSearchTimer)
  if (!showMention.value) return
  mentionSearchTimer = setTimeout(() => searchMentionFiles(q), 150)
})

const onMentionSelect = (item) => {
  // 把输入框里 @query 部分替换为 @filename（不重复添加已有文件）
  const ta = inputRef.value
  if (ta && mentionAtStart >= 0) {
    const before = inputText.value.slice(0, mentionAtStart)
    const after = inputText.value.slice(ta.selectionStart)
    inputText.value = before + after
    nextTick(() => {
      ta.selectionStart = ta.selectionEnd = mentionAtStart
      ta.focus()
    })
  }
  if (!mentionedFiles.value.find(f => f.path === item.path)) {
    mentionedFiles.value.push(item)
  }
  clearMention()
}

const removeMentionedFile = (file) => {
  if (file._key) {
    mentionedFiles.value = mentionedFiles.value.filter(f => f._key !== file._key)
  } else {
    mentionedFiles.value = mentionedFiles.value.filter(f => f.path !== file.path)
  }
}

const clearMention = () => {
  showMention.value = false
  mentionQuery.value = ''
  mentionItems.value = []
  mentionAtStart = -1
}

// 检测 @ 触发（在 onInput 中调用）
const detectMention = () => {
  if (!props.enableMention) return
  const ta = inputRef.value
  if (!ta) return
  const val = inputText.value
  const cursor = ta.selectionStart

  // 从光标往左找最近的 @
  let atPos = -1
  for (let i = cursor - 1; i >= 0; i--) {
    if (val[i] === '@') { atPos = i; break }
    // 遇到空格/换行说明没有 @
    if (val[i] === ' ' || val[i] === '\n') break
  }

  if (atPos >= 0) {
    const q = val.slice(atPos + 1, cursor)
    const justOpened = !showMention.value
    mentionAtStart = atPos
    showMention.value = true
    // @ 刚出现时主动请求编辑器文件列表（确保拿到最新状态）
    if (justOpened) {
      // mentionQuery 可能仍是 ''，watch 不会触发，需要主动调用一次
      clearTimeout(mentionSearchTimer)
      mentionSearchTimer = setTimeout(() => searchMentionFiles(q), 160)
    }
    mentionQuery.value = q   // watch 会触发后续 debounce 搜索（query 变化时）
  } else {
    if (showMention.value) clearMention()
  }
}

// ---- 输入 ----
const inputText = ref('')
const inputRef = ref(null)
const fileInputRef = ref(null)
const messagesRef = ref(null)
const panelRef = ref(null)
const isComposing = ref(false)  // 中文输入法合成中
const pendingAttachments = ref([])
let pendingAttachmentSeed = 0

const handleRegenerateAudio = async (payload = {}) => {
  const prompt = String(payload?.prompt || '').trim()
  if (!prompt) return
  inputText.value = prompt
  adjustTextareaHeight()
  await handleSend()
}

const formatAttachmentSize = (n) => {
  const size = Number(n || 0)
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(2)}MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${size}B`
}

const removePendingAttachment = (id) => {
  pendingAttachments.value = pendingAttachments.value.filter(a => a.id !== id)
}

const addPendingFiles = (files) => {
  const list = Array.from(files || [])
  for (const f of list) {
    const id = `att-${Date.now()}-${++pendingAttachmentSeed}`
    pendingAttachments.value.push({
      id,
      file: f,
      name: f.name || `file-${pendingAttachmentSeed}`,
      size: Number(f.size || 0),
      mime: f.type || 'application/octet-stream',
      status: 'pending',
      error: ''
    })
  }
}

const openFilePicker = () => {
  if (isStreaming.value) return
  fileInputRef.value?.click()
}

const onFileInputChange = (e) => {
  const files = e?.target?.files
  if (files && files.length > 0) addPendingFiles(files)
  if (e?.target) e.target.value = ''
}

const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onerror = () => reject(new Error('read file failed'))
  reader.onload = () => {
    const raw = String(reader.result || '')
    const i = raw.indexOf(',')
    resolve(i >= 0 ? raw.slice(i + 1) : raw)
  }
  reader.readAsDataURL(file)
})

const extractImageFilesFromClipboard = (e) => {
  const items = e?.clipboardData?.items || []
  const files = []
  for (const item of items) {
    if (!item || item.kind !== 'file') continue
    const f = item.getAsFile ? item.getAsFile() : null
    if (!f) continue
    if ((f.type || '').startsWith('image/')) files.push(f)
  }
  return files
}

const onInputPaste = (e) => {
  if (isStreaming.value) return
  const imageFiles = extractImageFilesFromClipboard(e)
  if (imageFiles.length > 0) {
    addPendingFiles(imageFiles)
  }
}

const onInputDragOver = (e) => {
  if (isStreaming.value) return
  e.preventDefault()
}

const onInputDrop = (e) => {
  if (isStreaming.value) return
  e.preventDefault()
  const files = e?.dataTransfer?.files
  if (files && files.length > 0) addPendingFiles(files)
}

// ---- 图片预览 ----
const showImageViewer = ref(false)
const previewImageSrc = ref('')
const previewImageAlt = ref('')

const onImageClick = (e) => {
  if (e.target.classList.contains('chat-image')) {
    previewImageSrc.value = e.target.src
    previewImageAlt.value = e.target.alt
    showImageViewer.value = true
  }
}

// ---- 会话历史持久化（projectPath 辅助函数提前，供历史列表复用）----
const historyProjectPath = () => props.projectPath || '__general__'
const HISTORY_CMD_RE = /^\/(history|memory)\s*$/i
const STOP_CMD_RE = /^\/stop\s*$/i
const CLEAR_CMD_RE = /^\/clear\s*$/i

// ---- 历史对话列表 ----
const showHistory = ref(false)
const conversationList = ref([])
const carrySummaryForNextSession = ref('')

const compactSummaryText = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const extractTextFromMessage = (m) => {
  if (!m) return ''
  if (typeof m.content === 'string') return compactSummaryText(m.content)
  if (Array.isArray(m.content)) {
    return compactSummaryText((m.content || []).map(p => (p && p.text) || '').join(' '))
  }
  return ''
}
const buildSessionSummary = (msgs = []) => {
  const list = (msgs || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, text: extractTextFromMessage(m) }))
    .filter(m => m.text)
  if (!list.length) return ''
  const recent = list.slice(-24)
  const userPoints = []
  const assistantPoints = []
  for (const item of recent) {
    if (item.role === 'user') {
      if (userPoints.length < 6) userPoints.push(item.text.slice(0, 120))
    } else if (item.role === 'assistant') {
      if (assistantPoints.length < 6) assistantPoints.push(item.text.slice(0, 140))
    }
  }
  const out = []
  out.push(`会话压缩摘要（${new Date().toLocaleString('zh-CN', { hour12: false })}）`)
  if (userPoints.length) {
    out.push('用户关注点：')
    userPoints.forEach(p => out.push(`- ${p}`))
  }
  if (assistantPoints.length) {
    out.push('已完成/已回复：')
    assistantPoints.forEach(p => out.push(`- ${p}`))
  }
  return out.join('\n')
}
const formatSummaryList = (summaries = []) => {
  if (!summaries.length) return '暂无历史记忆摘要。'
  const lines = ['最近历史记忆摘要：']
  summaries.forEach((s) => {
    const t = (s.updatedAt || s.createdAt || '').replace('T', ' ').replace('Z', '')
    const oneLine = compactSummaryText(s.content || '').slice(0, 160)
    lines.push(`- [${t}] ${oneLine}`)
  })
  return lines.join('\n')
}

const loadConversationList = async () => {
  try {
    const res = await window.electronAPI.ai.listConversations({ projectPath: historyProjectPath() })
    if (res?.success) conversationList.value = res.conversations || []
  } catch { /* ignore */ }
}

const switchConversation = async (sessionId) => {
  if (sessionId === currentSessionId.value) { showHistory.value = false; return }
  if (isStreaming.value) return
  showHistory.value = false
  currentSessionId.value = sessionId
  emit('session-loaded', sessionId)
  isLoadingHistory = true
  try {
    const res = await window.electronAPI.ai.loadChatHistory({ projectPath: historyProjectPath(), sessionId })
    if (res?.success && res.messages?.length > 0) {
      loadMessages(res.messages)
      await restoreProvider(res.apiBaseUrl)
      nextTick(() => {
        const el = messagesRef.value
        if (el) el.scrollTop = el.scrollHeight
      })
    } else {
      useAIChatInstance.clearMessages()
    }
    syncSessionName()
  } catch { /* ignore */ } finally {
    isLoadingHistory = false
  }
}

const startNewConversation = () => {
  if (isStreaming.value) return
  showHistory.value = false
  clearMessages()
  emit('session-created', null)
}

const deleteConversation = async (sessionId) => {
  try {
    await window.electronAPI.ai.clearChatHistory({ projectPath: historyProjectPath(), sessionId })
    conversationList.value = conversationList.value.filter(c => c.id !== sessionId)
    // 如果删的是当前会话，切到最新的
    if (sessionId === currentSessionId.value) {
      const next = conversationList.value[0]
      if (next) {
        await switchConversation(next.id)
      } else {
        currentSessionId.value = null
        clearMessages()
        emit('session-created', null)
      }
    }
  } catch { /* ignore */ }
}

// ---- 会话重命名 ----
const renamingConvId = ref(null)
const renameText = ref('')
const renameInputRef = ref(null)

const startRename = (conv) => {
  renamingConvId.value = conv.id
  renameText.value = conv.title || ''
  nextTick(() => {
    const el = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
    el?.focus()
    el?.select()
  })
}

const confirmRename = async (conv) => {
  if (!renamingConvId.value) return
  const newTitle = renameText.value.trim()
  renamingConvId.value = null
  if (!newTitle || newTitle === conv.title) return
  try {
    await window.electronAPI.ai.renameConversation({
      projectPath: historyProjectPath(),
      sessionId: conv.id,
      title: newTitle
    })
    conv.title = newTitle
    // 同步更新 session-registry 中的名称（多 Agent / 子 agent 编排用）
    window.electronAPI?.ai?.sessionUpdateMeta?.({
      sessionId: panelId,
      projectName: newTitle
    }).catch(() => {})
  } catch { /* ignore */ }
}

const cancelRename = () => { renamingConvId.value = null }

// ---- 会话历史持久化 ----
let isLoadingHistory = false
// 当前会话 ID（由主进程分配或从历史中恢复）
const currentSessionId = ref(null)
// 主 Agent 显示名（从 IDENTITY.md「名字：」解析），用于空状态与头像旁展示
const agentDisplayName = ref(null)
const identityPathForHint = ref('')
const refetchAgentDisplayName = async () => {
  const nameRes = await window.electronAPI?.ai?.getAgentDisplayName?.().catch(() => ({}))
  agentDisplayName.value = nameRes?.name ?? null
}
const onWindowFocusRefetchName = () => { refetchAgentDisplayName() }
const fetchIdentityPathHint = async () => {
  const res = await window.electronAPI?.ai?.getIdentityMdPath?.().catch(() => ({}))
  const p = res?.shortPath || res?.path
  if (p && typeof p === 'string') identityPathForHint.value = p
}
// 稳定的面板 ID（整个 ChatPanel 实例生命周期不变，用于 session-registry 追踪页面在线状态）
const panelId = `panel-${props.projectPath || '__general__'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

// 会话 ID 在 ref 与 useAIChat 闭包间同步，避免仅改 ref 时点「停止」仍带着旧/空的 sessionId 调 chatStop
watch(currentSessionId, (v) => {
  useAIChatInstance.setCurrentSessionId(v != null && v !== '' ? v : null)
}, { immediate: true })

// 切换会话时记录该会话曾使用的供应商，但不自动覆盖全局默认供应商
// （避免加载旧会话后永久改变用户的默认供应商设置）
const restoreProvider = async (savedApiBaseUrl) => {
  if (!savedApiBaseUrl) return
  // 仅记录，不写入全局配置
}

// 获取当前会话的标题（从列表或消息中提取）
const currentConvTitle = () => {
  if (currentSessionId.value) {
    const conv = conversationList.value.find(c => c.id === currentSessionId.value)
    if (conv?.title) return conv.title
  }
  const firstUser = messages.value.find(m => m.role === 'user')
  if (firstUser?.content) return firstUser.content.slice(0, 30)
  return ''
}

// 同步会话名称到 session-registry（多 Agent 编排可见）
const syncSessionName = () => {
  const lastAst = [...messages.value].reverse().find(m => m.role === 'assistant' && m.content)
  const projectName = props.projectPath ? props.projectPath.split('/').pop() : (agentDisplayName.value || 'AI Assistant')
  window.electronAPI?.ai?.sessionUpdateMeta?.({
    sessionId: panelId,
    projectName,
    sessionTitle: currentConvTitle() || '',
    model: currentModel.value || '',
    lastContent: lastAst?.content?.slice(-200) || ''
  }).catch(() => {})
}

watch(currentModel, (v) => {
  syncSessionName()
  emit('model-change', v)
})

// 命令执行情况仅在进行中展示，不保留到历史消息；保存时剥离
function stripToolExecutionForSave(msgs) {
  return msgs
    .filter(m => m && m.role !== 'tool')
    .map(m => {
      const out = { ...m }
      if (out.toolCalls !== undefined) delete out.toolCalls
      if (out.tool_calls !== undefined) delete out.tool_calls
      return out
    })
    .filter(m => m.role !== 'assistant' || (m.content && String(m.content).trim()))
}

const persistSave = async () => {
  if (isLoadingHistory) return
  if (!messages.value.length) return
  try {
    const filtered = messages.value.filter(m => !(m.role === 'assistant' && !m.content?.trim() && !m.toolCalls?.length))
    const toSave = stripToolExecutionForSave(JSON.parse(JSON.stringify(filtered)))
    if (!toSave.length) return
    const configRes = await window.electronAPI.ai.getConfig().catch(() => null)
    const apiBaseUrl = configRes?.config?.apiBaseUrl || ''
    const res = await window.electronAPI.ai.saveChatHistory({
      projectPath: historyProjectPath(),
      messages: toSave,
      sessionId: currentSessionId.value,
      apiBaseUrl: apiBaseUrl || undefined
    })
    if (res?.sessionId) {
      if (!currentSessionId.value) emit('session-created', res.sessionId)
      currentSessionId.value = res.sessionId
    }
    // 保存后同步名称到 session-registry
    syncSessionName()
    loadConversationList()
  } catch (e) {
    console.warn('[ChatPanel] persistSave failed:', e)
  }
}

const archiveSessionInBackground = async ({ sessionId, projectPath, messages }) => {
  if (!sessionId || !Array.isArray(messages) || !messages.length) return
  try {
    const archivedMessages = stripToolExecutionForSave(JSON.parse(JSON.stringify([
      ...messages,
      { role: 'user', content: '/new' },
      { role: 'assistant', content: '已归档当前会话并开启新会话。历史记忆将自动继承。' }
    ])))
    if (!archivedMessages.length) return

    window.electronAPI.ai.saveSessionSummary({
      projectPath,
      sessionId,
      messages: archivedMessages
    }).catch(() => null)

    const configRes = await window.electronAPI.ai.getConfig().catch(() => null)
    const apiBaseUrl = configRes?.config?.apiBaseUrl || ''
    await window.electronAPI.ai.saveChatHistory({
      projectPath,
      messages: archivedMessages,
      sessionId,
      apiBaseUrl: apiBaseUrl || undefined
    })
    loadConversationList()
  } catch (e) {
    console.warn('[ChatPanel] archiveSessionInBackground failed:', e)
  }
}

const persistLoad = async () => {
  isLoadingHistory = true
  try {
    const sessionIdToLoad = props.initialSessionId ?? currentSessionId.value
    const res = await window.electronAPI.ai.loadChatHistory({
      projectPath: historyProjectPath(),
      sessionId: sessionIdToLoad || null
    })
    if (res?.sessionId) {
      currentSessionId.value = res.sessionId
      if (!sessionIdToLoad && res.sessionId) emit('session-loaded', res.sessionId)
    }
    if (res?.success && res.messages?.length > 0) {
      loadMessages(res.messages)
      await restoreProvider(res.apiBaseUrl)
      userScrolledUp = false
      // 用 ResizeObserver 等容器有实际高度后再滚，解决 Tab 恢复时布局未稳定的问题
      const scrollWhenReady = () => {
        const el = messagesRef.value
        if (!el) return
        if (el.clientHeight > 0) {
          el.scrollTop = el.scrollHeight
          // 再补一次，等 markdown/工具卡片渲染完
          setTimeout(() => { el.scrollTop = el.scrollHeight }, 200)
          return
        }
        // 容器还没有高度，用 ResizeObserver 等
        const ro = new ResizeObserver(() => {
          if (el.clientHeight > 0) {
            ro.disconnect()
            el.scrollTop = el.scrollHeight
            setTimeout(() => { el.scrollTop = el.scrollHeight }, 200)
          }
        })
        ro.observe(el)
        // 最多等 3s 兜底
        setTimeout(() => { ro.disconnect(); el.scrollTop = el.scrollHeight }, 3000)
      }
      scrollWhenReady()
    }
  } catch { /* ignore */ } finally {
    isLoadingHistory = false
  }
}

watch(isStreaming, async (val) => {
  if (!val) {
    persistSave()
    loadConversationList()
    nextTick(() => inputRef.value?.focus())
  }
})
// 报错时滚到底部并让输入框重新聚焦
watch(() => error.value, (val) => {
  if (val) {
    nextTick(() => {
      const el = messagesRef.value
      if (el) el.scrollTop = el.scrollHeight
      inputRef.value?.focus()
    })
  }
})
watch(() => messages.value.length, persistSave)
watch(() => props.initialSessionId, (id) => {
  if (id === undefined || id === null) return
  if (id === currentSessionId.value) return
  currentSessionId.value = id
  persistLoad()
}, { flush: 'post' })

const onKeyDown = (e) => {
  // @ 提及面板优先
  if (showMention.value && mentionPaletteRef.value?.onKeyDown(e)) return
  // 斜杠面板键盘导航
  if (showSlash.value && slashPaletteRef.value?.onKeyDown(e)) return
  if (e.key === 'Escape' && (showSlash.value || hasActiveSlash.value)) {
    clearSlash()
    return
  }
  // 有技能标签且输入为空时，删除键可删掉最后一个标签
  if (e.key === 'Backspace' && !isComposing.value && !inputText.value) {
    if (activeSlashSkills.value.length > 0) {
      e.preventDefault()
      activeSlashSkills.value = activeSlashSkills.value.slice(0, -1)
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    // 中文输入法合成中（候选词未上屏）时不发送
    if (isComposing.value) return
    e.preventDefault()
    handleSend()
  }
}

const handleSend = async (opts = {}) => {
  const { stopPrevious } = opts
  const text = inputText.value.trim()
  if (!text && !hasActiveSlash.value && pendingAttachments.value.length === 0) return
  if (!stopPrevious && isStreaming.value && !STOP_CMD_RE.test(text) && !CLEAR_CMD_RE.test(text) && !/^\/new\s*$/i.test(text)) return

  // 应用工作室：无有效 projectPath 时主进程会落到默认 workspace，文件不会写进沙箱
  if (props.studioSandboxMode) {
    const pp = String(props.projectPath || '').trim()
    if (!pp || pp.startsWith('__')) {
      error.value = '应用目录未就绪，请等待左侧加载完成后再发送'
      return
    }
  }

  if (HISTORY_CMD_RE.test(text)) {
    inputText.value = ''
    adjustTextareaHeight()
    try {
      const res = await window.electronAPI.ai.listSessionSummaries({
        projectPath: historyProjectPath(),
        limit: 6
      })
      messages.value.push({ role: 'user', content: text })
      messages.value.push({ role: 'assistant', content: formatSummaryList(res?.summaries || []) })
      await persistSave()
      nextTick(() => forceScrollToBottom())
    } catch {
      messages.value.push({ role: 'assistant', content: '读取历史记忆失败。' })
    }
    return
  }

  // /stop：停止当前正在进行的生成（不发送新消息）
  if (STOP_CMD_RE.test(text)) {
    inputText.value = ''
    adjustTextareaHeight()
    clearSlash()
    try {
      await useAIChatInstance.stopChat()
    } catch { /* ignore */ }
    nextTick(() => forceScrollToBottom())
    return
  }

  // /clear：清空当前会话的 UI 消息，并重置 sessionId（不做 /new 的归档/进化）
  if (CLEAR_CMD_RE.test(text)) {
    inputText.value = ''
    adjustTextareaHeight()
    clearSlash()
    try {
      await useAIChatInstance.stopChat()
    } catch { /* ignore */ }

    showHistory.value = false
    carrySummaryForNextSession.value = ''
    error.value = ''
    useAIChatInstance.clearMessages()
    currentSessionId.value = null
    useAIChatInstance.setCurrentSessionId(null) // 同步 composable 内 sessionId
    syncSessionName()
    emit('session-created', null)
    nextTick(() => forceScrollToBottom())
    return
  }

  // /new：先压缩归档当前会话，再切到新会话；下一轮自动携带摘要
  const isNewCmd = /^\/new\s*$/i.test(text) || text === '/new'
  if (isNewCmd) {
    inputText.value = ''
    adjustTextareaHeight()
    const oldSessionId = currentSessionId.value != null ? String(currentSessionId.value) : ''
    const oldProjectPath = historyProjectPath()
    const oldMessages = JSON.parse(JSON.stringify(messages.value || []))
    carrySummaryForNextSession.value = ''
    startNewConversation()
    archiveSessionInBackground({
      sessionId: oldSessionId,
      projectPath: oldProjectPath,
      messages: oldMessages
    })
    return
  }

  inputText.value = ''
  adjustTextareaHeight()
  const isFirstMessage = messages.value.filter(m => m.role === 'user').length === 0

  let finalText = text
  let slashSystemPrompt = null
  let visionImageParts = []

  if (activeSlashSkills.value.length > 0) {
    const slashPromptState = slashSystemPromptCheck.value
    if (!slashPromptState.canSend) {
      error.value = slashPromptState.warning || '斜杠系统提示词存在风险，发送已阻断。'
      return
    }
    slashSystemPrompt = slashPromptState.value || null
    if (!finalText) {
      finalText = activeSlashSkills.value.length === 1
        ? `Using skill: ${activeSlashSkills.value[0].name}`
        : `Using selected skills (${activeSlashSkills.value.map(s => s.name).join(', ')})`
    }
    clearSlash()
  }
  let displayText = finalText  // 展示给用户看的消息（不含文件内容）

  // 上传本轮附件并注入上下文（与飞书入站共用同一主进程 ingest 管道）
  if (pendingAttachments.value.length > 0) {
    const filesForUpload = [...pendingAttachments.value]
    for (const a of filesForUpload) {
      a.status = 'pending'
      a.error = ''
    }
    try {
      const visionRes = await window.electronAPI.ai.modelSupportsVision({
        model: currentModel.value || undefined
      })
      const supportsVision = !!visionRes?.supportsVision
      const sessionForAttachments = currentSessionId.value || `pending-${Date.now()}`
      const payload = []
      const base64ByClientId = new Map()
      for (const a of filesForUpload) {
        const dataBase64 = await readFileAsBase64(a.file)
        base64ByClientId.set(a.id, dataBase64)
        payload.push({
          clientId: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size,
          dataBase64
        })
      }
      const res = await window.electronAPI.ai.uploadAttachments({
        sessionId: sessionForAttachments,
        source: 'main',
        attachments: payload,
        imageMode: supportsVision ? 'vision' : 'ocr'
      })
      if (res?.success) {
        const rejectedNames = new Set((res.rejected || []).map(r => r.name))
        for (const a of filesForUpload) {
          a.status = rejectedNames.has(a.name) ? 'rejected' : 'ok'
        }
        if (supportsVision) {
          const imageAccepted = (res.accepted || []).filter(a => a.kind === 'image')
          visionImageParts = imageAccepted.map((a) => {
            const b64 = base64ByClientId.get(a.clientId || '')
            if (!b64) return null
            const mime = a.mime || 'image/png'
            return {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${b64}` }
            }
          }).filter(Boolean)
        }
        const acceptedNames = (res.accepted || []).map(a => `@${a.name}`)
        if (res.contextText) {
          finalText = finalText ? `${finalText}\n\n${res.contextText}` : res.contextText
          if (acceptedNames.length > 0) {
            displayText = (displayText ? `${displayText}\n` : '') + acceptedNames.join(' ')
          }
        }
        const remaining = filesForUpload.filter(a => a.status !== 'ok')
        pendingAttachments.value = remaining
        if ((res.rejected || []).length > 0) {
          const firstErr = res.rejected[0]?.error || t('chat.attachRejected')
          error.value = firstErr
        }
      } else {
        error.value = res?.message || t('chat.attachUploadFailed')
      }
    } catch (e) {
      error.value = e?.message || t('chat.attachUploadFailed')
    }
  }

  // 如果有 @ 的文件，读取内容拼到消息末尾
  // 小文件（< 200 行）直接内联；大文件只传路径，让 AI 用 file_operation 工具自己读
  if (mentionedFiles.value.length > 0) {
    const snippetParts = []
    const newMentionedFiles = []
    const fileNames = []
    for (const f of mentionedFiles.value) {
      if (f.type === 'snippet') {
        const label = `${f.name}:${f.lineStart}-${f.lineEnd}`
        snippetParts.push(`\`\`\`${f.lang || ''}\n// @${label}\n${f.content}\n\`\`\``)
        fileNames.push(`@${label}`)
      } else {
        newMentionedFiles.push(f)
      }
    }
    // existing file processing — replace mentionedFiles.value with newMentionedFiles
    const inlineParts = []
    const largePaths = []
    for (const f of newMentionedFiles) {
      fileNames.push(`@${f.relativePath || f.name}`)
      try {
        const content = await window.electronAPI.readFile(f.path)
        if (typeof content === 'string' && content.length) {
          const lines = content.split('\n').length
          if (lines <= 200) {
            inlineParts.push(`\`\`\`\n// @${f.relativePath || f.name}\n${content}\n\`\`\``)
          } else {
            largePaths.push(`- ${f.relativePath} (${lines} lines, please read with file_operation)`)
          }
        }
      } catch { /* ignore */ }
    }
    const parts = []
    if (snippetParts.length > 0) parts.push('Relevant code snippets:\n\n' + snippetParts.join('\n\n'))
    if (inlineParts.length > 0) parts.push('Relevant file content:\n\n' + inlineParts.join('\n\n'))
    if (largePaths.length > 0) parts.push('These files are large, please read with file_operation:\n' + largePaths.join('\n'))
    if (parts.length > 0) {
      finalText = finalText + '\n\n' + parts.join('\n\n')
      displayText = (displayText ? displayText + '\n' : '') + fileNames.join(' ')
    }
    mentionedFiles.value = []
  }

  if (!String(finalText || '').trim()) {
    error.value = error.value || t('chat.attachNothingToSend')
    return
  }

  const ensuredSessionId = useAIChatInstance.ensureSessionId(currentSessionId.value || undefined)
  if (currentSessionId.value !== ensuredSessionId) {
    currentSessionId.value = ensuredSessionId
    emit('session-created', ensuredSessionId)
  }
  if (isFirstMessage) emit('first-message', { text, sessionId: ensuredSessionId })

  // 斜杠命令的 systemPrompt 优先级最高，覆盖 buildSystemPrompt
  const carryPrompt = carrySummaryForNextSession.value
    ? `[会话延续记忆]\n以下为上一会话压缩摘要，请在本轮回答中继承上下文，不要丢失关键信息：\n${carrySummaryForNextSession.value}`
    : ''
  const basePrompt = [carryPrompt, buildSystemPrompt() || ''].filter(Boolean).join('\n\n')
  const systemPrompt = slashSystemPrompt
    ? slashSystemPrompt + '\n\n---\n' + (basePrompt || '')
    : basePrompt

  const userContentParts = visionImageParts.length > 0
    ? [{ type: 'text', text: finalText }, ...visionImageParts]
    : null

  sendMessage(finalText, {
    model: currentModel.value || undefined,
    systemPrompt,
    projectPath: (props.projectPath && String(props.projectPath).trim()) || undefined,
    userContentParts,
    displayContent: finalText !== displayText ? displayText : undefined,
    panelId,
    sessionId: ensuredSessionId || undefined,
    stopPrevious: stopPrevious || undefined
  })
  if (props.studioSandboxMode) {
    studioRunInFlight.value = true
    studioWriteToolTouched.value = false
  }
  if (carrySummaryForNextSession.value) carrySummaryForNextSession.value = ''
  nextTick(() => forceScrollToBottom())
}


// ---- 智能自动滚动 ----
const BOTTOM_THRESHOLD = 60
let userScrolledUp = false
let programmaticScroll = false
// v-show 可见性变化时滚到底的 observer
let visibilityObserver = null

const isAtBottom = () => {
  const el = messagesRef.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD
}

const onScroll = () => {
  if (programmaticScroll) return
  userScrolledUp = !isAtBottom()
}

const onAIConfigUpdated = () => loadModels()

onMounted(async () => {
  messagesRef.value?.addEventListener('scroll', onScroll, { passive: true })
  messagesRef.value?.addEventListener('click', onImageClick)
  window.addEventListener('workspace-roots-changed', onWorkspaceRootsChanged)
  window.addEventListener('add-file-to-ai', onAddFileToAI)
  window.addEventListener('add-snippet-to-ai', onAddSnippetToAI)
  window.addEventListener('ai-config-updated', onAIConfigUpdated)
  window.addEventListener('focus', onWindowFocusRefetchName)

  // 用 IntersectionObserver 监听面板从隐藏变可见（v-show tab 切换），
  // 变为可见时重新拉取 Agent 名字（可能用户刚改过 IDENTITY.md）、并滚到底部
  if (panelRef.value) {
    visibilityObserver = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry.isIntersecting) {
        refetchAgentDisplayName()
        loadModels()
        if (messages.value.length > 0 && !userScrolledUp) {
          const el = messagesRef.value
          if (el) setTimeout(() => { el.scrollTop = el.scrollHeight }, 50)
        }
      }
    }, { threshold: 0.01 })
    visibilityObserver.observe(panelRef.value)
  }

  await loadModels()
  await loadSkills()
  if (window.electronAPI?.ai?.onSkillsChanged) {
    unsubscribeSkillsChanged = window.electronAPI.ai.onSkillsChanged(() => { loadSkills() })
  }
  if (props.initialSessionId) currentSessionId.value = props.initialSessionId
  await persistLoad()
  await loadConversationList()

  // 主 Agent 显示名（IDENTITY.md 中「名字：」），用于空状态与头像旁展示
  await refetchAgentDisplayName()
  await fetchIdentityPathHint()
  // 注册前端视图到 session-registry
  // projectName = 分类名（项目名 或 Agent 名字 / "AI 助手"），sessionTitle = 具体会话标题
  const lastAssistant = [...messages.value].reverse().find(m => m.role === 'assistant' && m.content)
  const projectName = props.projectPath ? props.projectPath.split('/').pop() : (agentDisplayName.value || 'AI Assistant')
  window.electronAPI?.ai?.sessionRegisterView?.({
    sessionId: panelId,
    projectPath: props.projectPath || '',
    projectName,
    sessionTitle: currentConvTitle() || '',
    model: currentModel.value || '',
    lastContent: lastAssistant?.content?.slice(-200) || '',
  }).catch(() => {})

  // 监听来自多 Agent / 子 agent 的指令注入（idle 状态下直接触发发送）
  window.electronAPI?.ai?.onSessionInjectToPanel?.((data) => {
    if (data.panelId === panelId && data.message) {
      handleExternalSend(data.message)
    }
  })
  // 飞书会话：收到新消息时切到对应会话并展示，/new 后新消息会进新 sessionId，必须切过去才能看到
  window.electronAPI?.ai?.onFeishuSessionUserMessage?.(async (data) => {
    if (!data?.sessionId || props.projectPath !== '__feishu__') return
    const incomingMsgId = String(data?.messageId || '').trim()
    if (incomingMsgId) {
      if (seenFeishuMessageIds.has(incomingMsgId)) return
      seenFeishuMessageIds.add(incomingMsgId)
      if (seenFeishuMessageIds.size > 500) {
        const keep = Array.from(seenFeishuMessageIds).slice(-250)
        seenFeishuMessageIds.clear()
        keep.forEach((id) => seenFeishuMessageIds.add(id))
      }
    }
    const incomingSessionId = data.sessionId
    const needSwitch = currentSessionId.value !== incomingSessionId
    if (needSwitch) {
      currentSessionId.value = incomingSessionId
      emit('session-loaded', incomingSessionId)
      await loadConversationList()
      const res = await window.electronAPI.ai.loadChatHistory({
        projectPath: historyProjectPath(),
        sessionId: incomingSessionId
      }).catch(() => ({}))
      if (res?.success && res?.messages?.length > 0) {
        loadMessages(res.messages)
        await restoreProvider(res.apiBaseUrl).catch(() => {})
      } else {
        useAIChatInstance.clearMessages()
      }
    }
    const text = String(data?.text || '').trim()
    // 飞书端也支持指令：/stop 停止生成；/clear 清空当前会话 UI（不发送给模型）
    if (STOP_CMD_RE.test(text)) {
      try {
        useAIChatInstance.setCurrentSessionId(incomingSessionId)
        await useAIChatInstance.stopChat()
      } catch { /* ignore */ }
      nextTick(() => forceScrollToBottom())
      return
    }
    if (CLEAR_CMD_RE.test(text)) {
      try {
        useAIChatInstance.setCurrentSessionId(incomingSessionId)
        await useAIChatInstance.stopChat()
      } catch { /* ignore */ }
      showHistory.value = false
      carrySummaryForNextSession.value = ''
      error.value = ''
      useAIChatInstance.clearMessages()
      currentSessionId.value = incomingSessionId
      syncSessionName()
      nextTick(() => forceScrollToBottom())
      return
    }
    let attachmentText = ''
    if (Array.isArray(data?.attachments) && data.attachments.length > 0) {
      const lines = []
      for (const a of data.attachments) {
        if (!a) continue
        if (a.type === 'image') lines.push(`[图片] ${a.name || ''}`.trim())
        else if (a.type === 'file') lines.push(`[文件] ${a.name || ''}`.trim())
        if (a.path) lines.push(`local_path: ${a.path}`)
      }
      attachmentText = lines.join('\n')
    }
    const userContent = [text, attachmentText].filter(Boolean).join('\n')
    const normalizedUserContent = String(userContent || '[附件]').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    messages.value.push({ role: 'user', content: normalizedUserContent })
    useAIChatInstance.setCurrentSessionId(incomingSessionId)
    useAIChatInstance.startStreamingPlaceholder()
    nextTick(() => persistSave())
    nextTick(() => forceScrollToBottom())
  })
  window.electronAPI?.ai?.onFeishuSessionUpdated?.((data) => {
    if (!data?.sessionId || props.projectPath !== '__feishu__') return
    if (!shouldProcessFeishuSessionUpdate(data)) return
    loadConversationList()
    if (currentSessionId.value === data.sessionId) {
      if (isStreaming.value) {
        feishuReloadPending.value = true
      } else {
        // 避免刚发出用户消息尚未收到 complete 时被 persistLoad 用旧数据覆盖导致丢消息
        const last = messages.value[messages.value.length - 1]
        if (last?.role === 'user') return
        persistLoad()
      }
    }
  })
  window.electronAPI?.ai?.onGatewaySessionUpdated?.((data) => {
    if (!data?.sessionId) return
    if (data.projectPath !== historyProjectPath()) return
    if (!shouldProcessGatewaySessionUpdate(data)) return
    loadConversationList()
    if (currentSessionId.value === data.sessionId) {
      const last = messages.value[messages.value.length - 1]
      if (last?.role === 'user') return
      persistLoad()
    }
  })
  // Gateway 同会话同步：浏览器发消息且当前打开的就是该会话时，展示用户消息 +「AI 回复中」并接收流式回复
  window.electronAPI?.ai?.onGatewayRemoteUserMessage?.((data) => {
    if (!data?.sessionId || data?.projectPath == null) return
    const proj = historyProjectPath()
    if (data.projectPath !== proj || data.sessionId !== currentSessionId.value) return
    const remoteText = normalizeRemoteContent(data.userContent || '')
    if (!remoteText) return
    if (!shouldProcessGatewayRemoteUserMessage(data)) return
    const last = messages.value[messages.value.length - 1]
    // 去重：若最后一条本地已是同内容 user（常见于从App窗口触发但仍收到remote同步时），忽略远端重复入队
    if (last?.role === 'user' && normalizeRemoteContent(last.content) === remoteText) return

    messages.value.push({ role: 'user', content: remoteText })
    useAIChatInstance.setCurrentSessionId(data.sessionId)
    useAIChatInstance.startStreamingPlaceholder()
    nextTick(() => persistSave())
    nextTick(() => forceScrollToBottom())
  })

  // 上报当前打开的会话，供 Gateway 判断是否同会话并转发 token/complete
  const reportSession = () => {
    window.electronAPI?.ai?.reportCurrentSession?.({
      projectPath: historyProjectPath(),
      sessionId: currentSessionId.value || ''
    })
  }
  reportSession()
  watch([currentSessionId, () => props.projectPath], reportSession)

  // 每轮对话结束后用当前完整消息列表写盘，避免被后端压缩结果覆盖导致「早期消息已压缩」后看不到完整记录
  // 注意：不能用 String(null)==='null' 与 sessionId 比较，否则在 currentSessionId 尚未写入时会误判为「非本会话」并整段跳过（预览不刷新、不落盘）
  window.electronAPI?.ai?.onComplete?.((data) => {
    const sid = data?.sessionId != null ? String(data.sessionId).trim() : ''
    const cur =
      currentSessionId.value != null && currentSessionId.value !== ''
        ? String(currentSessionId.value).trim()
        : ''
    if (sid && cur && sid !== cur) return
    nextTick(() => persistSave())
    // 窗口不在前台时提示用户（切到其他应用或最小化）
    try {
      if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) {
        window.electronAPI?.showSystemNotification?.({
          title: 'OpenUltron',
          body: 'AI 已完成本轮回复'
        })
      }
    } catch (_) { /* ignore */ }
  })

  startMarquee()
})
onActivated(() => {
  // 从其他 tab/路由回到聊天时重新拉取 Agent 名字（用户可能刚改过 IDENTITY.md）
  refetchAgentDisplayName()
  loadSkills()
})
onUnmounted(() => {
  if (typeof unsubscribeSkillsChanged === 'function') {
    unsubscribeSkillsChanged()
    unsubscribeSkillsChanged = null
  }
  window.removeEventListener('focus', onWindowFocusRefetchName)
  stopMarquee()
  document.removeEventListener('mousedown', onSlashPaletteClickOutside)
  messagesRef.value?.removeEventListener('scroll', onScroll)
  messagesRef.value?.removeEventListener('click', onImageClick)
  window.removeEventListener('workspace-roots-changed', onWorkspaceRootsChanged)
  window.removeEventListener('add-file-to-ai', onAddFileToAI)
  window.removeEventListener('add-snippet-to-ai', onAddSnippetToAI)
  window.removeEventListener('ai-config-updated', onAIConfigUpdated)
  visibilityObserver?.disconnect()
  clearInterval(scrollTimer)
  persistSave()
  // 注销前端视图
  window.electronAPI?.ai?.sessionUnregisterView?.({ sessionId: panelId }).catch(() => {})
})

const scrollToBottom = () => {
  if (userScrolledUp) return
  nextTick(() => {
    const el = messagesRef.value
    if (!el) return
    programmaticScroll = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { programmaticScroll = false })
  })
}

const forceScrollToBottom = () => {
  userScrolledUp = false
  nextTick(() => {
    const el = messagesRef.value
    if (!el) return
    programmaticScroll = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { programmaticScroll = false })
  })
}

watch(() => messages.value.length, (newLen, oldLen) => {
  if (!oldLen) { scrollToBottom(); return }
  const list = messages.value
  const last = list[list.length - 1]
  const prev = list.length >= 2 ? list[list.length - 2] : null
  if (last?.role === 'user') forceScrollToBottom()
  else if (last?.role === 'assistant' && prev?.role === 'user') forceScrollToBottom()
  else scrollToBottom()
})

let scrollTimer = null
watch(isStreaming, (streaming, wasStreaming) => {
  if (streaming) {
    scrollTimer = setInterval(scrollToBottom, 300)
  } else {
    clearInterval(scrollTimer)
    scrollToBottom()
    if (props.projectPath === '__feishu__' && feishuReloadPending.value) {
      feishuReloadPending.value = false
      persistLoad()
    }
    // 应用工作室：流式结束即刷新左侧预览（兜底 onComplete 被误过滤；并覆盖 execute_command 等写入）
    if (props.studioSandboxMode && wasStreaming === true) {
      nextTick(() => {
        try {
          window.dispatchEvent(new CustomEvent('ou-webapp-studio-preview-refresh'))
        } catch (_) { /* ignore */ }
      })
      if (studioRunInFlight.value && !studioWriteToolTouched.value) {
        messages.value.push({
          role: 'assistant',
          content: '提示：本轮未检测到任何写文件工具调用（file_operation/apply_patch/execute_command 写入）。如果你要改页面，我需要实际写入当前应用目录的文件。',
          _uiKey: genUiKey()
        })
      }
      studioRunInFlight.value = false
      studioWriteToolTouched.value = false
    }
  }
})

const handleExternalSend = (text) => {
  if (!text || isStreaming.value) return
  const ensuredSessionId = useAIChatInstance.ensureSessionId(currentSessionId.value || undefined)
  if (currentSessionId.value !== ensuredSessionId) {
    currentSessionId.value = ensuredSessionId
    emit('session-created', ensuredSessionId)
  }
  sendMessage(text, {
    model: currentModel.value || undefined,
    systemPrompt: buildSystemPrompt(),
    projectPath: (props.projectPath && String(props.projectPath).trim()) || undefined,
    panelId,
    sessionId: ensuredSessionId || undefined
  })
  if (props.studioSandboxMode) {
    studioRunInFlight.value = true
    studioWriteToolTouched.value = false
  }
  nextTick(() => forceScrollToBottom())
}

// 清空消息并开始新会话（旧会话文件保留，重置 sessionId 触发新建）
const clearMessages = () => {
  // 开启新会话时主动自我进化：根据上一会话记录提炼经验写入知识库（后台执行，不阻塞）
  const runIdForEvolve =
    useAIChatInstance.lastCompletedRunId?.value != null && String(useAIChatInstance.lastCompletedRunId.value).trim()
      ? String(useAIChatInstance.lastCompletedRunId.value).trim()
      : undefined
  if (currentSessionId.value) {
    window.electronAPI.ai.evolveFromSession({
      projectPath: historyProjectPath(),
      sessionId: currentSessionId.value,
      runId: runIdForEvolve
    }).catch(() => {})
  }
  useAIChatInstance.clearMessages()
  currentSessionId.value = null
  useAIChatInstance.setCurrentSessionId(null) // 同步 composable 内 sessionId，否则新会话首条消息会复用旧 id，可能导致事件对不上或无回复
  syncSessionName()
}

const clearChatError = () => { error.value = '' }

const openIdentityMd = () => {
  window.electronAPI?.ai?.openIdentityMd?.().catch(() => {})
}

defineExpose({ clearMessages, loadMessages, messages, handleExternalSend, isStreaming })
</script>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--ou-bg-main);
  position: relative;
  overflow: hidden;
}
.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
}
.chat-messages::-webkit-scrollbar { width: 6px; }
.chat-messages::-webkit-scrollbar-track { background: transparent; }
.chat-messages::-webkit-scrollbar-thumb { background: var(--ou-border); border-radius: 3px; }
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--ou-text-muted);
  gap: 8px;
}
.empty-icon { color: var(--ou-text-secondary); }
.avatar-logo-large { width: 40px; height: 40px; object-fit: contain; }
.chat-empty p { margin: 0; font-size: 14px; }
.chat-empty .hint { font-size: 12px; color: var(--ou-text-muted); }
.chat-empty-edit-role {
  margin-top: 10px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--ou-text-muted);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.chat-empty-edit-role:hover { color: var(--ou-primary); background: var(--ou-bg-hover); }
.chat-empty-path-hint { margin-top: 8px; font-size: 11px; color: var(--ou-text-muted); }
.chat-session-type-bar {
  flex-shrink: 0;
  padding: 6px 16px;
  font-size: 12px;
  color: var(--ou-text-muted);
  border-bottom: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
}
.chat-session-type-label { font-weight: 500; color: var(--ou-text-secondary); }
.chat-compression-notice {
  margin: 12px 16px;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--ou-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ou-warning) 30%, transparent);
  border-radius: 8px;
  color: var(--ou-warning);
}
.compression-notice-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 10px;
}
.compression-notice-head span { flex: 1; line-height: 1.5; }
.compression-notice-body {
  margin: 0;
  padding: 10px 12px;
  background: var(--ou-bg-hover);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 40vh;
  overflow-y: auto;
}
/* 顶栏：Context Tokens 细条，固定在聊天区顶部，不随消息滚动 */
.chat-usage-strip {
  flex-shrink: 0;
  border-bottom: 1px solid var(--ou-border);
  background: var(--ou-bg-sidebar);
  font-size: 11px;
  line-height: 1.35;
  color: var(--ou-text-muted);
}
.chat-usage-strip-inner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding: 4px 12px 3px;
  min-width: 0;
}
.chat-usage-strip-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  padding: 0 12px 4px;
  min-width: 0;
}
.chat-usage-strip-label {
  font-weight: 600;
  color: var(--ou-text-secondary);
  letter-spacing: 0.02em;
}
.chat-usage-strip-total {
  font-variant-numeric: tabular-nums;
  color: var(--ou-text);
  font-weight: 600;
}
.chat-usage-strip-sep {
  opacity: 0.45;
  user-select: none;
}
.chat-usage-strip-parts {
  font-variant-numeric: tabular-nums;
  min-width: 0;
  flex: 1 1 auto;
}
.chat-usage-strip-iter {
  font-variant-numeric: tabular-nums;
  color: var(--ou-text-secondary);
  margin-left: auto;
}
.chat-usage-meta-item {
  font-variant-numeric: tabular-nums;
  color: var(--ou-text-secondary);
}
.chat-usage-strip-bar {
  display: flex;
  height: 2px;
  width: 100%;
  overflow: hidden;
  opacity: 0.85;
}
.chat-usage-seg {
  display: block;
  height: 100%;
  min-width: 0;
  transition: width 0.15s ease;
}
.chat-usage-seg-sys {
  background: color-mix(in srgb, var(--ou-primary) 55%, var(--ou-bg-main));
}
.chat-usage-seg-summary {
  background: color-mix(in srgb, var(--ou-success, #10b981) 45%, var(--ou-bg-main));
}
.chat-usage-seg-user {
  background: color-mix(in srgb, var(--ou-info, #3b82f6) 55%, var(--ou-bg-main));
}
.chat-usage-seg-assistant {
  background: color-mix(in srgb, var(--ou-link) 50%, var(--ou-bg-main));
}
.chat-usage-seg-tool {
  background: color-mix(in srgb, var(--ou-warning) 45%, var(--ou-bg-main));
}
.streaming-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  color: var(--ou-text-muted);
  font-size: 12px;
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.chat-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  margin: 8px 0;
  background: color-mix(in srgb, var(--ou-error) 15%, transparent);
  border-radius: 8px;
  color: var(--ou-error);
  font-size: 13px;
}
.chat-error-text { flex: 1; word-break: break-word; }
.chat-error-dismiss {
  flex-shrink: 0;
  padding: 2px 8px;
  border: none;
  background: transparent;
  color: var(--ou-error);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.8;
}
.chat-error-dismiss:hover { opacity: 1; }

/* 输入区：默认高度与左侧 sidebar-footer 一致，内容上下居中；多行时自适应增高；分割线与左侧栏 footer 顶线对齐 */
.chat-input-area {
  flex-shrink: 0;
  width: 100%;
  min-height: 60px;
  border-top: 1px solid var(--ou-border);
  padding: 0 12px;
  display: flex;
  align-items: center;
  background: var(--ou-bg-sidebar);
  box-sizing: border-box;
}

.input-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  position: relative;
  width: 100%;
  min-width: 0;
}

.input-row textarea {
  flex: 1;
  min-width: 0;
  background: var(--ou-bg-main);
  border: none;
  border-radius: 0;
  color: var(--ou-text);
  font-size: 13px;
  resize: none;
  line-height: 1.5;
  font-family: inherit;
  outline: none;
  overflow-y: auto;
}

.input-row textarea:disabled { opacity: 0.5; }

/* textarea + @ 文件标签的容器 */
.textarea-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.textarea-wrap:focus-within { border-color: var(--ou-primary); }

/* 输入行：左侧指令小标签 + 右侧输入框（同一行） */
.input-inner {
  flex: 1;
  min-width: 0;
  min-height: 36px;
  display: flex;
  flex-direction: row;
  align-items: stretch;
}
/* 指令小标签：在输入框前边，删除键可删掉 */
.slash-tag-inline {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px 0 10px;
  margin: 6px 0 6px 6px;
  border-radius: 6px;
  font-size: 12px;
  border-right: 1px solid var(--ou-border);
}
.slash-tag-inline.slash-skill   { color: var(--ou-warning); background: color-mix(in srgb, var(--ou-warning) 15%, transparent); }
.slash-tag-inline.slash-command { color: var(--ou-link); background: color-mix(in srgb, var(--ou-link) 15%, transparent); }
.slash-tag-inline span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.slash-tag-inline .slash-tag-remove {
  margin-left: 2px;
  padding: 0 2px;
  background: none;
  border: none;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.slash-tag-inline .slash-tag-remove:hover { opacity: 1; }
.slash-prompt-check {
  margin: 6px 0 4px;
  width: 100%;
  border: 1px solid color-mix(in srgb, var(--ou-warning) 35%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ou-warning) 12%, transparent);
  padding: 8px 10px;
  color: var(--ou-warning);
}
.slash-prompt-check--danger {
  border-color: color-mix(in srgb, var(--ou-error) 45%, transparent);
  background: color-mix(in srgb, var(--ou-error) 12%, transparent);
  color: var(--ou-error);
}
.slash-prompt-check-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}
.slash-prompt-check-length {
  margin-left: auto;
  color: var(--ou-text-secondary);
  font-weight: 500;
}
.slash-prompt-check-body {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: color-mix(in srgb, #000 5%, transparent);
  border-radius: 6px;
  max-height: 96px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.45;
}
.slash-prompt-check-note {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.4;
}

.input-inner-field {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 36px;
}
.input-inner-field textarea {
  flex: 0 0 auto;
  min-height: 36px;
  height: 36px;
  padding: 6px 12px;
  margin: 0;
  border: none;
  border-radius: 0;
  resize: none;
  max-height: 114px;
  overflow-y: auto;
  transition: height 0.1s ease;
}
/* 跑马灯：盖在输入框上，无内容时显示，上下居中，字号与输入一致 */
.marquee-hint {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0 12px;
  display: flex;
  align-items: center;
  font-size: 13px;
  color: var(--ou-text-muted);
  pointer-events: none;
}

/* @ 文件提及标签 */
.mention-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px 4px;
  background: var(--ou-bg-main);
  border-bottom: 1px solid var(--ou-border);
}
.mention-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 6px;
  background: color-mix(in srgb, var(--ou-link) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--ou-link) 30%, transparent);
  border-radius: 10px;
  font-size: 11px;
  color: var(--ou-link);
  cursor: default;
  max-width: 200px;
}
.mention-tag span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mention-tag-remove {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.5;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
}
.mention-tag-remove:hover { opacity: 1; }

.attachment-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px 4px;
  background: var(--ou-bg-main);
  border-bottom: 1px solid var(--ou-border);
}
.attachment-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 6px;
  background: color-mix(in srgb, var(--ou-success) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ou-success) 30%, transparent);
  border-radius: 10px;
  font-size: 11px;
  color: var(--ou-text);
  max-width: 230px;
}
.attachment-tag span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachment-tag em {
  font-style: normal;
  opacity: 0.7;
}
.attachment-tag-rejected {
  background: color-mix(in srgb, var(--ou-error) 14%, transparent);
  border-color: color-mix(in srgb, var(--ou-error) 30%, transparent);
}
.attachment-tag-degraded {
  background: color-mix(in srgb, var(--ou-warning) 14%, transparent);
  border-color: color-mix(in srgb, var(--ou-warning) 30%, transparent);
}
.attachment-tag-remove {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
}
.attachment-tag-remove:hover { opacity: 1; }

.file-input-hidden { display: none; }
.attach-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-main);
  color: var(--ou-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}
.attach-btn:hover {
  border-color: var(--ou-primary);
  color: var(--ou-primary);
}

.send-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: none;
  background: var(--ou-primary);
  color: var(--ou-accent-fg);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}
.send-btn:hover { background: var(--ou-primary-hover); }
.send-btn:disabled { opacity: 0.4; cursor: default; }
.send-btn.stop { background: var(--ou-error); }
.send-btn.stop:hover { opacity: 0.9; }

/* 确认对话框 */
.confirm-dialog {
  display: flex;
  gap: 10px;
  margin: 8px 16px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--ou-border);
  background: var(--ou-bg-card);
}
.confirm-dialog.warning { border-color: color-mix(in srgb, var(--ou-warning) 35%, transparent); background: color-mix(in srgb, var(--ou-warning) 10%, transparent); }
.confirm-dialog.danger  { border-color: color-mix(in srgb, var(--ou-error) 35%, transparent); background: color-mix(in srgb, var(--ou-error) 10%, transparent); }
.confirm-dialog.info    { border-color: color-mix(in srgb, var(--ou-primary) 35%, transparent); background: color-mix(in srgb, var(--ou-primary) 10%, transparent); }
.confirm-icon { flex-shrink: 0; padding-top: 1px; }
.confirm-dialog.warning .confirm-icon { color: var(--ou-warning); }
.confirm-dialog.danger  .confirm-icon { color: var(--ou-error); }
.confirm-dialog.info    .confirm-icon { color: var(--ou-primary); }
.confirm-body { flex: 1; min-width: 0; }
.confirm-title   { font-size: 13px; font-weight: 600; color: var(--ou-text); margin-bottom: 4px; }
.confirm-message { font-size: 12px; color: var(--ou-text-muted); line-height: 1.5; margin-bottom: 10px; white-space: pre-wrap; }
.confirm-input {
  width: 100%;
  background: var(--ou-bg-main);
  border: 1px solid var(--ou-border);
  border-radius: 4px;
  color: var(--ou-text);
  font-size: 12px;
  font-family: inherit;
  padding: 7px 10px;
  outline: none;
  resize: vertical;
  line-height: 1.5;
  margin-bottom: 10px;
  box-sizing: border-box;
}
.confirm-input:focus { border-color: var(--ou-primary); }
.confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
.confirm-btn {
  padding: 5px 14px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--ou-border);
  transition: all 0.15s;
}
.confirm-btn.cancel { background: transparent; color: var(--ou-text-muted); }
.confirm-btn.cancel:hover { background: var(--ou-bg-hover); color: var(--ou-text); }
.confirm-btn.ok { background: var(--ou-primary); border-color: var(--ou-primary); color: var(--ou-accent-fg); }
.confirm-btn.ok:hover { background: var(--ou-primary-hover); }
.confirm-btn.ok.push { background: var(--ou-success); border-color: var(--ou-success); }
.confirm-btn.ok.push:hover { opacity: 0.9; }
.confirm-btn.ok.danger  { background: var(--ou-error); border-color: var(--ou-error); }
.confirm-btn.ok.danger:hover  { opacity: 0.9; }
.confirm-btn.ok.warning { background: var(--ou-warning); border-color: var(--ou-warning); color: var(--ou-bg-main); }
.confirm-btn.ok.warning:hover { opacity: 0.9; }

</style>
