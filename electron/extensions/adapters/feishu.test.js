const fs = require('fs')
const os = require('os')
const path = require('path')
const feishu = require('./feishu')

describe('feishu outbound image queue', () => {
  const screenshotDir = path.join(os.tmpdir(), 'screenshots')
  const imagePath = path.join(screenshotDir, 'dup-test.png')

  beforeAll(() => {
    fs.mkdirSync(screenshotDir, { recursive: true })
    fs.writeFileSync(imagePath, Buffer.from('fake-image'))
  })

  it('does not duplicate images already provided by payload.images', () => {
    expect(typeof feishu.__testables?.buildOutboundImageQueue).toBe('function')
    const buildOutboundImageQueue = feishu.__testables.buildOutboundImageQueue
    const queue = buildOutboundImageQueue({
      textRaw: '见截图 ![x](local-resource://screenshots/dup-test.png)',
      images: [{ path: imagePath }]
    })
    expect(queue).toHaveLength(1)
    expect(queue[0].path).toBe(imagePath)
  })

  it('does not turn screenshot links in text into outbound images', () => {
    expect(typeof feishu.__testables?.buildOutboundImageQueue).toBe('function')
    const buildOutboundImageQueue = feishu.__testables.buildOutboundImageQueue
    const queue = buildOutboundImageQueue({
      textRaw: '旧结果 ![x](local-resource://screenshots/dup-test.png)'
    })
    expect(queue).toHaveLength(0)
  })

  it('dedupes same image when payload.images and payload.files both contain it', () => {
    expect(typeof feishu.__testables?.buildOutboundImageQueue).toBe('function')
    const buildOutboundImageQueue = feishu.__testables.buildOutboundImageQueue
    const queue = buildOutboundImageQueue({
      images: [{ path: imagePath, filename: 'dup-test.png' }],
      files: [{ path: imagePath, name: 'dup-test.png' }]
    })
    expect(queue).toHaveLength(1)
    expect(queue[0].path).toBe(imagePath)
  })
})
