// 工具：读取 OpenUltron 主进程统一日志尾部，供排查应用自身问题（与设置 → 日志同源）
const { getForAi, getLogPath } = require('../../app-logger')

const definition = {
  description:
    '读取本应用写入 ~/.openultron/logs/app.log 的最近日志（主进程与各模块的 logger、以及 console.warn/error）。用户反馈崩溃、Gateway/飞书/渠道异常、工具失败时优先调用本工具定位；可与 query_command_log（命令执行记录）配合。可选 keyword 仅保留含关键词的行以缩小范围。',
  parameters: {
    type: 'object',
    properties: {
      lines: {
        type: 'number',
        description: '从文件末尾取的物理行数上限，默认 800，最小 100，最大 8000'
      },
      keyword: {
        type: 'string',
        description: '可选；忽略大小写，仅返回包含该子串的行（先按 lines 取尾部再过滤）。无匹配时会提示放宽条件。'
      }
    },
    required: []
  }
}

async function execute(args) {
  try {
    const raw = args && typeof args.lines === 'number' ? args.lines : 800
    const lines = Math.min(8000, Math.max(100, Math.floor(raw) || 800))
    const keyword = args && args.keyword != null ? String(args.keyword).trim() : ''
    const text = getForAi(lines, keyword ? { keyword } : undefined)
    const logPath = getLogPath()
    const approxLines = text.split('\n').length
    return {
      success: true,
      logPath,
      approxLines,
      text
    }
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
}

module.exports = { definition, execute }
