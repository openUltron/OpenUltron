/**
 * 将 LESSONS_LEARNED.md 经 LLM 合并去重后写回；执行前备份到 memory/knowledge/.backups/
 */
const fs = require('fs')
const path = require('path')
const { getLessonsLearnedPath } = require('./memory-store')

const MIN_CHARS_TO_CONSOLIDATE = 500
const INPUT_MAX_CHARS = 120000

async function consolidateLessonsLearned({ getResolvedAIConfig, aiOrchestrator, appLogger } = {}) {
  const p = getLessonsLearnedPath()
  if (!fs.existsSync(p)) {
    return { success: true, skipped: true, reason: 'no_file' }
  }
  const raw = fs.readFileSync(p, 'utf-8')
  if (!raw || String(raw).trim().length < MIN_CHARS_TO_CONSOLIDATE) {
    return { success: true, skipped: true, reason: 'too_short' }
  }
  if (String(raw).length > INPUT_MAX_CHARS) {
    return { success: true, skipped: true, reason: 'too_large_to_rewrite', bytes: String(raw).length }
  }

  const config = typeof getResolvedAIConfig === 'function' ? getResolvedAIConfig() : null
  if (!config?.apiKey?.trim()) {
    return { success: false, error: 'missing_api_key' }
  }
  if (!aiOrchestrator || typeof aiOrchestrator.generateText !== 'function') {
    return { success: false, error: 'orchestrator_unavailable' }
  }

  const backupDir = path.join(path.dirname(p), '.backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const backupPath = path.join(backupDir, `LESSONS_LEARNED-${Date.now()}.md`)
  fs.copyFileSync(p, backupPath)

  const systemPrompt =
    '你是知识库编辑。输入为 LESSONS_LEARNED 风格的 markdown。请输出整理后的完整文件正文（从一级标题开始），要求：合并明显重复或仅表述不同的条目；保留所有互不重复的可执行细节（命令、路径、步骤）；删减赘述；优先保留「### [日期] 分类」风格的小节；禁止丢失独有信息。只输出 markdown，不要用代码块包裹。'
  const prompt = `以下是需要整理的知识库全文：\n\n${raw}`

  const result = await aiOrchestrator.generateText({
    prompt,
    systemPrompt,
    config,
    model: config.defaultModel || 'deepseek-v3'
  })
  let out = typeof result === 'string' ? result.trim() : ''
  out = out.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  if (!out || out.length < 80) {
    return { success: false, error: 'model_output_empty', backupPath }
  }
  fs.writeFileSync(p, out.endsWith('\n') ? out : `${out}\n`, 'utf-8')
  try {
    appLogger?.info?.('[AI] consolidateLessonsLearned done', { backupPath, outLen: out.length })
  } catch (_) {}
  return { success: true, backupPath, bytesWritten: out.length }
}

module.exports = { consolidateLessonsLearned, MIN_CHARS_TO_CONSOLIDATE }
