// 工具：向飞书会话发送消息（文本 / 图片 / 文件 / 富文本 / 语音 / 图文）
const fs = require('fs')
const path = require('path')
const feishuNotify = require('../feishu-notify')
const { logger: appLogger } = require('../../app-logger')
const artifactRegistry = require('../artifact-registry')

const definition = {
  description: `向飞书群或会话发送消息。当用户在飞书内与机器人对话时，不传 chat_id 会自动发往当前会话。

【发文本】传 text。含 **粗体**、\`代码\`、\`[链](url)\`、标题(#)、列表(-) 时，服务端会自动用飞书 **post 富文本** 发送以便客户端渲染；若必须纯文本（不转义）可传 text_format=plain。
【发图片】二选一：1) image_key（已上传得到的 key）；2) image_base64 + image_filename（如 image.png），会自动上传后发送。限制：单张 <10MB，GIF≤2000×2000，其他≤12000×12000；格式仅支持 JPG/PNG/GIF/WEBP/BMP。
【发文件】二选一：1) file_key（已上传得到的 key）；2) file_path（本地绝对路径），会自动上传后发送。限制：<30MB。
【发语音】飞书仅支持 opus 格式，三种方式任选：1) audio_text：传入要读的文字，自动 TTS 成 opus 发送（推荐）；2) audio_file_path：本地 .opus 文件路径；3) audio_file_key：已上传的 opus 的 file_key。音色用 audio_voice（如 zh-CN-XiaoyiNeural 或配置的别名），可选 audio_duration（秒）。
【发图文/视频】media_file_key 或 media_file_path（mp4），可选 media_image_key 作封面。
【富文本】post_title + post_content（见参数说明）。`,
  parameters: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: '飞书群/会话 ID（可选）。用户在飞书内对话时不传则自动发往当前会话；其他场景可从 sessions_list 查询飞书会话的 feishuChatId 作为 chat_id'
      },
      text: {
        type: 'string',
        description: '发送纯文本时必填。含常见 Markdown 片段时会自动以飞书 post 富文本发送以便加粗/链接等渲染'
      },
      text_format: {
        type: 'string',
        enum: ['auto', 'plain'],
        description: '可选。auto（默认）：自动识别 Markdown 并尽量发 post；plain：强制纯 text 消息（不渲染 ** 等）'
      },
      image_key: {
        type: 'string',
        description: '发送图片时：飞书图片 image_key（若已有）。与 image_base64 二选一'
      },
      image_base64: {
        type: 'string',
        description: '发送图片时：图片 base64 字符串，将自动上传后发送。与 image_key 二选一'
      },
      image_filename: {
        type: 'string',
        description: '使用 image_base64 时的文件名，用于识别格式，如 image.png'
      },
      file_key: {
        type: 'string',
        description: '发送文件时：飞书文件 file_key（若已通过上传接口获得）。与 file_path 二选一'
      },
      file_name: {
        type: 'string',
        description: '发送文件时：显示的文件名，与 file_key 搭配使用；使用 file_path 时可省略（自动取文件名）'
      },
      file_path: {
        type: 'string',
        description: '发送文件时：本地文件路径，将先上传再发送；与 file_key 二选一'
      },
      post_title: {
        type: 'string',
        description: '发送富文本时的标题（post 格式）'
      },
      post_content: {
        type: 'array',
        description: '富文本内容。每项为一段，段内为元素数组。元素：{ tag: "text", text: "..." } 或 { tag: "a", href: "url", text: "链接文字" }。例：[ [{ tag: "text", text: "第一段" }], [{ tag: "a", href: "https://example.com", text: "链接" }] ]',
        items: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' }, text: { type: 'string' }, href: { type: 'string' } } } }
      },
      audio_file_key: {
        type: 'string',
        description: '发送语音：已上传好的语音 file_key（opus）'
      },
      audio_file_name: {
        type: 'string',
        description: '发送语音：文件名（使用 audio_file_path 或 audio_text 时可选）'
      },
      audio_file_path: {
        type: 'string',
        description: '发送语音：本地语音文件路径（建议 .opus）'
      },
      audio_duration: {
        type: 'number',
        description: '发送语音：可选时长（秒）'
      },
      audio_text: {
        type: 'string',
        description: '发送语音：待合成文本。传入后会使用 node-edge-tts 生成 mp3，再转 opus 上传发送；未传 audio_voice 时自动使用默认音色（若已配置）'
      },
      audio_voice: {
        type: 'string',
        description: '发送语音：TTS 音色，可传真实 shortName（如 zh-CN-XiaoyiNeural）或已配置别名（如 女声）'
      },
      audio_lang: {
        type: 'string',
        description: '发送语音：TTS 语言（如 zh-CN）'
      },
      audio_rate: {
        type: 'string',
        description: '发送语音：语速（如 +10% / -10% / default）'
      },
      audio_volume: {
        type: 'string',
        description: '发送语音：音量（如 +10% / -10% / default）'
      },
      audio_pitch: {
        type: 'string',
        description: '发送语音：音调（如 +0Hz / -50Hz / default）'
      },
      media_file_key: {
        type: 'string',
        description: '发送图文（media）：媒体文件 file_key（通常为 mp4）'
      },
      media_file_name: {
        type: 'string',
        description: '发送图文（media）：媒体文件名'
      },
      media_file_path: {
        type: 'string',
        description: '发送图文（media）：本地媒体文件路径（会自动上传）'
      },
      media_image_key: {
        type: 'string',
        description: '发送图文（media）：封面图 image_key（可选）'
      }
    },
    required: []
  }
}

function buildPostPayload(title, content) {
  if (!content || !Array.isArray(content)) {
    return { zh_cn: { title: title || '通知', content: [[{ tag: 'text', text: '无内容' }]] } }
  }
  const paragraphs = content.map((para) => {
    if (!Array.isArray(para)) return [{ tag: 'text', text: String(para) }]
    return para.map((el) => {
      if (el && el.tag === 'a') {
        return { tag: 'a', href: el.href || '', text: el.text || '' }
      }
      return { tag: 'text', text: el && el.text != null ? String(el.text) : String(el) }
    })
  })
  return { zh_cn: { title: title || '通知', content: paragraphs } }
}

function isImageExt(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
}

async function execute(args, context = {}) {
  const {
    chat_id, text, text_format, image_key, image_base64, image_filename, file_key, file_name, file_path, post_title, post_content,
    audio_file_key, audio_file_name, audio_file_path, audio_duration, audio_text, audio_voice, audio_lang, audio_rate, audio_volume, audio_pitch,
    media_file_key, media_file_name, media_file_path, media_image_key
  } = args || {}

  const opts = { chat_id: chat_id && chat_id.trim() ? chat_id.trim() : undefined }
  if (!opts.chat_id && context && context.feishuChatId) {
    const fallbackChatId = String(context.feishuChatId || '').trim()
    if (fallbackChatId) opts.chat_id = fallbackChatId
  }
  // 容错：截图场景中模型偶发把图片路径填到 file_path；这里自动转为 image_base64，避免飞书 file 模式参数报错
  const normalizedFilePath = file_path && String(file_path).trim() ? String(file_path).trim() : ''
  if (!image_key && !image_base64 && normalizedFilePath && isImageExt(normalizedFilePath) && fs.existsSync(normalizedFilePath)) {
    try {
      const buf = fs.readFileSync(normalizedFilePath)
      if (buf && buf.length > 0) {
        const inferredName = (file_name && String(file_name).trim()) || path.basename(normalizedFilePath) || 'image.png'
        args = {
          ...(args || {}),
          image_base64: buf.toString('base64'),
          image_filename: inferredName,
          file_path: undefined,
          file_name: undefined
        }
      }
    } catch (e) {
      appLogger?.warn?.('[FeishuTool] 图片路径自动转 image_base64 失败', {
        path: normalizedFilePath,
        error: e.message || String(e)
      })
    }
  }
  const normalizedImageBase64 = (args && typeof args.image_base64 === 'string' && args.image_base64.length > 0)
    ? args.image_base64
    : image_base64
  const normalizedImageFilename = (args && typeof args.image_filename === 'string' && args.image_filename.length > 0)
    ? args.image_filename
    : image_filename
  const normalizedFilePath2 = (args && typeof args.file_path === 'string' && args.file_path.trim())
    ? String(args.file_path).trim()
    : normalizedFilePath

  let mode = 'text'
  if (post_title != null || (post_content && post_content.length > 0)) mode = 'post'
  else if (audio_file_key || audio_file_path || audio_text) mode = 'audio'
  else if (media_file_key || media_file_path) mode = 'media'
  else if (image_key || normalizedImageBase64) mode = 'image'
  else if (file_key || normalizedFilePath2) mode = 'file'

  if (post_title != null || (post_content && post_content.length > 0)) {
    opts.post = buildPostPayload(post_title, post_content)
  } else if (audio_file_key || audio_file_path || audio_text) {
    opts.audio_file_key = audio_file_key && audio_file_key.trim() ? audio_file_key.trim() : undefined
    opts.audio_file_name = audio_file_name && audio_file_name.trim() ? audio_file_name.trim() : undefined
    opts.audio_file_path = audio_file_path && audio_file_path.trim() ? audio_file_path.trim() : undefined
    opts.audio_duration = Number.isFinite(Number(audio_duration)) ? Number(audio_duration) : undefined
    opts.audio_text = audio_text != null ? String(audio_text) : undefined
    opts.audio_voice = audio_voice && audio_voice.trim() ? audio_voice.trim() : undefined
    opts.audio_lang = audio_lang && audio_lang.trim() ? audio_lang.trim() : undefined
    opts.audio_rate = audio_rate && audio_rate.trim() ? audio_rate.trim() : undefined
    opts.audio_volume = audio_volume && audio_volume.trim() ? audio_volume.trim() : undefined
    opts.audio_pitch = audio_pitch && audio_pitch.trim() ? audio_pitch.trim() : undefined
  } else if (media_file_key || media_file_path) {
    opts.media_file_key = media_file_key && media_file_key.trim() ? media_file_key.trim() : undefined
    opts.media_file_name = media_file_name && media_file_name.trim() ? media_file_name.trim() : undefined
    opts.media_file_path = media_file_path && media_file_path.trim() ? media_file_path.trim() : undefined
    opts.media_image_key = media_image_key && media_image_key.trim() ? media_image_key.trim() : undefined
  } else if (image_key || normalizedImageBase64) {
    opts.image_key = image_key && image_key.trim() ? image_key.trim() : undefined
    opts.image_base64 = normalizedImageBase64 || undefined
    opts.image_filename = normalizedImageFilename || 'image.png'
  } else if (file_key || normalizedFilePath2) {
    opts.file_key = file_key && file_key.trim() ? file_key.trim() : undefined
    opts.file_name = file_name && file_name.trim() ? file_name.trim() : undefined
    opts.file_path = normalizedFilePath2 || undefined
  } else if (text != null) {
    opts.text = String(text)
    if (text_format === 'plain') opts.force_plain_text = true
  }

  const hasAnyPayload = !!(
    (opts.text && String(opts.text).trim()) ||
    opts.post ||
    opts.image_key ||
    opts.image_base64 ||
    opts.file_key ||
    opts.file_path ||
    opts.media_file_key ||
    opts.media_file_path ||
    opts.audio_file_key ||
    opts.audio_file_path ||
    opts.audio_text
  )
  if (!hasAnyPayload) {
    const fatalErr = new Error('feishu_send_message 缺少消息内容：请提供 text / post / image_* / file_* / audio_* / media_* 之一（不可重试）')
    fatalErr.code = 'FEISHU_NON_RETRYABLE'
    fatalErr.nonRetryable = true
    throw fatalErr
  }

  appLogger?.info?.('[FeishuTool] feishu_send_message 调用', {
    mode,
    chat_id: opts.chat_id || '',
    has_text: typeof opts.text === 'string' && opts.text.length > 0,
    text_len: typeof opts.text === 'string' ? opts.text.length : 0,
    text_preview: typeof opts.text === 'string' ? opts.text.slice(0, 160) : '',
    has_image_key: !!opts.image_key,
    has_image_base64: !!opts.image_base64,
    has_file_key: !!opts.file_key,
    has_file_path: !!opts.file_path,
    has_audio: !!(opts.audio_file_key || opts.audio_file_path || opts.audio_text),
    has_media: !!(opts.media_file_key || opts.media_file_path)
  })

  const contextSessionId = String((context && context.sessionId) || '').trim()
  const contextRunSessionId = String((context && context.runSessionId) || '').trim()
  const artifactIds = []
  try {
    if (opts.image_base64 && typeof opts.image_base64 === 'string') {
      const m = opts.image_base64.match(/^data:[^;,]+;base64,(.*)$/i)
      const raw = (m ? m[1] : opts.image_base64).replace(/\s+/g, '')
      const ext = path.extname(String(opts.image_filename || '')).toLowerCase() || '.png'
      const rec = artifactRegistry.registerBase64Artifact({
        base64: raw,
        ext,
        kind: 'image',
        source: 'feishu_tool',
        channel: 'feishu',
        sessionId: contextSessionId,
        runSessionId: contextRunSessionId,
        messageId: '',
        chatId: String(opts.chat_id || ''),
        role: 'assistant'
      })
      if (rec && rec.artifactId) artifactIds.push(rec.artifactId)
    }
    const registerPath = (p, kindHint = 'file') => {
      const full = String(p || '').trim()
      if (!full) return
      const rec = artifactRegistry.registerFileArtifact({
        path: full,
        kind: kindHint,
        source: 'feishu_tool',
        channel: 'feishu',
        sessionId: contextSessionId,
        runSessionId: contextRunSessionId,
        messageId: '',
        chatId: String(opts.chat_id || ''),
        role: 'assistant'
      })
      if (rec && rec.artifactId) artifactIds.push(rec.artifactId)
    }
    if (opts.file_path) registerPath(opts.file_path, 'file')
    if (opts.audio_file_path) registerPath(opts.audio_file_path, 'audio')
    if (opts.media_file_path) registerPath(opts.media_file_path, 'video')
  } catch (e) {
    appLogger?.warn?.('[FeishuTool] 产物入库失败', { error: e.message || String(e) })
  }

  appLogger?.info?.('[FeishuTool] feishu_send_message 产物', {
    sessionId: contextSessionId,
    artifactCount: artifactIds.length,
    artifactIds: artifactIds.slice(0, 20)
  })

  const result = await feishuNotify.sendMessage(opts)
  appLogger?.info?.('[FeishuTool] feishu_send_message 返回', {
    success: !!(result && result.success),
    message: result && result.message ? String(result.message).slice(0, 160) : '',
    message_id: result && result.message_id ? result.message_id : ''
  })
  const resultMessage = String((result && result.message) || '')
  const noChatId = !opts.chat_id || !String(opts.chat_id).trim()
  const invalidReceiveId = /invalid\s+receive_id/i.test(resultMessage)
  const missingReceiveId = /请提供\s*chat_id\/receive_id/i.test(resultMessage)
  const missingPayload = /请提供\s*text、image_key\/image_base64、file_key\/file_path、post、audio_\*\s*或\s*media_\*\s*之一/.test(resultMessage)
  if (result && result.success === false && (noChatId || invalidReceiveId || missingReceiveId || missingPayload)) {
    const fatalErr = new Error(resultMessage || 'feishu_send_message 参数无效（不可重试）')
    fatalErr.code = 'FEISHU_NON_RETRYABLE'
    fatalErr.nonRetryable = true
    throw fatalErr
  }
  try {
    if (result && result.success && contextSessionId && result.message_id && artifactIds.length > 0) {
      artifactRegistry.bindArtifactsToMessage({
        sessionId: contextSessionId,
        messageId: String(result.message_id),
        role: 'assistant',
        artifactIds
      })
    }
  } catch (e) {
    appLogger?.warn?.('[FeishuTool] 产物绑定消息失败', { error: e.message || String(e) })
  }
  return result
}

module.exports = { definition, execute }
