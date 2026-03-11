// Memory 存储：<appRoot>/memory/
//   memories.json              ← 碎片记忆（JSON，供程序检索）
//   YYYY-MM-DD.md              ← 按日期的对话日记（追加，供人工查看）
//   knowledge/
//     LESSONS_LEARNED.md       ← 结构化知识库（失败/成功经验提炼）
//     {project-hash}.md        ← 项目级知识沉淀
//
// <appRoot>/MEMORY.md          ← 全局持久偏好/决策（人工编辑 + AI 辅助）

const path = require('path')
const fs = require('fs')
const { getAppRoot, getAppRootPath } = require('../app-root')

function getGitManagerDir() {
  return getAppRoot()
}

function getMemoryDir() {
  return getAppRootPath('memory')
}

function getMemoryPath() {
  return path.join(getMemoryDir(), 'memories.json')
}

// 全局偏好文件路径
function getGlobalMemoryMdPath() {
  return getAppRootPath('MEMORY.md')
}

/** SOUL.md 路径：<appRoot>/SOUL.md（AI 性格/价值观层，与 MEMORY.md 并列） */
function getSoulMdPath() {
  return getAppRootPath('SOUL.md')
}

/** IDENTITY.md 路径：<appRoot>/IDENTITY.md（Agent 名字、形象、vibe、代词等） */
function getIdentityMdPath() {
  return getAppRootPath('IDENTITY.md')
}

/** USER.md 路径：<appRoot>/USER.md（用户信息：姓名、时区、工作、偏好、关键人物等） */
function getUserMdPath() {
  return getAppRootPath('USER.md')
}

/** BOOT.md 路径：<appRoot>/BOOT.md（会话启动时执行的简短指令） */
function getBootMdPath() {
  return getAppRootPath('BOOT.md')
}

/** AGENTS.md 路径：<appRoot>/AGENTS.md（工作区 Agent 说明，与 SOUL/IDENTITY 并列） */
function getAgentsMdPath() {
  return getAppRootPath('AGENTS.md')
}

/** TOOLS.md 路径：<appRoot>/TOOLS.md（工作区工具使用说明） */
function getToolsMdPath() {
  return getAppRootPath('TOOLS.md')
}

/** 读取本应用 SOUL.md（供 system prompt 注入），无或空则返回 null */
function readSoulMd() {
  try {
    const p = getSoulMdPath()
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8').trim()
    return content || null
  } catch { return null }
}

/** 读取 IDENTITY.md（供 system prompt 注入），无或空则返回 null */
function readIdentityMd() {
  try {
    const p = getIdentityMdPath()
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8').trim()
    return content || null
  } catch { return null }
}

function normalizeDisplayNameCandidate(value) {
  if (!value || typeof value !== 'string') return null
  let name = value.trim()
  if (!name) return null
  name = name
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/\*+/g, '')
    .replace(/^[_~\s]+|[_~\s]+$/g, '')
    .trim()
  if (!name) return null
  name = name.split(/[，。,；;！？!?]/)[0].trim()
  if (!name || name.length > 40) return null
  return name
}

/** 从 IDENTITY.md 内容解析显示名（用于 UI 展示「与谁对话」） */
function parseAgentDisplayName(raw) {
  if (!raw || typeof raw !== 'string') return null
  const lines = raw.split(/\r?\n/)

  // 1) 结构化键值：名字/名称/name/agent name
  const linePatterns = [
    /^[\s\-*•·>#\d.)\]]*(?:名字|名称|name|agent\s*name)\s*[：:]\s*(.+)$/i,
    /(?:名字|名称|name|agent\s*name)\s*[：:]\s*(.+)/i
  ]
  for (const line of lines) {
    const trimmed = line.trim()
    for (const p of linePatterns) {
      const m = trimmed.match(p)
      if (m && m[1]) {
        const name = normalizeDisplayNameCandidate(m[1])
        if (name) return name
      }
    }
  }

  // 2) 标题式写法：# Agent: Atlas
  for (const line of lines) {
    const m = line.trim().match(/^#{1,6}\s*(?:agent|assistant|名字|名称)?\s*[：:\-]\s*(.+)$/i)
    if (m && m[1]) {
      const name = normalizeDisplayNameCandidate(m[1])
      if (name) return name
    }
  }

  // 3) 块结构：## 名字（下一行是值）
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!/^#{1,6}\s*(名字|名称|name|agent\s*name)\s*$/i.test(t)) continue
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim()
      if (!next) continue
      if (/^#{1,6}\s+/.test(next)) break
      const name = normalizeDisplayNameCandidate(next)
      if (name) return name
      break
    }
  }

  // 4) 明确命名短语（优先于“我是 xxx”）：名为/叫做/you can call me
  const namedCn = raw.match(/(?:名为|叫做|名字是)\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,32})/)
  if (namedCn && namedCn[1]) {
    const name = normalizeDisplayNameCandidate(namedCn[1])
    if (name) return name
  }
  const namedEn = raw.match(/(?:my\s+name\s+is|you\s+can\s+call\s+me)\s+([A-Za-z][A-Za-z0-9 _-]{0,31})/i)
  if (namedEn && namedEn[1]) {
    const name = normalizeDisplayNameCandidate(namedEn[1])
    if (name) return name
  }

  // 5) 自我介绍短句：我是小石头 / 我叫小石头 / I am Atlas
  const cn = raw.match(/(?:我是|我叫)\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,32})/)
  if (cn && cn[1]) {
    const name = normalizeDisplayNameCandidate(cn[1])
    if (name) return name
  }
  const en = raw.match(/(?:i\s+am|i'm)\s+([A-Za-z][A-Za-z0-9 _-]{0,31})/i)
  if (en && en[1]) {
    const name = normalizeDisplayNameCandidate(en[1])
    if (name) return name
  }
  return null
}

/** 从 IDENTITY.md 解析显示名 */
function readAgentDisplayName() {
  const raw = readIdentityMd()
  return parseAgentDisplayName(raw)
}

/** 读取 USER.md（供 system prompt 注入），无或空则返回 null */
function readUserMd() {
  try {
    const p = getUserMdPath()
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8').trim()
    return content || null
  } catch { return null }
}

/** 读取 BOOT.md（会话启动时注入的简短指令），无或空则返回 null */
function readBootMd() {
  try {
    const p = getBootMdPath()
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8').trim()
    return content || null
  } catch { return null }
}

/** 读取 AGENTS.md（工作区 Agent 说明），无或空则返回 null */
function readAgentsMd() {
  try {
    const p = getAgentsMdPath()
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8').trim()
    return content || null
  } catch { return null }
}

/** 读取 TOOLS.md（工作区工具使用说明），无或空则返回 null */
function readToolsMd() {
  try {
    const p = getToolsMdPath()
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8').trim()
    return content || null
  } catch { return null }
}

// 按日期的日记文件路径
function getDiaryPath(date) {
  const d = date || new Date()
  const dateStr = d.toISOString().slice(0, 10)
  return path.join(getMemoryDir(), `${dateStr}.md`)
}

// 知识库目录
function getKnowledgeDir() {
  return path.join(getMemoryDir(), 'knowledge')
}

function getLessonsLearnedPath() {
  return path.join(getKnowledgeDir(), 'LESSONS_LEARNED.md')
}

/** 读取全局 MEMORY.md（供 system prompt 注入），过滤纯注释/标题行，无实质内容时返回 null */
function readGlobalMemoryMd() {
  try {
    const p = getGlobalMemoryMdPath()
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf-8')
    const meaningful = filterMeaningfulMemoryLines(content)
    if (meaningful.length === 0) return null
    return content.trim()
  } catch { return null }
}

function filterMeaningfulMemoryLines(content) {
  return content.split('\n').filter(line => {
    const t = line.trim()
    if (!t) return false
    if (t.startsWith('<!--') || t.endsWith('-->')) return false
    if (t.startsWith('#')) return false
    return true
  })
}

/** 追加到当日日记（对话结束后调用） */
function appendToDiary(entries, date) {
  if (!entries || entries.length === 0) return
  const p = getDiaryPath(date)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const now = new Date()
  const timeStr = now.toTimeString().slice(0, 8)
  const lines = [`\n## ${timeStr}\n`, ...entries.map(e => `- ${e}`), '']
  fs.appendFileSync(p, lines.join('\n'), 'utf-8')
}

/** 追加经验到 LESSONS_LEARNED.md */
function appendLesson(lesson, category = '通用') {
  if (!lesson?.trim()) return
  const p = getLessonsLearnedPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '# 知识库 - 经验教训\n\n> 由 AI 自动提炼，记录失败教训和成功模式\n\n', 'utf-8')
  }
  const now = new Date().toISOString().slice(0, 10)
  fs.appendFileSync(p, `\n### [${now}] ${category}\n${lesson.trim()}\n`, 'utf-8')
}

/** 读取 LESSONS_LEARNED.md（供自进化分析使用） */
function readLessonsLearned() {
  try {
    const p = getLessonsLearnedPath()
    if (!fs.existsSync(p)) return null
    return fs.readFileSync(p, 'utf-8').trim() || null
  } catch { return null }
}

function readAll() {
  try {
    const p = getMemoryPath()
    if (!fs.existsSync(p)) return []
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch { return [] }
}

function writeAll(memories) {
  const dir = getMemoryDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getMemoryPath(), JSON.stringify(memories, null, 2), 'utf-8')
}

function genId() {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 时序衰减因子：半衰期 30 天，指数衰减
 * score × e^(-λ × ageInDays)，λ = ln(2)/30 ≈ 0.023
 */
function temporalDecay(memory) {
  const updatedAt = memory.updatedAt || memory.createdAt
  if (!updatedAt) return 1
  const ageInDays = (Date.now() - new Date(updatedAt).getTime()) / 86400000
  return Math.exp(-0.023 * ageInDays)
}

/**
 * 关键词相关度打分（含时序衰减）
 */
function scoreMemory(memory, query, projectPath) {
  let score = 0
  const q = query.toLowerCase()
  const words = q.split(/\s+/).filter(Boolean)
  const text = (memory.content + ' ' + (memory.tags || []).join(' ')).toLowerCase()

  for (const word of words) {
    if (text.includes(word)) score += 2
  }
  // 完整短语匹配额外加分
  if (text.includes(q)) score += 3
  // 项目匹配额外加分
  if (projectPath && memory.projectPath === projectPath) score += 1
  // 全局记忆（无 projectPath）也有基础分
  if (!memory.projectPath) score += 0.5
  // 访问频率加权
  score += Math.min((memory.accessCount || 0) * 0.1, 1)
  // 时序衰减（旧记忆降权，避免过时信息干扰）
  score *= temporalDecay(memory)

  return score
}

/**
 * 搜索记忆（关键词匹配，按相关度排序）
 * @param {string} query       - 搜索关键词
 * @param {string} projectPath - 当前项目路径（可选，影响排序优先级）
 * @param {number} limit       - 返回数量，默认 10
 */
function searchMemories(query, projectPath, limit = 10) {
  const memories = readAll()
  if (!query) {
    // 无关键词时返回最近访问的
    return memories
      .filter(m => !projectPath || !m.projectPath || m.projectPath === projectPath)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit)
  }

  return memories
    .map(m => ({ ...m, _score: scoreMemory(m, query, projectPath) }))
    .filter(m => m._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...m }) => m)  // 去掉内部分数字段
}

/**
 * 按标签列出记忆（用于会话摘要历史）
 * @param {string[]} tags - 必须同时包含的标签
 * @param {string|null} projectPath - 可选，按项目过滤
 * @param {number} limit
 */
function listMemoriesByTags(tags = [], projectPath = null, limit = 10) {
  const required = (tags || []).map(t => String(t || '').trim()).filter(Boolean)
  const memories = readAll()
  return memories
    .filter((m) => {
      if (projectPath && m.projectPath !== projectPath) return false
      if (!required.length) return true
      const mTags = Array.isArray(m.tags) ? m.tags : []
      return required.every(t => mTags.includes(t))
    })
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, limit)
}

/**
 * 获取指定 id 的记忆，并更新访问统计
 */
function getMemory(id) {
  const memories = readAll()
  const idx = memories.findIndex(m => m.id === id)
  if (idx < 0) return null
  memories[idx].accessCount = (memories[idx].accessCount || 0) + 1
  memories[idx].lastAccessedAt = new Date().toISOString()
  writeAll(memories)
  return memories[idx]
}

/**
 * 保存记忆（新建或更新）
 * @param {string} content    - 记忆内容
 * @param {string[]} tags     - 标签数组
 * @param {string} projectPath - 关联项目路径（null 表示全局）
 * @param {string} [id]       - 更新时传入已有 id
 * @param {string} [source]   - 'auto' | 'manual'，默认 'manual'
 */
function saveMemory({ content, tags = [], projectPath = null, id = null, source = 'manual' }) {
  const memories = readAll()
  const now = new Date().toISOString()

  if (id) {
    const idx = memories.findIndex(m => m.id === id)
    if (idx >= 0) {
      memories[idx] = { ...memories[idx], content, tags, projectPath, updatedAt: now }
      writeAll(memories)
      return memories[idx]
    }
  }

  // 新建
  const memory = {
    id: genId(),
    content,
    tags,
    projectPath,
    source,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: null
  }
  memories.unshift(memory)
  writeAll(memories)
  return memory
}

/**
 * 删除记忆
 */
function deleteMemory(id) {
  const memories = readAll()
  writeAll(memories.filter(m => m.id !== id))
}

/**
 * 获取与当前项目相关的 top-N 记忆，用于注入 system prompt
 * 优先返回项目相关记忆，然后是全局记忆，按访问频率和时间排序
 */
function getTopMemoriesForProject(projectPath, limit = 5) {
  const memories = readAll()
  // 按 访问频率 × 时序衰减 综合评分排序
  const score = (m) => (1 + (m.accessCount || 0) * 0.2) * temporalDecay(m)

  const projectMems = memories
    .filter(m => m.projectPath === projectPath)
    .sort((a, b) => score(b) - score(a))
    .slice(0, Math.ceil(limit * 0.7))

  const needed = limit - projectMems.length
  const projectIds = new Set(projectMems.map(m => m.id))
  const globalMems = memories
    .filter(m => !m.projectPath && !projectIds.has(m.id))
    .sort((a, b) => score(b) - score(a))
    .slice(0, needed)

  return [...projectMems, ...globalMems]
}

// ---- 向量语义搜索支持 ----

/** 余弦相似度 */
function cosineSimilarity(v1, v2) {
  if (!v1 || !v2 || v1.length !== v2.length) return 0
  let dot = 0, n1 = 0, n2 = 0
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i]
    n1 += v1[i] * v1[i]
    n2 += v2[i] * v2[i]
  }
  const denom = Math.sqrt(n1) * Math.sqrt(n2)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 调用 AI API 生成文本 embedding（需要 apiConfig）
 * 返回 number[] 或 null（失败时）
 */
async function generateEmbedding(text, apiConfig) {
  if (!text || !apiConfig?.apiKey) return null
  const https = require('https')
  const http = require('http')
  const { URL } = require('url')

  const baseUrl = (apiConfig.apiBaseUrl || 'https://api.openai.com/v1').trim()
  // 仅通用 OpenAI 兼容 /embeddings 的供应商才走；Claude、七牛等无通用 embedding 接口则跳过
  if (baseUrl.includes('anthropic.com') || baseUrl.includes('qnaigc.com')) return null

  const url = new URL(`${baseUrl}/embeddings`)
  const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 2000) })

  return new Promise((resolve) => {
    const req = (url.protocol === 'https:' ? https : http).request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    }, (res) => {
      const chunks = []
      res.setEncoding('utf-8')
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const data = JSON.parse(chunks.join(''))
          resolve(data.data?.[0]?.embedding || null)
        } catch { resolve(null) }
      })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
    req.write(body)
    req.end()
  })
}

/**
 * 语义搜索（优先余弦相似度，fallback 关键词匹配）
 * @param {string} query
 * @param {string|null} projectPath
 * @param {number} limit
 * @param {object|null} apiConfig  - 若提供则尝试生成 query embedding
 */
async function searchMemoriesSemantic(query, projectPath, limit = 10, apiConfig = null) {
  const memories = readAll()
  if (!memories.length) return []

  // 尝试生成 query embedding
  let queryEmbedding = null
  if (apiConfig?.apiKey) {
    queryEmbedding = await generateEmbedding(query, apiConfig).catch(() => null)
  }

  const scored = memories.map(m => {
    let score = 0
    if (queryEmbedding && m.embedding) {
      // 向量相似度路径：cosine 相似度 + 时序衰减 + 项目加权
      score = cosineSimilarity(queryEmbedding, m.embedding) * 10
      score *= temporalDecay(m)
      if (projectPath && m.projectPath === projectPath) score *= 1.2
    } else {
      // fallback：关键词匹配（scoreMemory 内部已含时序衰减，无需再乘）
      score = scoreMemory(m, query, projectPath)
    }
    return { ...m, _score: score }
  })

  return scored
    .filter(m => m._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, embedding: _, ...m }) => m)  // 去掉内部字段
}

/**
 * 异步为记忆生成并缓存 embedding（后台执行）
 */
async function cacheEmbeddingForMemory(memoryId, apiConfig) {
  if (!apiConfig?.apiKey) return
  const memories = readAll()
  const idx = memories.findIndex(m => m.id === memoryId)
  if (idx < 0 || memories[idx].embedding) return  // 已有 embedding，跳过

  const embedding = await generateEmbedding(memories[idx].content, apiConfig).catch(() => null)
  if (embedding) {
    memories[idx].embedding = embedding
    writeAll(memories)
  }
}

module.exports = {
  searchMemories,
  listMemoriesByTags,
  searchMemoriesSemantic,
  generateEmbedding,
  cacheEmbeddingForMemory,
  getMemory,
  saveMemory,
  deleteMemory,
  getTopMemoriesForProject,
  readGlobalMemoryMd,
  getSoulMdPath,
  readSoulMd,
  getIdentityMdPath,
  readIdentityMd,
  parseAgentDisplayName,
  readAgentDisplayName,
  getUserMdPath,
  readUserMd,
  getBootMdPath,
  readBootMd,
  getAgentsMdPath,
  readAgentsMd,
  getToolsMdPath,
  readToolsMd,
  appendToDiary,
  appendLesson,
  readLessonsLearned,
  getGlobalMemoryMdPath,
  getLessonsLearnedPath
}
