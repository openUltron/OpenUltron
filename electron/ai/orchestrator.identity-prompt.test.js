const { __test } = require('./orchestrator')

const { hasModelIdentityQuestion, detectPromptIntentFlags } = __test

describe('orchestrator model identity prompt detection', () => {
  it('detects Chinese model-identity questions', () => {
    expect(hasModelIdentityQuestion('你是什么模型')).toBe(true)
    expect(hasModelIdentityQuestion('请问你现在用的是哪个模型？')).toBe(true)
    expect(hasModelIdentityQuestion('当前模型是 qwen2.5 吗？')).toBe(true)
    expect(hasModelIdentityQuestion('你现在使用的模型是什么？')).toBe(true)
    expect(hasModelIdentityQuestion('你现在用的是什么 llm 模型？')).toBe(true)
  })

  it('detects English model-identity questions', () => {
    expect(hasModelIdentityQuestion('What model are you using?')).toBe(true)
    expect(hasModelIdentityQuestion('Which model are you?')).toBe(true)
    expect(hasModelIdentityQuestion("What's your model?")).toBe(true)
  })

  it('does not treat casual self intro prompts as identity inquiries', () => {
    expect(hasModelIdentityQuestion('你是谁？')).toBe(false)
    expect(hasModelIdentityQuestion('你真厉害！')).toBe(false)
    expect(hasModelIdentityQuestion('你今天怎么样？')).toBe(false)
    expect(hasModelIdentityQuestion('这是什么文件？')).toBe(false)
  })

  it('flags identityInquiry intent flag consistently', () => {
    expect(detectPromptIntentFlags('你是什么模型').identityInquiry).toBe(true)
    expect(detectPromptIntentFlags('你真聪明，来点建议').identityInquiry).toBe(false)
  })
})
