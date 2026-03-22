/**
 * 扣子生成 commit message：从结构化 diff 文本提取变更摘要并拼 prompt（可单测）。
 */

const COZE_API_URL = 'https://api.coze.cn'

/**
 * @param {string} diffContent
 * @returns {{ type: string, path: string, changes: string[] }[]}
 */
function extractFileChanges (diffContent) {
  const files = []
  const sections = String(diffContent || '').split(/\n(?=\[(新增文件|修改文件|文件)\])/)

  for (const section of sections) {
    if (!section.trim()) continue

    const headerMatch = section.match(/^\[(新增文件|修改文件|文件)\]\s*(.+?)(?:\s*\(|:|\s*$)/m)
    if (!headerMatch) continue

    const fileType = headerMatch[1]
    const filePath = headerMatch[2].trim()

    const lines = section.split('\n')
    const keyChanges = []

    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) continue

      if (line.startsWith('+') || line.startsWith('-')) {
        const isAdd = line.startsWith('+')
        const content = line.substring(1).trim()
        if (content &&
            content.length > 2 &&
            !content.match(/^[{}\[\]();,'"` ]+$/)) {
          const prefix = isAdd ? '+' : '-'
          keyChanges.push(prefix + content.substring(0, 200))
          if (keyChanges.length >= 50) break
        }
      }
    }

    files.push({
      type: fileType,
      path: filePath,
      changes: keyChanges
    })
  }

  return files
}

/**
 * @param {string} diff
 * @returns {string} user prompt for Coze chat
 */
function buildCozeCommitPrompt (diff) {
  const fileChanges = extractFileChanges(diff)
  let changeSummary = ''
  for (const file of fileChanges) {
    changeSummary += `\n文件: ${file.path} [${file.type}]\n`
    if (file.changes.length > 0) {
      changeSummary += '关键变更:\n'
      for (const change of file.changes) {
        changeSummary += `  - ${change}\n`
      }
    }
  }

  // 与 main 原 buildCommitMessagePrompt 一致：无法解析结构化 diff 时截取原始片段
  if (!changeSummary.trim() && String(diff || '').trim()) {
    changeSummary = '\n代码变更:\n' + String(diff).substring(0, 3000)
  }

  return `你是一个资深开发者，请根据代码变更生成专业简洁的 commit message。
${changeSummary}
要求：
1. 理解变更的本质意图，不要描述表面操作
2. 用专业术语，简洁有力，像资深开发者写的
3. 禁止输出 type 前缀（禁止 feat: fix: chore: 等）
4. 不超过50字，只输出一行
5. 禁止使用"修改xxx文件"、"将xxx改为xxx"这种表面描述

示例（好）：
- 切换到测试环境
- 添加用户认证拦截器
- 修复分页越界问题
- 重构订单状态机

示例（差，禁止）：
- 修改Env.ets文件将cur值改为Testing
- 在utils.js中添加了一个新函数`
}

module.exports = {
  COZE_API_URL,
  extractFileChanges,
  buildCozeCommitPrompt
}
