/**
 * AI 数据备份 / 恢复 / 技能包 ZIP
 */

/** 将本地技能目录下所有文件写入 zip（整包备份，兼容 ClawHub 等导出结构） */
function zipAddTreeFromDir (zip, absRoot, zipPathPrefix, path, fs) {
  const prefix = String(zipPathPrefix || '').replace(/\/$/, '')
  let any = false
  const walk = (sub) => {
    const abs = sub ? path.join(absRoot, sub) : absRoot
    let names
    try {
      names = fs.readdirSync(abs)
    } catch {
      return
    }
    for (const name of names) {
      const rel = sub ? `${sub}/${name}` : name
      const fp = path.join(absRoot, rel)
      let st
      try {
        st = fs.statSync(fp)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(rel)
      else {
        zip.addFile(`${prefix}/${rel}`.replace(/\\/g, '/'), fs.readFileSync(fp))
        any = true
      }
    }
  }
  walk('')
  return any
}

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {typeof import('os')} deps.os
 * @param {import('electron').App} deps.app
 * @param {object} deps.store
 * @param {import('electron').Dialog} deps.dialog
 * @param {() => string} deps.getAppRoot
 * @param {object} deps.mcpConfigFile
 * @param {object} deps.aiMcpManager
 * @param {(jsonStr: string, disabledServers?: string[]) => any[]} deps.parseMcpJsonConfig
 * @param {object} deps.aiConfigFile
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {() => void} deps.ensureSkillsDir
 * @param {string} deps.skillsDir
 * @param {(opts?: object) => any[]} deps.readAllSkills
 * @param {(v: any) => void} deps.setSkillsCache
 */
function registerBackupIpc (deps) {
  const {
    registerChannel,
    path,
    fs,
    os,
    app,
    store,
    dialog,
    getAppRoot,
    mcpConfigFile,
    aiMcpManager,
    parseMcpJsonConfig,
    aiConfigFile,
    BrowserWindow,
    ensureSkillsDir,
    skillsDir,
    readAllSkills,
    setSkillsCache
  } = deps

  registerChannel('ai-export-backup', async () => {
    try {
      const skillsData = {}
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const skillDir = path.join(skillsDir, entry.name)
          const filePath = path.join(skillDir, 'SKILL.md')
          if (fs.existsSync(filePath)) {
            skillsData[entry.name] = fs.readFileSync(filePath, 'utf-8')
          }
        }
      }

      const mcpConfig = mcpConfigFile.readMcpConfig(store)
      const mcpDisabled = store.get('aiMcpDisabledServers', [])

      let aiConfig = null
      try {
        aiConfig = aiConfigFile.readAIConfig(app, store)
      } catch (e) { /* ignore */ }

      const backup = {
        version: 2,
        exportedAt: new Date().toISOString(),
        skills: skillsData,
        mcpConfig,
        mcpDisabledServers: mcpDisabled,
        aiConfig
      }

      return { success: true, data: JSON.stringify(backup, null, 2) }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-backup-export', async (event, { options } = {}) => {
    try {
      const AdmZip = require('adm-zip')
      const appRootDir = getAppRoot()

      const zip = new AdmZip()
      const stats = { fileCount: 0, dirCount: 0, totalBytes: 0, root: appRootDir }
      const zipRoot = 'app_root'

      const addDirToZip = (dirPath) => {
        if (!fs.existsSync(dirPath)) return
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          const fullPath = path.join(dirPath, entry.name)
          const rel = path.relative(appRootDir, fullPath).split(path.sep).join('/')
          const zPath = rel ? `${zipRoot}/${rel}` : zipRoot
          if (entry.isDirectory()) {
            stats.dirCount += 1
            addDirToZip(fullPath)
            continue
          }
          if (!entry.isFile()) continue
          const buf = fs.readFileSync(fullPath)
          zip.addFile(zPath, buf)
          stats.fileCount += 1
          stats.totalBytes += buf.length
        }
      }
      fs.mkdirSync(appRootDir, { recursive: true })
      addDirToZip(appRootDir)

      zip.addFile('meta.json', Buffer.from(JSON.stringify({
        version: 2,
        formatVersion: 2,
        mode: 'full_app_root',
        appRootDirname: path.basename(appRootDir),
        exportedAt: new Date().toISOString(),
        appName: app.getName(),
        appVersion: app.getVersion(),
        platform: process.platform,
        electron: process.versions.electron,
        stats
      }, null, 2), 'utf-8'))

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const defaultPath = path.join(os.homedir(), 'Desktop', `ai-backup-${ts}.zip`)
      const { canceled, filePath: savePath } = await dialog.showSaveDialog({
        title: '保存 AI 备份',
        defaultPath,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
      })
      if (canceled || !savePath) return { success: false, message: 'canceled' }

      zip.writeZip(savePath)
      const fileSize = fs.statSync(savePath).size
      return { success: true, savePath, fileSize, stats }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-backup-preview', async () => {
    try {
      const AdmZip = require('adm-zip')
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择 AI 备份文件',
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (canceled || !filePaths.length) return { success: false, message: 'canceled' }
      const filePath = filePaths[0]
      const zip = new AdmZip(filePath)
      const metaEntry = zip.getEntry('meta.json')
      if (!metaEntry) return { success: false, message: '无效的备份文件（缺少 meta.json）' }
      const meta = JSON.parse(metaEntry.getData().toString('utf-8'))
      const hasFullRoot = zip.getEntries().some((e) => e.entryName.startsWith('app_root/'))
      meta.mode = meta.mode || (hasFullRoot ? 'full_app_root' : 'legacy_partial')
      if (!meta.stats) meta.stats = {}
      if (meta.mode === 'full_app_root') {
        if (typeof meta.stats.fileCount !== 'number' || typeof meta.stats.dirCount !== 'number') {
          let fileCount = 0
          let dirCount = 0
          let totalBytes = 0
          for (const entry of zip.getEntries()) {
            if (!entry.entryName.startsWith('app_root/')) continue
            if (entry.isDirectory) {
              dirCount += 1
            } else {
              fileCount += 1
              totalBytes += entry.header.size || 0
            }
          }
          meta.stats.fileCount = fileCount
          meta.stats.dirCount = dirCount
          meta.stats.totalBytes = totalBytes
        }
      }
      return { success: true, filePath, meta }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-backup-restore', async (event, { filePath, options = {} }) => {
    try {
      const AdmZip = require('adm-zip')
      const appRootDir = getAppRoot()
      const tmpZipPath = path.join(os.tmpdir(), `openultron-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
      fs.copyFileSync(filePath, tmpZipPath)
      const zip = new AdmZip(tmpZipPath)
      const summary = { skillsRestored: 0, conversationsRestored: 0, memoriesRestored: false, mcpRestored: false, aiConfigRestored: false }

      const extractDir = (zipPrefix, targetDir) => {
        fs.mkdirSync(targetDir, { recursive: true })
        const base = path.resolve(targetDir)
        for (const entry of zip.getEntries()) {
          if (!entry.entryName.startsWith(zipPrefix + '/') || entry.isDirectory) continue
          const relPath = entry.entryName.slice(zipPrefix.length + 1)
          const destPath = path.join(targetDir, relPath)
          if (!path.resolve(destPath).startsWith(base + path.sep)) continue
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, entry.getData())
        }
      }

      const hasFullRoot = zip.getEntries().some((e) => e.entryName.startsWith('app_root/'))
      if (hasFullRoot) {
        const restoreBackupPath = `${appRootDir}.pre-restore-${Date.now()}`
        let movedOldRoot = false
        try {
          if (fs.existsSync(appRootDir)) {
            fs.renameSync(appRootDir, restoreBackupPath)
            movedOldRoot = true
          }
          fs.mkdirSync(appRootDir, { recursive: true })
          const base = path.resolve(appRootDir)
          let restoredFiles = 0
          for (const entry of zip.getEntries()) {
            if (!entry.entryName.startsWith('app_root/') || entry.isDirectory) continue
            const relPath = entry.entryName.slice('app_root/'.length)
            if (!relPath) continue
            const destPath = path.join(appRootDir, relPath)
            const resolved = path.resolve(destPath)
            if (!resolved.startsWith(base + path.sep) && resolved !== base) continue
            fs.mkdirSync(path.dirname(destPath), { recursive: true })
            fs.writeFileSync(destPath, entry.getData())
            restoredFiles += 1
          }

          try {
            ensureSkillsDir()
            setSkillsCache(readAllSkills({}))
          } catch (e) { /* ignore */ }
          try {
            const mcpCfg = mcpConfigFile.readMcpConfig(store)
            aiMcpManager.stopAll()
            const disabledServers = store.get('aiMcpDisabledServers', [])
            const servers = parseMcpJsonConfig(mcpCfg, disabledServers)
            if (servers.length > 0) await aiMcpManager.startAll(servers)
          } catch (e) { /* ignore */ }
          try {
            BrowserWindow.getAllWindows().forEach((win) => {
              if (win && !win.isDestroyed()) win.webContents.send('ai-config-updated')
            })
          } catch (e) { /* ignore */ }

          summary.mode = 'full_app_root'
          summary.restoredFiles = restoredFiles
          summary.rollbackPath = movedOldRoot ? restoreBackupPath : null
          try { fs.unlinkSync(tmpZipPath) } catch (_) {}
          return { success: true, summary }
        } catch (error) {
          try { if (fs.existsSync(appRootDir)) fs.rmSync(appRootDir, { recursive: true, force: true }) } catch (_) {}
          if (movedOldRoot) {
            try { fs.renameSync(restoreBackupPath, appRootDir) } catch (_) {}
          }
          throw error
        }
      }

      if (options.aiConfig !== false) {
        const openultronConfig = require('../../openultron-config')
        const entry = zip.getEntry('openultron.json')
        if (entry) {
          try {
            const full = JSON.parse(entry.getData().toString('utf-8'))
            if (full && (full.ai || full.feishu)) {
              const cur = openultronConfig.readAll()
              openultronConfig.writeAll({ ai: full.ai || cur.ai, feishu: full.feishu || cur.feishu })
              summary.aiConfigRestored = true
            }
          } catch (e) { /* ignore */ }
        } else {
          const legacyEntry = zip.getEntry('ai-config.json')
          if (legacyEntry) {
            try {
              const cfg = JSON.parse(legacyEntry.getData().toString('utf-8'))
              if (cfg && Array.isArray(cfg.providers)) {
                openultronConfig.writeAI(cfg)
                summary.aiConfigRestored = true
              }
            } catch (e) { /* ignore */ }
          }
        }
      }

      if (options.mcpConfig !== false) {
        const entry = zip.getEntry('mcp-config.json')
        if (entry) {
          try {
            const mcpStr = entry.getData().toString('utf-8')
            JSON.parse(mcpStr)
            mcpConfigFile.writeMcpConfig(mcpStr)
            aiMcpManager.stopAll()
            const disabledServers = store.get('aiMcpDisabledServers', [])
            const servers = parseMcpJsonConfig(mcpStr, disabledServers)
            if (servers.length > 0) await aiMcpManager.startAll(servers)
            summary.mcpRestored = true
          } catch (e) { /* ignore */ }
        }
      }

      if (options.skills !== false) {
        ensureSkillsDir()
        const skillsBase = path.resolve(skillsDir)
        for (const entry of zip.getEntries()) {
          if (!entry.entryName.startsWith('skills/') || entry.isDirectory) continue
          const relPath = entry.entryName.slice('skills/'.length)
          const destPath = path.join(skillsDir, relPath)
          if (!path.resolve(destPath).startsWith(skillsBase + path.sep)) continue
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, entry.getData())
          if (entry.entryName.endsWith('/SKILL.md')) summary.skillsRestored++
        }
        setSkillsCache(readAllSkills({}))
      }

      if (options.conversations !== false) {
        const convsDir = path.join(appRootDir, 'conversations')
        extractDir('conversations', convsDir)
        for (const entry of zip.getEntries()) {
          if (entry.entryName.startsWith('conversations/') && entry.entryName.endsWith('.json') && !entry.entryName.endsWith('index.json')) {
            summary.conversationsRestored++
          }
        }
      }

      if (options.memory !== false) {
        const memDir = path.join(appRootDir, 'memory')
        extractDir('memory', memDir)
        const memMd = zip.getEntry('MEMORY.md')
        if (memMd) fs.writeFileSync(path.join(appRootDir, 'MEMORY.md'), memMd.getData())
        summary.memoriesRestored = true
      }

      try { fs.unlinkSync(tmpZipPath) } catch (_) {}
      return { success: true, summary }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-import-backup', async (event, { data, options }) => {
    try {
      const backup = JSON.parse(data)
      const opts = options || { skills: true, mcp: true, aiConfig: true }
      const summary = { skillsImported: 0, mcpImported: false, aiConfigImported: false }

      if (opts.skills && backup.skills) {
        ensureSkillsDir()
        for (const [dirName, content] of Object.entries(backup.skills)) {
          const skillDir = path.join(skillsDir, dirName)
          fs.mkdirSync(skillDir, { recursive: true })
          fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
          summary.skillsImported++
        }
        setSkillsCache(readAllSkills({}))
      }

      if (opts.aiConfig && backup.aiConfig) {
        try {
          const raw = backup.aiConfig?.config !== undefined && backup.aiConfig?.providerKeys !== undefined
            ? aiConfigFile.fromLegacyBackup(backup.aiConfig)
            : backup.aiConfig
          if (raw && Array.isArray(raw.providers)) {
            aiConfigFile.writeAIConfig(app, raw)
            summary.aiConfigImported = true
          }
        } catch (e) { /* ignore */ }
      }

      if (opts.mcp && backup.mcpConfig) {
        JSON.parse(backup.mcpConfig)
        mcpConfigFile.writeMcpConfig(backup.mcpConfig)
        if (backup.mcpDisabledServers) {
          store.set('aiMcpDisabledServers', backup.mcpDisabledServers)
        }
        aiMcpManager.stopAll()
        const disabledServers = store.get('aiMcpDisabledServers', [])
        const servers = parseMcpJsonConfig(backup.mcpConfig, disabledServers)
        if (servers.length > 0) {
          await aiMcpManager.startAll(servers)
        }
        summary.mcpImported = true
      }

      return { success: true, summary }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-export-skills-pack', async (event, { names, includeSandbox }) => {
    try {
      const AdmZip = require('adm-zip')
      const zip = new AdmZip()
      let count = 0
      ensureSkillsDir()
      const wantNames = Array.isArray(names) && names.length > 0 ? new Set(names.map(String)) : null
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '_sandbox') continue
        if (wantNames && !wantNames.has(entry.name)) continue
        const skillRoot = path.join(skillsDir, entry.name)
        if (!fs.existsSync(path.join(skillRoot, 'SKILL.md'))) continue
        if (zipAddTreeFromDir(zip, skillRoot, `skills/${entry.name}`, path, fs)) count++
      }
      if (includeSandbox) {
        const sandboxDir = path.join(skillsDir, '_sandbox')
        if (fs.existsSync(sandboxDir)) {
          for (const entry of fs.readdirSync(sandboxDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const skillRoot = path.join(sandboxDir, entry.name)
            if (!fs.existsSync(path.join(skillRoot, 'SKILL.md'))) continue
            if (zipAddTreeFromDir(zip, skillRoot, `skills/_sandbox/${entry.name}`, path, fs)) count++
          }
        }
      }
      zip.addFile('meta.json', Buffer.from(JSON.stringify({
        type: 'skills-pack',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        appName: app.getName(),
        appVersion: app.getVersion(),
        platform: process.platform,
        electron: process.versions.electron,
        skillsCount: count,
        includeSandbox: !!includeSandbox
      }, null, 2), 'utf-8'))
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const defaultPath = path.join(os.homedir(), 'Desktop', `skills-pack-${ts}.zip`)
      const { canceled, filePath: savePath } = await dialog.showSaveDialog({
        title: '导出技能包',
        defaultPath,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
      })
      if (canceled || !savePath) return { success: false, message: 'canceled' }
      zip.writeZip(savePath)
      return { success: true, savePath, skillsCount: count }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('ai-import-skills-pack', async (event, { filePath, toSandbox }) => {
    try {
      const AdmZip = require('adm-zip')
      let zipPath = filePath
      if (!zipPath) {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: '选择技能包 ZIP',
          filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
          properties: ['openFile']
        })
        if (canceled || !filePaths.length) return { success: false, message: 'canceled' }
        zipPath = filePaths[0]
      }
      const zip = new AdmZip(zipPath)
      ensureSkillsDir()
      const destRoot = toSandbox ? path.join(skillsDir, '_sandbox') : skillsDir
      const importedRoots = new Set()
      for (const entry of zip.getEntries()) {
        if (typeof entry.isDirectory === 'function' && entry.isDirectory()) continue
        let name = String(entry.entryName || '').replace(/\\/g, '/')
        if (name.startsWith('./')) name = name.slice(2)
        if (!name.startsWith('skills/')) continue
        const rel = name.slice('skills/'.length)
        const parts = rel.split('/').filter(Boolean)
        if (parts.length < 2) continue
        const top = parts[0]
        if (top === '_sandbox') {
          if (parts.length < 3) continue
          const sbSkill = parts[1]
          const innerPath = parts.slice(2).join('/')
          const sbBase = toSandbox ? destRoot : path.join(destRoot, '_sandbox')
          const destPath = path.join(sbBase, sbSkill, innerPath)
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, entry.getData())
          if (innerPath === 'SKILL.md') importedRoots.add(`_sandbox/${sbSkill}`)
          continue
        }
        const skillId = top
        const innerPath = parts.slice(1).join('/')
        const destPath = path.join(destRoot, skillId, innerPath)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, entry.getData())
        if (innerPath === 'SKILL.md') importedRoots.add(skillId)
      }
      const count = importedRoots.size
      setSkillsCache(readAllSkills({}))
      return { success: true, skillsImported: count }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
}

module.exports = { registerBackupIpc, zipAddTreeFromDir }
