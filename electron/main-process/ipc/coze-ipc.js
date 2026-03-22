/**
 * 扣子 Coze：配置读写、生成 commit message、check-auth、logout
 */

const { URL } = require('url')
const { COZE_API_URL, buildCozeCommitPrompt } = require('../../coze/commit-message')

function makeHttpsRequest (https, url, options, postData) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data })
      })
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

/**
 * @param {object} deps
 * @param {(ch: string, fn: Function) => void} deps.registerChannel
 * @param {object} deps.store
 * @param {typeof import('https')} deps.https
 */
function registerCozeIpc (deps) {
  const { registerChannel, store, https } = deps

  registerChannel('get-coze-config', async () => {
    try {
      const config = store.get('cozeConfig', {})
      return {
        success: true,
        config: {
          botId: config.botId || '',
          hasToken: !!config.apiToken
        }
      }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('save-coze-config', async (event, { apiToken, botId }) => {
    try {
      const config = store.get('cozeConfig', {})
      if (apiToken) {
        config.apiToken = apiToken
      }
      config.botId = botId
      store.set('cozeConfig', config)
      console.log('✅ 扣子配置已保存')
      return { success: true }
    } catch (error) {
      console.error('❌ 保存扣子配置失败:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('coze-generate-commit-message', async (event, { diff }) => {
    try {
      const config = store.get('cozeConfig', {})

      if (!config.apiToken) {
        return { success: false, message: '请先配置 API Token' }
      }

      if (!config.botId) {
        return { success: false, message: '请先配置 Bot ID' }
      }

      const chatUrl = `${COZE_API_URL}/v3/chat`
      const prompt = buildCozeCommitPrompt(diff)

      const body = JSON.stringify({
        bot_id: config.botId,
        user_id: 'git_manager_user',
        stream: false,
        auto_save_history: true,
        additional_messages: [{
          role: 'user',
          content: prompt,
          content_type: 'text'
        }]
      })

      const response = await makeHttpsRequest(https, chatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        }
      }, body)

      const responseText = response.body

      if (response.status !== 200) {
        console.error('🤖 API 错误响应:', responseText.substring(0, 500))
        return { success: false, message: `API 请求失败: ${response.status}` }
      }

      if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
        console.error('🤖 收到 HTML 响应，Token 可能无效')
        return { success: false, message: 'API Token 无效或已过期，请重新配置' }
      }

      let data
      try {
        data = JSON.parse(responseText)
      } catch (e) {
        console.error('🤖 JSON 解析失败:', responseText.substring(0, 200))
        return { success: false, message: '响应格式错误' }
      }

      if (data.code === 0 && data.data) {
        const chatId = data.data.id
        const conversationId = data.data.conversation_id

        let retries = 0
        while (retries < 30) {
          await new Promise(resolve => setTimeout(resolve, 1000))

          const statusUrl = `${COZE_API_URL}/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${conversationId}`
          const statusResponse = await makeHttpsRequest(https, statusUrl, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${config.apiToken}`
            }
          })

          let statusData
          try {
            statusData = JSON.parse(statusResponse.body)
          } catch (e) {
            console.error('轮询状态解析失败:', statusResponse.body.substring(0, 200))
            retries++
            continue
          }

          if (statusData.data && statusData.data.status === 'completed') {
            const messagesUrl = `${COZE_API_URL}/v3/chat/message/list?chat_id=${chatId}&conversation_id=${conversationId}`
            const messagesResponse = await makeHttpsRequest(https, messagesUrl, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${config.apiToken}`
              }
            })

            let messagesData
            try {
              messagesData = JSON.parse(messagesResponse.body)
            } catch (e) {
              console.error('消息列表解析失败:', messagesResponse.body.substring(0, 200))
              break
            }

            if (messagesData.data && messagesData.data.length > 0) {
              const assistantMessage = messagesData.data.find(m => m.role === 'assistant' && m.type === 'answer')
              if (assistantMessage) {
                const commitMessage = assistantMessage.content.trim()
                return { success: true, commitMessage }
              }
            }
            break
          } else if (statusData.data && statusData.data.status === 'failed') {
            return { success: false, message: '生成失败：' + (statusData.data.last_error?.msg || '未知错误') }
          }

          retries++
        }

        return { success: false, message: '生成超时，请重试' }
      }
      return { success: false, message: data.msg || '调用 AI 失败' }
    } catch (error) {
      console.error('❌ 调用扣子 AI 失败:', error)
      return { success: false, message: error.message }
    }
  })

  registerChannel('coze-check-auth', async () => {
    try {
      const config = store.get('cozeConfig', {})
      return {
        success: true,
        authorized: !!(config.apiToken && config.botId),
        botId: config.botId
      }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  registerChannel('coze-logout', async () => {
    try {
      store.set('cozeConfig', {})
      console.log('✅ 已清除扣子配置')
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })
}

module.exports = { registerCozeIpc }
