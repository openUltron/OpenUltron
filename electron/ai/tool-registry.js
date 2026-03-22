// 工具注册中心 - 管理所有可用工具的注册和查找

class ToolRegistry {
  constructor() {
    this.tools = new Map() // name -> { definition, execute }
  }

  // 注册工具
  register(name, tool) {
    if (!tool.definition || !tool.execute) {
      throw new Error(`工具 ${name} 必须包含 definition 和 execute`)
    }
    this.tools.set(name, tool)
  }

  // 获取工具
  getTool(name) {
    return this.tools.get(name)
  }

  // 获取所有工具的 OpenAI function calling 格式定义
  getToolDefinitions() {
    const definitions = []
    for (const [name, tool] of this.tools) {
      definitions.push({
        type: 'function',
        function: {
          name,
          description: tool.definition.description,
          parameters: tool.definition.parameters
        }
      })
    }
    return definitions
  }

  // 获取所有工具名
  getToolNames() {
    return Array.from(this.tools.keys())
  }
}

// 创建默认注册中心并加载内置工具
function createDefaultRegistry(options = {}) {
  const registry = new ToolRegistry()

  // 内置工具靠前：飞书语音/文件/消息、TTS 音色，便于模型优先选用
  try {
    registry.register('feishu_send_voice_message', require('./tools/feishu-send-voice-message'))
  } catch (e) { console.warn('加载 feishu_send_voice_message 工具失败:', e.message) }
  try {
    registry.register('feishu_send_file_message', require('./tools/feishu-send-file-message'))
  } catch (e) { console.warn('加载 feishu_send_file_message 工具失败:', e.message) }
  try {
    registry.register('feishu_send_message', require('./tools/feishu-send-message'))
  } catch (e) { console.warn('加载 feishu_send_message 工具失败:', e.message) }
  try {
    registry.register('feishu_get_tenant_token', require('./tools/feishu-get-tenant-token'))
  } catch (e) { console.warn('加载 feishu_get_tenant_token 工具失败:', e.message) }
  try {
    registry.register('tts_voice_manager', require('./tools/tts-voice-manager'))
  } catch (e) { console.warn('加载 tts_voice_manager 工具失败:', e.message) }
  try {
    registry.register('edge_tts_synthesize', require('./tools/edge-tts-synthesize'))
  } catch (e) { console.warn('加载 edge_tts_synthesize 工具失败:', e.message) }
  try {
    registry.register('ffmpeg_run', require('./tools/ffmpeg-run'))
  } catch (e) { console.warn('加载 ffmpeg_run 工具失败:', e.message) }
  try {
    registry.register('feishu_doc_capability', require('./tools/feishu-doc-capability'))
  } catch (e) { console.warn('加载 feishu_doc_capability 工具失败:', e.message) }

  const builtinTools = [
    ['analyze_project', './tools/analyze-project'],
    ['execute_command', './tools/execute-command'],
    ['query_command_log', './tools/query-command-log'],
    ['read_app_log', './tools/read-app-log'],
    ['run_script', './tools/run-script'],
    ['git_operation', './tools/git-operation'],
    ['file_operation', './tools/file-operation'],
    ['user_confirmation', './tools/user-confirmation'],
    ['hardware_invoke', './tools/hardware-invoke'],
    ['show_desktop_notification', './tools/show-desktop-notification'],
    ['sessions_list', './tools/sessions-list'],
    ['sessions_history', './tools/sessions-history'],
    ['sessions_send', './tools/sessions-send'],
  ]

  for (const [name, modulePath] of builtinTools) {
    try {
      const tool = require(modulePath)
      registry.register(name, tool)
    } catch (e) {
      console.warn(`加载 ${name} 工具失败:`, e.message)
    }
  }

  // 浏览器自动化已统一走 chrome-devtools MCP，不再注册内置 webview_control

  // get_skill 需要 getSkills、可选 getSkillsSources、getSandboxSkills（沙箱列表）
  if (options.getSkills) {
    try {
      const { createGetSkillTool } = require('./tools/get-skill')
      registry.register('get_skill', createGetSkillTool(options.getSkills, options.getSkillsSources, options.getSandboxSkills))
    } catch (e) {
      console.warn('加载 get_skill 工具失败:', e.message)
    }
  }

  try {
    const { createUpdateMcpConfigTool } = require('./tools/update-mcp-config')
    // mcpManager is passed via options
    if (options.mcpManager) {
      registry.register('update_mcp_config', createUpdateMcpConfigTool(options.store, options.mcpManager))
    }
  } catch (e) {
    console.warn('加载 update_mcp_config 工具失败:', e.message)
  }

  if (options.skillsDir) {
    try {
      const { createInstallSkillTool } = require('./tools/install-skill')
      registry.register('install_skill', createInstallSkillTool(options.skillsDir, options.onSkillChanged, options.getSkillsSources))
    } catch (e) {
      console.warn('加载 install_skill 工具失败:', e.message)
    }
  }

  if (options.skillsDir) {
    try {
      const { createValidateSkillTool } = require('./tools/validate-skill')
      registry.register('validate_skill', createValidateSkillTool(options.skillsDir))
    } catch (e) {
      console.warn('加载 validate_skill 工具失败:', e.message)
    }
  }

  function getApiKey() {
    if (options.getAIConfig) {
      const legacy = options.getAIConfig()
      return (legacy && legacy.config && legacy.config.apiKey) || ''
    }
    const config = options.store.get('aiConfig', {})
    const providerKeys = options.store.get('aiProviderKeys', {})
    const baseUrl = config.apiBaseUrl || 'https://api.qnaigc.com/v1'
    return providerKeys[baseUrl] || config.apiKey || ''
  }

  if (options.getAIConfig && options.writeAIConfig) {
    try {
      const { createAIConfigControlTool } = require('./tools/ai-config-control')
      registry.register('ai_config_control', createAIConfigControlTool(
        options.getAIConfig,
        options.writeAIConfig,
        options.getValidatedModelsForBaseUrl || null
      ))
    } catch (e) {
      console.warn('加载 ai_config_control 工具失败:', e.message)
    }
  }

  // Memory 工具（支持向量语义搜索，getAIConfig 用于生成 embedding）
  try {
    const { createMemorySearchTool } = require('./tools/memory-search')
    registry.register('memory_search', createMemorySearchTool(options.getAIConfig || null))
    registry.register('memory_get', require('./tools/memory-get'))
    const { createMemorySaveTool } = require('./tools/memory-save')
    registry.register('memory_save', createMemorySaveTool(options.getAIConfig || null))
  } catch (e) {
    console.warn('加载 memory 工具失败:', e.message)
  }

  // 知识库 LESSONS_LEARNED：写入与读取（自进化专用，替代 file_operation 操作该文件）
  try {
    registry.register('lesson_save', require('./tools/lesson-save'))
    registry.register('read_lessons_learned', require('./tools/read-lessons-learned'))
  } catch (e) {
    console.warn('加载 lesson 工具失败:', e.message)
  }

  // web_fetch 工具
  try {
    registry.register('web_fetch', require('./tools/web-fetch'))
  } catch (e) {
    console.warn('加载 web_fetch 工具失败:', e.message)
  }

  // web_search 工具（内置网页搜索，不依赖 MCP）
  try {
    registry.register('web_search', require('./tools/web-search'))
  } catch (e) {
    console.warn('加载 web_search 工具失败:', e.message)
  }

  // 产物库检索：支持 AI 查询本地文件 + 云文档引用，减少找错
  try {
    registry.register('artifact_search', require('./tools/artifact-search'))
  } catch (e) {
    console.warn('加载 artifact_search 工具失败:', e.message)
  }

  // 定时任务 Cron：list / add / update / delete / run_now
  try {
    registry.register('cron_task', require('./tools/cron-task'))
  } catch (e) {
    console.warn('加载 cron_task 工具失败:', e.message)
  }

  // 飞书多维表格能力：表/字段/记录
  try {
    registry.register('feishu_bitable_capability', require('./tools/feishu-bitable-capability'))
  } catch (e) {
    console.warn('加载 feishu_bitable_capability 工具失败:', e.message)
  }

  // 飞书电子表格能力：读取/写入单元格范围
  try {
    registry.register('feishu_sheets_capability', require('./tools/feishu-sheets-capability'))
  } catch (e) {
    console.warn('加载 feishu_sheets_capability 工具失败:', e.message)
  }

  // Telegram 通知：发送文本/语音
  try {
    registry.register('telegram_send_message', require('./tools/telegram-send-message'))
  } catch (e) {
    console.warn('加载 telegram_send_message 工具失败:', e.message)
  }

  // DingTalk 通知：发送文本/语音
  try {
    registry.register('dingtalk_send_message', require('./tools/dingtalk-send-message'))
  } catch (e) {
    console.warn('加载 dingtalk_send_message 工具失败:', e.message)
  }

  // process_manager 后台进程管理
  try {
    registry.register('process_manager', require('./tools/process-manager'))
  } catch (e) {
    console.warn('加载 process_manager 工具失败:', e.message)
  }

  // apply_patch 精准文件修改
  try {
    registry.register('apply_patch', require('./tools/apply-patch'))
  } catch (e) {
    console.warn('加载 apply_patch 工具失败:', e.message)
  }

  // python_run 白名单目录下执行 Python 脚本
  try {
    registry.register('python_run', require('./tools/python-run'))
  } catch (e) {
    console.warn('加载 python_run 工具失败:', e.message)
  }

  // llm_task 结构化子任务
  if (options.getAIConfig) {
    try {
      const { createLlmTaskTool } = require('./tools/llm-task')
      registry.register('llm_task', createLlmTaskTool(options.getAIConfig))
    } catch (e) {
      console.warn('加载 llm_task 工具失败:', e.message)
    }
  }

  console.log(`[AI] 已注册 ${registry.getToolNames().length} 个工具: ${registry.getToolNames().join(', ')}`)
  return registry
}

module.exports = { ToolRegistry, createDefaultRegistry }
