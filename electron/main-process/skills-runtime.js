/**
 * 技能目录读写、内置技能初始化、文件监视与缓存刷新（从 main.js 迁出）
 */
const skillPack = require('../ai/skill-pack')

/**
 * @param {{
 *   path: import('path')
 *   fs: import('fs')
 *   getAppRootPath: (rel: string) => string
 *   store: import('electron-store')
 *   BUILTIN_SKILLS: Array<{ id: string, name?: string, description?: string, category?: string, projectType?: string, type?: string, prompt?: string }>
 *   REMOVED_BUILTIN_SKILL_IDS: string[]
 *   getMainWindow: () => import('electron').BrowserWindow | null | undefined
 * }} deps
 */
function createSkillsRuntime(deps) {
  const { path, fs, getAppRootPath, store, BUILTIN_SKILLS, REMOVED_BUILTIN_SKILL_IDS, getMainWindow } = deps
  const skillsDir = getAppRootPath('skills')
  let skillsCache = []
  let skillsChokidar = null

  function ensureSkillsDir() {
    fs.mkdirSync(skillsDir, { recursive: true })
  }

  /** @param {{ hostConfig?: object, entries?: object }} [ctx] */
  function parseSkillFile(skillDir, ctx = {}) {
    const dirName = path.basename(skillDir)
    const filePath = path.join(skillDir, 'SKILL.md')
    let raw
    try {
      raw = fs.readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
    try {
      return skillPack.parseSkillMd(raw, dirName, skillDir, {
        hostConfig: ctx.hostConfig,
        entries: ctx.entries
      })
    } catch {
      return {
        id: dirName,
        name: dirName,
        description: '',
        category: 'custom',
        projectType: 'all',
        builtIn: false,
        type: 'markdown',
        prompt: (raw || '').trim(),
        source: 'app',
        skillDir,
        skillKey: dirName,
        skillGateMeta: null,
        skillGateOk: true,
        skillGateReason: '',
        disableModelInvocation: false,
        userInvocable: true,
        homepage: ''
      }
    }
  }

  function writeSkillFile(name, skill) {
    const skillDir = path.join(skillsDir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    const lines = [
      '---',
      `name: ${skill.name || name}`,
      `description: ${skill.description || ''}`,
      `category: ${skill.category || 'custom'}`,
      `projectType: ${skill.projectType || 'all'}`,
      `builtin: ${skill.builtIn ? 'true' : 'false'}`
    ]
    if (skill.type) lines.push(`type: ${skill.type}`)
    lines.push('---', '', skill.prompt || '')
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), lines.join('\n'), 'utf-8')
  }

  /**
   * 读取技能：workspace/skills（最高）→ ~/.openultron/skills → skills.load.extraDirs（最低）
   * @param {{ projectPath?: string }} [options]
   */
  function readAllSkills(options = {}) {
    ensureSkillsDir()
    let hostConfig = {}
    try {
      hostConfig = require('../openultron-config').readAll() || {}
    } catch (_) {}
    const load = (hostConfig.skills && hostConfig.skills.load) || {}
    const extraDirs = Array.isArray(load.extraDirs) ? load.extraDirs : []
    const entries = (hostConfig.skills && hostConfig.skills.entries && typeof hostConfig.skills.entries === 'object')
      ? hostConfig.skills.entries
      : {}
    let workspaceDir = null
    const pp = options.projectPath != null ? String(options.projectPath).trim() : ''
    if (pp && !pp.startsWith('__') && path.isAbsolute(pp)) {
      const w = path.join(pp, 'skills')
      try {
        if (fs.existsSync(w)) workspaceDir = w
      } catch (_) {}
    }
    const merged = skillPack.mergeSkillRootDirs({
      managedDir: skillsDir,
      workspaceDir,
      extraDirs
    })
    const skills = []
    for (const [id, info] of merged) {
      try {
        const skill = parseSkillFile(info.skillDir, { hostConfig, entries })
        if (!skill) continue
        skill.source = info.source === 'workspace' ? 'workspace' : info.source === 'extra' ? 'extra' : 'app'
        if (skillPack.entryDisabled(entries, skillPack.skillEntryKeys(id, skill.name, skill.skillKey))) continue
        if (!skill.skillGateOk) continue
        skills.push(skill)
      } catch (_) {}
    }
    return skills
  }

  function readSandboxSkills() {
    ensureSkillsDir()
    let hostConfig = {}
    let entries = {}
    try {
      hostConfig = require('../openultron-config').readAll() || {}
      entries = (hostConfig.skills && hostConfig.skills.entries && typeof hostConfig.skills.entries === 'object')
        ? hostConfig.skills.entries
        : {}
    } catch (_) {}
    const sandboxDir = path.join(skillsDir, '_sandbox')
    if (!fs.existsSync(sandboxDir)) return []
    const skills = []
    for (const entry of fs.readdirSync(sandboxDir)) {
      const entryPath = path.join(sandboxDir, entry)
      try { if (!fs.statSync(entryPath).isDirectory()) continue } catch { continue }
      const skillFile = path.join(entryPath, 'SKILL.md')
      if (!fs.existsSync(skillFile)) continue
      try { skills.push(parseSkillFile(entryPath, { hostConfig, entries })) } catch {}
    }
    return skills
  }

  function initBuiltinSkills() {
    ensureSkillsDir()
    const deletedList = store.get('aiDeletedBuiltinSkillIds', [])
    const newDeletedList = deletedList.filter(id => !REMOVED_BUILTIN_SKILL_IDS.includes(id))
    if (newDeletedList.length !== deletedList.length) store.set('aiDeletedBuiltinSkillIds', newDeletedList)
    for (const id of REMOVED_BUILTIN_SKILL_IDS) {
      const dir = path.join(skillsDir, id)
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch (e) {
          console.warn('[initBuiltinSkills] 移除旧内置技能目录失败:', id, e.message)
        }
      }
    }
    for (const f of fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'))) {
      const oldPath = path.join(skillsDir, f)
      const name = f.replace(/\.md$/, '')
      const newDir = path.join(skillsDir, name)
      try {
        if (!fs.existsSync(newDir)) {
          fs.mkdirSync(newDir, { recursive: true })
          fs.renameSync(oldPath, path.join(newDir, 'SKILL.md'))
        } else {
          fs.unlinkSync(oldPath)
        }
      } catch {}
    }
    const deletedIds = new Set(store.get('aiDeletedBuiltinSkillIds', []))
    for (const skill of BUILTIN_SKILLS) {
      if (deletedIds.has(skill.id)) continue
      try {
        const skillFile = path.join(skillsDir, skill.id, 'SKILL.md')
        if (!fs.existsSync(skillFile)) {
          writeSkillFile(skill.id, { ...skill, builtIn: true })
        }
      } catch {}
    }
  }

  function refreshSkillsCacheAndNotify() {
    try {
      skillsCache = readAllSkills({})
      const mw = getMainWindow()
      if (mw && !mw.isDestroyed()) mw.webContents.send('ai-skills-changed')
    } catch (_) {}
  }

  function getSkillsWatchPaths() {
    const list = []
    try {
      if (skillsDir && fs.existsSync(skillsDir)) list.push(skillsDir)
      const cfgPath = getAppRootPath('openultron.json')
      if (fs.existsSync(cfgPath)) list.push(cfgPath)
      const cfg = require('../openultron-config').readAll() || {}
      const extras = (cfg.skills && cfg.skills.load && cfg.skills.load.extraDirs) || []
      for (const d of extras) {
        const abs = String(d || '').trim()
        if (abs && fs.existsSync(abs)) list.push(abs)
      }
    } catch (_) {}
    return list
  }

  function rebindSkillsWatchPaths() {
    try {
      if (skillsChokidar) {
        skillsChokidar.close().catch(() => {})
        skillsChokidar = null
      }
      const chokidar = require('chokidar')
      const paths = getSkillsWatchPaths()
      if (paths.length === 0) return
      skillsChokidar = chokidar.watch(paths, {
        ignoreInitial: true,
        depth: 12,
        awaitWriteFinish: { stabilityThreshold: 200 }
      })
      skillsChokidar.on('all', (event, p) => {
        refreshSkillsCacheAndNotify()
        if (p && path.basename(String(p)) === 'openultron.json') {
          setTimeout(() => rebindSkillsWatchPaths(), 400)
        }
      })
    } catch (e) {
      console.warn('[skills] 目录监视不可用:', e.message)
    }
  }

  function closeSkillsWatcher() {
    try {
      if (skillsChokidar) {
        skillsChokidar.close().catch(() => {})
        skillsChokidar = null
      }
    } catch (_) {}
  }

  function bootstrap() {
    initBuiltinSkills()
    skillsCache = readAllSkills({})
  }

  return {
    skillsDir,
    ensureSkillsDir,
    writeSkillFile,
    readAllSkills,
    readSandboxSkills,
    refreshSkillsCacheAndNotify,
    rebindSkillsWatchPaths,
    closeSkillsWatcher,
    getSkillsCache: () => skillsCache,
    setSkillsCache: (v) => { skillsCache = v },
    bootstrap
  }
}

module.exports = { createSkillsRuntime }
