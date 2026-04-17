const {
  buildWebAppStudioSandboxMemoryBlock,
  buildWebAppStudioDelegateCallerBlock
} = require('./webapp-studio-context')

describe('webapp studio context', () => {
  it('describes full engineering permissions in studio memory block', () => {
    const text = buildWebAppStudioSandboxMemoryBlock('/tmp/app')

    expect(text).toContain('完整工程级工具权限')
    expect(text).toContain('sessions_spawn')
    expect(text).toContain('webapp_studio_invoke')
  })

  it('allows delegated studio agent to expand beyond current app when required', () => {
    const text = buildWebAppStudioDelegateCallerBlock('session-1')

    expect(text).toContain('可继续使用 sessions_spawn')
    expect(text).toContain('当前应用之外的宿主代码')
  })
})
