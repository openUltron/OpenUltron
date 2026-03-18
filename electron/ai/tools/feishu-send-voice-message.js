// 工具：专用发送飞书「语音消息」（自动转 OPUS、上传、发送）
const path = require('path')
const fs = require('fs')
const feishuNotify = require('../feishu-notify')
const { logger: appLogger } = require('../../app-logger')
const artifactRegistry = require('../artifact-registry')

const definition = {
  description: `发送飞书「语音消息」（不是文件）。

你可以用两种方式之一发送：
- audio_text：输入要朗读的文字（推荐）。会自动 TTS 并转 OPUS 后发送。
- audio_file_path：本地音频路径（支持 mp3/wav/m4a/aiff/opus 等），会自动转 OPUS 后发送。

可选：audio_voice（音色 shortName 或别名），audio_duration（秒）。
注意：此工具只用于「语音消息」，不要用来发送 mp3 文件。`,
  parameters: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: '飞书会话 chat_id（可选；在飞书会话中不传会自动发往当前会话）' },
      audio_text: { type: 'string', description: '要合成并发送的文本（推荐）' },
      audio_file_path: { type: 'string', description: '本地音频文件绝对路径（将自动转 OPUS 后发送语音消息）' },
      audio_file_name: { type: 'string', description: '语音文件名（可选）' },
      audio_voice: { type: 'string', description: 'TTS 音色（可选；如 zh-CN-XiaoxiaoNeural 或别名）' },
      audio_duration: { type: 'number', description: '可选时长（秒）' },
      audio_lang: { type: 'string', description: 'TTS 语言（可选，如 zh-CN）' },
      audio_rate: { type: 'string', description: 'TTS 语速（可选，如 +10%）' },
      audio_volume: { type: 'string', description: 'TTS 音量（可选，如 +10%）' },
      audio_pitch: { type: 'string', description: 'TTS 音调（可选，如 -50Hz）' }
    },
    required: []
  }
}

async function execute(args = {}, context = {}) {
  const chatId = String(args.chat_id || '').trim() || String(context?.feishuChatId || '').trim()
  const audioText = args.audio_text != null ? String(args.audio_text) : ''
  const audioPath = args.audio_file_path != null ? String(args.audio_file_path).trim() : ''
  const audioName = args.audio_file_name != null ? String(args.audio_file_name).trim() : ''

  if (!audioText.trim() && !audioPath) {
    return { success: false, message: '请提供 audio_text 或 audio_file_path 之一' }
  }
  if (audioPath && (!path.isAbsolute(audioPath) || !fs.existsSync(audioPath))) {
    return { success: false, message: `audio_file_path 不存在或非绝对路径：${audioPath}` }
  }

  appLogger?.info?.('[FeishuVoiceTool] feishu_send_voice_message 调用', {
    has_chat_id: !!chatId,
    has_audio_text: !!audioText.trim(),
    has_audio_file_path: !!audioPath,
    file_ext: audioPath ? path.extname(audioPath).toLowerCase() : ''
  })

  const res = await feishuNotify.sendMessage({
    chat_id: chatId || undefined,
    audio_text: audioText && audioText.trim() ? audioText : undefined,
    audio_file_path: audioPath || undefined,
    audio_file_name: audioName || (audioPath ? path.basename(audioPath) : undefined),
    audio_voice: args.audio_voice && String(args.audio_voice).trim() ? String(args.audio_voice).trim() : undefined,
    audio_duration: Number.isFinite(Number(args.audio_duration)) ? Number(args.audio_duration) : undefined,
    audio_lang: args.audio_lang && String(args.audio_lang).trim() ? String(args.audio_lang).trim() : undefined,
    audio_rate: args.audio_rate && String(args.audio_rate).trim() ? String(args.audio_rate).trim() : undefined,
    audio_volume: args.audio_volume && String(args.audio_volume).trim() ? String(args.audio_volume).trim() : undefined,
    audio_pitch: args.audio_pitch && String(args.audio_pitch).trim() ? String(args.audio_pitch).trim() : undefined
  })

  if (res?.success) {
    // 产物入库：若是文件路径则记录为 audio，便于后续追踪。
    try {
      if (audioPath) {
        await artifactRegistry.registerFile({
          kind: 'audio',
          source: 'feishu_tool',
          sessionId: context?.sessionId || '',
          messageId: '',
          path: audioPath
        })
      }
    } catch (_) {}
  }

  return {
    success: !!res?.success,
    message: res?.success ? '语音消息发送成功' : (res?.message || '语音消息发送失败'),
    message_id: res?.message_id || ''
  }
}

module.exports = { definition, execute }

