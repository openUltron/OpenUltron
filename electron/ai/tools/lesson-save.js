// 工具：将经验教训写入 LESSONS_LEARNED.md（自进化专用，替代用 file_operation 写该文件）
const { appendLesson } = require('../memory-store')
const { logger: appLogger } = require('../../app-logger')

const definition = {
  description: '将一条经验教训写入知识库 LESSONS_LEARNED.md。用于自进化或对话后反思：记录失败原因与正确做法、成功模式、可复用规律。每条会按日期与类别自动排版追加。知识库会在每次对话开始时自动注入给 AI，因此写详细才能被后续直接利用。',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '教训内容，须写详细便于下次直接套用：① 具体场景/问题（在什么任务下遇到）② 失败原因或成功做法 ③ 可复用的具体命令、路径、步骤或格式（尽量可直接复制执行）。单条建议 80～400 字，避免仅一句话概括。'
      },
      category: {
        type: 'string',
        description: '分类（如：通用、git、部署、调试、飞书、MCP、命令、路径），不填则用「通用」'
      }
    },
    required: ['content']
  }
}

async function execute(args, ctx = {}) {
  const { content, category } = args
  if (!content?.trim()) return { success: false, error: '缺少 content 参数' }
  try {
    const cat = category && String(category).trim() ? String(category).trim() : '通用'
    appendLesson(content.trim(), cat)
    try {
      appLogger?.info?.('[AI][Memory] lesson_save', {
        runId: String(ctx.runId || '').slice(0, 48),
        channel: ctx.channel || 'main',
        category: cat,
        contentLen: content.trim().length
      })
    } catch (_) { /* ignore */ }
    return { success: true, message: '已写入知识库' }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

module.exports = { definition, execute }
