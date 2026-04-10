const { normalizeExtractedPage, buildSearchResultsFromPage } = require('./webview-search')

describe('webview-search helpers', () => {
  it('normalizes page text and links', () => {
    const page = normalizeExtractedPage({
      title: '  Example Search  ',
      url: 'https://www.baidu.com/s?wd=test',
      text: '  hello   world  \n\n foo ',
      links: [
        { href: '/link?x=1', text: ' result 1 ', context: ' summary 1 ' },
        { href: 'https://example.com/a', text: '', context: ' context text ' },
        { href: 'javascript:void(0)', text: 'ignored', context: '' },
        { href: '/link?x=1', text: 'dup', context: 'dup' }
      ]
    }, { maxLinks: 10, maxTextLength: 1000 })

    expect(page.title).toBe('Example Search')
    expect(page.text).toBe('hello world foo')
    expect(page.links).toEqual([
      { text: 'result 1', url: 'https://www.baidu.com/link?x=1', context: 'summary 1' },
      { text: 'context text', url: 'https://example.com/a', context: 'context text' }
    ])
  })

  it('builds search results from external links only', () => {
    const results = buildSearchResultsFromPage({
      links: [
        { text: '百度导航', url: 'https://www.baidu.com/more', context: 'ignored' },
        { text: 'OpenAI Docs', url: 'https://platform.openai.com/docs', context: 'Official docs' },
        { text: 'OpenAI API', url: 'https://platform.openai.com/api-reference', context: 'API reference' }
      ]
    }, 'baidu', 10)

    expect(results).toEqual([
      { index: 1, title: 'OpenAI Docs', url: 'https://platform.openai.com/docs', content: 'Official docs' },
      { index: 2, title: 'OpenAI API', url: 'https://platform.openai.com/api-reference', content: 'API reference' }
    ])
  })
})
