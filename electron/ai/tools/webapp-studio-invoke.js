/**
 * 主会话 / IM 协调会话 → 委派「应用工作室 Agent」在指定 web-apps 目录内独立执行，结果通过工具返回给调用方。
 */

const path = require('path')
const fs = require('fs')
const { buildExecutionEnvelope, truncateDelegationStdoutPreview } = require('../execution-envelope')
const { ingestEnvelopeArtifacts } = require('../artifact-hub')
const { listInstalledApps, getWebAppsRoot, createBlankWebApp } = require('../../web-apps/registry')
const { sanitizeInjectedSystemPrompt } = require('../system-prompt-guard')

const DEFAULT_TASK_AFTER_CREATE =
  '应用已新建。请核对 manifest、README、index.html、service.js，并给用户一句如何本地预览的说明。'

const definition = {
  description:
    '【侧栏「应用」·改代码唯一入口】主会话/协调会话要**修改或新建** ~/.openultron/web-apps 下沙箱应用时**必须调用本工具**委派「应用工作室 Agent」；**禁止**用 file_operation(write) / apply_patch / 把 execute_command 的 cwd 指到应用目录来改沙箱代码（主进程会拦截）。本工具返回值即对用户的汇报依据。定位方式：**app_hint**（自然语言/名称或 id 片段）、**web_apps_list** 查 path、**project_path**、**app_id+version**、仅 **app_id**（唯一版本时）、**create_new=true**（先建再委派，可配 new_app_name）。子会话已合并 webapp__*；勿与 sessions_spawn 嵌套委派。',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          '交给应用工作室 Agent 的任务说明（user 消息）。create_new=true 时可省略，将使用简短默认说明。若需求含页面/表单/上传等，须写清「同时改 index.html（或入口页）与 service.js」；含糊任务易导致子 Agent 只改后端。'
      },
      project_path: { type: 'string', description: '应用根绝对路径；与其它定位方式择一' },
      app_id: { type: 'string', description: 'manifest.id；可与 version 同传，或单独传（仅一个已装版本时）' },
      version: { type: 'string', description: 'manifest.version；与 app_id 成对使用时可省略 app_hint' },
      app_hint: {
        type: 'string',
        description:
          '自然语言或名称/id 片段，用于在已装应用中唯一匹配（如「记账」「hello」、完整 id@version）。不唯一时工具返回 candidates，请再调用或让用户指定。'
      },
      create_new: {
        type: 'boolean',
        description: '为 true 时先新建空白沙箱应用再委派；可与 new_app_name 同用。'
      },
      new_app_name: {
        type: 'string',
        description: 'create_new 时可选，写入 manifest 展示名；也可用 web_apps_create 再带 path 调用本工具。'
      },
      system_prompt: {
        type: 'string',
        description: '可选，追加到子 Agent 的 system（委派说明仍会自动注入，max 5000 字符）。'
      },
      provider: { type: 'string', description: '可选，子 Agent 使用的供应商' },
      model: { type: 'string', description: '可选，子 Agent 使用的模型' }
    },
    required: []
  }
}

function normalizeParentSessionId(sid) {
  const s = String(sid || '').trim()
  if (!s) return ''
  const m = s.match(/^(.*)-run-\d+$/)
  return m && m[1] ? String(m[1]).trim() : s
}

const MAX_CANDIDATES = 24

function serializeCandidates(cands) {
  return (cands || []).slice(0, MAX_CANDIDATES).map((a) => ({
    id: a.id,
    version: a.version,
    name: a.name,
    path: a.path
  }))
}

/**
 * @param {string} hint
 * @param {Array<{ id: string, version: string, name: string, path: string }>} apps
 */
function resolveWebAppFromHint(hint, apps) {
  const raw = String(hint || '').trim()
  if (!raw) return { error: 'app_hint 为空' }
  const hl = raw.toLowerCase()

  if (raw.includes('@')) {
    const parts = raw.split('@')
    const idPart = String(parts[0] || '').trim()
    const verPart = String(parts.slice(1).join('@') || '').trim()
    if (idPart && verPart) {
      const hit = apps.find((a) => a.id === idPart && a.version === verPart)
      if (hit) return { path: hit.path, matched: hit }
      return { error: `未找到已安装应用 ${idPart}@${verPart}。可先调用 web_apps_list 核对。` }
    }
  }

  const exactId = apps.filter((a) => a.id === raw)
  if (exactId.length === 1) return { path: exactId[0].path, matched: exactId[0] }

  let cands = apps.filter((a) => a.id.toLowerCase() === hl)
  if (cands.length === 1) return { path: cands[0].path, matched: cands[0] }
  if (cands.length > 1) {
    return {
      ambiguous: true,
      candidates: cands,
      error: '多个应用匹配该 id 片段，请指定 id@version 或更完整的 app_hint。'
    }
  }

  cands = apps.filter((a) => a.id.toLowerCase().includes(hl))
  if (cands.length === 1) return { path: cands[0].path, matched: cands[0] }
  if (cands.length > 1) {
    return { ambiguous: true, candidates: cands, error: '多个应用的 id 包含该片段，请缩小 app_hint 或指定 id@version。' }
  }

  cands = apps.filter((a) => String(a.name || '').toLowerCase().includes(hl))
  if (cands.length === 1) return { path: cands[0].path, matched: cands[0] }
  if (cands.length > 1) {
    return { ambiguous: true, candidates: cands, error: '多个应用名称匹配，请改用 id@version 或更具体的描述。' }
  }

  return {
    error: `无法从「${raw}」唯一匹配应用。请先调用 web_apps_list，或提供 project_path / id@version。`
  }
}

function resolveStudioPath({ project_path, app_id, version, app_hint }) {
  const pp = String(project_path || '').trim()
  if (pp) {
    const abs = path.resolve(pp)
    const root = path.resolve(getWebAppsRoot())
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      return { error: `project_path 必须位于 web-apps 目录下：${root}` }
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return { error: 'project_path 不存在或不是目录' }
    }
    return { path: abs }
  }

  const apps = listInstalledApps()
  const id = String(app_id || '').trim()
  const ver = String(version || '').trim()

  if (id && ver) {
    const hit = apps.find((a) => a.id === id && a.version === ver)
    if (!hit) {
      return { error: `未找到已安装应用 ${id}@${ver}。可先调用 web_apps_list 或在侧栏「应用」核对。` }
    }
    return { path: hit.path, matched: hit }
  }

  if (id && !ver) {
    const same = apps.filter((a) => a.id === id)
    if (same.length === 1) return { path: same[0].path, matched: same[0] }
    if (same.length === 0) return { error: `未找到已安装应用 id=${id}。可先调用 web_apps_list。` }
    return {
      ambiguous: true,
      candidates: same,
      error: `应用 ${id} 有多个已装版本，请指定 version，或使用 app_hint / project_path。`
    }
  }

  if (!id && ver) {
    return { error: '不能只提供 version；请配合 app_id、或使用 app_hint / project_path。' }
  }

  const hint = String(app_hint || '').trim()
  if (hint) {
    return resolveWebAppFromHint(hint, apps)
  }

  return {
    error:
      '请提供 project_path，或 app_id（+version）、或 app_hint，或设 create_new=true。不确定时可先调用 web_apps_list。'
  }
}

function createWebappStudioInvokeTool(runSubChat) {
  if (typeof runSubChat !== 'function') {
    return {
      definition,
      execute: async () => ({ success: false, error: 'webapp_studio_invoke 未配置（缺少 runSubChat）' })
    }
  }

  async function execute(args, context = {}) {
    const {
      task,
      project_path,
      app_id,
      version,
      app_hint,
      create_new,
      new_app_name,
      system_prompt,
      provider,
      model
    } = args || {}

    const createNew = create_new === true
    let studioPath = ''
    let createdApp = null
    let resolvedApp = null

    let effectiveTask = String(task || '').trim()
    const sanitizedSystem = sanitizeInjectedSystemPrompt(system_prompt, { source: 'webapp_studio_invoke' })
    if (!sanitizedSystem.ok) {
      return { success: false, error: sanitizedSystem.error }
    }

    if (createNew) {
      if (!effectiveTask) effectiveTask = DEFAULT_TASK_AFTER_CREATE
      const cr = createBlankWebApp({
        name: new_app_name != null && String(new_app_name).trim() ? String(new_app_name).trim() : undefined
      })
      if (!cr.success) {
        return { success: false, error: cr.error || '新建沙箱应用失败' }
      }
      studioPath = cr.path
      createdApp = { id: cr.id, version: cr.version, path: cr.path, name: cr.manifest?.name || '' }
    } else {
      if (!effectiveTask) {
        return { success: false, error: '缺少 task（新建应用时可设 create_new=true 并省略 task）' }
      }
      const resolved = resolveStudioPath({ project_path, app_id, version, app_hint })
      if (resolved.ambiguous) {
        return {
          success: false,
          error: resolved.error || '无法唯一匹配应用',
          ambiguous: true,
          candidates: serializeCandidates(resolved.candidates)
        }
      }
      if (resolved.error) {
        return { success: false, error: resolved.error }
      }
      studioPath = resolved.path
      if (resolved.matched) {
        resolvedApp = {
          id: resolved.matched.id,
          version: resolved.matched.version,
          name: resolved.matched.name
        }
      }
    }

    const parentSessionId = normalizeParentSessionId(context.sessionId || '')

    const stream = {
      sendToolResult: (obj) => {
        try {
          if (!context?.sender || !context?.sessionId || !context?.toolCallId) return
          context.sender.send('ai-chat-tool-result', {
            sessionId: context.sessionId,
            toolCallId: context.toolCallId,
            name: 'webapp_studio_invoke',
            result: JSON.stringify(obj || {})
          })
        } catch (_) {}
      }
    }

    const parentRunId = String(context.runId || '').trim()
    try {
      const out = await runSubChat({
        task: effectiveTask,
        systemPrompt: sanitizedSystem.value,
        systemPromptSource: 'webapp_studio_invoke',
        roleName: '应用工作室 Agent',
        runtime: 'internal',
        webappStudioDelegate: true,
        parentSessionId,
        parentRunId: parentRunId || undefined,
        feishuChatId: context.feishuChatId || context.remoteId || '',
        feishuTenantKey: context.feishuTenantKey || '',
        feishuDocHost: context.feishuDocHost || '',
        feishuSenderOpenId: context.feishuSenderOpenId || '',
        feishuSenderUserId: context.feishuSenderUserId || '',
        stream,
        provider: provider != null && String(provider).trim() !== '' ? String(provider).trim() : undefined,
        model: model && String(model).trim() ? String(model).trim() : undefined,
        projectPath: studioPath
      })

      const envelope = buildExecutionEnvelope(out || {}, out?.runtime || 'internal')
      try {
        ingestEnvelopeArtifacts(envelope, {
          sessionId: parentSessionId,
          runSessionId: out?.subSessionId != null ? String(out.subSessionId) : '',
          parentRunId,
          chatId: String(context.feishuChatId || context.remoteId || ''),
          channel: String(context.channel || ''),
          source: 'webapp_studio_invoke'
        })
      } catch (_) {}

      const stdoutPreview = truncateDelegationStdoutPreview(out?.commandLogs)
      if (!out || !out.success) {
        return {
          success: false,
          message: envelope.summary,
          envelope,
          error: out?.error || '应用工作室 Agent 执行失败',
          stdout: stdoutPreview,
          studio_path: studioPath,
          ...(createdApp ? { created_app: createdApp } : {}),
          ...(resolvedApp ? { resolved_app: resolvedApp } : {})
        }
      }
      return {
        success: true,
        message: envelope.summary,
        envelope,
        result: out.result ?? '',
        stdout: stdoutPreview,
        sub_session_id: out.subSessionId ?? null,
        runtime: out.runtime || 'internal',
        studio_path: studioPath,
        ...(createdApp ? { created_app: createdApp } : {}),
        ...(resolvedApp ? { resolved_app: resolvedApp } : {})
      }
    } catch (e) {
      const envCatch = buildExecutionEnvelope({ success: false, error: e.message || String(e), runtime: 'internal' }, 'internal')
      try {
        ingestEnvelopeArtifacts(envCatch, {
          sessionId: parentSessionId,
          runSessionId: '',
          parentRunId,
          chatId: String(context.feishuChatId || context.remoteId || ''),
          channel: String(context.channel || ''),
          source: 'webapp_studio_invoke'
        })
      } catch (_) {}
      return {
        success: false,
        message: envCatch.summary,
        error: e.message || String(e),
        envelope: envCatch,
        studio_path: studioPath || undefined,
        ...(createdApp ? { created_app: createdApp } : {}),
        ...(resolvedApp ? { resolved_app: resolvedApp } : {})
      }
    }
  }

  return { definition, execute }
}

module.exports = { definition, createWebappStudioInvokeTool, resolveStudioPath, resolveWebAppFromHint }
