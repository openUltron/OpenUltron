const { validateMvpManifest } = require('./registry')

describe('web-app registry manifest normalization', () => {
  it('preserves advanced service runtime fields', () => {
    const manifest = {
      id: 'com.openultron.webapp.devmode',
      name: 'Dev Mode App',
      version: '0.1.0',
      host: {
        openUltron: '>=1.0.0',
        protocol: 1
      },
      entry: {
        html: 'index.html',
        service: {
          command: 'npm run dev',
          cwd: '.',
          portEnv: 'PORT',
          healthPath: '/healthz',
          startupTimeoutMs: 45000,
          env: {
            NODE_ENV: 'development',
            VITE_API_BASE: 'http://127.0.0.1:3000'
          }
        }
      },
      runtime: { browser: true, node: true }
    }

    const out = validateMvpManifest(manifest)

    expect(out.ok).toBe(true)
    expect(out.normalized.entry.service.healthPath).toBe('/healthz')
    expect(out.normalized.entry.service.env).toEqual({
      NODE_ENV: 'development',
      VITE_API_BASE: 'http://127.0.0.1:3000'
    })
  })
})
