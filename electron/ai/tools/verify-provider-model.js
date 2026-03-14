/**
 * 验证某供应商下某模型是否可用（发一次最小 chat 请求）。切换主会话模型/供应商前可先调用本工具确认可用再切换。
 */

const definition = {
  description: '验证指定供应商下的某模型是否可用（发送一次最小请求测试）。仅用于 OpenAI 兼容的对话 API（供应商 base_url + 模型 ID），不适用于 Leonardo、Playground 等生图服务。切换主会话的模型或供应商前可先调用本工具确认可用再调用 ai_config_control；若用户要求「验证 Leonardo / Playground / 生图 Key」，请直接说明当前不支持，勿反复调用本工具。',
  parameters: {
    type: 'object',
    properties: {
      provider: {
        type: 'string',
        description: '可选。供应商名称或 base_url；不传则使用当前默认供应商'
      },
      model: {
        type: 'string',
        description: '必填。要验证的模型 ID（如 deepseek-v3、gpt-4o-mini、stepfun/step-3.5-flash:free）'
      }
    },
    required: ['model']
  }
}

function createVerifyProviderModelTool(verifyProviderModelFn) {
  if (typeof verifyProviderModelFn !== 'function') {
    return {
      definition,
      execute: async () => ({ success: false, error: 'verify_provider_model 未配置' })
    }
  }

  async function execute(args) {
    const provider = args?.provider != null && String(args.provider).trim() !== '' ? String(args.provider).trim() : null
    const model = args?.model != null ? String(args.model).trim() : ''
    if (!model) {
      return { success: false, error: '请指定要验证的模型 ID（model 参数）' }
    }
    try {
      const result = await verifyProviderModelFn(provider, model)
      if (result.success) {
        return { success: true, message: '模型可用', provider: provider || '当前默认', model }
      }
      return { success: false, error: result.error || '验证失败' }
    } catch (e) {
      return { success: false, error: e.message || String(e) }
    }
  }

  return { definition, execute }
}

module.exports = { definition, createVerifyProviderModelTool }
