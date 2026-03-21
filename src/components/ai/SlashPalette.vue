<template>
  <div v-if="show" class="slash-palette">
    <!-- 头部：当前路径 -->
    <div class="sp-header">
      <span class="sp-slash">/</span>
      <span v-if="category" class="sp-cat" @click="$emit('back')">{{ category }}</span>
      <span v-if="category" class="sp-sep"> </span>
      <span class="sp-query">{{ query }}</span>
      <span class="sp-cursor"></span>
    </div>

    <!-- 命令列表 -->
    <div class="sp-list" ref="listRef">
      <template v-if="items.length > 0">
        <div
          v-for="(item, idx) in items"
          :key="item.id"
          class="sp-item"
          :class="{ active: idx === activeIdx }"
          @mouseenter="activeIdx = idx"
          @mousedown.prevent="$emit('select', item)"
        >
          <span class="sp-item-icon" :class="'type-' + item.type">
            <component :is="typeIcon(item.type)" :size="12" />
          </span>
          <div class="sp-item-body">
            <span class="sp-item-name">{{ item.name }}</span>
            <span v-if="item.description" class="sp-item-desc">{{ item.description }}</span>
          </div>
          <ChevronRight v-if="item.type === 'category'" :size="11" class="sp-item-arrow" />
        </div>
      </template>
      <div v-else class="sp-empty">无匹配结果</div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { Zap, BookOpen, Plug, ChevronRight, Hash, Cpu } from 'lucide-vue-next'

const props = defineProps({
  show: Boolean,
  category: { type: String, default: '' },  // '' | 'skills' | 'playbook' | 'mcp' | 'model'
  query: { type: String, default: '' },
  items: { type: Array, default: () => [] }
})

const emit = defineEmits(['select', 'back', 'close'])

const activeIdx = ref(0)
const listRef = ref(null)

watch(() => [props.query, props.category, props.items], () => { activeIdx.value = 0 })

watch(activeIdx, (idx) => {
  nextTick(() => {
    const list = listRef.value
    if (!list) return
    const el = list.children[idx]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
})

const typeIcon = (type) => {
  if (type === 'category') return Hash
  if (type === 'skill')    return Zap
  if (type === 'playbook') return BookOpen
  if (type === 'mcp')      return Plug
  if (type === 'model')    return Cpu
  return ChevronRight
}

const onKeyDown = (e) => {
  if (!props.show) return false
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = Math.min(activeIdx.value + 1, props.items.length - 1)
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = Math.max(activeIdx.value - 1, 0)
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    const item = props.items[activeIdx.value]
    if (item) emit('select', item)
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return true
  }
  // Backspace 退回上一级
  if (e.key === 'Backspace' && props.category && !props.query) {
    emit('back')
    return true
  }
  return false
}

defineExpose({ onKeyDown })
</script>

<style scoped>
.slash-palette {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  background: var(--ou-bg-sidebar);
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--ou-shadow);
  overflow: hidden;
  z-index: 200;
  max-height: 300px;
  display: flex;
  flex-direction: column;
}

.sp-header {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--ou-border);
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', monospace;
  flex-shrink: 0;
}
.sp-slash { color: var(--ou-primary); font-weight: 700; }
.sp-cat {
  color: var(--ou-link);
  cursor: pointer;
}
.sp-cat:hover { text-decoration: underline; }
.sp-sep { color: var(--ou-text-muted); margin: 0 1px; }
.sp-query { color: var(--ou-warning); }
.sp-cursor {
  display: inline-block;
  width: 1px;
  height: 13px;
  background: var(--ou-primary);
  animation: blink 1s step-end infinite;
  vertical-align: middle;
  margin-left: 1px;
}
@keyframes blink { 50% { opacity: 0; } }

.sp-list { overflow-y: auto; flex: 1; }
.sp-list::-webkit-scrollbar { width: 4px; }
.sp-list::-webkit-scrollbar-thumb { background: var(--ou-border); border-radius: 2px; }

.sp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.sp-item.active { background: var(--ou-bg-hover); }

.sp-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  flex-shrink: 0;
}
.sp-item-icon.type-category { background: var(--ou-bg-hover); color: var(--ou-text-muted); }
.sp-item-icon.type-skill    { background: color-mix(in srgb, var(--ou-warning) 15%, transparent); color: var(--ou-warning); }
.sp-item-icon.type-playbook { background: color-mix(in srgb, var(--ou-link) 15%, transparent);  color: var(--ou-link); }
.sp-item-icon.type-mcp      { background: color-mix(in srgb, var(--ou-success) 15%, transparent); color: var(--ou-success); }

.sp-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sp-item-name { font-size: 13px; color: var(--ou-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-item-desc { font-size: 11px; color: var(--ou-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-item-arrow { color: var(--ou-text-secondary); flex-shrink: 0; }

.sp-empty { padding: 14px 12px; font-size: 12px; color: var(--ou-text-muted); text-align: center; }
</style>
