/**
 * 获取当前有效的飞书 tenant_access_token，供 AI 在 run_script 等脚本中调用飞书开放 API（内置未实现的能力）时使用。
 * Token 计算规则明确：POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal，body { app_id, app_secret }。
 */
const feishuNotify = require('../feishu-notify')

const definition = {
  description: '获取当前有效的飞书 tenant_access_token 与剩余有效秒数。用于在 run_script 等脚本中调用飞书开放 API（如自定义接口、批量操作等内置未实现的能力）时，在请求头中加 Authorization: Bearer <token>。配置项 app_id、app_secret 来自 ~/.openultron/openultron.json 的 feishu 字段；Token 由飞书服务端根据该二项计算，有效期约 2 小时。',
  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
}

async function execute() {
  try {
    const info = await feishuNotify.getTenantAccessTokenInfo()
    return {
      success: true,
      token: info.token,
      expire_in: info.expire_in,
      note: '在脚本中请求飞书 API 时请使用 Header: Authorization: Bearer <token>；open.feishu.cn 文档：https://open.feishu.cn/document/'
    }
  } catch (e) {
    return {
      success: false,
      message: e.message || '获取飞书 tenant token 失败',
      hint: '请确认已在「AI 管理 → 飞书通知」中配置 App ID 与 App Secret，并确保应用已开通对应权限。'
    }
  }
}

module.exports = { definition, execute }
