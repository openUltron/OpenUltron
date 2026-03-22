/**
 * 技能列表 CRUD（<appRoot>/skills）
 */

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.store
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {Array<{id: string}>} deps.BUILTIN_SKILLS
 * @param {string} deps.skillsDir
 * @param {(opts?: object) => any[]} deps.readAllSkills
 * @param {(name: string, skill: object) => void} deps.writeSkillFile
 * @param {() => void} deps.ensureSkillsDir
 * @param {() => any} deps.getSkillsCache
 * @param {(v: any) => void} deps.setSkillsCache
 */
function registerSkillsIpc (deps) {
  const {
    registerChannel,
    store,
    path,
    fs,
    BUILTIN_SKILLS,
    skillsDir,
    readAllSkills,
    writeSkillFile,
    ensureSkillsDir,
    getSkillsCache,
    setSkillsCache
  } = deps

  registerChannel('ai-get-skills', async (event, opts) => {
    try {
      setSkillsCache(readAllSkills(opts || {}))
      return { success: true, skills: getSkillsCache() }
    } catch (error) {
      return { success: false, message: error.message, skills: getSkillsCache() || [] }
    }
  })

  registerChannel('ai-save-skill', async (event, skill) => {
    try {
      ensureSkillsDir()
      const safeName = (skill.id || skill.name).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_')
      writeSkillFile(safeName, skill)
      setSkillsCache(readAllSkills({}))
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-delete-skill', async (event, { id }) => {
    try {
      const builtinIds = new Set(BUILTIN_SKILLS.map(s => s.id))
      if (builtinIds.has(id)) {
        const deleted = store.get('aiDeletedBuiltinSkillIds', [])
        if (!deleted.includes(id)) store.set('aiDeletedBuiltinSkillIds', [...deleted, id])
      }
      const skillDir = path.join(skillsDir, id)
      if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true })
      setSkillsCache(readAllSkills({}))
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
}

module.exports = { registerSkillsIpc }
