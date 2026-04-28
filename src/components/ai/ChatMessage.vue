<template>
  <!-- 用户消息（右侧） -->
  <div v-if="message.role === 'user'" class="user-row">
    <div class="chat-bubble user">
      <div class="bubble-avatar user-avatar"><User :size="14" /></div>
      <div class="bubble-body">
        <div class="bubble-name">{{ t('chatMessage.me') }}</div>
        <div class="bubble-text user-text">{{ message.content }}</div>
        <div v-if="screenshotsInMessage.length" class="message-screenshots user-message-screenshots">
          <img
            v-for="(src, idx) in screenshotsInMessage"
            :key="`user-shot-${idx}`"
            class="chat-image message-screenshot-img"
            :src="src"
            :alt="t('chatMessage.screenshot')"
          />
        </div>
        <div v-if="messageArtifactsNonImage.length" class="message-artifacts user-message-artifacts">
          <template v-for="(art, idx) in messageArtifactsNonImage" :key="art.artifactId || art.path || idx">
            <div class="message-artifact-card">
              <div class="message-artifact-head">
                <span class="message-artifact-icon">
                  <component :is="artifactIcon(art)" :size="14" />
                </span>
                <span class="message-artifact-kind">{{ artifactTypeLabel(art) }}</span>
                <span class="message-artifact-name" :title="art.name || art.openPath || art.path">{{ art.name || artifactDisplayPath(art) }}</span>
              </div>
              <button
                v-if="isModalPreviewableArtifact(art)"
                type="button"
                class="message-artifact-file"
                :title="art.name || art.path"
                @click="openArtifactPreviewModal(art)"
              >{{ art.name || (art.kind === 'file' ? '文件' : art.kind) }}</button>
              <span
                v-else
                class="message-artifact-file message-artifact-file-static"
                :title="art.name || art.path"
              >{{ art.name || (art.kind === 'file' ? '文件' : art.kind) }}</span>
              <div class="message-artifact-meta">
                <span>{{ artifactTypeLabel(art) }}</span>
                <span v-if="art.sourceLabel">{{ art.sourceLabel }}</span>
                <span v-if="art.sizeText">{{ art.sizeText }}</span>
                <span class="message-artifact-path" :title="art.openPath || art.path">{{ artifactDisplayPath(art) }}</span>
              </div>
              <div class="message-artifact-actions">
                <button
                  v-if="isRevealableArtifact(art)"
                  type="button"
                  class="message-artifact-reveal"
                  @click="revealArtifact(art)"
                >文件夹</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>

  <!-- assistant：左侧头像，右侧昵称+命令卡片+正文（命令与昵称对齐） -->
  <template v-else-if="message.role === 'assistant'">
    <div v-if="toolCallsToRender.length || message.content?.trim()" class="chat-bubble assistant">
      <div class="bubble-avatar ai-avatar"><img :src="logoUrl" :alt="agentDisplayName || 'Ultron'" class="avatar-logo" /></div>
      <div class="bubble-body">
        <div class="bubble-name">
          {{ agentDisplayName || 'Ultron' }}
          <button class="copy-btn" :class="{ copied }" @click="copyContent" :title="copied ? t('chatMessage.copied') : t('chatMessage.copy')">
            <Check v-if="copied" :size="11" />
            <Copy v-else :size="11" />
          </button>
        </div>

        <!-- 命令/工具卡片：与昵称同列，左对齐 -->
        <template v-for="(tc, idx) in toolCallsToRender" :key="tc?.id || `tc-${idx}`">
          <div
            class="tool-card"
            :class="tcStatus(tc)"
          >
            <div class="tc-header" @click="toggleExpanded(tc)">
              <div class="tc-left">
                <div class="tc-status-dot"></div>
                <component :is="toolIcon(tc.name)" :size="12" class="tc-type-icon" />
                <div class="tc-texts">
                  <div class="tc-topline">
                    <span class="tc-name">{{ toolLabel(tc) }}</span>
                    <span v-if="tc.name === 'execute_command' && (commandOf(tc) || cwdOf(tc))" class="tc-summary-text tc-command-inline">
                      <code v-if="commandOf(tc)" class="tc-cmd-inline">{{ commandOf(tc) }}</code>
                      <span v-if="cwdOf(tc)" class="tc-cwd-inline"> ({{ cwdOf(tc) }})</span>
                    </span>
                    <span v-else class="tc-summary-text">{{ toolSummary(tc) }}</span>
                  </div>
                  <div v-if="runningSubtitle(tc)" class="tc-subtitle">{{ runningSubtitle(tc) }}</div>
                  <div v-else-if="resultPreview(tc)" class="tc-subtitle tc-subtitle-result">{{ resultPreview(tc) }}</div>
                </div>
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
            <div v-if="tc && tc._expanded && (tc.result || tc.name === 'execute_command')" class="tc-detail">
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
        </template>

        <!-- 本条消息中的截图/图片直接展示在列表里（含保存后从 metadata.artifacts 还原的） -->
        <div v-if="screenshotsInMessage.length" class="message-screenshots">
          <img
            v-for="(src, idx) in screenshotsInMessage"
            :key="idx"
            class="chat-image message-screenshot-img"
            :src="src"
            :alt="t('chatMessage.screenshot')"
          />
        </div>

        <!-- 本条消息中已保存的其它产物：音频、视频、文件/PDF（还原展示） -->
        <div v-if="messageArtifactsNonImage.length" class="message-artifacts">
          <template v-for="(art, idx) in messageArtifactsNonImage" :key="art.artifactId || art.path || idx">
            <div class="message-artifact-card">
              <div class="message-artifact-head">
                <span class="message-artifact-icon">
                  <component :is="artifactIcon(art)" :size="14" />
                </span>
                <span class="message-artifact-kind">{{ artifactTypeLabel(art) }}</span>
                <span class="message-artifact-name" :title="art.name || art.openPath || art.path">{{ art.name || artifactDisplayPath(art) }}</span>
              </div>
              <audio
                v-if="art.kind === 'audio'"
                class="message-artifact-audio"
                controls
                :src="art.path"
                :title="art.name || 'audio'"
                @loadedmetadata="captureArtifactDuration(art, $event)"
                @durationchange="captureArtifactDuration(art, $event)"
              />
              <video
                v-else-if="art.kind === 'video'"
                class="message-artifact-video"
                controls
                :src="art.path"
                :title="art.name || 'video'"
                @loadedmetadata="captureArtifactDuration(art, $event)"
                @durationchange="captureArtifactDuration(art, $event)"
              />
              <button
                v-else-if="isModalPreviewableArtifact(art)"
                type="button"
                class="message-artifact-file"
                :title="art.name || art.path"
                @click="openArtifactPreviewModal(art)"
              >{{ art.name || (art.kind === 'file' ? '文件' : art.kind) }}</button>
              <span
                v-else
                class="message-artifact-file message-artifact-file-static"
                :title="art.name || art.path"
              >{{ art.name || (art.kind === 'file' ? '文件' : art.kind) }}</span>
              <div class="message-artifact-meta">
                <span>{{ artifactTypeLabel(art) }}</span>
                <span v-if="art.sourceLabel">{{ art.sourceLabel }}</span>
                <span v-if="art.durationText">{{ art.durationText }}</span>
                <span v-if="art.sizeText">{{ art.sizeText }}</span>
                <span class="message-artifact-path" :title="art.openPath || art.path">{{ artifactDisplayPath(art) }}</span>
              </div>
              <div class="message-artifact-actions">
                <a
                  v-if="art.kind !== 'audio' && isModalPreviewableArtifact(art)"
                  class="message-artifact-open"
                  href="#"
                  :title="art.name || art.path"
                  @click.prevent="openArtifactPreviewModal(art)"
                >预览</a>
                <a
                  v-if="art.kind !== 'audio'"
                  class="message-artifact-open"
                  href="#"
                  :title="art.name || art.path"
                  @click.prevent="openArtifactExternal(art)"
                >系统打开</a>
                <a
                  v-if="art.kind === 'audio'"
                  class="message-artifact-open"
                  :href="art.path"
                  :download="art.name || ''"
                  :title="art.name || art.path"
                >下载</a>
                <button
                  v-if="art.kind === 'audio'"
                  type="button"
                  class="message-artifact-copy"
                  @click="requestAudioRegenerate(art)"
                >换音色重生成</button>
                <button
                  v-if="isRevealableArtifact(art)"
                  type="button"
                  class="message-artifact-reveal"
                  @click="revealArtifact(art)"
                >文件夹</button>
                <button
                  v-if="isRevealableArtifact(art)"
                  type="button"
                  class="message-artifact-copy"
                  @click="copyArtifactPath(art)"
                >{{ copiedArtifactPath === (art.openPath || art.path) ? '已复制路径' : '复制路径' }}</button>
                <button
                  v-if="art.name"
                  type="button"
                  class="message-artifact-copy"
                  @click="copyArtifactName(art)"
                >{{ copiedArtifactName === art.name ? '已复制文件名' : '复制文件名' }}</button>
                <button
                  v-if="isPreviewableArtifact(art)"
                  type="button"
                  class="message-artifact-copy"
                  @click="toggleArtifactPreview(art)"
                >{{ isArtifactPreviewOpen(art) ? '收起预览' : '快速预览' }}</button>
              </div>
              <div v-if="isArtifactPreviewOpen(art)" class="message-artifact-preview">
                <iframe
                  v-if="isHtmlArtifact(art)"
                  class="message-artifact-preview-frame"
                  :src="art.path"
                  :title="art.name || 'html preview'"
                />
                <div v-else-if="artifactPreviewLoading[artifactIdentity(art)]" class="message-artifact-preview-state">正在加载预览...</div>
                <div v-else-if="artifactPreviewError[artifactIdentity(art)]" class="message-artifact-preview-state message-artifact-preview-error">
                  {{ artifactPreviewError[artifactIdentity(art)] }}
                </div>
                <pre v-else class="message-artifact-preview-text">{{ artifactPreviewText[artifactIdentity(art)] || '' }}</pre>
              </div>
            </div>
          </template>
        </div>

        <div v-if="mainContent" class="bubble-text ai-text" @click="onBubbleLinkClick" v-html="renderedContent"></div>
        <div v-if="uiBlocks.length" class="message-ui-blocks">
          <div
            v-for="(block, blockIdx) in uiBlocks"
            :key="`${block.type}-${blockIdx}`"
            class="message-ui-block"
          >
            <div v-if="block.type === 'thinking'" class="think-block">
              <div class="think-header" @click="toggleUiBlockExpanded(blockIdx)">
                <ChevronRight :size="12" class="think-chevron" :class="{ rotated: isUiBlockExpanded(blockIdx) }" />
                <span>{{ block.title || t('chatMessage.thinkingProcess') }}</span>
              </div>
              <div v-if="isUiBlockExpanded(blockIdx)" class="think-body" v-html="renderMarkdown(block.content || '')"></div>
            </div>
            <div v-else-if="block.type === 'status'" class="ui-status-card" :class="`ui-status-${block.level}`">
              <div v-if="block.title" class="ui-status-title">{{ block.title }}</div>
              <div v-if="block.content" class="ui-status-body" v-html="renderMarkdown(block.content)"></div>
            </div>
            <div v-else-if="block.type === 'reply_options'" class="reply-options">
              <button
                v-for="(option, idx) in block.options"
                :key="`${idx}-${option}`"
                type="button"
                class="reply-option-btn"
                @click="selectReplyOption(option, block)"
              >{{ option }}</button>
            </div>
            <div v-else-if="block.type === 'decision_card'" class="ui-decision-card">
              <div v-if="block.title" class="ui-decision-title">{{ block.title }}</div>
              <div v-if="block.content" class="ui-decision-desc" v-html="renderMarkdown(block.content)"></div>
              <div class="reply-options">
                <button
                  v-for="(option, idx) in block.options"
                  :key="`${idx}-${option}`"
                  type="button"
                  class="reply-option-btn"
                  @click="selectReplyOption(option, block)"
                >{{ option }}</button>
              </div>
            </div>
            <div v-else-if="block.type === 'progress'" class="ui-progress-card">
              <div class="ui-progress-head">
                <span class="ui-progress-title">{{ block.title || '进度' }}</span>
                <span class="ui-progress-value">{{ block.percent }}%</span>
              </div>
              <div class="ui-progress-track">
                <span class="ui-progress-fill" :style="{ width: `${block.percent}%` }" />
              </div>
              <div v-if="block.content" class="ui-progress-desc" v-html="renderMarkdown(block.content)"></div>
            </div>
            <div v-else-if="block.type === 'table'" class="ui-table-card">
              <div v-if="block.title" class="ui-table-title">{{ block.title }}</div>
              <table class="ui-table">
                <thead v-if="block.headers.length">
                  <tr>
                    <th v-for="(h, idx) in block.headers" :key="`h-${idx}`">{{ h }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rIdx) in block.rows" :key="`r-${rIdx}`">
                    <td v-for="(cell, cIdx) in row" :key="`c-${rIdx}-${cIdx}`">{{ cell }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else-if="block.type === 'form'" class="ui-form-card">
              <div v-if="block.title" class="ui-form-title">{{ block.title }}</div>
              <div class="ui-form-grid">
                <div
                  v-for="(field, fIdx) in block.fields"
                  :key="`f-${fIdx}-${field.name}`"
                  class="ui-form-item"
                >
                  <label class="ui-form-label">{{ field.label || field.name }}</label>
                  <input
                    v-if="field.type !== 'textarea'"
                    :value="field.value"
                    disabled
                    class="ui-form-input"
                  />
                  <textarea
                    v-else
                    :value="field.value"
                    disabled
                    class="ui-form-textarea"
                    rows="2"
                  />
                </div>
              </div>
              <div class="ui-form-actions">
                <button
                  type="button"
                  class="reply-option-btn"
                  @click="emitUiAction({
                    type: block.action || 'send_text',
                    sourceType: block.type,
                    text: block.submitText || ''
                  })"
                >{{ block.submitLabel || '使用此参数继续' }}</button>
              </div>
            </div>
            <div v-else-if="block.type === 'script_execute'" class="ui-script-card">
              <div v-if="block.title" class="ui-script-title">{{ block.title }}</div>
              <code class="ui-script-command">{{ block.command }}</code>
              <div class="ui-script-meta">
                <span v-if="block.cwd">cwd: {{ block.cwd }}</span>
                <span>timeout: {{ Math.floor(block.timeoutMs / 1000) }}s</span>
              </div>
              <div class="ui-script-actions">
                <button
                  type="button"
                  class="reply-option-btn"
                  @click="emitUiAction({
                    type: 'run_script',
                    sourceType: block.type,
                    command: block.command,
                    cwd: block.cwd,
                    timeoutMs: block.timeoutMs,
                    confirm: block.confirm
                  })"
                >{{ block.runLabel || '执行脚本' }}</button>
              </div>
            </div>
            <div v-else-if="block.type === 'artifact_card'" class="ui-artifact-card">
              <div class="ui-artifact-head">
                <span class="ui-artifact-title">{{ block.title || block.name || '产物文件' }}</span>
                <span v-if="block.kind" class="ui-artifact-kind">{{ block.kind }}</span>
              </div>
              <div class="ui-artifact-path" :title="block.path">{{ block.path }}</div>
              <div v-if="block.content" class="ui-artifact-desc" v-html="renderMarkdown(block.content)"></div>
              <div class="ui-artifact-actions">
                <button
                  v-for="(action, idx) in block.actions"
                  :key="`artifact-action-${idx}`"
                  type="button"
                  class="reply-option-btn"
                  @click="emitUiAction({ ...action, sourceType: block.type, path: block.path, openPath: block.openPath || block.path, name: block.name || '' })"
                >{{ action.label || '执行' }}</button>
              </div>
            </div>
            <div v-else-if="block.type === 'tool_result_card'" class="ui-tool-result-card" :class="`ui-tool-result-${block.status}`">
              <div class="ui-tool-result-head">
                <span class="ui-tool-result-title">{{ block.title || block.toolName || '工具结果' }}</span>
                <span class="ui-tool-result-status">{{ block.status }}</span>
              </div>
              <div v-if="block.summary" class="ui-tool-result-summary">{{ block.summary }}</div>
              <div v-if="block.content" class="ui-tool-result-desc" v-html="renderMarkdown(block.content)"></div>
              <div v-if="block.actions.length" class="ui-tool-result-actions">
                <button
                  v-for="(action, idx) in block.actions"
                  :key="`tool-action-${idx}`"
                  type="button"
                  class="reply-option-btn"
                  @click="emitUiAction({ ...action, sourceType: block.type, toolName: block.toolName || '' })"
                >{{ action.label || '执行' }}</button>
              </div>
            </div>
            <div v-else-if="block.type === 'confirm_card'" class="ui-confirm-card" :class="`ui-confirm-${block.level}`">
              <div class="ui-confirm-head">
                <span class="ui-confirm-title">{{ block.title || '请确认操作' }}</span>
              </div>
              <div v-if="block.content" class="ui-confirm-desc" v-html="renderMarkdown(block.content)"></div>
              <div class="ui-confirm-actions">
                <button
                  type="button"
                  class="reply-option-btn"
                  @click="emitUiAction({
                    type: block.confirmAction || 'send_text',
                    sourceType: block.type,
                    text: block.confirmText || '',
                    confirm: true
                  })"
                >{{ block.confirmLabel || '确认' }}</button>
                <button
                  type="button"
                  class="reply-option-btn ui-btn-secondary"
                  @click="emitUiAction({
                    type: block.cancelAction || 'send_text',
                    sourceType: block.type,
                    text: block.cancelText || '',
                    confirm: false
                  })"
                >{{ block.cancelLabel || '取消' }}</button>
              </div>
            </div>
            <div v-else-if="block.type === 'input_prompt'" class="ui-input-card">
              <div v-if="block.title" class="ui-input-title">{{ block.title }}</div>
              <div v-if="block.content" class="ui-input-desc" v-html="renderMarkdown(block.content)"></div>
              <label class="ui-input-label">{{ block.label || '输入内容' }}</label>
              <input
                class="ui-input-field"
                type="text"
                :placeholder="block.placeholder || ''"
                :value="getUiInputValue(blockIdx, block)"
                @input="setUiInputValue(blockIdx, block, $event?.target?.value)"
                @keydown.enter.prevent="submitInputPrompt(blockIdx, block)"
              />
              <div class="ui-input-actions">
                <button
                  type="button"
                  class="reply-option-btn"
                  @click="submitInputPrompt(blockIdx, block)"
                >{{ block.submitLabel || '提交' }}</button>
              </div>
            </div>
            <div v-else-if="block.type === 'json_view'" class="ui-json-card">
              <div v-if="block.title" class="ui-json-title">{{ block.title }}</div>
              <pre class="ui-json-pre">{{ block.pretty }}</pre>
            </div>
            <div v-else-if="block.type === 'timeline'" class="ui-timeline-card">
              <div v-if="block.title" class="ui-timeline-title">{{ block.title }}</div>
              <div class="ui-timeline-list">
                <div
                  v-for="(item, idx) in block.items"
                  :key="`timeline-${idx}`"
                  class="ui-timeline-item"
                  :class="`ui-timeline-${item.status}`"
                >
                  <span class="ui-timeline-dot" />
                  <div class="ui-timeline-body">
                    <div class="ui-timeline-item-title">{{ item.title || `步骤 ${idx + 1}` }}</div>
                    <div v-if="item.detail" class="ui-timeline-item-detail">{{ item.detail }}</div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else-if="block.type === 'image_single'" class="ui-single-card">
              <div v-if="block.title" class="ui-single-title">{{ block.title }}</div>
              <div v-if="block.content" class="ui-single-desc" v-html="renderMarkdown(block.content)"></div>
              <figure class="ui-single-figure">
                <img
                  class="chat-image ui-single-image"
                  :src="block.image.src"
                  :alt="block.image.alt || 'image'"
                  :title="block.image.alt || ''"
                />
                <figcaption v-if="block.image.alt" class="ui-single-caption">{{ block.image.alt }}</figcaption>
              </figure>
            </div>
            <div v-else-if="block.type === 'image_gallery'" class="ui-gallery-card">
              <div v-if="block.title" class="ui-gallery-title">{{ block.title }}</div>
              <div v-if="block.content" class="ui-gallery-desc" v-html="renderMarkdown(block.content)"></div>
              <div class="ui-gallery-grid" :class="`ui-gallery-${block.layout}`">
                <img
                  v-for="(img, idx) in block.images"
                  :key="`gallery-${idx}`"
                  class="chat-image ui-gallery-image"
                  :src="img.src"
                  :alt="img.alt || `image-${idx + 1}`"
                  :title="img.alt || ''"
                />
              </div>
            </div>
            <div v-else-if="block.type === 'image_compare'" class="ui-compare-card">
              <div v-if="block.title" class="ui-compare-title">{{ block.title }}</div>
              <div v-if="block.content" class="ui-compare-desc" v-html="renderMarkdown(block.content)"></div>
              <div class="ui-compare-grid">
                <figure v-for="(img, idx) in block.images.slice(0, 2)" :key="`compare-${idx}`" class="ui-compare-item">
                  <img class="chat-image ui-compare-image" :src="img.src" :alt="img.alt || `compare-${idx + 1}`" :title="img.alt || ''" />
                  <figcaption v-if="img.alt" class="ui-compare-caption">{{ img.alt }}</figcaption>
                </figure>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </template>

  <Teleport to="body">
    <div
      v-if="artifactPreviewModal"
      class="artifact-modal-overlay"
      @click.self="closeArtifactPreviewModal"
    >
      <div class="artifact-modal" role="dialog" aria-modal="true" :aria-label="artifactPreviewModal.name || '文件预览'">
        <div class="artifact-modal-head">
          <div class="artifact-modal-meta">
            <div class="artifact-modal-title">{{ artifactPreviewModal.name || artifactDisplayPath(artifactPreviewModal) }}</div>
            <div class="artifact-modal-subtitle">
              <span>{{ artifactTypeLabel(artifactPreviewModal) }}</span>
              <span v-if="artifactPreviewModal.sourceLabel">{{ artifactPreviewModal.sourceLabel }}</span>
              <span v-if="artifactPreviewModal.sizeText">{{ artifactPreviewModal.sizeText }}</span>
              <span class="artifact-modal-path" :title="artifactDisplayPath(artifactPreviewModal)">{{ artifactDisplayPath(artifactPreviewModal) }}</span>
            </div>
          </div>
          <div class="artifact-modal-actions">
            <button type="button" class="artifact-modal-btn" @click="openArtifactExternal(artifactPreviewModal)">系统打开</button>
            <button type="button" class="artifact-modal-btn artifact-modal-btn-close" @click="closeArtifactPreviewModal">关闭</button>
          </div>
        </div>
        <div class="artifact-modal-body">
          <iframe
            v-if="artifactPreviewModal && isHtmlArtifact(artifactPreviewModal)"
            class="artifact-modal-frame"
            :src="artifactPreviewModal.path"
            :title="artifactPreviewModal.name || 'html preview'"
          />
          <iframe
            v-else-if="artifactPreviewModal && isPdfArtifact(artifactPreviewModal)"
            class="artifact-modal-frame artifact-modal-frame-pdf"
            :src="artifactPreviewModal.path"
            :title="artifactPreviewModal.name || 'pdf preview'"
          />
          <div v-else-if="artifactPreviewModalLoading" class="artifact-modal-state">正在加载预览...</div>
          <div v-else-if="artifactPreviewModalError" class="artifact-modal-state artifact-modal-state-error">{{ artifactPreviewModalError }}</div>
          <pre v-else-if="artifactPreviewModalText" class="artifact-modal-text">{{ artifactPreviewModalText }}</pre>
          <div v-else class="artifact-modal-state">该文件类型暂不支持直接预览，请使用“系统打开”。</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { User, Wrench, ChevronRight, Terminal, GitBranch, FileText, Shield, Search, CheckCircle, XCircle, Copy, Check, Music4, Clapperboard, Globe, File as FileIcon } from 'lucide-vue-next'
import { useLogoUrl } from '../../composables/useLogoUrl.js'
import { useI18n } from '../../composables/useI18n'

const logoUrl = useLogoUrl()
const { t } = useI18n()
const MAX_VISIBLE_TOOL_CALLS = 8
const props = defineProps({
  message: { type: Object, required: true },
  sessionId: { type: String, default: '' },
  agentDisplayName: { type: String, default: '' }
})
const emit = defineEmits(['regenerate-audio', 'ui-action'])

const copied = ref(false)
const copiedArtifactPath = ref('')
const copiedArtifactName = ref('')
const artifactDurationMap = ref({})
const artifactPreviewOpen = ref({})
const artifactPreviewText = ref({})
const artifactPreviewLoading = ref({})
const artifactPreviewError = ref({})
const artifactPreviewModal = ref(null)
const artifactPreviewModalText = ref('')
const artifactPreviewModalLoading = ref(false)
const artifactPreviewModalError = ref('')
const uiBlockExpanded = ref({})
const uiInputValues = ref({})
const nowMs = ref(Date.now())
let nowTimer = null
const UI_PROTOCOL_VERSION = '1'
const UI_MAX_TEXT_LEN = 2000
const UI_MAX_LABEL_LEN = 80
const UI_ALLOWED_ACTION_TYPES = new Set([
  'send_text',
  'run_script',
  'open_external',
  'reveal_path',
  'download_url',
  'noop'
])

onMounted(() => {
  nowTimer = setInterval(() => { nowMs.value = Date.now() }, 1000)
  document.addEventListener('keydown', onDocumentKeydown)
})

onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer)
  nowTimer = null
  document.removeEventListener('keydown', onDocumentKeydown)
})

const onDocumentKeydown = (event) => {
  if (event.key === 'Escape' && artifactPreviewModal.value) {
    closeArtifactPreviewModal()
  }
}

const copyContent = async () => {
  try {
    await navigator.clipboard.writeText(normalizeToolCallXmlForDisplay(props.message.content || ''))
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* ignore */ }
}

// 点击消息中的链接时在系统浏览器打开
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
      if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url)
      else window.electronAPI?.openUrlInNewTab?.(url)
    } catch { /* ignore */ }
  }
}

// 从 content 中拆分出 <think>...</think> 思维链和正文
function normalizeToolCallXmlForDisplay(rawText = '') {
  const raw = String(rawText || '')
  if (!raw) return ''
  const summaries = []
  const cleaned = raw.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, (block) => {
    const fn = (block.match(/<function=([^>\s]+)>/i)?.[1] || '').trim()
    const params = []
    const re = /<parameter=([^>\s]+)>/gi
    let m = null
    while ((m = re.exec(block)) !== null) {
      const key = String(m[1] || '').trim()
      if (key) params.push(key)
      if (params.length >= 3) break
    }
    if (fn) {
      const suffix = params.length ? `（${params.join(' / ')}）` : ''
      summaries.push(`已执行工具：${fn}${suffix}`)
    }
    return ''
  })
  const stripped = cleaned
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<function=[^>]+>/gi, '')
    .replace(/<\/function>/gi, '')
    .replace(/<parameter=[^>]+>/gi, '')
    .replace(/<\/parameter>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!summaries.length) return stripped
  const head = summaries.join('\n')
  return stripped ? `${head}\n\n${stripped}` : head
}

const splitContent = computed(() => {
  const raw = normalizeToolCallXmlForDisplay((props.message.content || '').trim())
  const parsed = stripMessageUiBlocks(raw)
  const main = parsed.cleaned.trim()
  return {
    mainContent: main,
    uiBlocks: parsed.uiBlocks
  }
})

const mainContent = computed(() => splitContent.value.mainContent)
const uiBlocks = computed(() => splitContent.value.uiBlocks || [])

const normalizeReplyOptionText = (value) => {
  let text = String(value || '').trim()
  if (!text) return ''
  text = text.replace(/^[“"'`]+/, '').replace(/[”"'`]+$/, '').trim()
  text = text.replace(/^[-*+]\s+/, '').replace(/^\d+[.)、]\s+/, '').trim()
  if (!text) return ''
  if (text.length > 80) return ''
  if (/^请回复(?:一句)?[：:]?$/u.test(text)) return ''
  return text
}

const clampText = (value, max = UI_MAX_TEXT_LEN) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) : text
}

const clampLabel = (value, max = UI_MAX_LABEL_LEN) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) : text
}

const sanitizeActionType = (value, fallback = 'noop') => {
  const t = String(value || '').trim().toLowerCase()
  return UI_ALLOWED_ACTION_TYPES.has(t) ? t : fallback
}

const extractReplyOptionsFromBlock = (block) => {
  const options = []
  const source = String(block || '')
  const fromTag = source.matchAll(/<option>([\s\S]*?)<\/option>/gi)
  for (const match of fromTag) {
    const text = normalizeReplyOptionText(match?.[1] || '')
    if (text) options.push(text)
  }
  if (options.length > 0) return options
  const lines = source.split('\n')
  for (const line of lines) {
    const text = normalizeReplyOptionText(line)
    if (text) options.push(text)
  }
  return options
}

const parseOuUiAttrs = (attrsRaw) => {
  const attrs = {}
  const src = String(attrsRaw || '')
  const reg = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match = null
  while ((match = reg.exec(src)) !== null) {
    const key = String(match[1] || '').trim()
    const value = String(match[3] || match[4] || match[5] || '').trim()
    if (key) attrs[key] = value
  }
  return attrs
}

const normalizeUiType = (value) => String(value || '').trim().toLowerCase()

const parseUiBlock = (type, body, attrs = {}) => {
  if (attrs.version && String(attrs.version).trim() !== UI_PROTOCOL_VERSION) return null
  const t = normalizeUiType(type)
  const source = String(body || '').trim()
  if (t === 'reply_options') {
    const options = [...new Set(extractReplyOptionsFromBlock(source))].slice(0, 6)
    if (options.length === 0) return null
    return {
      type: 'reply_options',
      options,
      action: sanitizeActionType(attrs.action || 'send_text', 'send_text')
    }
  }
  if (t === 'thinking' || t === 'think') {
    if (!source) return null
    return {
      type: 'thinking',
      title: clampLabel(attrs.title || ''),
      content: clampText(source)
    }
  }
  if (t === 'status') {
    const level = String(attrs.level || attrs.variant || 'info').trim().toLowerCase()
    const normalizedLevel = ['info', 'success', 'warning', 'error'].includes(level) ? level : 'info'
    return {
      type: 'status',
      level: normalizedLevel,
      title: clampLabel(attrs.title || ''),
      content: clampText(source)
    }
  }
  if (t === 'decision_card') {
    const options = [...new Set(extractReplyOptionsFromBlock(source))].slice(0, 4)
    if (options.length === 0) return null
    return {
      type: 'decision_card',
      title: clampLabel(attrs.title || ''),
      content: clampText(attrs.desc || ''),
      options,
      action: sanitizeActionType(attrs.action || 'send_text', 'send_text')
    }
  }
  if (t === 'progress') {
    let percent = Number(attrs.percent)
    if (!Number.isFinite(percent)) percent = 0
    percent = Math.max(0, Math.min(100, Math.round(percent)))
    return {
      type: 'progress',
      title: clampLabel(attrs.title || ''),
      content: clampText(source),
      percent
    }
  }
  if (t === 'table') {
    const rows = []
    const rowReg = /<row>([\s\S]*?)<\/row>/gi
    let rowMatch = null
    while ((rowMatch = rowReg.exec(source)) !== null) {
      const rowText = String(rowMatch?.[1] || '').trim()
      if (!rowText) continue
      const cells = rowText.split('|').map((x) => String(x || '').trim()).filter(Boolean)
      if (cells.length > 0) rows.push(cells)
      if (rows.length >= 20) break
    }
    if (rows.length === 0) return null
    const headerRaw = String(attrs.headers || '').trim()
    const headers = headerRaw ? headerRaw.split('|').map((x) => String(x || '').trim()).filter(Boolean) : []
    return {
      type: 'table',
      title: clampLabel(attrs.title || ''),
      headers,
      rows
    }
  }
  if (t === 'form') {
    const fields = []
    const fieldReg = /<field\b([^>]*)\/?>/gi
    let fieldMatch = null
    while ((fieldMatch = fieldReg.exec(source)) !== null) {
      const fAttrs = parseOuUiAttrs(fieldMatch?.[1] || '')
      const name = String(fAttrs.name || '').trim()
      if (!name) continue
      fields.push({
        name,
        label: String(fAttrs.label || name).trim(),
        value: String(fAttrs.value || '').trim(),
        type: String(fAttrs.type || 'text').trim().toLowerCase()
      })
      if (fields.length >= 12) break
    }
    if (fields.length === 0) return null
    return {
      type: 'form',
      title: clampLabel(attrs.title || ''),
      fields,
      submitLabel: clampLabel(attrs.submit_label || attrs.submitLabel || ''),
      submitText: clampText(attrs.submit_text || attrs.submitText || '', 400),
      action: sanitizeActionType(attrs.action || 'send_text', 'send_text')
    }
  }
  if (t === 'script_execute') {
    const command = String(attrs.command || source || '').trim()
    if (!command) return null
    const timeoutMs = Math.max(1000, Math.min(600000, Number(attrs.timeout_ms || attrs.timeoutMs || 120000) || 120000))
    return {
      type: 'script_execute',
      title: clampLabel(attrs.title || ''),
      command: clampText(command, 1200),
      cwd: clampText(attrs.cwd || '', 600),
      runLabel: clampLabel(attrs.run_label || attrs.runLabel || ''),
      confirm: String(attrs.confirm || '').trim().toLowerCase() === 'true',
      timeoutMs
    }
  }
  if (t === 'artifact_card') {
    const path = String(attrs.path || attrs.url || '').trim()
    if (!path) return null
    const actionRaw = String(attrs.actions || 'open|reveal|download').trim()
    const actionMap = {
      open: { type: 'open_external', label: '打开' },
      reveal: { type: 'reveal_path', label: '文件夹' },
      download: { type: 'download_url', label: '下载' },
      regenerate: { type: 'send_text', label: '重生成', text: String(attrs.regenerate_text || '请基于当前文件重生成一个新版本。').trim() }
    }
    const actions = actionRaw.split('|')
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean)
      .map((k) => actionMap[k])
      .filter(Boolean)
      .slice(0, 6)
    return {
      type: 'artifact_card',
      title: clampLabel(attrs.title || ''),
      name: clampLabel(attrs.name || ''),
      kind: clampLabel(attrs.kind || '', 24),
      path: clampText(path, 1200),
      openPath: clampText(attrs.open_path || attrs.openPath || path, 1200),
      content: clampText(source),
      actions
    }
  }
  if (t === 'tool_result_card') {
    const status = String(attrs.status || 'info').trim().toLowerCase()
    const normalizedStatus = ['success', 'warning', 'error', 'info'].includes(status) ? status : 'info'
    const actions = parseUiActionsFromBody(source).slice(0, 6)
    return {
      type: 'tool_result_card',
      title: clampLabel(attrs.title || ''),
      toolName: clampLabel(attrs.tool_name || attrs.toolName || '', 40),
      summary: clampText(attrs.summary || '', 300),
      status: normalizedStatus,
      content: stripUiActionsFromBody(source),
      actions
    }
  }
  if (t === 'confirm_card') {
    const level = String(attrs.level || attrs.variant || 'warning').trim().toLowerCase()
    const normalizedLevel = ['info', 'success', 'warning', 'error'].includes(level) ? level : 'warning'
    return {
      type: 'confirm_card',
      level: normalizedLevel,
      title: clampLabel(attrs.title || ''),
      content: clampText(source),
      confirmLabel: clampLabel(attrs.confirm_label || attrs.confirmLabel || ''),
      confirmText: clampText(attrs.confirm_text || attrs.confirmText || '', 400),
      confirmAction: sanitizeActionType(attrs.confirm_action || attrs.confirmAction || 'send_text', 'send_text'),
      cancelLabel: clampLabel(attrs.cancel_label || attrs.cancelLabel || ''),
      cancelText: clampText(attrs.cancel_text || attrs.cancelText || '', 400),
      cancelAction: sanitizeActionType(attrs.cancel_action || attrs.cancelAction || 'send_text', 'send_text')
    }
  }
  if (t === 'input_prompt') {
    return {
      type: 'input_prompt',
      title: clampLabel(attrs.title || ''),
      content: clampText(source),
      label: clampLabel(attrs.label || ''),
      placeholder: clampText(attrs.placeholder || '', 120),
      defaultValue: clampText(attrs.default_value || attrs.defaultValue || '', 300),
      submitLabel: clampLabel(attrs.submit_label || attrs.submitLabel || ''),
      action: sanitizeActionType(attrs.action || 'send_text', 'send_text'),
      template: clampText(attrs.template || '{{input}}', 300),
      fieldName: clampLabel(attrs.field_name || attrs.fieldName || 'input', 40)
    }
  }
  if (t === 'json_view') {
    if (!source) return null
    let pretty = source
    try {
      pretty = JSON.stringify(JSON.parse(source), null, 2)
    } catch { /* keep raw */ }
    return {
      type: 'json_view',
      title: clampLabel(attrs.title || ''),
      pretty: clampText(pretty, 12000)
    }
  }
  if (t === 'timeline') {
    const items = []
    const itemReg = /<item\b([^>]*)\/?>/gi
    let itemMatch = null
    while ((itemMatch = itemReg.exec(source)) !== null) {
      const itemAttrs = parseOuUiAttrs(itemMatch?.[1] || '')
      const status = String(itemAttrs.status || 'todo').trim().toLowerCase()
      const normalizedStatus = ['done', 'doing', 'todo', 'error'].includes(status) ? status : 'todo'
      items.push({
        status: normalizedStatus,
        title: clampLabel(itemAttrs.title || ''),
        detail: clampText(itemAttrs.detail || '', 300)
      })
      if (items.length >= 20) break
    }
    if (items.length === 0) return null
    return {
      type: 'timeline',
      title: clampLabel(attrs.title || ''),
      items
    }
  }
  if (t === 'image_single') {
    const image = parseUiImagesFromBody(source)[0]
    if (!image) return null
    return {
      type: 'image_single',
      title: clampLabel(attrs.title || ''),
      content: clampText(stripUiImagesFromBody(source), 500),
      image
    }
  }
  if (t === 'image_gallery') {
    const images = parseUiImagesFromBody(source).slice(0, 12)
    if (images.length === 0) return null
    const layout = String(attrs.layout || 'grid').trim().toLowerCase()
    return {
      type: 'image_gallery',
      title: clampLabel(attrs.title || ''),
      content: clampText(stripUiImagesFromBody(source), 500),
      layout: ['grid', 'masonry'].includes(layout) ? layout : 'grid',
      images
    }
  }
  if (t === 'image_compare') {
    const images = parseUiImagesFromBody(source).slice(0, 2)
    if (images.length < 2) return null
    return {
      type: 'image_compare',
      title: clampLabel(attrs.title || ''),
      content: clampText(stripUiImagesFromBody(source), 500),
      images
    }
  }
  return null
}

const parseUiActionsFromBody = (source) => {
  const actions = []
  const actionReg = /<action\b([^>]*)\/?>/gi
  let actionMatch = null
  while ((actionMatch = actionReg.exec(String(source || ''))) !== null) {
    const attrs = parseOuUiAttrs(actionMatch?.[1] || '')
    const type = String(attrs.type || '').trim().toLowerCase()
    if (!type) continue
    actions.push({
      type: sanitizeActionType(type, 'noop'),
      label: clampLabel(attrs.label || ''),
      text: clampText(attrs.text || '', 800),
      command: clampText(attrs.command || '', 1200),
      cwd: clampText(attrs.cwd || '', 600),
      timeoutMs: Number(attrs.timeout_ms || attrs.timeoutMs || 120000) || 120000,
      confirm: String(attrs.confirm || '').trim().toLowerCase() === 'true',
      path: clampText(attrs.path || attrs.url || '', 1200)
    })
  }
  return actions
}

const stripUiActionsFromBody = (source) => String(source || '').replace(/<action\b[^>]*\/?>/gi, '').trim()

const normalizeImageSrc = (value) => {
  const src = clampText(value || '', 1200)
  if (!src) return ''
  if (/^(https?:\/\/|data:image\/|file:\/\/|local-resource:\/\/)/i.test(src)) return src
  if (src.startsWith('/')) return `file://${src}`
  return src
}

const parseUiImagesFromBody = (source) => {
  const images = []
  const reg = /<(?:image|img)\b([^>]*)\/?>/gi
  let match = null
  while ((match = reg.exec(String(source || ''))) !== null) {
    const attrs = parseOuUiAttrs(match?.[1] || '')
    const src = normalizeImageSrc(attrs.src || attrs.url || '')
    if (!src) continue
    images.push({
      src,
      alt: clampLabel(attrs.alt || attrs.caption || '', 120)
    })
  }
  return images
}

const stripUiImagesFromBody = (source) => String(source || '').replace(/<(?:image|img)\b[^>]*\/?>/gi, '').trim()

const stripUnclosedOuUiTail = (raw) => {
  const text = String(raw || '')
  if (!text) return ''
  const openIdx = text.lastIndexOf('<ou_ui')
  if (openIdx < 0) return text
  const closeIdx = text.lastIndexOf('</ou_ui>')
  if (closeIdx >= openIdx) return text
  return text.slice(0, openIdx)
}

const stripMessageUiBlocks = (raw) => {
  const uiBlocks = []
  let cleaned = String(raw || '')

  cleaned = cleaned.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => {
    const block = parseUiBlock('thinking', inner, {})
    if (block) uiBlocks.push(block)
    return ''
  })

  cleaned = cleaned.replace(/<ou_ui\b([^>]*)>([\s\S]*?)<\/ou_ui>/gi, (_, attrsRaw, body) => {
    const attrs = parseOuUiAttrs(attrsRaw)
    const block = parseUiBlock(attrs.type, body, attrs)
    if (block) uiBlocks.push(block)
    return ''
  })

  cleaned = stripUnclosedOuUiTail(cleaned)
  return { cleaned, uiBlocks: uiBlocks.slice(0, 8) }
}

const selectReplyOption = (option, block = {}) => {
  const text = normalizeReplyOptionText(option)
  if (!text) return
  emitUiAction({
    type: sanitizeActionType(String(block?.action || 'send_text'), 'send_text'),
    sourceType: String(block?.type || 'reply_options'),
    text
  })
}

const emitUiAction = (payload = {}) => {
  emit('ui-action', payload)
}

const getUiInputKey = (index, block = {}) => `${block.type || 'input'}:${index}:${block.fieldName || ''}`

const getUiInputValue = (index, block = {}) => {
  const key = getUiInputKey(index, block)
  const current = uiInputValues.value[key]
  if (typeof current === 'string') return current
  return String(block.defaultValue || '')
}

const setUiInputValue = (index, block = {}, value = '') => {
  const key = getUiInputKey(index, block)
  uiInputValues.value = {
    ...uiInputValues.value,
    [key]: String(value || '')
  }
}

const submitInputPrompt = (index, block = {}) => {
  const raw = String(getUiInputValue(index, block) || '').trim()
  if (!raw) return
  const template = String(block.template || '{{input}}').trim() || '{{input}}'
  const text = clampText(template.replace(/\{\{\s*input\s*\}\}/gi, raw), 4000)
  emitUiAction({
    type: sanitizeActionType(String(block.action || 'send_text').trim().toLowerCase(), 'send_text'),
    sourceType: block.type || 'input_prompt',
    text,
    value: raw,
    fieldName: String(block.fieldName || 'input').trim()
  })
}

const messageStableKey = computed(() => {
  const raw = String(
    props?.message?.id
    || props?.message?._uiKey
    || props?.message?.createdAt
    || `${props?.message?.role || ''}:${String(props?.message?.content || '').slice(0, 80)}`
  )
  return raw.replace(/\s+/g, '_')
})

const uiDraftStorageKey = computed(() => {
  const sid = String(props.sessionId || 'default')
  const mid = String(messageStableKey.value || 'msg')
  return `ou:ui:draft:${sid}:${mid}`
})

const restoreUiDrafts = () => {
  try {
    const raw = sessionStorage.getItem(uiDraftStorageKey.value)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') uiInputValues.value = parsed
  } catch { /* ignore */ }
}

const persistUiDrafts = () => {
  try {
    sessionStorage.setItem(uiDraftStorageKey.value, JSON.stringify(uiInputValues.value || {}))
  } catch { /* ignore */ }
}

watch(uiDraftStorageKey, () => {
  uiInputValues.value = {}
  restoreUiDrafts()
}, { immediate: true })

watch(uiInputValues, () => {
  persistUiDrafts()
}, { deep: true })

const isUiBlockExpanded = (index) => !!uiBlockExpanded.value[index]

const toggleUiBlockExpanded = (index) => {
  const key = String(index)
  uiBlockExpanded.value = {
    ...uiBlockExpanded.value,
    [key]: !uiBlockExpanded.value[key]
  }
}

const parseToolArguments = (raw) => {
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

const normalizeForDedup = (value) => {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((x) => normalizeForDedup(x))
  const keys = Object.keys(value || {}).sort()
  const out = {}
  for (const k of keys) {
    out[k] = normalizeForDedup(value[k])
  }
  return out
}

const stableStringify = (value) => {
  try {
    return JSON.stringify(normalizeForDedup(value))
  } catch (_) {
    return String(value == null ? '' : value)
  }
}

const canonicalToolArguments = (tc) => {
  const parsed = parseToolArguments(tc?.arguments)
  if (parsed == null) return ''
  return stableStringify(parsed)
}

const toolCallDedupKey = (tc) => {
  const id = String(tc?.id || '').trim()
  if (id) return `id:${id}`
  const name = String(tc?.name || '').trim()
  const args = canonicalToolArguments(tc)
  return `name:${name}::args:${args}`
}

const toolCallsAll = computed(() => {
  const list = Array.isArray(props.message?.toolCalls) ? props.message.toolCalls : []
  const normalized = list
    .map((tc) => {
      if (!tc || typeof tc !== 'object') return null
      if (tc._expanded === undefined) tc._expanded = false
      return tc
    })
    .filter(Boolean)

    const seen = new Set()
  const deduped = []
  for (let i = normalized.length - 1; i >= 0; i--) {
    const tc = normalized[i]
    const name = String(tc.name || '').trim()
    if (!name) continue
    const key = `${toolCallDedupKey(tc)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(tc)
  }
  return deduped.reverse()
})

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

const toggleExpanded = (tc) => {
  if (!tc || typeof tc !== 'object') return
  tc._expanded = !tc._expanded
}

const toolIcon = (name) => {
  const map = { execute_command: Terminal, git_operation: GitBranch, file_operation: FileText, analyze_project: Search, user_confirmation: Shield }
  return map[name] || Wrench
}

const formatNamespacedTool = (name) => {
  if (name.startsWith('mcp__')) {
    const body = name.slice('mcp__'.length)
    const idx = body.indexOf('__')
    return idx >= 0 ? `${body.slice(0, idx)}/${body.slice(idx + 2)}` : body
  }
  if (name.startsWith('webapp__')) {
    const body = name.slice('webapp__'.length)
    const idx = body.indexOf('__')
    return idx >= 0 ? `${body.slice(0, idx)}/${body.slice(idx + 2)}` : body
  }
  return name
}

const toolLabel = (tcOrName) => {
  const tc = (tcOrName && typeof tcOrName === 'object') ? tcOrName : null
  const name = tc ? String(tc.name || '').trim() : String(tcOrName || '').trim()
  const map = {
    execute_command: t('chatMessage.executeCommand'),
    git_operation: t('chatMessage.gitOperation'),
    file_operation: t('chatMessage.fileOperation'),
    analyze_project: t('chatMessage.analyzeProject'),
    user_confirmation: t('chatMessage.requestConfirmation'),
    webview_control: t('chatMessage.browser'),
    feishu_send_message: t('chatMessage.feishuSend'),
    read_app_log: t('chatMessage.readAppLog')
  }
  const base = map[name] || formatNamespacedTool(name)
  if (name !== 'sessions_spawn' || !tc) return base
  const args = parseToolArguments(tc.arguments) || {}
  const role = String(args.role_name || args.role || '').trim()
  const runtime = String(args.runtime || args.provider_runtime || '').trim()
  if (!role && !runtime) return `${base}`
  const joinText = [runtime ? `runtime=${runtime}` : '', role ? `role=${role}` : ''].filter(Boolean).join(' · ')
  return `${base}（${joinText}）`
}

const toolSummary = (tc) => {
  try {
    const args = parseToolArguments(tc.arguments) || {}
    const toolName = String(tc.name || '')
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
    if (tc.name === 'sessions_spawn') {
      const role = args.role_name || args.role || ''
      const runtime = args.runtime || ''
      const provider = args.provider || args.profile || ''
      const segments = []
      if (role) segments.push(`角色: ${role}`)
      if (runtime) segments.push(`runtime: ${runtime}`)
      if (provider) segments.push(`profile: ${provider}`)
      return segments.length ? segments.join(' · ') : t('chatMessage.childAgent')
    }
    if (tc.name === 'read_app_log') {
      const k = args.keyword ? ` · ${args.keyword}` : ''
      return `${args.lines || 800} lines${k}`
    }
    if (toolName.startsWith('mcp__') || toolName.startsWith('webapp__')) {
      const summaryText = args.prompt || args.text || args.query || args.message || args.path || args.url
      return summaryText ? String(summaryText).slice(0, 110) : ''
    }
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

const parseJsonSafe = (raw) => {
  try { return JSON.parse(raw) } catch { return null }
}

const basenameOfPath = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.split(/[\\/]/).pop() || text
}

const artifactExtension = (art) => {
  const name = String(art?.name || artifactDisplayPath(art) || '').trim().toLowerCase()
  const match = name.match(/\.([a-z0-9]+)$/i)
  return match ? `.${match[1]}` : ''
}

const isTextLikeExtension = (ext) => {
  return [
    '.md', '.txt', '.json', '.js', '.mjs', '.cjs',
    '.ts', '.tsx', '.jsx', '.vue', '.css', '.scss', '.yml', '.yaml',
    '.xml', '.csv', '.log'
  ].includes(String(ext || '').toLowerCase())
}

const formatBytes = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const formatDuration = (seconds) => {
  const n = Math.floor(Number(seconds) || 0)
  if (!Number.isFinite(n) || n <= 0) return ''
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

const inferArtifactKind = (value, fallback = '') => {
  const explicit = String(fallback || '').trim().toLowerCase()
  if (explicit && explicit !== 'file') return explicit
  const lower = String(value || '').toLowerCase()
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac)(\?|$)/.test(lower)) return 'audio'
  if (/\.(mp4|mov|webm|mkv)(\?|$)/.test(lower)) return 'video'
  return explicit || 'file'
}

const artifactKindLabel = (art) => {
  const kind = String(art?.kind || '').toLowerCase()
  if (kind === 'audio') return '音频'
  if (kind === 'video') return '视频'
  if (kind === 'html') return '网页'
  return '文件'
}

const artifactTypeLabel = (art) => {
  const kind = String(art?.kind || '').toLowerCase()
  if (kind === 'audio') {
    const ext = artifactExtension(art)
    if (ext === '.mp3') return 'MP3'
    if (ext === '.wav') return 'WAV'
    if (ext === '.m4a') return 'M4A'
    if (ext === '.ogg' || ext === '.opus') return '音频'
    return '音频'
  }
  if (kind === 'video') {
    const ext = artifactExtension(art)
    if (ext === '.mp4') return 'MP4'
    if (ext === '.mov') return 'MOV'
    if (ext === '.webm') return 'WEBM'
    return '视频'
  }
  const ext = artifactExtension(art)
  if (ext === '.md') return 'Markdown'
  if (ext === '.json') return 'JSON'
  if (ext === '.txt') return '文本'
  if (ext === '.html' || ext === '.htm') return 'HTML'
  if (ext === '.pdf') return 'PDF'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'JavaScript'
  if (ext === '.ts' || ext === '.tsx') return 'TypeScript'
  if (ext === '.jsx') return 'JSX'
  if (ext === '.vue') return 'Vue'
  if (ext === '.css') return 'CSS'
  if (ext === '.scss') return 'SCSS'
  if (ext === '.yaml' || ext === '.yml') return 'YAML'
  if (ext === '.xml') return 'XML'
  if (ext === '.csv') return 'CSV'
  return artifactKindLabel(art)
}

const artifactIcon = (art) => {
  const kind = String(art?.kind || '').toLowerCase()
  if (kind === 'audio') return Music4
  if (kind === 'video') return Clapperboard
  if (kind === 'html') return Globe
  return FileIcon
}

const artifactDisplayPath = (art) => {
  const target = String(art?.openPath || art?.path || '').trim()
  if (!target) return ''
  if (target.startsWith('file://')) return target.slice('file://'.length)
  return target
}

const normalizeArtifactStoragePath = (value) => {
  let text = String(value || '').trim()
  if (!text) return ''
  try {
    text = decodeURIComponent(text)
  } catch { /* ignore */ }
  if (text.startsWith('file://')) text = text.slice('file://'.length)

  if (text.startsWith('local-resource://')) {
    text = text.slice('local-resource://'.length)
    const rel = text.replace(/^\/+/, '')
    if (rel.startsWith('artifacts/') || rel.startsWith('workspace/')) return `.openultron/${rel}`
    return rel
  }

  const unixHit = text.indexOf('/.openultron/')
  if (unixHit >= 0) {
    return `.openultron/${text.slice(unixHit + '/.openultron/'.length).replace(/^\/+/, '')}`
  }

  const windowsText = text.replace(/\\/g, '/')
  const windowsHit = windowsText.indexOf('/.openultron/')
  if (windowsHit >= 0) {
    return `.openultron/${windowsText.slice(windowsHit + '/.openultron/'.length).replace(/^\/+/, '')}`
  }

  if (windowsText.startsWith('~/.openultron/')) {
    return `.openultron/${windowsText.slice('~/.openultron/'.length).replace(/^\/+/, '')}`
  }

  return text.replace(/\\/g, '/')
}

const artifactMatchKey = (art) => {
  const pathKey = normalizeArtifactStoragePath(art?.openPath || art?.path || '')
  const kind = String(art?.kind || 'file').toLowerCase()
  if (pathKey) return `${kind}:${pathKey}`
  if (art?.artifactId) return `id:${String(art.artifactId)}`
  return `${kind}:${String(art?.name || '').trim()}`
}

const artifactIdentity = (art) => artifactMatchKey(art)

const toLocalResourceFromOpenUltronPath = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = raw.startsWith('file://') ? raw.slice('file://'.length) : raw
  const workspaceOrArtifact =
    normalized.startsWith('workspace/')
    || normalized.startsWith('artifacts/')
    || normalized.startsWith('/workspace/')
    || normalized.startsWith('/artifacts/')
    || normalized.startsWith('local-resource:///workspace/')
    || normalized.startsWith('local-resource:///artifacts/')
  if (workspaceOrArtifact) {
    const rel = normalized.replace(/^\/+/, '')
      .replace(/^local-resource:\/\//i, '')
      .replace(/^local-resource:\/+/i, '')
      .replace(/^openultron\//i, '')
    if (rel) return `local-resource://${rel}`
  }
  const unixHit = normalized.indexOf('/.openultron/')
  if (unixHit >= 0) {
    const rel = normalized.slice(unixHit + '/.openultron/'.length).replace(/^\/+/, '')
    if (rel) return `local-resource://${rel}`
  }
  const winNorm = normalized.replace(/\\/g, '/')
  const winHit = winNorm.toLowerCase().indexOf('/.openultron/')
  if (winHit >= 0) {
    const rel = winNorm.slice(winHit + '/.openultron/'.length).replace(/^\/+/, '')
    if (rel) return `local-resource://${rel}`
  }
  if (winNorm.startsWith('~/.openultron/')) {
    const rel = winNorm.slice('~/.openultron/'.length).replace(/^\/+/, '')
    if (rel) return `local-resource://${rel}`
  }
  return ''
}

const toRenderableArtifactPath = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.startsWith('local-resource://') || /^https?:\/\//i.test(text)) return text
  const converted = toLocalResourceFromOpenUltronPath(text)
  if (converted) return converted
  if (text.startsWith('file://')) {
    const fromFile = toLocalResourceFromOpenUltronPath(text)
    return fromFile || text
  }
  if (text.startsWith('/')) return `file://${text}`
  return text
}

const toArtifactRecord = (input = {}) => {
  const rawPath = String(input.openPath || input.path || '').trim()
  if (!rawPath) return null
  const identity = String(input.artifactId || rawPath)
  return {
    artifactId: input.artifactId || '',
    kind: inferArtifactKind(rawPath, input.kind),
    name: input.name || basenameOfPath(rawPath),
    path: toRenderableArtifactPath(input.path || rawPath),
    openPath: rawPath,
    sizeText: formatBytes(input.size),
    durationText: artifactDurationMap.value[identity] || '',
    sourceLabel: String(input.sourceLabel || '').trim()
  }
}

const shortenLine = (s, max = 120) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}

const extractCommandFromLogLine = (line) => {
  const text = String(line || '').trim()
  if (!text) return ''
  // [tool_call] execute_command {"command":"..."}
  if (text.includes('execute_command')) {
    const m = text.match(/execute_command\s+(\{.*\})$/)
    if (m && m[1]) {
      const obj = parseJsonSafe(m[1])
      if (obj && obj.command) return String(obj.command)
    }
    const after = text.split('execute_command').slice(1).join('execute_command').trim()
    if (after) return after
  }
  // [codex][meta] cmd=/path/codex exec ...
  const cmdIdx = text.indexOf('cmd=')
  if (cmdIdx >= 0) {
    return text.slice(cmdIdx + 4).trim()
  }
  return ''
}

const runningSubtitle = (tc) => {
  if (!isToolRunning(tc)) return ''
  if (tc.name === 'execute_command') {
    const cmd = shortenLine(commandOf(tc))
    return cmd ? `正在执行：${cmd}` : ''
  }
  if (tc.name !== 'sessions_spawn') return ''
  const obj = parseJsonSafe(tc.result || '')
  if (!obj || typeof obj !== 'object') return ''
  const lines = []
  if (Array.isArray(obj.log_lines)) lines.push(...obj.log_lines.map(x => String(x || '')))
  if (typeof obj.stdout === 'string' && obj.stdout.trim()) lines.push(...obj.stdout.split('\n'))
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = String(lines[i] || '').trim()
    if (!ln) continue
    const cmd = shortenLine(extractCommandFromLogLine(ln))
    if (cmd) return `正在执行：${cmd}`
    if (!ln.startsWith('[token]')) return `进行中：${shortenLine(ln)}`
  }
  return ''
}

const resultPreview = (tc) => {
  if (!tc || isToolRunning(tc)) return ''
  if (!tc.result) return t('chatMessage.successNoOutput')
  const txt = String(formatResult(tc.result, tc.name) || '').replace(/\s+/g, ' ').trim()
  if (!txt) return t('chatMessage.successNoOutput')
  return shortenLine(txt, 120)
}

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

// 本条 assistant 消息中所有图片 URL/base64：来自 tool 结果 + 保存后的 metadata.artifacts（还原展示）
const screenshotsInMessage = computed(() => {
  const list = []
  const toolCalls = props.message.toolCalls || []
  for (const tc of toolCalls) {
    const info = screenshotFromResult(tc.result)
    if (info?.url) list.push(info.url)
    else if (info?.base64) list.push('data:image/png;base64,' + info.base64)
  }
  const fromMeta = (props.message.metadata?.artifacts || [])
    .filter((a) => a.kind === 'image')
    .map((a) => toRenderableArtifactPath(a.path || a.openPath || ''))
    .filter(Boolean)
  fromMeta.forEach((url) => { if (!list.includes(url)) list.push(url) })
  return list
})

// 本条消息中已保存的产物（除图片外）：音频、视频、文件/PDF 等，用于还原展示
const messageArtifactsNonImage = computed(() => {
  const merged = new Map()
  const pickPreferredArtifact = (current, incoming) => {
    const currentPath = String(current?.path || '').trim()
    const incomingPath = String(incoming?.path || '').trim()
    if (!currentPath) return incoming
    if (!incomingPath) return current
    if (incomingPath.startsWith('local-resource://') && !currentPath.startsWith('local-resource://')) return incoming
    if (!incomingPath.startsWith('local-resource://') && currentPath.startsWith('local-resource://')) return current
    return incomingPath.length < currentPath.length ? incoming : current
  }
  const pushArtifact = (raw) => {
    const rec = toArtifactRecord(raw)
    if (!rec || rec.kind === 'image' || !rec.path) return
    const key = artifactMatchKey(rec)
    if (!merged.has(key)) {
      merged.set(key, rec)
      return
    }
    merged.set(key, pickPreferredArtifact(merged.get(key), rec))
  }

  for (const a of (props.message.metadata?.artifacts || [])) pushArtifact(a)
  for (const tc of toolCallsAll.value) {
    const obj = parseJsonSafe(tc?.result || '')
    if (!obj || typeof obj !== 'object') continue
    const filePath = obj.file_path || obj.filePath || obj.output_path || obj.outputPath || obj.path
    if (filePath && typeof filePath === 'string') {
      pushArtifact({
        path: filePath,
        openPath: filePath,
        kind: obj.kind,
        name: obj.file_name || obj.filename || obj.name,
        sourceLabel: tc?.name === 'edge_tts_synthesize' ? 'Edge TTS' : ''
      })
    }
    const fileUrl = obj.file_url || obj.fileUrl
    if (fileUrl && typeof fileUrl === 'string' && !String(fileUrl).includes('screenshots')) {
      pushArtifact({
        path: fileUrl,
        openPath: fileUrl,
        kind: obj.kind,
        name: obj.file_name || obj.filename || obj.name,
        sourceLabel: tc?.name === 'edge_tts_synthesize' ? 'Edge TTS' : ''
      })
    }
  }
  const rank = { audio: 0, video: 1, html: 2, file: 3 }
  return [...merged.values()].sort((a, b) => {
    const ra = rank[a.kind] ?? 99
    const rb = rank[b.kind] ?? 99
    if (ra !== rb) return ra - rb
    return String(a.name || a.openPath || a.path || '').localeCompare(
      String(b.name || b.openPath || b.path || ''),
      'zh-Hans-CN'
    )
  })
})

const isRevealableArtifact = (art) => {
  const target = String(art?.openPath || art?.path || '').trim()
  return !!target && (target.startsWith('/') || target.startsWith('local-resource://') || target.startsWith('file://'))
}

const revealArtifact = (art) => {
  const target = String(art?.openPath || art?.path || '').trim()
  if (!target) return
  try {
    window.electronAPI?.openInFinder?.({ path: target })
  } catch { /* ignore */ }
}

const captureArtifactDuration = (art, event) => {
  const key = artifactIdentity(art)
  if (!key) return
  const duration = Number(event?.target?.duration || 0)
  const text = formatDuration(duration)
  if (!text) return
  artifactDurationMap.value = {
    ...artifactDurationMap.value,
    [key]: text
  }
}

const isPreviewableArtifact = (art) => {
  const ext = artifactExtension(art)
  const target = String(art?.openPath || art?.path || '').trim()
  return !!target && (isTextLikeExtension(ext) || isHtmlArtifact(art))
}

const isArtifactPreviewOpen = (art) => !!artifactPreviewOpen.value[artifactIdentity(art)]

const isHtmlArtifact = (art) => {
  const ext = artifactExtension(art)
  return ext === '.html' || ext === '.htm' || String(art?.kind || '').toLowerCase() === 'html'
}

const isPdfArtifact = (art) => artifactExtension(art) === '.pdf'

const isModalPreviewableArtifact = (art) => {
  if (!art) return false
  return isHtmlArtifact(art) || isPdfArtifact(art) || isPreviewableArtifact(art)
}

const loadArtifactPreview = async (art) => {
  if (isHtmlArtifact(art) || isPdfArtifact(art)) return
  const key = artifactIdentity(art)
  const target = String(art?.openPath || art?.path || '').trim()
  if (!key || !target || artifactPreviewText.value[key] || artifactPreviewLoading.value[key]) return
  artifactPreviewLoading.value = { ...artifactPreviewLoading.value, [key]: true }
  artifactPreviewError.value = { ...artifactPreviewError.value, [key]: '' }
  try {
    const raw = await window.electronAPI?.readFile?.(target)
    const text = String(raw || '')
    artifactPreviewText.value = {
      ...artifactPreviewText.value,
      [key]: text.length > 12000 ? `${text.slice(0, 12000)}\n\n... (preview truncated)` : text
    }
  } catch (e) {
    artifactPreviewError.value = {
      ...artifactPreviewError.value,
      [key]: e?.message ? `预览失败：${e.message}` : '预览失败'
    }
  } finally {
    artifactPreviewLoading.value = { ...artifactPreviewLoading.value, [key]: false }
  }
}

const toggleArtifactPreview = (art) => {
  const key = artifactIdentity(art)
  if (!key) return
  const next = !artifactPreviewOpen.value[key]
  artifactPreviewOpen.value = { ...artifactPreviewOpen.value, [key]: next }
  if (next) loadArtifactPreview(art)
}

const openArtifactExternal = async (art) => {
  const target = String(art?.path || art?.openPath || '').trim()
  if (!target) return
  try {
    await window.electronAPI?.openExternal?.(target)
  } catch { /* ignore */ }
}

const openArtifactPreviewModal = async (art) => {
  artifactPreviewModal.value = art || null
  artifactPreviewModalText.value = ''
  artifactPreviewModalLoading.value = false
  artifactPreviewModalError.value = ''
  if (!art || isHtmlArtifact(art) || isPdfArtifact(art)) return
  if (!isPreviewableArtifact(art)) {
    artifactPreviewModalError.value = '该文件类型暂不支持直接预览，请使用“系统打开”。'
    return
  }
  const key = artifactIdentity(art)
  const cachedText = artifactPreviewText.value[key]
  if (cachedText) {
    artifactPreviewModalText.value = cachedText
    return
  }
  artifactPreviewModalLoading.value = true
  await loadArtifactPreview(art)
  artifactPreviewModalLoading.value = false
  artifactPreviewModalText.value = artifactPreviewText.value[key] || ''
  artifactPreviewModalError.value = artifactPreviewError.value[key] || ''
}

const closeArtifactPreviewModal = () => {
  artifactPreviewModal.value = null
  artifactPreviewModalText.value = ''
  artifactPreviewModalLoading.value = false
  artifactPreviewModalError.value = ''
}

const copyArtifactPath = async (art) => {
  const target = artifactDisplayPath(art)
  if (!target) return
  try {
    await navigator.clipboard.writeText(target)
    copiedArtifactPath.value = art.openPath || art.path
    setTimeout(() => {
      if (copiedArtifactPath.value === (art.openPath || art.path)) copiedArtifactPath.value = ''
    }, 1500)
  } catch { /* ignore */ }
}

const copyArtifactName = async (art) => {
  const name = String(art?.name || '').trim()
  if (!name) return
  try {
    await navigator.clipboard.writeText(name)
    copiedArtifactName.value = name
    setTimeout(() => {
      if (copiedArtifactName.value === name) copiedArtifactName.value = ''
    }, 1500)
  } catch { /* ignore */ }
}

const requestAudioRegenerate = (art) => {
  const targetName = String(art?.name || '').trim()
  const targetPath = artifactDisplayPath(art)
  const sourceLabel = String(art?.sourceLabel || '').trim()
  const prompt = [
    '请把刚才这条音频换一个明显不同的音色重新生成。',
    '保持文案不变。',
    '请直接使用 edge_tts_synthesize 在当前主会话生成并展示新的音频，不要发送到飞书。',
    sourceLabel ? `当前来源：${sourceLabel}。` : '',
    targetName ? `当前音频文件：${targetName}。` : '',
    targetPath ? `参考路径：${targetPath}。` : ''
  ].filter(Boolean).join(' ')
  emit('regenerate-audio', {
    artifact: art,
    prompt,
    message: props.message
  })
}

// take_screenshot 类工具结果：提取 file_url 或 image_base64 用于在会话中展示截图（支持被截断的 JSON）
function screenshotFromResult(resultStr) {
  if (!resultStr || typeof resultStr !== 'string') return null
  try {
    const obj = JSON.parse(resultStr)
    if (!obj || typeof obj !== 'object') return null
    const url = obj.file_url
    if (url && typeof url === 'string' && (url.startsWith('local-resource://screenshots/') || url.startsWith('local-resource://artifacts/') || url.startsWith('http'))) {
      return { url }
    }
    if (obj.image_base64 && typeof obj.image_base64 === 'string') {
      return { base64: obj.image_base64 }
    }
    return null
  } catch {
    const urlMatch = resultStr.match(/"file_url"\s*:\s*"(local-resource:\/\/[^"]+)"/)
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

  const codePlaceholders = []
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codePlaceholders.length
    const safeLang = String(lang || '').trim()
    codePlaceholders.push(`<pre class="code-block"><code class="lang-${safeLang}">${String(code || '').trim()}</code></pre>`)
    return `__CODE_PLACEHOLDER_${idx}__`
  })

  const applyInline = (line) => {
    let s = String(line || '')
    s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    return s
  }

  const lines = text.split('\n')
  const blocks = []
  let paragraphLines = []
  let listType = null
  let listItems = []

  const flushParagraph = () => {
    if (!paragraphLines.length) return
    blocks.push(`<div class="md-p">${paragraphLines.map(applyInline).join('<br>')}</div>`)
    paragraphLines = []
  }

  const flushList = () => {
    if (!listType || !listItems.length) return
    const tag = listType === 'ol' ? 'ol' : 'ul'
    const items = listItems.map((x) => `<li class="md-list-item">${applyInline(x)}</li>`).join('')
    blocks.push(`<${tag} class="md-list ${listType === 'ol' ? 'md-ordered-list' : 'md-unordered-list'}">${items}</${tag}>`)
    listType = null
    listItems = []
  }

  for (const rawLine of lines) {
    const line = String(rawLine || '')
    const t = line.trim()
    if (!t) {
      flushParagraph()
      flushList()
      continue
    }
    if (/^__CODE_PLACEHOLDER_\d+__$/.test(t)) {
      flushParagraph()
      flushList()
      blocks.push(t)
      continue
    }
    const h3 = t.match(/^###\s+(.+)$/)
    if (h3) {
      flushParagraph()
      flushList()
      blocks.push(`<div class="md-h3">${applyInline(h3[1])}</div>`)
      continue
    }
    const h2 = t.match(/^##\s+(.+)$/)
    if (h2) {
      flushParagraph()
      flushList()
      blocks.push(`<div class="md-h2">${applyInline(h2[1])}</div>`)
      continue
    }
    const h1 = t.match(/^#\s+(.+)$/)
    if (h1) {
      flushParagraph()
      flushList()
      blocks.push(`<div class="md-h1">${applyInline(h1[1])}</div>`)
      continue
    }
    const bq = t.match(/^&gt;\s+(.+)$/)
    if (bq) {
      flushParagraph()
      flushList()
      blocks.push(`<div class="md-blockquote">${applyInline(bq[1])}</div>`)
      continue
    }
    if (/^---$/.test(t)) {
      flushParagraph()
      flushList()
      blocks.push('<hr class="md-hr">')
      continue
    }
    const ul = t.match(/^[*-]\s+(.+)$/)
    if (ul) {
      flushParagraph()
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'
      listItems.push(ul[1])
      continue
    }
    const ol = t.match(/^\d+\.\s+(.+)$/)
    if (ol) {
      flushParagraph()
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'
      listItems.push(ol[1])
      continue
    }
    flushList()
    paragraphLines.push(t)
  }
  flushParagraph()
  flushList()
  text = blocks.join('')

  if (codePlaceholders.length) {
    text = text.replace(/__CODE_PLACEHOLDER_(\d+)__/g, (_, idx) => {
      const i = parseInt(idx, 10)
      return codePlaceholders[i] || ''
    })
  }

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
.reply-options {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.message-ui-blocks {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.message-ui-block {
  width: 100%;
}
.ui-status-card {
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
}
.ui-status-info {
  border-color: color-mix(in srgb, var(--ou-primary) 35%, var(--ou-border));
}
.ui-status-success {
  border-color: color-mix(in srgb, var(--ou-success) 35%, var(--ou-border));
}
.ui-status-warning {
  border-color: color-mix(in srgb, var(--ou-warning) 35%, var(--ou-border));
}
.ui-status-error {
  border-color: color-mix(in srgb, var(--ou-error) 35%, var(--ou-border));
}
.ui-status-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.ui-status-body {
  font-size: 12px;
  line-height: 1.5;
}
.ui-decision-card,
.ui-progress-card,
.ui-table-card,
.ui-form-card,
.ui-script-card {
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
}
.ui-decision-title,
.ui-table-title,
.ui-form-title,
.ui-script-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
}
.ui-decision-desc,
.ui-progress-desc {
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.ui-progress-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.ui-progress-title,
.ui-progress-value {
  font-size: 12px;
}
.ui-progress-track {
  width: 100%;
  height: 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  overflow: hidden;
}
.ui-progress-fill {
  display: block;
  height: 100%;
  background: color-mix(in srgb, var(--ou-primary) 75%, white 10%);
}
.ui-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.ui-table th,
.ui-table td {
  border: 1px solid rgba(255,255,255,0.08);
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.ui-table th {
  background: rgba(255,255,255,0.04);
}
.ui-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}
.ui-form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ui-form-label {
  font-size: 11px;
  color: var(--ou-text-muted);
}
.ui-form-input,
.ui-form-textarea {
  width: 100%;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  background: rgba(255,255,255,0.03);
  color: var(--ou-text);
  font-size: 12px;
  padding: 6px 8px;
  resize: vertical;
}
.ui-form-actions,
.ui-script-actions {
  margin-top: 10px;
}
.ui-script-command {
  display: block;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 8px;
}
.ui-script-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--ou-text-muted);
}
.ui-artifact-card,
.ui-tool-result-card {
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255,255,255,0.02);
}
.ui-artifact-head,
.ui-tool-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ui-artifact-title,
.ui-tool-result-title {
  font-size: 12px;
  font-weight: 600;
}
.ui-artifact-kind,
.ui-tool-result-status {
  font-size: 11px;
  color: var(--ou-text-muted);
}
.ui-artifact-path {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ou-text-muted);
  word-break: break-all;
}
.ui-artifact-desc,
.ui-tool-result-desc {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.ui-artifact-actions,
.ui-tool-result-actions {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ui-tool-result-summary {
  margin-top: 6px;
  font-size: 12px;
}
.ui-tool-result-success { border-color: color-mix(in srgb, var(--ou-success) 35%, var(--ou-border)); }
.ui-tool-result-warning { border-color: color-mix(in srgb, var(--ou-warning) 35%, var(--ou-border)); }
.ui-tool-result-error { border-color: color-mix(in srgb, var(--ou-error) 35%, var(--ou-border)); }
.ui-confirm-card {
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255,255,255,0.02);
}
.ui-confirm-warning { border-color: color-mix(in srgb, var(--ou-warning) 35%, var(--ou-border)); }
.ui-confirm-error { border-color: color-mix(in srgb, var(--ou-error) 35%, var(--ou-border)); }
.ui-confirm-success { border-color: color-mix(in srgb, var(--ou-success) 35%, var(--ou-border)); }
.ui-confirm-title {
  font-size: 12px;
  font-weight: 600;
}
.ui-confirm-desc {
  margin-top: 8px;
  font-size: 12px;
}
.ui-confirm-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ui-btn-secondary {
  border-color: rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.04);
}
.ui-input-card,
.ui-json-card,
.ui-timeline-card,
.ui-single-card,
.ui-gallery-card,
.ui-compare-card {
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255,255,255,0.02);
}
.ui-input-title,
.ui-json-title,
.ui-timeline-title,
.ui-single-title,
.ui-gallery-title,
.ui-compare-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
}
.ui-input-desc {
  margin-bottom: 8px;
  font-size: 12px;
}
.ui-input-label {
  display: block;
  font-size: 11px;
  color: var(--ou-text-muted);
  margin-bottom: 4px;
}
.ui-input-field {
  width: 100%;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  background: rgba(255,255,255,0.03);
  color: var(--ou-text);
  font-size: 12px;
  padding: 6px 8px;
}
.ui-input-actions {
  margin-top: 10px;
}
.ui-json-pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.45;
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.ui-timeline-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ui-timeline-item {
  display: flex;
  gap: 8px;
}
.ui-timeline-dot {
  margin-top: 4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ou-text-muted);
  flex: 0 0 auto;
}
.ui-timeline-done .ui-timeline-dot { background: var(--ou-success); }
.ui-timeline-doing .ui-timeline-dot { background: var(--ou-primary); }
.ui-timeline-error .ui-timeline-dot { background: var(--ou-error); }
.ui-timeline-item-title {
  font-size: 12px;
  font-weight: 600;
}
.ui-timeline-item-detail {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ou-text-muted);
}
.ui-gallery-desc,
.ui-compare-desc,
.ui-single-desc {
  margin-bottom: 8px;
  font-size: 12px;
}
.ui-single-figure {
  margin: 0;
}
.ui-single-image {
  width: 100%;
  max-height: 420px;
  object-fit: contain;
  border-radius: 8px;
}
.ui-single-caption {
  margin-top: 4px;
  font-size: 11px;
  color: var(--ou-text-muted);
}
.ui-gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}
.ui-gallery-masonry {
  grid-auto-flow: dense;
}
.ui-gallery-image {
  width: 100%;
  min-height: 92px;
  max-height: 220px;
  object-fit: cover;
  border-radius: 8px;
}
.ui-compare-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.ui-compare-item {
  margin: 0;
}
.ui-compare-image {
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  border-radius: 8px;
}
.ui-compare-caption {
  margin-top: 4px;
  font-size: 11px;
  color: var(--ou-text-muted);
}
.reply-option-btn {
  border: 1px solid color-mix(in srgb, var(--ou-primary) 45%, transparent);
  background: color-mix(in srgb, var(--ou-primary) 14%, transparent);
  color: var(--ou-text);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  transition: all 0.15s ease;
}
.reply-option-btn:hover {
  border-color: color-mix(in srgb, var(--ou-primary) 70%, transparent);
  background: color-mix(in srgb, var(--ou-primary) 24%, transparent);
}
.user-text { color: var(--ou-text); }

/* ── 工具调用卡片（与昵称同列，左对齐） ── */
.tool-card {
  margin: 6px 0;
  box-sizing: border-box;
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
.tc-texts {
  min-width: 0;
  flex: 1;
}
.tc-topline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tc-subtitle {
  margin-top: 2px;
  font-size: 9px;
  line-height: 1.1;
  color: color-mix(in srgb, var(--ou-text-muted) 78%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tc-subtitle-result {
  color: color-mix(in srgb, var(--ou-text) 74%, transparent);
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
.tc-detail { border-top: 1px solid var(--ou-border); padding-top: 8px; margin-top: -1px; }
.tc-screenshot { max-width: 100%; height: auto; border-radius: 6px; display: block; margin-bottom: 8px; }
.message-screenshots { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.message-screenshot-img { max-width: 100%; max-height: 320px; width: auto; height: auto; border-radius: 8px; object-fit: contain; cursor: pointer; }

.message-artifacts { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 10px; }
.message-artifact-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  width: min(100%, 560px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  background: rgba(255,255,255,0.03);
}
.message-artifact-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.message-artifact-icon {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.8);
}
.message-artifact-kind {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.72);
}
.message-artifact-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.message-artifact-audio { max-width: 320px; height: 36px; }
.message-artifact-video { max-width: 360px; border-radius: 8px; }
.message-artifact-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255,255,255,0.6);
}
.message-artifact-path {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-artifact-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.message-artifact-open,
.message-artifact-reveal,
.message-artifact-copy {
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.04);
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.message-artifact-preview {
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(0,0,0,0.18);
  overflow: hidden;
}
.message-artifact-preview-frame {
  display: block;
  width: 100%;
  height: 320px;
  border: 0;
  background: #fff;
}
.message-artifact-preview-state {
  padding: 10px 12px;
  font-size: 12px;
  color: rgba(255,255,255,0.65);
}
.message-artifact-preview-error {
  color: #ff8f8f;
}
.message-artifact-preview-text {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow: auto;
}
.message-artifact-video { max-width: 100%; max-height: 280px; border-radius: 8px; }
.message-artifact-file {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ou-primary);
  text-decoration: underline;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.message-artifact-file:hover { opacity: 0.85; }
.message-artifact-file-static {
  color: inherit;
  text-decoration: none;
  cursor: default;
}
.artifact-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.64);
  backdrop-filter: blur(8px);
}
.artifact-modal {
  width: min(960px, 100%);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.12);
  background: linear-gradient(180deg, rgba(34,34,34,0.98), rgba(22,22,22,0.98));
  box-shadow: 0 24px 70px rgba(0,0,0,0.45);
  overflow: hidden;
}
.artifact-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.artifact-modal-meta {
  min-width: 0;
  flex: 1 1 auto;
}
.artifact-modal-title {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.4;
  color: rgba(255,255,255,0.96);
  word-break: break-word;
}
.artifact-modal-subtitle {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: rgba(255,255,255,0.62);
}
.artifact-modal-path {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifact-modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.artifact-modal-btn {
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.92);
  font-size: 12px;
  cursor: pointer;
}
.artifact-modal-btn-close {
  background: rgba(255,255,255,0.08);
}
.artifact-modal-body {
  flex: 1 1 auto;
  min-height: 220px;
  background: rgba(10,10,10,0.62);
}
.artifact-modal-frame {
  display: block;
  width: 100%;
  height: min(72vh, 760px);
  border: 0;
  background: #fff;
}
.artifact-modal-frame-pdf {
  background: #2c2c2c;
}
.artifact-modal-state {
  padding: 28px 24px;
  font-size: 14px;
  line-height: 1.7;
  color: rgba(255,255,255,0.74);
}
.artifact-modal-state-error {
  color: #ff9898;
}
.artifact-modal-text {
  margin: 0;
  padding: 24px;
  max-height: min(72vh, 760px);
  overflow: auto;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(255,255,255,0.9);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SFMono-Regular', 'Monaco', 'Menlo', 'Consolas', monospace;
}
@media (max-width: 720px) {
  .artifact-modal-overlay {
    padding: 12px;
  }
  .artifact-modal {
    max-height: 92vh;
    border-radius: 14px;
  }
  .artifact-modal-head {
    flex-direction: column;
  }
  .artifact-modal-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .artifact-modal-frame,
  .artifact-modal-text {
    max-height: 68vh;
  }
}
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
.bubble-text :deep(.md-p) { margin: 0 0 10px; line-height: 1.72; }
.bubble-text :deep(.md-p:last-child) { margin-bottom: 0; }
.bubble-text :deep(.md-h1) { font-size: 16px; font-weight: 700; color: var(--ou-text); margin: 12px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--ou-border); }
.bubble-text :deep(.md-h2) { font-size: 14px; font-weight: 600; color: var(--ou-text); margin: 10px 0 5px; }
.bubble-text :deep(.md-h3) { font-size: 13px; font-weight: 600; color: var(--ou-text); margin: 8px 0 4px; }
.bubble-text :deep(.md-blockquote) { border-left: 3px solid var(--ou-border); padding: 4px 0 4px 10px; margin: 8px 0; color: var(--ou-text-muted); font-style: italic; }
.bubble-text :deep(.md-list) { margin: 6px 0 10px 0; padding-left: 20px; }
.bubble-text :deep(.md-list-item)  { margin: 3px 0; line-height: 1.66; }
.bubble-text :deep(.md-list.md-ordered-list) { list-style-type: decimal; }
.bubble-text :deep(.md-list.md-unordered-list) { list-style-type: disc; }
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
