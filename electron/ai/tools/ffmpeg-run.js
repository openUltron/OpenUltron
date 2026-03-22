/**
 * 内置 ffmpeg 工具：使用应用打包的 ffmpeg-static 或系统 PATH 中的 ffmpeg 执行转码/处理。
 * 优先用内置二进制，若内置失败可让模型通过 execute_command 安装或调用系统 ffmpeg。
 */
const feishuNotify = require('../feishu-notify')

/** @param {string} preset @param {string} inputPath @param {string} outputPath @returns {string[]|null} */
function argsFromPreset(preset, inputPath, outputPath) {
  const input = String(inputPath || '').trim()
  const output = String(outputPath || '').trim()
  if (!input || !output) return null
  switch (preset) {
    case 'feishu_opus_mono':
      // 与 feishu-notify convertAudioToOpus 一致：飞书语音等场景
      return ['-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', output]
    case 'extract_wav_16k_mono':
      return ['-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]
    case 'copy_remux':
      return ['-y', '-i', input, '-c', 'copy', output]
    default:
      return null
  }
}

const definition = {
  description: `使用内置 ffmpeg 执行任意转码或处理。

**通用**：传 \`args\` 为完整参数数组（不含前面的 \`ffmpeg\` 可执行文件名），等价于命令行 \`ffmpeg ...\`，可表达任意滤镜、映射流、编码参数。

**便捷预设**：设 \`preset\` 为 feishu_opus_mono | extract_wav_16k_mono | copy_remux 时，只需 \`input_path\` 与 \`output_path\`，内部展开为常用参数（飞书语音 opus、16k 单声道 wav、无重编码复制）。

优先使用应用内置 ffmpeg。若报错未检测到 ffmpeg，可改用 execute_command 安装系统 ffmpeg 后重试。`,
  parameters: {
    type: 'object',
    properties: {
      preset: {
        type: 'string',
        enum: ['feishu_opus_mono', 'extract_wav_16k_mono', 'copy_remux'],
        description:
          '可选。与 input_path、output_path 联用，展开为固定参数链；不设 preset 时改用 args 完全自定义'
      },
      input_path: { type: 'string', description: '预设模式：输入媒体文件绝对路径' },
      output_path: { type: 'string', description: '预设模式：输出文件绝对路径' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description:
          '通用模式：ffmpeg 参数列表，例如 ["-y", "-i", "/path/in.mp4", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "/path/out.opus"]。与 preset 二选一（有 preset 时忽略 args）'
      },
      cwd: { type: 'string', description: '可选。工作目录（绝对路径）' },
      timeout: { type: 'number', description: '可选。超时毫秒数，默认 120000' }
    }
  }
}

async function execute(args, context = {}) {
  const { preset, input_path: inputPath, output_path: outputPath, cwd, timeout = 120000 } = args || {}
  let ffmpegArgs = args?.args

  const presetKey = preset != null ? String(preset).trim() : ''
  if (presetKey) {
    const built = argsFromPreset(presetKey, inputPath, outputPath)
    if (!built) {
      return { success: false, error: 'preset 需要同时提供有效的 input_path 与 output_path' }
    }
    ffmpegArgs = built
  }

  if (!Array.isArray(ffmpegArgs) || ffmpegArgs.length === 0) {
    return {
      success: false,
      error: '请提供 args（通用模式）或 preset + input_path + output_path（预设模式）'
    }
  }

  const options = {
    timeout: Math.max(5000, Math.min(600000, Number(timeout) || 120000)),
    maxBuffer: 8 * 1024 * 1024
  }
  if (cwd && String(cwd).trim()) options.cwd = String(cwd).trim()

  try {
    const { stdout, stderr } = await feishuNotify.execFfmpegWithFallback(ffmpegArgs, options)
    return {
      success: true,
      stdout: (stdout || '').trim().slice(-2000),
      stderr: (stderr || '').trim().slice(-2000),
      message: 'ffmpeg 执行完成。若未检测到内置 ffmpeg 或需系统版本，可用 execute_command 安装或调用系统 ffmpeg。'
    }
  } catch (e) {
    const stderrTail = String(e?.stderr || e?.message || '').trim().slice(-500)
    const notFound = /not found|enoent|no such file/i.test(stderrTail) || e.code === 'ENOENT'
    return {
      success: false,
      error: notFound
        ? '未检测到 ffmpeg。可改用 execute_command 安装系统 ffmpeg（如 macOS: brew install ffmpeg）后重试。'
        : `ffmpeg 执行失败: ${stderrTail || e.message || String(e)}`
    }
  }
}

module.exports = { definition, execute }
