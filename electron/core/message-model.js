/**
 * 统一消息与会话模型：各渠道在进入 runChat 前归一成统一结构。
 * 见 EXTENSIBILITY-DESIGN.md 第二节。
 *
 * @typedef {Object} InboundMessage
 * @property {string} sourceChannel - 'app' | 'gateway' | 'feishu' | 'slack' | ...
 * @property {string} remoteId - 渠道内会话/群/用户 ID（如飞书 chat_id）
 * @property {string} text
 * @property {Array<{ type: 'image'|'file'|'audio'; url?: string; path?: string; base64?: string }>} [attachments]
 * @property {string} [messageId] - 去重用
 * @property {Record<string, unknown>} [metadata]
 *
 * @typedef {Object} SessionBinding
 * @property {string} sessionId - 本地会话 ID
 * @property {string} projectPath - 项目路径或 __feishu__ / __gateway__
 * @property {string} channel - 'feishu' | 'slack' | 'app' | ...
 * @property {string} remoteId
 * @property {string} [feishuChatId] - 兼容现有飞书回发
 *
 * @typedef {Object} OutboundPayload
 * @property {string} [text]
 * @property {Array<{ path?: string; base64?: string; filename?: string }>} [images]
 * @property {object} [post] - 富文本等
 */

/**
 * @param {string} sourceChannel
 * @param {string} remoteId
 * @param {string} text
 * @param {string} [messageId]
 * @param {InboundMessage['attachments']} [attachments]
 * @returns {InboundMessage}
 */
function createInboundMessage(sourceChannel, remoteId, text, messageId, attachments) {
  return {
    sourceChannel,
    remoteId,
    text: text || '',
    messageId,
    attachments
  }
}

/**
 * @param {string} sessionId
 * @param {string} projectPath
 * @param {string} channel
 * @param {string} remoteId
 * @param {string} [feishuChatId]
 * @returns {SessionBinding}
 */
function createSessionBinding(sessionId, projectPath, channel, remoteId, feishuChatId) {
  return {
    sessionId,
    projectPath,
    channel,
    remoteId,
    ...(feishuChatId != null && { feishuChatId })
  }
}

module.exports = {
  createInboundMessage,
  createSessionBinding
}
