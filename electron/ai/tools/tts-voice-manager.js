// 工具：管理内置 TTS 音色（查询全量音色、别名、默认音色）
const feishuNotify = require('../feishu-notify')

const definition = {
  description: '管理内置 TTS 音色：可查询 Edge 全量音色列表、设置/删除音色别名、设置默认音色。供 AI 在语音回复前选择并记忆用户偏好音色。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list_voices', 'list_aliases', 'set_alias', 'remove_alias', 'set_default', 'get_default', 'resolve_voice'],
        description: 'list_voices: 列出可用音色；list_aliases: 列出别名；set_alias/remove_alias: 管理别名；set_default/get_default: 管理默认音色；resolve_voice: 解析别名为真实音色'
      },
      locale: {
        type: 'string',
        description: 'list_voices 可选：按语言过滤，如 zh-CN、en-US'
      },
      force_refresh: {
        type: 'boolean',
        description: 'list_voices 可选：true 时强制联网刷新音色列表'
      },
      alias: {
        type: 'string',
        description: 'set_alias/remove_alias 时必填：别名（如 女声、客服女声、男声）'
      },
      voice: {
        type: 'string',
        description: 'set_alias 时必填：真实音色 shortName（如 zh-CN-XiaoyiNeural）'
      },
      voice_or_alias: {
        type: 'string',
        description: 'set_default/resolve_voice 时必填：真实音色或别名'
      }
    },
    required: ['action']
  }
}

async function execute(args = {}) {
  const action = String(args.action || '').trim()

  if (action === 'list_voices') {
    try {
      const voices = await feishuNotify.listEdgeTtsVoices({
        locale: args.locale,
        forceRefresh: !!args.force_refresh
      })
      return { success: true, count: voices.length, voices }
    } catch (e) {
      return { success: false, message: e.message || '读取音色列表失败', voices: [] }
    }
  }

  if (action === 'list_aliases') {
    const aliases = feishuNotify.getTtsAliasMap()
    return { success: true, aliases, count: Object.keys(aliases).length }
  }

  if (action === 'set_alias') {
    const alias = args.alias
    const voice = args.voice
    if (!alias || !voice) return { success: false, message: 'set_alias 需要 alias 和 voice' }
    try {
      const data = await feishuNotify.setTtsVoiceAlias(alias, voice)
      return { success: true, ...data, message: `已设置音色别名 ${data.alias} -> ${data.voice}` }
    } catch (e) {
      return { success: false, message: e.message || '设置别名失败' }
    }
  }

  if (action === 'remove_alias') {
    const alias = args.alias
    if (!alias) return { success: false, message: 'remove_alias 需要 alias' }
    try {
      const data = await feishuNotify.removeTtsVoiceAlias(alias)
      return { success: true, ...data, message: `已删除音色别名 ${data.alias}` }
    } catch (e) {
      return { success: false, message: e.message || '删除别名失败' }
    }
  }

  if (action === 'set_default') {
    const value = args.voice_or_alias
    if (!value) return { success: false, message: 'set_default 需要 voice_or_alias' }
    try {
      const data = await feishuNotify.setTtsDefaultVoice(value)
      return { success: true, ...data, message: `默认音色已设置为 ${data.defaultVoice}（解析后 ${data.resolvedVoice}）` }
    } catch (e) {
      return { success: false, message: e.message || '设置默认音色失败' }
    }
  }

  if (action === 'get_default') {
    const defaultVoice = feishuNotify.getTtsDefaultVoice()
    const resolvedVoice = feishuNotify.resolveTtsVoice(defaultVoice)
    return { success: true, defaultVoice, resolvedVoice }
  }

  if (action === 'resolve_voice') {
    const value = args.voice_or_alias
    if (!value) return { success: false, message: 'resolve_voice 需要 voice_or_alias' }
    const resolvedVoice = feishuNotify.resolveTtsVoice(value)
    return { success: true, input: String(value), resolvedVoice }
  }

  return { success: false, message: `未知 action: ${action}` }
}

module.exports = { definition, execute }

