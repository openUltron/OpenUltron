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
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '', openAiWireMode: 'codex' },
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
  // 可选：文档链接域名（如 imeipian.feishu.cn），用于统一生成租户可访问文档链接
  doc_host: '',
  // 可选：用户 access token（用于以用户身份创建文档到个人空间）
  user_access_token: '',
  // 可选：用户 refresh token（用于后续刷新 user_access_token）
  user_refresh_token: '',
  // 可选：用户 access token 过期时间戳（秒）
  user_access_token_expire_at: 0,
  // OAuth 回调地址（需与飞书后台安全设置中的 Redirect URL 完全一致）
  oauth_redirect_uri: 'http://127.0.0.1:14579/feishu/oauth/callback',
  // 文档创建是否优先使用 user_access_token（创建到用户空间）
  doc_create_in_user_space: false,
  notify_on_complete: false,
  receive_enabled: false,
  // 是否在同一条消息中流式更新 AI 输出（支持思考/命令过程）
  streaming_reply_enabled: true,
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
  /** 默认 chat_id：任务完成通知等场景使用（需与 bot 有过对话） */
  default_chat_id: '',
  /** 会话结束时向 default_chat_id 发送完成摘要 */
  notify_on_complete: false,
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
  /** 会话结束时向 default_chat_id + default_robot_code 发送完成摘要 */
  notify_on_complete: false,
  /** 允许触发的 conversationId/用户 ID 列表，'*' 表示全部允许；不配或空数组表示全部允许 */
  allowFrom: undefined
}

const DEFAULT_HARDWARE = {
  screen: { enabled: true },
  notify: { enabled: true }
}

/** 默认不填任何代理地址，由用户在「设置 → 代理」中配置并写入 openultron.json */
const DEFAULT_PROXY = {
  enabled: false,
  http_proxy: '',
  https_proxy: '',
  all_proxy: '',
  no_proxy: ''
}

/** 飞书/Telegram/钉钉 入站协调 Agent：是否在工具列表中包含 sessions_spawn（默认 false，与历史行为一致） */
const DEFAULT_IM_COORDINATOR = {
  include_sessions_spawn: false
}

/** 子 Agent 编排：并发、深度、Profile 白名单（见 docs/plans/agent-orchestration-redesign.md） */
const DEFAULT_SUBAGENT_ORCHESTRATION = {
  maxSpawnDepth: 1,
  maxConcurrent: 8,
  maxChildrenPerAgent: 5,
  /** 允许 sessions_spawn 使用的 profile id；`*` 表示全部 */
  allowedProfiles: ['*'],
  /** 子会话默认不注入 SOUL/IDENTITY/USER 等长身份块（executor 等仍可在 profile 中 inherit_identity） */
  subagentMinimalMemory: true,
  /** 允许 wait_for_result=false 异步 spawn（后台跑 + sessions_subagent_poll 取结果） */
  allowAsyncSpawn: true,
  /** auto/runtime:external 时的外部子 Agent 候选顺序 */
  externalRuntimePreference: ['codex', 'claude', 'gateway', 'opencode'],
  /** auto 模式无外部可用时，是否在日志/元信息保留 fallback 提示 */
  reportAutoFallback: true
}

/** 默认含 ClawHub；list_remote 对 type=clawhub 走搜索 API（见 get-skill.js） */
const DEFAULT_SKILLS_SOURCES = [
  { name: 'ClawHub', url: 'https://clawhub.ai/', enabled: true, type: 'clawhub' }
]

function normalizeSkillsBlock(data) {
  const sk = data.skills && typeof data.skills === 'object' ? data.skills : {}
  let sources
  if (!Array.isArray(sk.sources)) {
    sources = DEFAULT_SKILLS_SOURCES.map((s) => ({ ...s }))
  } else {
    sources = sk.sources.filter(
      (s) => s && typeof s.name === 'string' && (typeof s.url === 'string' || s.type === 'clawhub')
    )
  }
  const load = sk.load && typeof sk.load === 'object' ? sk.load : {}
  const extraDirs = Array.isArray(load.extraDirs) ? load.extraDirs.map((x) => String(x || '').trim()).filter(Boolean) : []
  const entries = sk.entries && typeof sk.entries === 'object' ? sk.entries : {}
  return {
    sources,
    load: {
      extraDirs,
      watch: !!load.watch,
      watchDebounceMs: load.watchDebounceMs
    },
    entries
  }
}

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

/** 合并 OpenAI 接口类型：已保存优先；未写字段时用默认模板（如 OpenAI 默认 codex） */
function pickOpenAiWireMode(saved, defaultTemplate) {
  const v = saved && saved.openAiWireMode
  if (v === 'responses' || v === 'chat' || v === 'codex' || v === 'auto') return v
  const d = defaultTemplate && defaultTemplate.openAiWireMode
  if (d === 'responses' || d === 'chat' || d === 'codex' || d === 'auto') return d
  return undefined
}

function mergeProviders(defaultList, savedList) {
  if (!Array.isArray(savedList) || savedList.length === 0) return defaultList.map(p => ({ ...p }))
  const byUrl = new Map(savedList.filter(p => p && p.baseUrl).map(p => [p.baseUrl, p]))
  const merged = defaultList.map(p => {
    const saved = byUrl.get(p.baseUrl)
    if (saved) {
      byUrl.delete(p.baseUrl)
      const out = { name: p.name, baseUrl: p.baseUrl, apiKey: saved.apiKey ?? '' }
      const wm = pickOpenAiWireMode(saved, p)
      if (wm) out.openAiWireMode = wm
      return out
    }
    return { ...p }
  })
  byUrl.forEach((saved) => {
    const out = { name: saved.name || saved.baseUrl, baseUrl: saved.baseUrl, apiKey: saved.apiKey ?? '' }
    const v = saved.openAiWireMode
    if (v === 'responses' || v === 'chat' || v === 'codex' || v === 'auto') {
      out.openAiWireMode = v
    }
    merged.push(out)
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
      const skillsBlock = normalizeSkillsBlock(data)
      let ai = data.ai && Array.isArray(data.ai.providers) ? data.ai : { ...DEFAULT_AI, ...data.ai }
      ai = { ...ai, providers: mergeProviders(DEFAULT_AI.providers, ai.providers) }
      ai.modelPool = normalizeModelPool(ai.modelPool, ai.defaultModel)
      ai.modelBindings = normalizeModelBindings(ai.modelBindings, ai.providers, ai.modelPool, ai.defaultProvider)
      const imCoordinator = data.imCoordinator && typeof data.imCoordinator === 'object'
        ? { ...DEFAULT_IM_COORDINATOR, ...data.imCoordinator }
        : { ...DEFAULT_IM_COORDINATOR }
      const subOrc = data.subagentOrchestration && typeof data.subagentOrchestration === 'object'
        ? { ...DEFAULT_SUBAGENT_ORCHESTRATION, ...data.subagentOrchestration }
        : { ...DEFAULT_SUBAGENT_ORCHESTRATION }
      if (subOrc.allowedProfiles != null && !Array.isArray(subOrc.allowedProfiles)) {
        subOrc.allowedProfiles = DEFAULT_SUBAGENT_ORCHESTRATION.allowedProfiles
      }
      return {
        ai,
        feishu: { ...DEFAULT_FEISHU, ...data.feishu },
        telegram,
        dingtalk,
        webhooks,
        hardware,
        proxy: { ...DEFAULT_PROXY, ...(data.proxy && typeof data.proxy === 'object' ? data.proxy : {}) },
        skills: skillsBlock,
        imCoordinator,
        subagentOrchestration: subOrc
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
  const merged = {
    ai,
    feishu,
    telegram: { ...DEFAULT_TELEGRAM },
    dingtalk: { ...DEFAULT_DINGTALK },
    webhooks: [],
    hardware: { ...DEFAULT_HARDWARE },
    proxy: { ...DEFAULT_PROXY },
    skills: normalizeSkillsBlock({}),
    imCoordinator: { ...DEFAULT_IM_COORDINATOR },
    subagentOrchestration: { ...DEFAULT_SUBAGENT_ORCHESTRATION }
  }
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
    doc_host: partial && partial.doc_host !== undefined ? String(partial.doc_host).trim() : String(cur.doc_host || ''),
    user_access_token: partial && partial.user_access_token !== undefined ? String(partial.user_access_token).trim() : String(cur.user_access_token || ''),
    user_refresh_token: partial && partial.user_refresh_token !== undefined ? String(partial.user_refresh_token).trim() : String(cur.user_refresh_token || ''),
    user_access_token_expire_at: partial && partial.user_access_token_expire_at !== undefined
      ? Number(partial.user_access_token_expire_at || 0) || 0
      : Number(cur.user_access_token_expire_at || 0) || 0,
    oauth_redirect_uri: partial && partial.oauth_redirect_uri !== undefined
      ? String(partial.oauth_redirect_uri).trim()
      : String(cur.oauth_redirect_uri || 'http://127.0.0.1:14579/feishu/oauth/callback'),
    doc_create_in_user_space: partial && partial.doc_create_in_user_space !== undefined
      ? !!partial.doc_create_in_user_space
      : !!cur.doc_create_in_user_space,
    notify_on_complete: partial && partial.notify_on_complete !== undefined ? !!partial.notify_on_complete : cur.notify_on_complete,
    receive_enabled: partial && partial.receive_enabled !== undefined ? !!partial.receive_enabled : cur.receive_enabled,
    streaming_reply_enabled: partial && partial.streaming_reply_enabled !== undefined ? !!partial.streaming_reply_enabled : (cur.streaming_reply_enabled !== false),
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
    default_chat_id: partial && partial.default_chat_id !== undefined ? String(partial.default_chat_id).trim() : String(cur.default_chat_id || ''),
    notify_on_complete: partial && partial.notify_on_complete !== undefined ? !!partial.notify_on_complete : !!cur.notify_on_complete,
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
    notify_on_complete: partial && partial.notify_on_complete !== undefined ? !!partial.notify_on_complete : !!cur.notify_on_complete,
    allowFrom: allowFromDingtalk
  }
  writeAll(all)
}

/** 技能远程源：{ name, url, enabled }[] */
function getSkillsSources() {
  const all = readAll()
  const src = all.skills?.sources
  return Array.isArray(src) ? src : []
}

function getSkillsLoadConfig() {
  const all = readAll()
  return all.skills?.load || { extraDirs: [] }
}

function getSkillsEntries() {
  const all = readAll()
  return all.skills?.entries && typeof all.skills.entries === 'object' ? all.skills.entries : {}
}

function setSkillsSources(sources) {
  const all = readAll()
  const sk = all.skills && typeof all.skills === 'object' ? all.skills : {}
  all.skills = normalizeSkillsBlock({ skills: { ...sk, sources: Array.isArray(sources) ? sources : [] } })
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

function getProxy() {
  const all = readAll()
  return all.proxy && typeof all.proxy === 'object' ? { ...DEFAULT_PROXY, ...all.proxy } : { ...DEFAULT_PROXY }
}

function setProxy(partial) {
  const all = readAll()
  const cur = all.proxy && typeof all.proxy === 'object' ? { ...DEFAULT_PROXY, ...all.proxy } : { ...DEFAULT_PROXY }
  all.proxy = {
    enabled: partial && partial.enabled !== undefined ? !!partial.enabled : !!cur.enabled,
    http_proxy: partial && partial.http_proxy !== undefined ? String(partial.http_proxy || '').trim() : String(cur.http_proxy || ''),
    https_proxy: partial && partial.https_proxy !== undefined ? String(partial.https_proxy || '').trim() : String(cur.https_proxy || ''),
    all_proxy: partial && partial.all_proxy !== undefined ? String(partial.all_proxy || '').trim() : String(cur.all_proxy || ''),
    no_proxy: partial && partial.no_proxy !== undefined ? String(partial.no_proxy || '').trim() : String(cur.no_proxy || '')
  }
  writeAll(all)
}

function getImCoordinator() {
  const all = readAll()
  const m = all.imCoordinator && typeof all.imCoordinator === 'object' ? all.imCoordinator : {}
  return {
    include_sessions_spawn: m.include_sessions_spawn === true
  }
}

function setImCoordinator(partial) {
  const all = readAll()
  const cur = getImCoordinator()
  all.imCoordinator = {
    include_sessions_spawn:
      partial && partial.include_sessions_spawn !== undefined
        ? !!partial.include_sessions_spawn
        : cur.include_sessions_spawn
  }
  writeAll(all)
}

function getSubagentOrchestration() {
  const all = readAll()
  const m = all.subagentOrchestration && typeof all.subagentOrchestration === 'object'
    ? all.subagentOrchestration
    : {}
  const externalRuntimePreference = Array.isArray(m.externalRuntimePreference)
    ? m.externalRuntimePreference.map(x => String(x || '').trim()).filter(Boolean)
    : DEFAULT_SUBAGENT_ORCHESTRATION.externalRuntimePreference
  return {
    maxSpawnDepth: Number.isFinite(Number(m.maxSpawnDepth)) ? Math.max(1, Math.min(5, Number(m.maxSpawnDepth))) : DEFAULT_SUBAGENT_ORCHESTRATION.maxSpawnDepth,
    maxConcurrent: Number.isFinite(Number(m.maxConcurrent)) ? Math.max(1, Number(m.maxConcurrent)) : DEFAULT_SUBAGENT_ORCHESTRATION.maxConcurrent,
    maxChildrenPerAgent: Number.isFinite(Number(m.maxChildrenPerAgent)) ? Math.max(1, Number(m.maxChildrenPerAgent)) : DEFAULT_SUBAGENT_ORCHESTRATION.maxChildrenPerAgent,
    allowedProfiles: Array.isArray(m.allowedProfiles) && m.allowedProfiles.length > 0 ? m.allowedProfiles.map((x) => String(x || '').trim()).filter(Boolean) : DEFAULT_SUBAGENT_ORCHESTRATION.allowedProfiles,
    subagentMinimalMemory: m.subagentMinimalMemory !== false,
    allowAsyncSpawn: m.allowAsyncSpawn !== false,
    externalRuntimePreference,
    reportAutoFallback: m.reportAutoFallback !== false
  }
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
  getSkillsLoadConfig,
  getSkillsEntries,
  normalizeSkillsBlock,
  getHardware,
  getWebhooks,
  setWebhooks,
  getProxy,
  setProxy,
  getImCoordinator,
  setImCoordinator,
  getSubagentOrchestration,
  ensureMerged,
  DEFAULT_AI,
  DEFAULT_FEISHU,
  DEFAULT_TELEGRAM,
  DEFAULT_DINGTALK,
  DEFAULT_HARDWARE,
  DEFAULT_PROXY,
  DEFAULT_IM_COORDINATOR,
  DEFAULT_SUBAGENT_ORCHESTRATION,
}
