<template>
  <div class="chat-panel" ref="panelRef">
    <!-- 消息列表 -->
    <div class="chat-messages" ref="messagesRef">
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
        :key="idx"
        :message="msg"
        :agent-display-name="agentDisplayName"
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
        <div class="textarea-wrap">
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
                :disabled="isStreaming"
                @keydown="onKeyDown"
                @input="onInput"
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
          :disabled="!inputText.trim() && !hasActiveSlash"
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
import { Loader, AlertCircle, AlertTriangle, Info, Send, Square, Zap, FileCode, Code } from 'lucide-vue-next'
import ChatMessage from './ChatMessage.vue'
import SlashPalette from './SlashPalette.vue'
import MentionPalette from './MentionPalette.vue'
import ImageViewer from './ImageViewer.vue'
import { useAIChat } from '../../composables/useAIChat'
import { useLogoUrl } from '../../composables/useLogoUrl.js'
import { useI18n } from '../../composables/useI18n'

const logoUrl = useLogoUrl()
const { t } = useI18n()
const props = defineProps({
  systemPrompt: { type: String, default: '' },
  model: { type: String, default: '' },
  projectPath: { type: String, default: '' },
  enableMention: { type: Boolean, default: true },  // 是否支持 @ 文件提及（非项目页面禁用）
  initialSessionId: { type: String, default: null }  // 主会话传入的当前会话 id，用于加载指定会话或与 URL 同步
})

const emit = defineEmits(['first-message', 'model-change', 'provider-change', 'session-loaded', 'session-created'])

const useAIChatInstance = useAIChat()
const { messages, isStreaming, error, pendingConfirm, sendMessage, stopChat, loadMessages, respondConfirm } = useAIChatInstance

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

// 仅展示 user/assistant，避免被压缩后只含 system 的会话出现整屏空白（ChatMessage 不渲染 system）
const displayMessages = computed(() =>
  messages.value.filter(m => m.role === 'user' || m.role === 'assistant')
)

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

// ---- 模型：使用配置默认或会话保存的模型，不再提供底部切换 UI ----
const currentModel = ref('')

const loadModels = async () => {
  try {
    const configRes = await window.electronAPI.ai.getConfig()
    if (configRes.success && configRes.config) {
      const defaultModel = configRes.config.defaultModel || ''
      if (props.model) {
        currentModel.value = props.model
      } else {
        currentModel.value = defaultModel
      }
    }
  } catch { /* ignore */ }
}

// 当父组件传入 model 变化时（首次加载会话时同步）
watch(() => props.model, (val) => {
  if (val && val !== currentModel.value) currentModel.value = val
}, { immediate: true })

// ---- 技能（自动注入，无需手动选择）----
const skills = ref([])
const agentMdContent = ref(null)  // 当前项目 AGENT.md 内容

const loadSkills = async () => {
  try {
    const res = await window.electronAPI.ai.getSkills()
    if (res.success) skills.value = res.skills || []
  } catch { /* ignore */ }
}

const loadAgentMd = async () => {
  try {
    const projectPath = props.projectPath
    if (!projectPath) return
    const res = await window.electronAPI.ai.readAgentMd({ projectPath })
    agentMdContent.value = res?.content || null
  } catch { /* ignore */ }
}

// ---- 斜杠命令 ----
const slashPaletteRef = ref(null)
const showSlash = ref(false)
const slashCategory = ref('')   // '' | 'skills' | 'mcp'
const slashQuery = ref('')
// 斜杠选择：多技能
const activeSlashSkills = ref([])
const hasActiveSlash = computed(() => activeSlashSkills.value.length > 0)

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

// 跑马灯快捷指令提示（轮播）
const MARQUEE_HINTS = [
  'Type / to choose skills or commands',
  'Enter to send · Shift+Enter for newline',
  '/skills for skills · /mcp for MCP tools',
]
const marqueeHintIndex = ref(0)
const marqueeHint = computed(() => MARQUEE_HINTS[marqueeHintIndex.value] ?? MARQUEE_HINTS[0])
let marqueeTimer = null
function startMarquee() {
  if (marqueeTimer) return
  marqueeTimer = setInterval(() => {
    marqueeHintIndex.value = (marqueeHintIndex.value + 1) % MARQUEE_HINTS.length
  }, 2800)
}
function stopMarquee() {
  if (marqueeTimer) {
    clearInterval(marqueeTimer)
    marqueeTimer = null
  }
}

// 一级菜单：分类（自进化由后台自动执行，不再提供 /evolve 指令）
const SLASH_CATEGORIES = [
  { id: 'skills', name: 'skills', description: 'Skills', type: 'category' },
  { id: 'mcp', name: 'mcp', description: 'MCP Tools', type: 'category' },
]

// 根据当前分类和 query 计算候选列表
const slashItems = computed(() => {
  const q = slashQuery.value.toLowerCase()

  if (!slashCategory.value) {
    return SLASH_CATEGORIES.filter(c => !q || c.id.includes(q) || c.description.includes(q))
  }

  let items = []
  if (slashCategory.value === 'skills') {
    items = skills.value.map(s => ({
      id: s.id, name: s.name, description: s.description, type: 'skill', raw: s
    }))
  } else if (slashCategory.value === 'mcp') {
    items = mcpServers.value
  }

  if (!q) return items
  return items.filter(i =>
    i.name?.toLowerCase().includes(q) ||
    i.description?.toLowerCase().includes(q)
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
    const knownCats = ['skills', 'mcp']
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

// 当前日期，供 AI 回答「今天」类问题时使用
const currentDateLabel = () => {
  const d = new Date()
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

// 构建最终 systemPrompt：基础 prompt + 技能目录（不含内容，AI 按需调用 get_skill 工具获取）
const buildSystemPrompt = () => {
  const parts = []
  // 当前应用边界：本应用为 OpenUltron；用户要求改本机其他项目时直接操作，不预写具体项目名或路径
  parts.push(
    '## 当前应用\n' +
    '你正在运行的应用是 **OpenUltron**（本应用）。' +
    '当用户要求修改或配置本机其他项目、某仓库或用户提到的任意名称时，你应当直接操作：用 execute_command 查找路径，用 file_operation 读取与修改配置文件；不要推脱或仅请用户提供路径。具体是什么项目、配置文件名与目录结构由你通过检索或用户表述自行判断。\n' +
    '**名字与身份**：当用户说「改名字」「改身份」「修改角色」等且未指明外部项目时，指本应用（OpenUltron）的 IDENTITY.md、SOUL.md。两文件在**应用根目录**（与 prompts 同级），如 ~/.openultron/IDENTITY.md、~/.openultron/SOUL.md；文件名为**大写** IDENTITY.md、SOUL.md，勿写入 prompts/ 或 identity.md（小写）。可引导用户点「编辑我的名字与角色」打开，或用 file_operation 写上述路径；勿误解为改 OpenClaw 等。'
  )
  const todayStr = currentDateLabel()
  parts.push(`当前日期：${todayStr}。回答中凡涉及「今天」「本月」「当前」等时间，必须使用此日期（${todayStr}），不得使用搜索结果或其它来源的日期。`)
  // 联网与工具优先级：必须优先尝试搜索，且禁止同一轮对话内重复多次搜索造成死循环
  parts.push(
    '## 本地检索与命令自我进化\n' +
    '在项目中查找代码、文件、内容时，**由你自行决定**用哪些命令或 file_operation，不提供固定命令示例。\n' +
    '**命令执行日志**：每次 execute_command 的成功/失败会写入本地记录。你可通过 **query_command_log**（query 取 summary 或 both）查看当前项目下已执行次数、成功/失败统计、已查看过的目录与文件。请据此自我总结：哪些命令有效、哪些失败，避免重复失败、优化后续命令选择，实现自我进化。不要依赖提示词中的命令列表，以实际执行结果与日志为准。'
  )
  parts.push(
    '## 联网与实时信息\n' +
    '1) 搜索：当用户询问天气、新闻、股价、实时事件、技术文档等时，**必须调用已配置的 MCP 搜索工具**（如 Serper、Brave Search 等）。若未配置任何搜索 MCP，告知用户需在设置中添加搜索类 MCP（如 serper-mcp）。禁止对同一问题重复多次调用；获得结果后立即作答。\n' +
    '2) 抓取链接：当用户给出具体 URL 时，优先用 `web_fetch` 抓取正文；需登录或动态渲染时，**优先使用 chrome-devtools MCP**（已内置，能力最强）；chrome-devtools 失败或不可用时再用内置 `webview_control`（打开/截屏/点击/填表/执行 JS 等）。两者互补，webview 扩展 Chrome 不可用时的能力。'
  )
  parts.push(
    '## 经验总结与知识库\n' +
    '知识库 LESSONS_LEARNED 会在**每次对话开始时自动注入**给你，无需再调 read_lessons_learned 即可直接按其中经验执行。用户要求「总结经验」或对话中产生可复用教训时，用 **lesson_save** 写入：须写**详细**——含① 具体场景/问题 ② 失败原因或成功做法 ③ 可复用的命令、路径或步骤（便于下次直接套用），避免只写一句话概括；这样后续对话才能快速利用。'
  )
  parts.push(
    '## 脚本能力与技能沉淀\n' +
    '你拥有 run_script 工具：可在 ~/.openultron/temp/<task_id>/ 下编写并运行 Python 脚本，用于当前工具无法直接完成的任务。' +
    '典型场景：爬取新闻/天气/小红书/公众号、读取 Excel/PDF/Word（可用 requirements 指定 openpyxl、PyPDF2、python-docx 等）、复杂数据处理。' +
    '脚本运行成功后，若逻辑可复用，必须调用 install_skill 将该脚本保存为技能：content 为完整 SKILL.md，frontmatter 含 type: script，正文为 Python 代码。' +
    '技能会随「AI 数据备份/恢复」一起备份与恢复；后续同类需求可先 get_skill 获取脚本再 run_script 执行。'
  )
  parts.push(
    '## 查找并修改本机其他项目\n' +
    '用户要求查看或修改本机某项目、某仓库或用户提到的任意名称时：**自行决定**用 execute_command 执行哪些命令定位，用 file_operation 读改配置；不得未执行就称找不到或向用户索要路径。可先调用 query_command_log 看当前项目下曾执行过的命令与成功/失败情况，再决定本次用什么命令。具体项目名称、常见路径、配置文件与目录结构由你自行检索或根据用户表述判断，提示词中不预设。\n' +
    '**回复风格**：不要写「我来帮你…」「让我执行搜索命令」等固定话术；不要输出「可能的原因和建议」「请提供以下任一信息」等模板式列表。直接执行、根据结果继续或简短说明已尝试与下一步。'
  )
  if (props.systemPrompt) parts.push(props.systemPrompt)
  if (skills.value.length > 0) {
    // 仅列出 id + name，不含描述，减少 token 占用；完整内容由 AI 按需调用 get_skill 获取
    const skillList = skills.value
      .filter(s => s.id)
      .map(s => `- [${s.id}] ${s.name}`)
      .join('\n')
    parts.push(
      `你有以下可用技能（共 ${skills.value.length} 个），请根据用户意图自动判断是否需要使用。` +
      `需要使用某个技能时，先调用 get_skill(action="get", skill_id="...") 获取完整内容（含描述和步骤）后严格执行：\n\n${skillList}\n\n` +
      `## 技能自动优化规则\n` +
      `当你执行某个技能并在对话中做了调整（如修复了步骤错误、补充了遗漏环节、根据用户反馈优化了流程），` +
      `在对话结束前必须调用 install_skill(action="update") 将最终正确的版本写回该技能文件。\n` +
      `触发条件（满足任一即更新）：\n` +
      `1. 执行技能时遇到报错，调整后成功\n` +
      `2. 用户指出技能步骤有问题并确认了修正方案\n` +
      `3. 你主动补充了技能中缺失的关键步骤且用户认可\n` +
      `4. 你通过 run_script 写出的脚本运行成功且可复用，必须用 install_skill 保存为 type: script 技能\n` +
      `更新时保留原有 frontmatter，只修改正文内容，不得降低原有步骤的完整性。\n\n` +
      `## git commit 确认规则\n` +
      `执行 git commit 前调用 user_confirmation 时，必须带上 allow_push: true 参数，` +
      `让用户可以选择「确认并推送」一步完成提交+推送。若用户选择「确认并推送」，` +
      `工具返回结果中 push_after_commit 为 true，此时在 commit 成功后立即执行 git push origin <当前分支>。`
    )
  }
  // 注入项目 AGENT.md（如存在）
  if (agentMdContent.value) {
    parts.push(`## 项目上下文（AGENT.md）\n${agentMdContent.value}`)
  }

  return parts.join('\n\n') || undefined
}

// ---- @ 文件提及 ----
const mentionPaletteRef = ref(null)
const showMention = ref(false)
const mentionQuery = ref('')
const mentionItems = ref([])
const mentionLoading = ref(false)
const mentionedFiles = ref([])   // 已选中的文件列表
let mentionSearchTimer = null
let mentionAtStart = -1          // @ 符号在 textarea 中的位置

// 编辑器当前打开的文件列表（通过全局事件同步）
const editorOpenFiles = ref([])
const onEditorFilesChanged = (e) => { editorOpenFiles.value = e.detail || [] }

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

// 当 @ 弹框打开时，向全局派发请求当前打开文件列表（若有监听方如编辑器可响应）
const requestEditorFiles = () => {
  window.dispatchEvent(new CustomEvent('request-editor-open-files'))
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
  // query 为空时，优先展示编辑器已打开的文件（最多 10 个）
  if (!q) {
    if (editorOpenFiles.value.length > 0) {
      mentionItems.value = editorOpenFiles.value.slice(0, 10).map(f => ({
        path: f.filePath,
        name: f.fileName,
        relativePath: toRelativeWithProject(f.filePath),
        type: 'file'
      }))
      return
    }
  }

  // 搜索所有工作区根目录
  const roots = workspaceRoots.value.length > 0
    ? workspaceRoots.value
    : (props.projectPath ? [{ path: props.projectPath, name: props.projectPath.split('/').pop() }] : [])

  if (!roots.length) return
  mentionLoading.value = true
  try {
    // 并发搜索所有根目录
    const results = await Promise.all(
      roots.map(root =>
        window.electronAPI.editor.searchFiles({ rootPath: root.path, query: q || '' })
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
      requestEditorFiles()
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
const messagesRef = ref(null)
const panelRef = ref(null)
const isComposing = ref(false)  // 中文输入法合成中

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

// 构建斜杠技能注入的 system prompt
const buildSlashSystemPrompt = async (item) => {
  if (!item) return null
  if (item.type === 'skill') {
    return item.raw.prompt || null
  }
  return null
}

const handleSend = async () => {
  const text = inputText.value.trim()
  if (!text && !hasActiveSlash.value) return
  if (isStreaming.value) return

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

  // /new：先压缩归档当前会话，再切到新会话；下一轮自动携带摘要
  const isNewCmd = /^\/new\s*$/i.test(text) || text === '/new'
  if (isNewCmd) {
    inputText.value = ''
    adjustTextareaHeight()
    const summary = buildSessionSummary(messages.value)
    if (summary) carrySummaryForNextSession.value = summary
    if (currentSessionId.value != null && currentSessionId.value !== '') {
      const userMsg = { role: 'user', content: '/new' }
      const assistantMsg = { role: 'assistant', content: '已归档当前会话并开启新会话。历史记忆将自动继承。' }
      messages.value = [...messages.value, userMsg, assistantMsg]
      if (summary) {
        await window.electronAPI.ai.saveSessionSummary({
          projectPath: historyProjectPath(),
          sessionId: currentSessionId.value,
          messages: messages.value
        }).catch(() => {})
      }
      await persistSave()
    }
    startNewConversation()
    if (summary) {
      messages.value = [{ role: 'assistant', content: '新会话已创建，并继承上一会话摘要。可发送 /history 查看历史摘要。' }]
    }
    return
  }

  inputText.value = ''
  adjustTextareaHeight()
  const isFirstMessage = messages.value.filter(m => m.role === 'user').length === 0

  let finalText = text
  let slashSystemPrompt = null

  if (activeSlashSkills.value.length > 0) {
    const prompts = await Promise.all(activeSlashSkills.value.map(s => buildSlashSystemPrompt(s)))
    slashSystemPrompt = prompts.filter(Boolean).join('\n\n')
    if (!finalText) {
      finalText = activeSlashSkills.value.length === 1
        ? `Using skill: ${activeSlashSkills.value[0].name}`
        : `Using selected skills (${activeSlashSkills.value.map(s => s.name).join(', ')})`
    }
    clearSlash()
  }

  // 如果有 @ 的文件，读取内容拼到消息末尾
  // 小文件（< 200 行）直接内联；大文件只传路径，让 AI 用 file_operation 工具自己读
  let displayText = finalText  // 展示给用户看的消息（不含文件内容）
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
        const res = await window.electronAPI.editor.readFile({ filePath: f.path })
        if (res?.success && res.content) {
          const lines = res.content.split('\n').length
          if (lines <= 200) {
            inlineParts.push(`\`\`\`\n// @${f.relativePath || f.name}\n${res.content}\n\`\`\``)
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

  if (isFirstMessage) emit('first-message', { text, sessionId: currentSessionId.value })

  // 斜杠命令的 systemPrompt 优先级最高，覆盖 buildSystemPrompt
  const carryPrompt = carrySummaryForNextSession.value
    ? `[会话延续记忆]\n以下为上一会话压缩摘要，请在本轮回答中继承上下文，不要丢失关键信息：\n${carrySummaryForNextSession.value}`
    : ''
  const basePrompt = [carryPrompt, buildSystemPrompt() || ''].filter(Boolean).join('\n\n')
  const systemPrompt = slashSystemPrompt
    ? slashSystemPrompt + '\n\n---\n' + (basePrompt || '')
    : basePrompt

  sendMessage(finalText, {
    model: currentModel.value || undefined,
    systemPrompt,
    projectPath: props.projectPath || undefined,
    displayContent: finalText !== displayText ? displayText : undefined,
    panelId,
    sessionId: currentSessionId.value || undefined
  })
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
  window.addEventListener('editor-open-files-changed', onEditorFilesChanged)
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
  await loadAgentMd()
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
    messages.value.push({ role: 'user', content: data.text || '' })
    useAIChatInstance.setCurrentSessionId(incomingSessionId)
    useAIChatInstance.startStreamingPlaceholder()
    nextTick(() => forceScrollToBottom())
  })
  window.electronAPI?.ai?.onFeishuSessionUpdated?.((data) => {
    if (!data?.sessionId || props.projectPath !== '__feishu__') return
    loadConversationList()
    if (currentSessionId.value === data.sessionId) {
      persistLoad()
    }
  })
  window.electronAPI?.ai?.onGatewaySessionUpdated?.((data) => {
    if (!data?.sessionId) return
    if (data.projectPath !== historyProjectPath()) return
    loadConversationList()
    if (currentSessionId.value === data.sessionId) {
      persistLoad()
    }
  })
  // Gateway 同会话同步：浏览器发消息且当前打开的就是该会话时，展示用户消息 +「AI 回复中」并接收流式回复
  window.electronAPI?.ai?.onGatewayRemoteUserMessage?.((data) => {
    if (!data?.sessionId || data?.projectPath == null) return
    const proj = historyProjectPath()
    if (data.projectPath !== proj || data.sessionId !== currentSessionId.value) return
    messages.value.push({ role: 'user', content: data.userContent || '' })
    useAIChatInstance.setCurrentSessionId(data.sessionId)
    useAIChatInstance.startStreamingPlaceholder()
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
  window.electronAPI?.ai?.onComplete?.((data) => {
    if (data?.sessionId != null && String(data.sessionId) !== String(currentSessionId.value)) return
    nextTick(() => persistSave())
  })

  startMarquee()
})
onActivated(() => {
  // 从其他 tab/路由回到聊天时重新拉取 Agent 名字（用户可能刚改过 IDENTITY.md）
  refetchAgentDisplayName()
})
onUnmounted(() => {
  window.removeEventListener('focus', onWindowFocusRefetchName)
  stopMarquee()
  document.removeEventListener('mousedown', onSlashPaletteClickOutside)
  messagesRef.value?.removeEventListener('scroll', onScroll)
  messagesRef.value?.removeEventListener('click', onImageClick)
  window.removeEventListener('editor-open-files-changed', onEditorFilesChanged)
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
watch(isStreaming, (streaming) => {
  if (streaming) {
    scrollTimer = setInterval(scrollToBottom, 300)
  } else {
    clearInterval(scrollTimer)
    scrollToBottom()
  }
})

const handleExternalSend = (text) => {
  if (!text || isStreaming.value) return
  sendMessage(text, {
    model: currentModel.value || undefined,
    systemPrompt: buildSystemPrompt(),
    projectPath: props.projectPath || undefined,
    panelId,
    sessionId: currentSessionId.value || undefined
  })
  nextTick(() => forceScrollToBottom())
}

// 清空消息并开始新会话（旧会话文件保留，重置 sessionId 触发新建）
const clearMessages = () => {
  // 开启新会话时主动自我进化：根据上一会话记录提炼经验写入知识库（后台执行，不阻塞）
  if (currentSessionId.value) {
    window.electronAPI.ai.evolveFromSession({
      projectPath: historyProjectPath(),
      sessionId: currentSessionId.value
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
