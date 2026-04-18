// 工具：内置 Edge TTS，将文本合成为语音文件（mp3），供后续发送或使用
const path = require('path')
const fs = require('fs')
const feishuNotify = require('../feishu-notify')
const { logger: appLogger } = require('../../app-logger')
const { getWorkspaceRoot } = require('../../app-root')

const definition = {
  description: `使用内置 Edge TTS（node-edge-tts）将文本合成为音频文件。

**通用能力**：与 Edge 在线 TTS 一致的参数——output_format（码率/封装）、pitch、rate、volume、timeout；可选 save_subtitles、proxy。音色可用 tts_voice_manager(list_voices) 或传 shortName / 别名。

**便捷默认**：不传 output_format 时为 24kHz 48kbps 单声道 mp3。生成路径可传给 feishu_send_voice_message(audio_file_path)。

**使用建议**：
- 在主会话里，用户说“生成语音 / 生成播报 / 生成 mp3 / 语音介绍”时，优先使用本工具，生成本地可播放音频。
- 只有当用户明确要“发送到飞书”，且当前是飞书会话或已提供 chat_id 时，才使用 feishu_send_voice_message。

不要使用系统 CLI「edge-tts」，请用本工具。`,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要合成的文本' },
      voice: {
        type: 'string',
        description: '音色 shortName（如 zh-CN-XiaoxiaoNeural）或 tts_voice_manager 配置的别名（如 女声）'
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（可选）。不传则生成到工作空间 audio 目录，文件名自动生成（默认 .mp3）'
      },
      lang: { type: 'string', description: 'BCP-47 语言代码（可选，默认 zh-CN）' },
      output_format: {
        type: 'string',
        description:
          'Edge 输出格式 id（可选）。示例：audio-24khz-48kbitrate-mono-mp3（默认）、audio-24khz-96kbitrate-mono-mp3。更多见微软 Edge TTS 格式列表。'
      },
      pitch: {
        type: 'string',
        description: '音高（可选）。default 或如 +10Hz、-5Hz（与 node-edge-tts / Edge 一致）'
      },
      rate: {
        type: 'string',
        description: '语速（可选）。default 或如 +20%、-10%'
      },
      volume: {
        type: 'string',
        description: '音量（可选）。default 或如 +10%、-5%'
      },
      timeout: {
        type: 'number',
        description: '单次合成超时毫秒（可选，默认 20000）'
      },
      save_subtitles: {
        type: 'boolean',
        description: '为 true 时尝试生成字幕文件（由 node-edge-tts 写入，与音频同目录）'
      },
      proxy: {
        type: 'string',
        description: 'HTTPS 代理 URL（可选），需访问 Edge TTS 服务时使用'
      }
    },
    required: ['text']
  }
}

function makeOutputPath(customPath, defaultDir) {
  if (customPath && path.isAbsolute(customPath)) return customPath
  const dir = defaultDir || path.join(getWorkspaceRoot(), 'audio')
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  } catch (_) {}
  const base = `tts_${Date.now()}.mp3`
  return path.join(dir, base)
}

async function execute(args = {}, context = {}) {
  const text = args.text != null ? String(args.text).trim() : ''
  if (!text) return { success: false, message: 'text 不能为空' }

  const voice = args.voice != null ? String(args.voice).trim() : undefined
  const lang = args.lang != null ? String(args.lang).trim() : undefined
  const outputFormat =
    args.output_format != null && String(args.output_format).trim()
      ? String(args.output_format).trim()
      : undefined
  const pitch = args.pitch != null && String(args.pitch).trim() ? String(args.pitch).trim() : undefined
  const rate = args.rate != null && String(args.rate).trim() ? String(args.rate).trim() : undefined
  const volume = args.volume != null && String(args.volume).trim() ? String(args.volume).trim() : undefined
  const timeout = args.timeout != null ? Number(args.timeout) : undefined
  const saveSubtitles = args.save_subtitles === true
  const proxy = args.proxy != null && String(args.proxy).trim() ? String(args.proxy).trim() : undefined
  const defaultDir = path.join(getWorkspaceRoot(), 'audio')
  const outputPath = makeOutputPath(args.output_path, defaultDir)

  appLogger?.info?.('[EdgeTtsTool] edge_tts_synthesize 调用', {
    text_len: text.length,
    voice: voice || '(默认)',
    output_path: outputPath,
    output_format: outputFormat || '(默认)',
    has_proxy: Boolean(proxy)
  })

  try {
    await feishuNotify.synthesizeEdgeTtsToMp3(text, outputPath, {
      voice: voice ? feishuNotify.resolveTtsVoice(voice) || voice : undefined,
      lang: lang || 'zh-CN',
      outputFormat,
      pitch,
      rate,
      volume,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      saveSubtitles,
      proxy
    })
  } catch (e) {
    appLogger?.warn?.('[EdgeTtsTool] 合成失败', { error: e?.message })
    return { success: false, message: e?.message || 'TTS 合成失败', output_path: '' }
  }

  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0
  return {
    success: true,
    message: '语音合成成功',
    output_path: outputPath,
    file_path: outputPath,
    file_name: path.basename(outputPath),
    kind: 'audio',
    bytes: size
  }
}

module.exports = { definition, execute }
