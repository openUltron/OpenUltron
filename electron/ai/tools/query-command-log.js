// 工具：查询命令执行日志（按命令聚合的目录/文件、成功失败统计），供 AI 后续进化时参考
const commandExecutionLog = require('../command-execution-log')

const definition = {
  description: '查询当前项目下已执行过的命令聚合结果：查看过哪些目录和文件、成功/失败统计、或最近执行成功的命令列表。用于避免重复查看、避免重复安装（先查再装）、辅助后续操作与进化。',
  parameters: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: '项目路径（可选，不传则用当前会话项目）' },
      query: {
        type: 'string',
        enum: ['viewed_paths', 'summary', 'both', 'recent_successful_commands'],
        description: 'viewed_paths=仅返回查看过的目录与文件；summary=仅返回成功/失败统计；both=路径+统计；recent_successful_commands=返回最近执行成功的命令列表（含 command、cwd），用于判断是否已安装过某依赖、避免重复执行 npm/pip/brew install。默认 both'
      }
    },
    required: []
  }
}

async function execute(args, context = {}) {
  const projectPath = (args && args.projectPath) || context.projectPath || ''
  const query = (args && args.query) || 'both'
  try {
    const viewed = commandExecutionLog.getViewedPaths(projectPath)
    const summary = commandExecutionLog.getExecutionSummary(projectPath)
    if (query === 'viewed_paths') {
      return {
        success: true,
        directories: viewed.directories,
        files: viewed.files,
        summary: viewed.summary
      }
    }
    if (query === 'summary') {
      return { success: true, ...summary }
    }
    if (query === 'recent_successful_commands') {
      const { entries } = commandExecutionLog.getRecentEntries(projectPath, 50)
      const successful = entries.filter((e) => e.success).slice(0, 40)
      return {
        success: true,
        recent_successful_commands: successful.map((e) => ({ command: e.command || '', cwd: e.cwd || '' })),
        executionSummary: summary,
        note: '上述命令曾在本项目下执行成功。执行安装类命令（npm/pip/brew install）前请对照此列表，若相同或等价命令已存在则不要重复执行。'
      }
    }
    return {
      success: true,
      directories: viewed.directories,
      files: viewed.files,
      executionSummary: summary
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

module.exports = { definition, execute }
