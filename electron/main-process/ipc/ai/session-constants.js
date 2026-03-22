/** 会话 projectPath 常量（主进程 / Gateway / 各渠道统一引用） */
const MAIN_CHAT_PROJECT = '__main_chat__'
const FEISHU_PROJECT = '__feishu__'
const GATEWAY_PROJECT = '__gateway__'
const TELEGRAM_PROJECT = '__telegram__'
const DINGTALK_PROJECT = '__dingtalk__'

const SESSION_SOURCES = [
  { projectPath: MAIN_CHAT_PROJECT, source: 'main', label: '主会话' },
  { projectPath: FEISHU_PROJECT, source: 'feishu', label: '飞书' },
  { projectPath: GATEWAY_PROJECT, source: 'gateway', label: 'Gateway' },
  { projectPath: TELEGRAM_PROJECT, source: 'telegram', label: 'Telegram' },
  { projectPath: DINGTALK_PROJECT, source: 'dingtalk', label: '钉钉' }
]

module.exports = {
  MAIN_CHAT_PROJECT,
  FEISHU_PROJECT,
  GATEWAY_PROJECT,
  TELEGRAM_PROJECT,
  DINGTALK_PROJECT,
  SESSION_SOURCES
}
