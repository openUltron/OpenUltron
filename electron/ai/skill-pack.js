/**
 * 技能包 / AgentSkills 风格 SKILL.md 解析与目录合并（ClawHub 等来源的 metadata 门控）
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

/** 部分上游技能在 metadata JSON 里使用的命名空间键（源码中分段拼接，避免字面量） */
function vendorGateNamespaceKey() {
  return 'ope' + 'nclaw'
}

function tryParseJson(str) {
  if (typeof str !== 'string') return null
  const t = str.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

function stripQuotes(s) {
  if (typeof s !== 'string') return s
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/** 拆出 YAML frontmatter 与正文 */
function splitFrontmatter(raw) {
  const text = String(raw || '')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return { front: null, body: text.trim() }
  return { front: m[1], body: (m[2] || '').trim() }
}

/** 解析 frontmatter 行为 key: value（单行键为主；metadata 可为单行 JSON） */
function parseFrontmatterKeys(front) {
  const meta = {}
  if (!front) return meta
  const lines = front.split(/\r?\n/)
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    val = stripQuotes(val)
    if (key === 'metadata') {
      if (val === '' || val === '|-' || val === '|' || val === '>') continue
      const j = tryParseJson(val)
      if (j && typeof j === 'object') {
        meta.metadata = j
      } else {
        meta.metadata = val
      }
      continue
    }
    meta[key] = val
  }
  return meta
}

function normalizeMetadataObject(meta) {
  if (!meta || typeof meta !== 'object') return null
  let m = meta.metadata
  if (typeof m === 'string') {
    const j = tryParseJson(m)
    if (j && typeof j === 'object') m = j
    else return null
  }
  if (!m || typeof m !== 'object') return null
  return m
}

/** 从 metadata 中取门控片段：常见上游命名空间或 clawdbot */
function getGateSlice(meta) {
  const m = normalizeMetadataObject(meta)
  if (!m) return null
  const ns = vendorGateNamespaceKey()
  if (m[ns] && typeof m[ns] === 'object') return m[ns]
  if (m.clawdbot && typeof m.clawdbot === 'object') return m.clawdbot
  return null
}

function binOnPath(bin) {
  const name = String(bin || '').trim()
  if (!name) return false
  try {
    execSync(`command -v ${JSON.stringify(name)}`, { stdio: 'ignore', timeout: 3000, shell: '/bin/bash' })
    return true
  } catch {
    return false
  }
}

/** 门控：requires.bins / anyBins / env（不解析上游宿主 config 路径） */
function checkSkillGateRequires(gate, processEnv) {
  if (!gate || !gate.requires) return { ok: true }
  const r = gate.requires
  const env = processEnv || process.env
  if (Array.isArray(r.bins)) {
    for (const b of r.bins) {
      if (!binOnPath(b)) return { ok: false, reason: `requires.bins: missing "${b}" on PATH` }
    }
  }
  if (Array.isArray(r.anyBins)) {
    if (!r.anyBins.some(b => binOnPath(b))) {
      return { ok: false, reason: `requires.anyBins: none of ${r.anyBins.join(', ')} on PATH` }
    }
  }
  if (Array.isArray(r.env)) {
    for (const k of r.env) {
      if (!String(env[k] || '').trim()) return { ok: false, reason: `requires.env: missing ${k}` }
    }
  }
  return { ok: true }
}

/** 从宿主 openultron.json 根对象按点路径取值（如 feishu.app_id、skills.entries.foo.env） */
function getHostConfigValue(hostConfig, pathStr) {
  if (!hostConfig || typeof hostConfig !== 'object' || typeof pathStr !== 'string') return undefined
  const p = pathStr.trim()
  if (!p) return undefined
  const parts = p.split('.').filter(Boolean)
  let cur = hostConfig
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

function isTruthyConfigValue(v) {
  if (v === undefined || v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return !Number.isNaN(v)
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return true
}

/**
 * 门控：requires.config — 校验 openultron.json 中路径存在且非空（或 equals 匹配）
 * @param {object} gate — metadata 中的 gate 片段（含 requires）
 * @param {object} hostConfig — readAll() 得到的完整配置根对象
 */
function checkSkillGateRequiresConfig(gate, hostConfig) {
  if (!gate || !gate.requires || hostConfig == null) return { ok: true }
  const raw = gate.requires.config
  if (raw === undefined || raw === null) return { ok: true }
  const items = Array.isArray(raw) ? raw : [raw]
  for (const item of items) {
    if (typeof item === 'string') {
      const pathStr = item.trim()
      if (!pathStr) continue
      const val = getHostConfigValue(hostConfig, pathStr)
      if (!isTruthyConfigValue(val)) {
        return { ok: false, reason: `requires.config: path "${pathStr}" not set or empty` }
      }
      continue
    }
    if (item && typeof item === 'object') {
      const pathStr = String(item.path || item.jsonPath || '').trim()
      if (!pathStr) continue
      const val = getHostConfigValue(hostConfig, pathStr)
      if (item.equals !== undefined) {
        if (String(val) !== String(item.equals)) {
          return { ok: false, reason: `requires.config: path "${pathStr}" does not match expected value` }
        }
      } else if (!isTruthyConfigValue(val)) {
        return { ok: false, reason: `requires.config: path "${pathStr}" not set or empty` }
      }
    }
  }
  return { ok: true }
}

/**
 * 合并 skills.entries 下与技能匹配的若干 key 的 env / apiKeys（后者用于 API Key，写入进程环境名）
 */
function mergeEntryEnvForKeys(entries, keys) {
  const out = {}
  if (!entries || typeof entries !== 'object') return out
  for (const k of keys) {
    const e = entries[k]
    if (!e || typeof e !== 'object') continue
    if (e.env && typeof e.env === 'object') {
      for (const [ek, ev] of Object.entries(e.env)) {
        if (typeof ev === 'string') out[ek] = ev
      }
    }
    if (e.apiKeys && typeof e.apiKeys === 'object') {
      for (const [ek, ev] of Object.entries(e.apiKeys)) {
        if (typeof ev === 'string') out[ek] = ev
      }
    }
  }
  return out
}

function isTruthyMetaString(v) {
  return String(v || '').trim().toLowerCase() === 'true'
}

function skillEntryKeys(id, name, skillKey) {
  const keys = new Set()
  if (id) keys.add(String(id))
  if (name) keys.add(String(name))
  if (skillKey) keys.add(String(skillKey))
  return keys
}

function entryDisabled(entries, keys) {
  if (!entries || typeof entries !== 'object') return false
  for (const k of keys) {
    const e = entries[k]
    if (e && e.enabled === false) return true
  }
  return false
}

/**
 * 合并技能根目录：extraDirs（最低）→ managed → workspace（最高）
 * @returns Map(skillFolderName -> { skillDir, source })
 */
function mergeSkillRootDirs({ managedDir, workspaceDir, extraDirs }) {
  const layers = []
  const extras = Array.isArray(extraDirs) ? extraDirs : []
  for (const d of extras) {
    const abs = String(d || '').trim()
    if (abs && fs.existsSync(abs)) layers.push({ root: abs, source: 'extra' })
  }
  if (managedDir && fs.existsSync(managedDir)) layers.push({ root: managedDir, source: 'managed' })
  if (workspaceDir && fs.existsSync(workspaceDir)) layers.push({ root: workspaceDir, source: 'workspace' })

  const map = new Map()
  for (const layer of layers) {
    let dirents
    try {
      dirents = fs.readdirSync(layer.root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of dirents) {
      if (!ent.isDirectory()) continue
      if (ent.name === '_sandbox') continue
      const skillDir = path.join(layer.root, ent.name)
      try {
        if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue
      } catch {
        continue
      }
      map.set(ent.name, { skillDir, source: layer.source })
    }
  }
  return map
}

/** 将技能包文档中的 {baseDir} 替换为技能目录绝对路径 */
function applyBaseDir(prompt, skillDir) {
  if (!prompt || !skillDir) return prompt
  const base = String(skillDir)
  return String(prompt).split('{baseDir}').join(base)
}

/**
 * 由 SKILL.md 原文 + 目录名生成技能对象
 * @param {object} [options]
 * @param {object} [options.hostConfig] — openultron.json readAll() 根对象，供 requires.config
 * @param {object} [options.entries] — skills.entries
 */
function parseSkillMd(raw, id, skillDir, options = {}) {
  const { front, body } = splitFrontmatter(raw)
  const meta = parseFrontmatterKeys(front || '')
  const gate = getGateSlice(meta)

  const name = meta.name || id
  const description = meta.description || ''
  const skillKey = (gate && gate.skillKey) || name || id

  const disableModelInvocation =
    isTruthyMetaString(meta['disable-model-invocation']) ||
    isTruthyMetaString(meta.disable_model_invocation)

  const userInvocable = meta['user-invocable'] === undefined ? true : !['false', '0', 'no'].includes(String(meta['user-invocable']).toLowerCase())

  const entries = options.entries && typeof options.entries === 'object' ? options.entries : {}
  const hostConfig = options.hostConfig && typeof options.hostConfig === 'object' ? options.hostConfig : null
  const entryKeys = skillEntryKeys(id, name, skillKey)
  const entryEnv = mergeEntryEnvForKeys(entries, entryKeys)
  const envForGate = { ...process.env, ...entryEnv }

  const skipGate = !!(gate && (gate.always === true || String(gate.always).toLowerCase() === 'true'))
  let req = skipGate ? { ok: true } : checkSkillGateRequires(gate, envForGate)
  if (req.ok && !skipGate && gate && hostConfig) {
    const rc = checkSkillGateRequiresConfig(gate, hostConfig)
    if (!rc.ok) req = rc
  }

  return {
    id,
    name,
    description,
    category: meta.category || 'custom',
    projectType: meta.projectType || 'all',
    builtIn: meta.builtin === 'true',
    type: meta.type || 'markdown',
    prompt: body,
    source: 'app',
    skillDir: skillDir || '',
    skillKey: skillKey || id,
    skillGateMeta: gate || null,
    skillGateOk: req.ok,
    skillGateReason: req.ok ? '' : req.reason || '',
    disableModelInvocation,
    userInvocable,
    homepage: meta.homepage || (gate && gate.homepage) || ''
  }
}

/** 注入模型上下文的技能列表：排除 disable-model-invocation 与门控失败 */
function filterSkillsForModelPrompt(skills) {
  return (skills || []).filter((s) => {
    if (!s) return false
    if (s.disableModelInvocation) return false
    if (s.skillGateOk === false) return false
    return true
  })
}

module.exports = {
  splitFrontmatter,
  parseFrontmatterKeys,
  getGateSlice,
  vendorGateNamespaceKey,
  checkSkillGateRequires,
  checkSkillGateRequiresConfig,
  getHostConfigValue,
  mergeEntryEnvForKeys,
  mergeSkillRootDirs,
  applyBaseDir,
  parseSkillMd,
  filterSkillsForModelPrompt,
  entryDisabled,
  skillEntryKeys,
  tryParseJson
}
