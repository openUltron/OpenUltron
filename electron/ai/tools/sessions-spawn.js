/**
 * 派生子 Agent（多 Agent / 代理模式）：创建独立会话执行任务，执行完成后返回结果给主 Agent。
 * 对标 OpenClaw 的 sessions_spawn。
 */

const definition = {
  description: '派生子 Agent 执行一项任务。主 Agent 将任务与可选系统提示交给子 Agent，子 Agent 在独立会话中运行直至完成，最后把最终回复文本返回给主 Agent。用于任务分派、多角色协作、或需隔离上下文的子任务。可通过 provider 与 model 指定子 Agent 使用的供应商与模型（先调用 list_providers_and_models 获取可用列表）。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '交给子 Agent 执行的任务描述（作为一条 user 消息）' },
      system_prompt: { type: 'string', description: '可选。注入子 Agent 的 system 提示，用于限定角色或步骤' },
      role_name: { type: 'string', description: '可选。子 Agent 的角色名/显示名，便于在对话中区分（如「代码审查员」「翻译助手」）' },
      runtime: { type: 'string', description: '可选。子 Agent 运行时：auto（默认，先尝试可用外部子 Agent，失败自动回退）/ internal（仅内置）/ external:<name>（如 external:codex）' },
      provider: { type: 'string', description: '可选。子 Agent 使用的供应商：供应商名称（如「OpenAI」「DeepSeek」）或 base_url；不传则使用当前默认供应商' },
      model: { type: 'string', description: '可选。子 Agent 使用的模型 ID。根据任务复杂度选择：简单任务选 tags 含 fast 的模型；需要深度推理/复杂代码调试选 reasoning 模型；长文本创作/复杂指令选 powerful 模型。优先选 in_pool:true 的模型（已在全局配置中验证可用）。不传则使用当前默认模型。' },
      project_path: { type: 'string', description: '可选。子 Agent 的项目路径上下文，默认与主会话一致' }
    },
    required: ['task']
  }
}

function createSessionsSpawnTool(runSubChat) {
  if (typeof runSubChat !== 'function') {
    return {
      definition,
      execute: async () => ({ success: false, error: 'sessions_spawn 未配置（缺少 runSubChat）' })
    }
  }

  async function execute(args, context = {}) {
    const { task, system_prompt, provider, model, project_path, role_name, runtime } = args || {}
    if (!task || String(task).trim() === '') {
      return { success: false, error: '缺少 task 参数' }
    }
    // 避免子 Agent 递归再派生，导致并发风暴与上下文失控
    if (context.sessionId && String(context.sessionId).startsWith('sub-')) {
      return { success: false, error: '子 Agent 不允许再调用 sessions_spawn（已阻止递归派生）' }
    }
    const projectPath = (project_path != null && String(project_path).trim() !== '')
      ? String(project_path).trim()
      : (context.projectPath || '__main_chat__')
    try {
      const out = await runSubChat({
        task: String(task).trim(),
        systemPrompt: system_prompt && String(system_prompt).trim() ? String(system_prompt).trim() : undefined,
        roleName: role_name != null && String(role_name).trim() !== '' ? String(role_name).trim() : undefined,
        runtime: runtime != null && String(runtime).trim() !== '' ? String(runtime).trim() : undefined,
        parentSessionId: context.sessionId || '',
        provider: provider != null && String(provider).trim() !== '' ? String(provider).trim() : undefined,
        model: model && String(model).trim() ? String(model).trim() : undefined,
        projectPath
      })
      if (!out.success) {
        return { success: false, error: out.error || '子 Agent 执行失败' }
      }
      return {
        success: true,
        result: out.result ?? '',
        sub_session_id: out.subSessionId ?? null,
        runtime: out.runtime || 'internal',
        attempted_runtimes: Array.isArray(out.attemptedRuntimes) ? out.attemptedRuntimes : [],
        message: '子 Agent 已完成，结果见 result 字段'
      }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return { definition, execute }
}

module.exports = { definition, createSessionsSpawnTool }
