const { loadViaWebview, getBaiduSearchUrl, getGoogleSearchUrl } = require('./webview-search')

const definition = {
  description: '使用隐藏浏览器加载网页或搜索页，返回页面标题、可见文本与链接列表。适合处理需要浏览器渲染、登录态外的公开页面、搜索引擎结果页，并让 AI 自行解析页面内容。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'search'],
        description: 'open 直接打开指定 url；search 打开搜索引擎结果页。'
      },
      url: { type: 'string', description: 'action=open 时必填，完整 URL。' },
      query: { type: 'string', description: 'action=search 时必填，搜索关键词。' },
      engine: { type: 'string', enum: ['baidu', 'google'], description: 'action=search 时可选，默认 baidu。' },
      wait_ms: { type: 'number', description: '页面加载完成后额外等待的毫秒数，默认 2000。' },
      max_links: { type: 'number', description: '返回链接条数，默认 40，最大 100。' },
      max_text_length: { type: 'number', description: '返回正文最大字符数，默认 6000，最大 20000。' }
    },
    required: ['action']
  }
}

async function execute(args = {}) {
  const action = String(args.action || '').trim()
  const waitMs = Number.isFinite(Number(args.wait_ms)) ? Number(args.wait_ms) : undefined
  const maxLinks = Number.isFinite(Number(args.max_links)) ? Number(args.max_links) : undefined
  const maxTextLength = Number.isFinite(Number(args.max_text_length)) ? Number(args.max_text_length) : undefined

  let targetUrl = ''
  if (action === 'open') {
    targetUrl = String(args.url || '').trim()
    if (!targetUrl) return { success: false, error: 'action=open 时缺少 url' }
  } else if (action === 'search') {
    const query = String(args.query || '').trim()
    if (!query) return { success: false, error: 'action=search 时缺少 query' }
    const engine = String(args.engine || 'baidu').trim() === 'google' ? 'google' : 'baidu'
    targetUrl = engine === 'google' ? getGoogleSearchUrl(query) : getBaiduSearchUrl(query)
  } else {
    return { success: false, error: 'action 仅支持 open/search' }
  }

  const out = await loadViaWebview(targetUrl, { waitMs, maxLinks, maxTextLength })
  if (!out.success) return out

  return {
    success: true,
    action,
    requested_url: targetUrl,
    page: out.page
  }
}

module.exports = { definition, execute }
