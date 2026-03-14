/**
 * 桌面原生通知：独立工具，便于模型直接选用（用户说「桌面原生通知」时用本工具，不要用 webview_control 模拟）。
 * 底层复用 hardware notify 能力，配置受 openultron.json hardware.notify.enabled 控制。
 */
const openultronConfig = require('../../openultron-config')
const hardwareRegistry = require('../../extensions/hardware-registry')

const definition = {
  description: '在用户桌面显示一条系统原生通知（操作系统通知中心/角标弹窗）。用户要求「桌面原生通知」「本机系统通知」「桌面弹窗」时请使用本工具，不要用飞书、浏览器或 webview_control 模拟。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '通知标题，可选，默认「通知」' },
      body: { type: 'string', description: '通知正文，可选' },
      silent: { type: 'boolean', description: '是否静音，可选' }
    },
    required: []
  }
}

async function execute(args, context = {}) {
  const hw = openultronConfig.getHardware && openultronConfig.getHardware()
  if (hw && hw.notify && hw.notify.enabled === false) {
    return { success: false, error: '桌面通知已在配置中关闭（hardware.notify.enabled），请在 openultron.json 中开启' }
  }
  const capability = hardwareRegistry.get('notify')
  if (!capability) {
    return { success: false, error: '桌面通知能力未注册' }
  }
  const methodDef = capability.methods && capability.methods.find(m => m.name === 'show')
  if (!methodDef || typeof methodDef.invoke !== 'function') {
    return { success: false, error: 'notify.show 不可用' }
  }
  const title = args && args.title != null ? String(args.title) : '通知'
  const body = args && args.body != null ? String(args.body) : ''
  try {
    const result = await methodDef.invoke(
      { title: title || '通知', body, silent: !!(args && args.silent) },
      { projectPath: context.projectPath, sessionId: context.sessionId }
    )
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
