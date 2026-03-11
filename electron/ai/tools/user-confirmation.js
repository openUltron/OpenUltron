// 工具：请求用户确认
// 危险操作前暂停 Agent 循环，等待用户确认

const definition = {
  description: '在执行危险操作（git push、部署、删除文件等）前请求用户确认。支持带输入框的确认弹框，用户可直接编辑内容（如 commit message）后提交。用户确认后继续，拒绝则终止',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '需要确认的操作描述' },
      severity: { type: 'string', enum: ['info', 'warning', 'danger'], description: '严重程度，默认 warning' },
      input_default: { type: 'string', description: '可选。若提供此字段，弹框会显示一个可编辑的输入框，预填此内容（如 commit message）。用户编辑后点确认，返回的 user_input 即为用户最终输入的内容。' },
      allow_push: { type: 'boolean', description: '可选。为 true 时弹框额外显示「确认并推送」按钮，用户点击后返回 push_after_commit=true，AI 应在提交后立即执行 git push。用于 git commit 确认弹框。' }
    },
    required: ['message']
  }
}

async function execute(args, context) {
  const { message, severity = 'warning', input_default, allow_push } = args
  const { sender, sessionId } = context || {}
  const canSend = !!(sender && typeof sender.send === 'function' && !(typeof sender.isDestroyed === 'function' && sender.isDestroyed()))

  if (!canSend) {
    return { confirmed: false, user_input: '', push_after_commit: false, message: '无可用 UI 通道，已拒绝操作' }
  }

  return new Promise((resolve) => {
    const confirmId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    try {
      sender.send('ai-chat-confirm-request', {
        sessionId,
        confirmId,
        message,
        severity,
        inputDefault: input_default || null,
        allowPush: allow_push || false
      })
    } catch (e) {
      resolve({ confirmed: false, user_input: '', push_after_commit: false, message: `确认请求发送失败：${e.message}` })
      return
    }

    const { ipcMain } = require('electron')
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      try { ipcMain.removeHandler('ai-chat-confirm-response') } catch {}
      resolve(payload)
    }

    const handler = (event, data) => {
      if (data.confirmId !== confirmId) return
      finish({
        confirmed: data.confirmed,
        user_input: data.userInput || '',
        push_after_commit: data.pushAfterCommit || false,
        message: data.confirmed ? '用户已确认' : '用户已拒绝'
      })
    }

    try { ipcMain.removeHandler('ai-chat-confirm-response') } catch {}
    ipcMain.handle('ai-chat-confirm-response', handler)

    setTimeout(() => {
      finish({ confirmed: false, user_input: '', push_after_commit: false, message: '确认超时，操作已取消' })
    }, 5 * 60 * 1000)
  })
}

module.exports = { definition, execute }
