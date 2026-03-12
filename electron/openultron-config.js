/**
 * 统一配置：<appRoot>/openultron.json（合并原 ai-config.json + feishu.json）
 * 每次写入前按时间戳备份：openultron.json.<ts>.bak，最多保留 5 个用于出错恢复
 */
const path = require('path')
const fs = require('fs')
const { getAppRootPath, getAppRoot } = require('./app-root')

const CONFIG_FILENAME = 'openultron.json'
const MAX_BACKUPS = 5

function getPath() {
  return getAppRootPath(CONFIG_FILENAME)
}

function getBackupPath() {
  return getAppRootPath(`${CONFIG_FILENAME}.${Date.now()}.bak`)
}

const DEFAULT_AI = {
  defaultProvider: 'https://api.qnaigc.com/v1',
  defaultModel: 'deepseek-v3',
  modelPool: ['deepseek-v3'],
  modelBindings: { 'deepseek-v3': 'https://api.qnaigc.com/v1' },
  temperature: 0,
  maxTokens: 0,
  maxToolIterations: 0,
  providers: [
    // 国内主流
    { name: '七牛 AI', baseUrl: 'https://api.qnaigc.com/v1', apiKey: '' },
    { name: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' },
    { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '' },
    { name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', apiKey: '' },
    { name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', apiKey: '' },
    { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.ai/v1', apiKey: '' },
    { name: '零一万物 Yi', baseUrl: 'https://api.lingyiwanwu.com/v1', apiKey: '' },
    { name: 'Minimax', baseUrl: 'https://api.minimax.chat/v1', apiKey: '' },
    { name: '火山引擎豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: '' },
    { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '' },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '' },
    // 国外主流
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '' },
    { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: '' },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
    { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '' },
    { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', apiKey: '' },
    { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: '' },
    { name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiKey: '' },
  ],
}

const DEFAULT_FEISHU = {
  app_id: '',
  app_secret: '',
  default_chat_id: '',
  notify_on_complete: false,
  receive_enabled: false,
  // TTS：默认音色（可填 Edge shortName 或别名）
  tts_default_voice: '',
  // TTS：音色别名映射，key=别名，value=Edge shortName（如 zh-CN-XiaoyiNeural）
  tts_voice_aliases: {},
  /** 允许触发的 chat_id/用户 ID 列表，'*' 表示全部允许；不配或空数组表示全部允许（兼容旧配置） */
  allowFrom: undefined
}

const DEFAULT_TELEGRAM = {
  bot_token: '',
  enabled: false,
  voice_reply_enabled: false,
  /** 允许触发的 chat_id 列表，'*' 表示全部允许；不配或空数组表示全部允许 */
  allowFrom: undefined
}

const DEFAULT_DINGTALK = {
  app_key: '',
  app_secret: '',
  default_chat_id: '',
  default_robot_code: '',
  receive_enabled: false,
  voice_reply_enabled: false,
  /** 允许触发的 conversationId/用户 ID 列表，'*' 表示全部允许；不配或空数组表示全部允许 */
  allowFrom: undefined
}

const DEFAULT_HARDWARE = {
  screen: { enabled: true },
  notify: { enabled: true }
}

/** 技能远程源：url 为 skills 列表 JSON 的完整 URL（返回 { skills: [{ id, name, description, install_url?, ... }] }） */
const DEFAULT_SKILLS_SOURCES = []

/** 合并默认供应商与已保存列表：默认列表保证全部展示，已保存的 apiKey 保留；保存里多出的自定义供应商追加到末尾 */
function normalizeModelPool(pool, fallbackModel = '') {
  const arr = Array.isArray(pool) ? pool.map(x => String(x || '').trim()).filter(Boolean) : []
  const uniq = [...new Set(arr)]
  const fb = String(fallbackModel || '').trim()
  if (fb && !uniq.includes(fb)) uniq.unshift(fb)
  return uniq
}

function normalizeModelBindings(bindings, providers = [], pool = [], fallbackProvider = '') {
  const allow = new Set((providers || []).map(p => String(p?.baseUrl || '').trim()).filter(Boolean))
  const out = {}
  const raw = bindings && typeof bindings === 'object' ? bindings : {}
  for (const [k, v] of Object.entries(raw)) {
    const model = String(k || '').trim()
    const provider = String(v || '').trim()
    if (!model || !provider) continue
    if (allow.size > 0 && !allow.has(provider)) continue
    out[model] = provider
  }
  const fb = String(fallbackProvider || '').trim()
  for (const m of (pool || [])) {
    const model = String(m || '').trim()
    if (!model) continue
    if (!out[model] && fb) out[model] = fb
  }
  return out
}

function mergeProviders(defaultList, savedList) {
  if (!Array.isArray(savedList) || savedList.length === 0) return defaultList.map(p => ({ ...p }))
  const byUrl = new Map(savedList.filter(p => p && p.baseUrl).map(p => [p.baseUrl, p]))
  const merged = defaultList.map(p => {
    const saved = byUrl.get(p.baseUrl)
    if (saved) {
      byUrl.delete(p.baseUrl)
      return { name: p.name, baseUrl: p.baseUrl, apiKey: saved.apiKey ?? '' }
    }
    return { ...p }
  })
  byUrl.forEach((saved) => {
    merged.push({ name: saved.name || saved.baseUrl, baseUrl: saved.baseUrl, apiKey: saved.apiKey ?? '' })
  })
  return merged
}

function readAll() {
  const configPath = getPath()
  const dir = path.dirname(configPath)
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const data = JSON.parse(raw)
      const webhooks = Array.isArray(data.webhooks) ? data.webhooks : []
      const telegram = data.telegram && typeof data.telegram === 'object' ? { ...DEFAULT_TELEGRAM, ...data.telegram } : { ...DEFAULT_TELEGRAM }
      const dingtalk = data.dingtalk && typeof data.dingtalk === 'object' ? { ...DEFAULT_DINGTALK, ...data.dingtalk } : { ...DEFAULT_DINGTALK }
      const hardware = data.hardware && typeof data.hardware === 'object'
        ? { screen: { ...DEFAULT_HARDWARE.screen, ...data.hardware.screen }, notify: { ...DEFAULT_HARDWARE.notify, ...data.hardware.notify } }
        : { ...DEFAULT_HARDWARE }
      const skillsSources = Array.isArray(data.skills?.sources)
        ? data.skills.sources.filter(s => s && typeof s.name === 'string' && typeof s.url === 'string')
        : DEFAULT_SKILLS_SOURCES
      let ai = data.ai && Array.isArray(data.ai.providers) ? data.ai : { ...DEFAULT_AI, ...data.ai }
      ai = { ...ai, providers: mergeProviders(DEFAULT_AI.providers, ai.providers) }
      ai.modelPool = normalizeModelPool(ai.modelPool, ai.defaultModel)
      ai.modelBindings = normalizeModelBindings(ai.modelBindings, ai.providers, ai.modelPool, ai.defaultProvider)
      return {
        ai,
        feishu: { ...DEFAULT_FEISHU, ...data.feishu },
        telegram,
        dingtalk,
        webhooks,
        hardware,
        skills: { sources: skillsSources }
      }
    } catch (e) {
      console.warn('[openultron-config] 读取失败，使用默认:', e.message)
    }
  }
  const aiPath = getAppRootPath('ai-config.json')
  const feishuPath = getAppRootPath('feishu.json')
  let ai = JSON.parse(JSON.stringify(DEFAULT_AI))
  let feishu = { ...DEFAULT_FEISHU }
  let didMerge = false
  if (fs.existsSync(aiPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(aiPath, 'utf-8'))
      if (d.providers && Array.isArray(d.providers)) {
        ai = { ...ai, ...d, providers: mergeProviders(DEFAULT_AI.providers, d.providers) }
        didMerge = true
      }
    } catch (_) {}
  }
  if (fs.existsSync(feishuPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(feishuPath, 'utf-8'))
      feishu = { ...feishu, ...d }; didMerge = true
    } catch (_) {}
  }
  const merged = { ai, feishu, telegram: { ...DEFAULT_TELEGRAM }, dingtalk: { ...DEFAULT_DINGTALK }, webhooks: [], hardware: { ...DEFAULT_HARDWARE }, skills: { sources: [] } }
  writeAll(merged)
  if (didMerge) {
    try { if (fs.existsSync(aiPath)) fs.unlinkSync(aiPath) } catch (e) { console.warn('[openultron-config] 删除旧文件 ai-config.json 失败:', e.message) }
    try { if (fs.existsSync(feishuPath)) fs.unlinkSync(feishuPath) } catch (e) { console.warn('[openultron-config] 删除旧文件 feishu.json 失败:', e.message) }
  }
  return merged
}

/** 启动时显式执行一次，确保 openultron.json 存在（若不存在则从旧文件合并并删除旧文件） */
function ensureMerged() {
  readAll()
}

function pruneOldBackups(dir) {
  try {
    const prefix = `${CONFIG_FILENAME}.`
    const suffix = '.bak'
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
      .map((f) => {
        const ts = f.slice(prefix.length, -suffix.length)
        return { name: f, path: path.join(dir, f), ts: parseInt(ts, 10) || 0 }
      })
      .filter((o) => !Number.isNaN(o.ts))
      .sort((a, b) => b.ts - a.ts)
    for (let i = MAX_BACKUPS; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path) } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.warn('[openultron-config] 清理旧备份失败:', e.message)
  }
}

function writeAll(data) {
  const configPath = getPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(configPath, getBackupPath())
      pruneOldBackups(dir)
    } catch (e) {
      console.warn('[openultron-config] 备份失败:', e.message)
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8')
}

function getAI() {
  return readAll().ai
}

function writeAI(aiData) {
  const all = readAll()
  const providers = Array.isArray(aiData?.providers) ? aiData.providers : DEFAULT_AI.providers
  const modelPool = normalizeModelPool(aiData?.modelPool, aiData?.defaultModel)
  all.ai = {
    ...aiData,
    modelPool,
    modelBindings: normalizeModelBindings(aiData?.modelBindings, providers, modelPool, aiData?.defaultProvider)
  }
  writeAll(all)
}

function getFeishu() {
  return readAll().feishu
}

function setFeishu(partial) {
  const all = readAll()
  const cur = all.feishu
  const allowFromFeishu = partial && partial.allowFrom !== undefined
    ? (partial.allowFrom === '*' ? '*' : (Array.isArray(partial.allowFrom) ? partial.allowFrom : cur.allowFrom))
    : cur.allowFrom
  all.feishu = {
    app_id: partial && partial.app_id !== undefined ? String(partial.app_id).trim() : cur.app_id,
    app_secret: partial && partial.app_secret !== undefined ? String(partial.app_secret).trim() : cur.app_secret,
    default_chat_id: partial && partial.default_chat_id !== undefined ? String(partial.default_chat_id).trim() : cur.default_chat_id,
    notify_on_complete: partial && partial.notify_on_complete !== undefined ? !!partial.notify_on_complete : cur.notify_on_complete,
    receive_enabled: partial && partial.receive_enabled !== undefined ? !!partial.receive_enabled : cur.receive_enabled,
    tts_default_voice: partial && partial.tts_default_voice !== undefined ? String(partial.tts_default_voice).trim() : String(cur.tts_default_voice || ''),
    tts_voice_aliases: partial && partial.tts_voice_aliases !== undefined
      ? (partial.tts_voice_aliases && typeof partial.tts_voice_aliases === 'object' ? partial.tts_voice_aliases : {})
      : (cur.tts_voice_aliases && typeof cur.tts_voice_aliases === 'object' ? cur.tts_voice_aliases : {}),
    allowFrom: allowFromFeishu
  }
  writeAll(all)
}

/** Telegram 配置 */
function getTelegram() {
  const all = readAll()
  return all.telegram && typeof all.telegram === 'object' ? all.telegram : { ...DEFAULT_TELEGRAM }
}

function setTelegram(partial) {
  const all = readAll()
  const cur = all.telegram && typeof all.telegram === 'object' ? all.telegram : { ...DEFAULT_TELEGRAM }
  const allowFromTg = partial && partial.allowFrom !== undefined
    ? (partial.allowFrom === '*' ? '*' : (Array.isArray(partial.allowFrom) ? partial.allowFrom : cur.allowFrom))
    : cur.allowFrom
  all.telegram = {
    bot_token: partial && partial.bot_token !== undefined ? String(partial.bot_token).trim() : cur.bot_token,
    enabled: partial && partial.enabled !== undefined ? !!partial.enabled : cur.enabled,
    voice_reply_enabled: partial && partial.voice_reply_enabled !== undefined ? !!partial.voice_reply_enabled : !!cur.voice_reply_enabled,
    allowFrom: allowFromTg
  }
  writeAll(all)
}

/** 钉钉配置 */
function getDingtalk() {
  const all = readAll()
  return all.dingtalk && typeof all.dingtalk === 'object' ? { ...DEFAULT_DINGTALK, ...all.dingtalk } : { ...DEFAULT_DINGTALK }
}

function setDingtalk(partial) {
  const all = readAll()
  const cur = all.dingtalk && typeof all.dingtalk === 'object' ? { ...DEFAULT_DINGTALK, ...all.dingtalk } : { ...DEFAULT_DINGTALK }
  const allowFromDingtalk = partial && partial.allowFrom !== undefined
    ? (partial.allowFrom === '*' ? '*' : (Array.isArray(partial.allowFrom) ? partial.allowFrom : cur.allowFrom))
    : cur.allowFrom
  all.dingtalk = {
    app_key: partial && partial.app_key !== undefined ? String(partial.app_key).trim() : cur.app_key,
    app_secret: partial && partial.app_secret !== undefined ? String(partial.app_secret).trim() : cur.app_secret,
    default_chat_id: partial && partial.default_chat_id !== undefined ? String(partial.default_chat_id).trim() : cur.default_chat_id,
    default_robot_code: partial && partial.default_robot_code !== undefined ? String(partial.default_robot_code).trim() : String(cur.default_robot_code || ''),
    receive_enabled: partial && partial.receive_enabled !== undefined ? !!partial.receive_enabled : cur.receive_enabled,
    voice_reply_enabled: partial && partial.voice_reply_enabled !== undefined ? !!partial.voice_reply_enabled : !!cur.voice_reply_enabled,
    allowFrom: allowFromDingtalk
  }
  writeAll(all)
}

/** 技能远程源：{ name, url, enabled }[] */
function getSkillsSources() {
  const all = readAll()
  return Array.isArray(all.skills?.sources) ? all.skills.sources : []
}

function setSkillsSources(sources) {
  const all = readAll()
  all.skills = all.skills && typeof all.skills === 'object' ? all.skills : {}
  all.skills.sources = Array.isArray(sources) ? sources : []
  writeAll(all)
}

/** 硬件能力开关：{ screen: { enabled }, notify: { enabled } } */
function getHardware() {
  const all = readAll()
  if (!all.hardware || typeof all.hardware !== 'object') {
    return { ...DEFAULT_HARDWARE }
  }
  return {
    screen: { ...DEFAULT_HARDWARE.screen, ...all.hardware.screen },
    notify: { ...DEFAULT_HARDWARE.notify, ...all.hardware.notify },
  }
}

/** Webhook 配置：{ path, secret?, description? }[]，path 不可重复 */
function getWebhooks() {
  const all = readAll()
  return Array.isArray(all.webhooks) ? all.webhooks : []
}

function setWebhooks(webhooks) {
  const all = readAll()
  all.webhooks = Array.isArray(webhooks) ? webhooks : []
  writeAll(all)
}

module.exports = {
  getPath,
  readAll,
  writeAll,
  getAI,
  writeAI,
  getFeishu,
  setFeishu,
  getTelegram,
  setTelegram,
  getDingtalk,
  setDingtalk,
  getSkillsSources,
  setSkillsSources,
  getHardware,
  getWebhooks,
  setWebhooks,
  ensureMerged,
  DEFAULT_AI,
  DEFAULT_FEISHU,
  DEFAULT_TELEGRAM,
  DEFAULT_DINGTALK,
  DEFAULT_HARDWARE,
}
