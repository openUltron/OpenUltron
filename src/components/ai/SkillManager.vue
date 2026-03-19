<template>
  <div class="skill-manager">
    <div class="sm-header">
      <div class="sm-title">
        <Zap :size="16" />
        <span>Skills</span>
      </div>
    </div>

    <!-- 新建/编辑表单 -->
    <div v-if="editing" class="sm-form">
      <div class="sm-form-title">{{ editing.id && !editing._isNew ? '编辑 Skills' : '新建 Skills' }}</div>
      <div class="sm-form-row">
        <div class="sm-form-col">
          <label class="sm-label">技能名称</label>
          <input v-model="editing.name" class="sm-input" placeholder="技能名称" />
        </div>
        <div class="sm-form-col">
          <label class="sm-label">项目类型</label>
          <select v-model="editing.projectType" class="sm-select">
            <option value="frontend">前端</option>
            <option value="backend">后端</option>
            <option value="app">APP</option>
            <option value="all">通用</option>
          </select>
        </div>
        <div class="sm-form-col">
          <label class="sm-label">分类</label>
          <select v-model="editing.category" class="sm-select">
            <option value="deploy">部署</option>
            <option value="review">审查</option>
            <option value="custom">自定义</option>
          </select>
        </div>
      </div>
      <label class="sm-label">描述</label>
      <input v-model="editing.description" class="sm-input" placeholder="简短描述此技能的用途" />
      <label class="sm-label">Prompt</label>
      <textarea v-model="editing.prompt" class="sm-textarea" placeholder="输入技能 Prompt..." rows="10"></textarea>
      <div class="sm-form-actions">
        <button class="sm-btn primary" @click="saveEditing" :disabled="!editing.name.trim() || !editing.prompt.trim()">保存</button>
        <button class="sm-btn" @click="editing = null">取消</button>
      </div>
    </div>

    <!-- 技能列表 -->
    <div class="sm-list">
      <div v-if="allSkills.length === 0 && !editing" class="sm-empty">
        <Zap :size="40" class="sm-empty-icon" />
        <p>暂无 Skills</p>
        <p class="sm-empty-hint">由 AI 自动安装</p>
      </div>

      <!-- 内置 + 自定义技能 -->
      <template v-for="(group, catKey) in groupedSkills" :key="catKey">
        <div class="sm-group-label">
          <component :is="categoryIcon(catKey)" :size="11" />
          <span>{{ categoryLabel(catKey) }}</span>
          <span class="sm-group-count">{{ group.length }}</span>
        </div>
        <div v-for="skill in group" :key="skill.id" class="sm-card">
          <div class="sm-card-header">
            <span class="sm-card-name">{{ skill.name }}</span>
            <span class="sm-project-tag" :style="{ background: projectTypeColor(skill.projectType) + '22', color: projectTypeColor(skill.projectType), borderColor: projectTypeColor(skill.projectType) + '44' }">
              {{ projectTypeLabel(skill.projectType) }}
            </span>
            <span v-if="skill.builtIn" class="sm-builtin-tag">内置</span>
            <div class="sm-card-actions">
              <button class="sm-icon-btn" @click="startEdit(skill)" title="编辑">
                <Pencil :size="12" />
              </button>
              <button v-if="!skill.builtIn" class="sm-icon-btn danger" @click="deleteSkill(skill.id)" title="删除">
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
          <div class="sm-card-desc">{{ skill.description || '(无描述)' }}</div>
          <div class="sm-card-preview">{{ skill.prompt }}</div>
          <div class="sm-card-meta">{{ skill.builtIn ? '内置技能' : ('更新于 ' + formatDate(skill.updatedAt)) }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Zap, Pencil, Trash2, Rocket, Eye, Wrench } from 'lucide-vue-next'

// ── 状态 ──────────────────────────────────────────────────
const allSkillsRaw = ref([])
const editing = ref(null)

// ── 计算属性 ──────────────────────────────────────────────
// 展示全部技能（含内置如 agent-browser），内置技能带「内置」标签且不可删除
const allSkills = computed(() => allSkillsRaw.value)

const groupedSkills = computed(() => {
  const order = ['deploy', 'review', 'custom']
  const groups = {}
  for (const cat of order) {
    const items = allSkills.value.filter(s => s.category === cat)
    if (items.length > 0) groups[cat] = items
  }
  return groups
})

// ── 生命周期 ──────────────────────────────────────────────
let unsubscribeSkillsChanged = null
onMounted(() => {
  loadSkills()
  if (window.electronAPI?.ai?.onSkillsChanged) {
    unsubscribeSkillsChanged = window.electronAPI.ai.onSkillsChanged(loadSkills)
  }
})
onUnmounted(() => {
  if (typeof unsubscribeSkillsChanged === 'function') unsubscribeSkillsChanged()
})

// ── 数据读写 ──────────────────────────────────────────────
async function loadSkills() {
  try {
    const res = await window.electronAPI.ai.getSkills()
    if (res && res.success) {
      allSkillsRaw.value = res.skills || []
      return
    }
  } catch { /* ignore */ }
  allSkillsRaw.value = []
}

async function persistSkill(skill) {
  try {
    await window.electronAPI.ai.saveSkill(skill)
  } catch { /* ignore */ }
  await loadSkills()
}

async function removeSkill(id) {
  try {
    await window.electronAPI.ai.deleteSkill({ id })
  } catch { /* ignore */ }
  await loadSkills()
}

// ── 操作 ──────────────────────────────────────────────────
function startEdit(skill) {
  editing.value = { ...skill, _isNew: false }
}

async function saveEditing() {
  if (!editing.value?.name.trim() || !editing.value?.prompt.trim()) return

  // Use existing id (filename without .md) or derive from name for new skills
  const id = editing.value.id || editing.value.name.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_')
  const skill = {
    id,
    name: editing.value.name.trim(),
    category: editing.value.category,
    projectType: editing.value.projectType,
    description: editing.value.description.trim(),
    prompt: editing.value.prompt.trim(),
    builtIn: editing.value.builtIn || false
  }

  await persistSkill(skill)
  editing.value = null
}

async function deleteSkill(id) {
  await removeSkill(id)
}

// ── 辅助函数 ──────────────────────────────────────────────
function categoryLabel(cat) {
  return { deploy: '部署', review: '审查', custom: '自定义' }[cat] || cat
}

function categoryIcon(cat) {
  return { deploy: Rocket, review: Eye, custom: Wrench }[cat] || Zap
}

function projectTypeLabel(pt) {
  return { frontend: '前端', backend: '后端', app: 'APP', all: '通用' }[pt] || pt
}

function projectTypeColor(pt) {
  return { frontend: 'var(--ou-link)', backend: '#ce9178', app: '#c9a0dc', all: 'var(--ou-success)' }[pt] || 'var(--ou-text-muted)'
}

function formatDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<style scoped>
.skill-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--ou-bg-main);
  overflow: hidden;
  padding: 20px 24px;
}

/* ── Header ── */
.sm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 12px 0;
  border-bottom: 1px solid var(--ou-border);
  flex-shrink: 0;
  gap: 10px;
}
.sm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--ou-text);
  flex-shrink: 0;
}
.sm-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm-ghost-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--ou-border);
  border-radius: 4px;
  background: transparent;
  color: var(--ou-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.sm-ghost-btn:hover { background: var(--ou-bg-hover); color: var(--ou-text); }
.sm-new-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  background: var(--ou-primary);
  border: none;
  border-radius: 4px;
  color: var(--ou-accent-fg);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.sm-new-btn:hover { background: var(--ou-primary-hover); }

/* ── Form ── */
.sm-form {
  padding: 16px 20px;
  border-bottom: 1px solid var(--ou-border);
  background: var(--ou-bg-sidebar);
  flex-shrink: 0;
  max-height: 55vh;
  overflow-y: auto;
}
.sm-form::-webkit-scrollbar { width: 6px; }
.sm-form::-webkit-scrollbar-thumb { background: var(--ou-border); border-radius: 3px; }

.sm-form-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
  margin-bottom: 12px;
}
.sm-form-row {
  display: flex;
  gap: 12px;
}
.sm-form-col {
  flex: 1;
  min-width: 0;
}
.sm-label {
  display: block;
  font-size: 11px;
  color: var(--ou-text-muted);
  margin-bottom: 4px;
  margin-top: 10px;
}
.sm-input,
.sm-select,
.sm-textarea {
  width: 100%;
  background: var(--ou-bg-main);
  border: 1px solid var(--ou-border);
  border-radius: 4px;
  color: var(--ou-text);
  font-size: 12px;
  padding: 6px 10px;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s;
}
.sm-input:focus,
.sm-select:focus,
.sm-textarea:focus { border-color: var(--ou-primary); }
.sm-select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
  cursor: pointer;
}
.sm-select option { background: var(--ou-bg-card); }
.sm-textarea {
  resize: vertical;
  min-height: 160px;
  line-height: 1.6;
  font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
  font-size: 11.5px;
}
.sm-form-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.sm-btn {
  padding: 5px 14px;
  border: 1px solid var(--ou-border);
  border-radius: 4px;
  background: transparent;
  color: var(--ou-text);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.sm-btn:hover { background: var(--ou-bg-hover); }
.sm-btn.primary { background: var(--ou-primary); border-color: var(--ou-primary); color: var(--ou-accent-fg); }
.sm-btn.primary:hover { background: var(--ou-primary-hover); }
.sm-btn:disabled { opacity: 0.4; cursor: default; }

/* ── List ── */
.sm-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
  align-content: start;
}
.sm-list::-webkit-scrollbar { width: 6px; }
.sm-list::-webkit-scrollbar-thumb { background: var(--ou-border); border-radius: 3px; }

.sm-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--ou-text-muted);
  gap: 8px;
}
.sm-empty-icon { color: var(--ou-text-secondary); }
.sm-empty p { margin: 0; font-size: 14px; }
.sm-empty-hint { font-size: 12px !important; color: var(--ou-text-secondary); }

.sm-group-label {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--ou-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 6px;
}
.sm-group-count {
  background: var(--ou-bg-hover);
  color: var(--ou-text-muted);
  border-radius: 8px;
  padding: 0 5px;
  font-size: 9px;
  line-height: 16px;
}

/* ── Card ── */
.sm-card {
  background: var(--ou-bg-sidebar);
  border: 1px solid var(--ou-border);
  border-radius: 8px;
  padding: 12px 14px;
  transition: border-color 0.15s;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sm-card:hover { border-color: var(--ou-border); }

.sm-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm-card-name {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--ou-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-project-tag {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 10px;
  border: 1px solid;
  font-weight: 500;
  flex-shrink: 0;
  line-height: 16px;
}
.sm-builtin-tag {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 10px;
  background: rgba(255, 200, 0, 0.1);
  color: var(--ou-warning);
  border: 1px solid rgba(240, 192, 64, 0.3);
  flex-shrink: 0;
  line-height: 16px;
}
.sm-card-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.sm-icon-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--ou-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.sm-icon-btn:hover { background: var(--ou-bg-hover); color: var(--ou-text); }
.sm-icon-btn.danger:hover { background: rgba(241,76,76,0.15); color: var(--ou-error); }

.sm-card-desc {
  font-size: 11px;
  color: var(--ou-text-muted);
  line-height: 1.4;
}
.sm-card-preview {
  font-size: 11px;
  color: var(--ou-text-muted);
  line-height: 1.5;
  max-height: 52px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  white-space: pre-wrap;
  word-break: break-word;
}
.sm-card-meta {
  font-size: 10px;
  color: var(--ou-text-secondary);
  margin-top: 2px;
}

/* ── Claude 技能 ── */
.sm-group-path {
  font-size: 9px;
  color: var(--ou-text-secondary);
  font-family: 'Monaco', 'Menlo', monospace;
  margin-left: 4px;
}
</style>
