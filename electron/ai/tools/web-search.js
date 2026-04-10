/**
 * 网页搜索工具：通过百度/谷歌搜索获取结果列表，供 AI 获取实时或外部信息。
 * 不依赖 MCP 搜索；与 web_fetch 配合可先搜索再抓取正文。
 */
const { searchViaWebview } = require('./webview-search')

const definition = {
  description: '使用内置网页搜索获取关键词的标题、链接和摘要列表。用于获取实时信息、技术文档、社区讨论等；如需页面正文请对结果中的 url 再调用 web_fetch。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      engine: { type: 'string', enum: ['baidu', 'google'], description: '可选，指定搜索后端（未指定时使用默认）' }
    },
    required: ['query']
  }
}

async function execute(args) {
  const { query, engine = 'baidu' } = args
  if (!query || typeof query !== 'string') {
    return { success: false, error: '缺少 query 参数' }
  }
  const eng = engine === 'google' ? 'google' : 'baidu'
  const out = await searchViaWebview(query.trim(), eng)
  if (!out.success) {
    return { success: false, error: out.error || '搜索失败' }
  }
  return {
    success: true,
    query: out.query,
    engine: eng,
    results: out.results || [],
    total: out.total || 0,
    page: out.page || null
  }
}

module.exports = { definition, execute }
