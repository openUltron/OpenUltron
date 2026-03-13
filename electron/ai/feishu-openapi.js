const https = require('https')
const feishuNotify = require('./feishu-notify')
const openultronConfig = require('../openultron-config')

function requestJson({ method = 'GET', path, body, token }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf-8')
    const req = https.request({
      host: 'open.feishu.cn',
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        ...(payload ? { 'Content-Length': payload.length } : {})
      }
    }, (res) => {
      let buf = ''
      res.on('data', (ch) => { buf += ch })
      res.on('end', () => {
        try {
          const json = JSON.parse(buf || '{}')
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json)
          return reject(new Error(json.msg || json.error_description || `HTTP ${res.statusCode}`))
        } catch (e) {
          reject(new Error(buf || e.message))
        }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function withTenantToken() {
  return await feishuNotify.getTenantAccessToken()
}

function getConfiguredUserAccessToken() {
  try {
    const cfg = openultronConfig.getFeishu()
    return String(cfg?.user_access_token || '').trim()
  } catch (_) {
    return ''
  }
}

async function withFeishuToken(options = {}) {
  const preferUser = options && options.preferUser === true
  const allowTenantFallback = !(options && options.allowTenantFallback === false)
  const userToken = getConfiguredUserAccessToken()
  if (preferUser) {
    if (userToken) {
      return { token: userToken, tokenType: 'user', source: 'config:user_access_token' }
    }
    if (!allowTenantFallback) {
      const err = new Error('未配置 feishu.user_access_token，无法以用户身份创建到个人空间')
      err.code = 'FEISHU_USER_TOKEN_MISSING'
      throw err
    }
  }
  const tenantToken = await withTenantToken()
  return { token: tenantToken, tokenType: 'tenant', source: 'tenant_access_token' }
}

module.exports = {
  requestJson,
  withTenantToken,
  withFeishuToken
}
