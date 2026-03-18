// 内置技能定义
// agent-browser 来自 vercel-labs/agent-browser：https://github.com/vercel-labs/agent-browser
const path = require('path')
const fs = require('fs')

const AGENT_BROWSER_BODY_PATH = path.join(__dirname, 'agent-browser.SKILL.body.md')

function loadAgentBrowserPrompt() {
  try {
    if (fs.existsSync(AGENT_BROWSER_BODY_PATH)) {
      return fs.readFileSync(AGENT_BROWSER_BODY_PATH, 'utf-8').trim()
    }
  } catch (e) {
    console.warn('[builtin-skills] 读取 agent-browser.SKILL.body.md 失败:', e.message)
  }
  return `# agent-browser

Browser automation CLI for AI agents. Source: https://github.com/vercel-labs/agent-browser

Use when the user needs to interact with websites: navigate, fill forms, click buttons, take screenshots, scrape data, test web apps, or automate browser tasks. Run via \`execute_command\`: \`npx agent-browser open <url>\`, \`agent-browser snapshot -i\`, \`agent-browser click @e1\`, etc. If agent-browser CLI is not available, use chrome-devtools MCP (preferred; no built-in webview).`
}

const BUILTIN_SKILLS = [
  {
    id: 'agent-browser',
    name: 'Agent 浏览器',
    category: 'custom',
    projectType: 'all',
    description: 'Browser automation CLI for AI agents (vercel-labs/agent-browser). Use when the user needs to interact with websites: navigate pages, fill forms, click buttons, take screenshots, extract data, test web apps, or automate any browser task. Run via npx agent-browser or execute_command.',
    prompt: loadAgentBrowserPrompt()
  }
]

/** 已移除的内置技能 id（启动时删除其目录，不再作为内置展示） */
const REMOVED_BUILTIN_SKILL_IDS = [
  'builtin-init-playbook',
  'builtin-analyze-project',
  'builtin-git-status',
  'builtin-deploy-test',
  'builtin-code-review',
  'builtin-frontend-deploy',
  'builtin-backend-deploy',
  'builtin-app-build'
]

module.exports = { BUILTIN_SKILLS, REMOVED_BUILTIN_SKILL_IDS }
