const fs = require('fs')
const path = require('path')
const mainPath = path.join(__dirname, '../electron/main.js')
const lines = fs.readFileSync(mainPath, 'utf8').split('\n')
// 0-based: line 3386 is index 3385
const start = 3385 // registerChannel('ai-fetch-models'
const end = 3679 // inclusive, line 3680 is blank before getTools comment
const body = lines.slice(start, end + 1).join('\n')
const wrapped = `/**
 * 拉取 / 缓存模型列表（含 Anthropic 验证逻辑）
 */
function registerAiModelsIpc (deps) {
  const { registerChannel, getAIConfigLegacy, store, https, http } = deps
${body.replace(/^registerChannel\(/m, '  registerChannel(').replace(/\n/g, '\n').replace(/^  registerChannel/m, '  registerChannel')}
}

module.exports = { registerAiModelsIpc }
`
// Fix indentation: each line of body needs 2 extra spaces except we replaced first registerChannel
const fixed = wrapped.split('\n').map((line, i) => {
  if (i < 7) return line
  if (line.trim() === '') return line
  if (!line.startsWith('  ') && !line.startsWith('function') && !line.startsWith('module')) {
    return '  ' + line
  }
  return line
}).join('\n')

// Simpler: manual indent - the script output might be wrong. Use different approach:
const inner = lines.slice(start, end + 1)
  .join('\n')
  .replace(/^registerChannel/m, '  registerChannel')
  .split('\n')
  .map(l => (l.trim() === '' ? l : (l.match(/^\s{2}registerChannel/) ? l : '  ' + l.replace(/^\s*/, ''))))
  .join('\n')

const out = `/**
 * 拉取 / 缓存模型列表（含 Anthropic 验证逻辑）
 */
function registerAiModelsIpc (deps) {
  const { registerChannel, getAIConfigLegacy, store, https, http } = deps
${inner}
}

module.exports = { registerAiModelsIpc }
`
fs.writeFileSync(path.join(__dirname, '../electron/main-process/ipc/ai/ai-models-ipc.js'), out)
console.log('written', out.length)
