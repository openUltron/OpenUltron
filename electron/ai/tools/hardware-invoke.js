/**
 * 通用硬件能力调用工具：根据 capabilityId + method 调用已注册的硬件能力。
 * 见 EXTENSIBILITY-DESIGN.md 4.2 方案 A。
 */
const hardwareRegistry = require('../../extensions/hardware-registry')
const openultronConfig = require('../../openultron-config')

const definition = {
  description: '调用本机硬件能力。用户要求「桌面原生通知」「本机系统通知」「桌面弹窗」时，请使用本工具：capabilityId=notify, method=show, args={ title, body }（可选 silent）。另支持 screen.capture 截取内置浏览器截图。参数 capabilityId 与 method 必填；各能力可在 openultron.json 的 hardware 下开关。',
  parameters: {
    type: 'object',
    properties: {
      capabilityId: { type: 'string', description: '能力 ID，如 screen' },
      method: { type: 'string', description: '方法名，如 capture' },
      args: { type: 'object', description: '传给该方法的参数（可选）', default: {} }
    },
    required: ['capabilityId', 'method']
  }
}

async function execute(args, context = {}) {
  const { capabilityId, method, args: invokeArgs = {} } = args
  if (!capabilityId || !method) {
    return { success: false, error: '缺少 capabilityId 或 method' }
  }
  const capability = hardwareRegistry.get(capabilityId)
  if (!capability) {
    return { success: false, error: `未注册的硬件能力: ${capabilityId}` }
  }
  if (capability.configKey) {
    const hw = openultronConfig.getHardware && openultronConfig.getHardware()
    const key = capability.configKey.replace('hardware.', '')
    const enabled = hw && hw[key] && hw[key].enabled !== false
    if (!enabled) {
      return { success: false, error: `硬件能力 ${capabilityId} 已在配置中关闭，请在 openultron.json 的 hardware.${key}.enabled 中开启` }
    }
  }
  const methodDef = capability.methods && capability.methods.find(m => m.name === method)
  if (!methodDef || typeof methodDef.invoke !== 'function') {
    return { success: false, error: `能力 ${capabilityId} 不存在方法: ${method}` }
  }
  try {
    const result = await methodDef.invoke(invokeArgs, {
      projectPath: context.projectPath,
      sessionId: context.sessionId
    })
    if (result.success && result.data !== undefined) {
      return { success: true, ...result.data }
    }
    if (result.success) return { success: true }
    return { success: false, error: result.error || '调用失败' }
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
}

module.exports = { definition, execute }
