// 工具：向钉钉发送文本/语音（支持 audio_text 内置 TTS）
const dingtalkNotify = require('../dingtalk-notify')

const definition = {
  description: '向钉钉发送消息。支持 text 文本与语音（audio_file_path 或 audio_text 内置 TTS）。优先使用 session_webhook（文本）；语音发送需 open_conversation_id + robot_code。',
  parameters: {
    type: 'object',
    properties: {
      session_webhook: {
        type: 'string',
        description: '会话 webhook（可选，文本发送优先使用）'
      },
      open_conversation_id: {
        type: 'string',
        description: '开放会话 ID（发送文本/语音均可用）'
      },
      robot_code: {
        type: 'string',
        description: '机器人 robotCode（发送文本/语音需要）'
      },
      chat_id: {
        type: 'string',
        description: '兼容字段：等价 open_conversation_id'
      },
      text: {
        type: 'string',
        description: '发送文本'
      },
      audio_file_path: {
        type: 'string',
        description: '发送语音：本地语音文件路径（建议 ogg/opus）'
      },
      audio_text: {
        type: 'string',
        description: '发送语音：待合成文本（内置 TTS）'
      },
      audio_voice: {
        type: 'string',
        description: 'TTS 音色 shortName 或别名（可选）'
      },
      audio_lang: {
        type: 'string',
        description: 'TTS 语言（可选，如 zh-CN）'
      },
      audio_rate: {
        type: 'string',
        description: 'TTS 语速（可选，如 +10%）'
      },
      audio_volume: {
        type: 'string',
        description: 'TTS 音量（可选，如 +10%）'
      },
      audio_pitch: {
        type: 'string',
        description: 'TTS 音调（可选，如 -50Hz）'
      }
    },
    required: []
  }
}

async function execute(args = {}) {
  return dingtalkNotify.sendMessage(args)
}

module.exports = { definition, execute }
