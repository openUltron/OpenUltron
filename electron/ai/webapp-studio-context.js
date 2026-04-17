'use strict'

/**
 * 应用工作室沙箱：与 orchestrator memory、委派子 Agent 共用的文案，避免分叉。
 */

/** @param {string} sandboxRoot 应用根目录绝对路径 */
function buildWebAppStudioSandboxMemoryBlock(sandboxRoot) {
  const root = String(sandboxRoot || '').trim()
  return (
    '[当前应用 - 应用工作室沙箱 · 最高优先级]\n' +
    '你正在 **应用工作室** 中编辑 **一个已安装的 Web 沙箱应用**（不是 OpenUltron 主程序仓库）。\n' +
    '当前会话拥有 **完整工程级工具权限**：可直接使用 file_operation / apply_patch / execute_command，也可继续使用 **sessions_spawn** 做拆分执行，或用 **webapp_studio_invoke / web_apps_create** 切换、委派或创建其它应用工作室任务。\n' +
    `本会话 **projectPath**（沙箱应用根目录，绝对路径）为：\n\`${root}\`\n` +
    '相对路径默认基于该目录；当前应用仍是默认主目标，但若任务需要宿主集成、共享脚本、上游配置或当前应用之外的代码修改，可以直接通过绝对路径进行，不必受限于沙箱根目录。\n' +
    '修改 index.html/css/manifest.json 会直接影响预览；若要走真实开发模式，优先补齐 package.json、依赖、构建脚本与 manifest.entry.service，尽量让预览跑在应用自己的 dev server / service 上，而不是只依赖静态预览。\n' +
    '**全栈交付**：用户若同时要求「界面 / 前端 / 表单 / 上传 / 按钮 / 页面 / index.html」与「接口 / API / 后端 / service」等，必须在**同一轮交付**内**同时**改入口页（通常为 **index.html**，若有独立 css/js 也要改）与 **service.js**（或项目实际服务端入口）。**禁止**只改后端、不动 UI 就声称功能已完成；若任务清单分列前端与后端条款，收工前须核对两条线均有实质改动（不仅是 package.json）。\n' +
    '必须实际写文件后再汇报结果（file_operation/apply_patch/execute_command），不要只给方案。\n' +
    '改应用展示名优先改 manifest.json 的 name；改页面文字优先改应用目录内入口页面，禁止改 ~/.openultron/IDENTITY.md、SOUL.md。\n' +
    '仅当工具返回成功才能宣称“已完成”。\n' +
    '\n【自测·必做 · 适用于任意沙箱应用，非仅示例】\n' +
    '每次实现或修改功能后，必须在 **本应用根目录**（上述 projectPath）执行自测并据输出修复，**未跑通不得声称交付完成**。\n' +
    '1) **逻辑 / API**：若有 Node 服务（如 `entry.service`、server.js），用 **node --test** 或脚本对关键 HTTP/API 断言；纯静态至少跑 **node --check** 或项目既有构建/类型检查命令。\n' +
    '2) **UI / 行为**：至少任选其一——(a) **Playwright**（或 Cypress）对入口页做 smoke：打开 → 操作关键控件 → 断言可见文案或 DOM（给可交互元素加 **data-testid**）；(b) 无法装浏览器依赖时，用 **curl/fetch** 拉入口 HTML 断言关键片段，并说明未做 E2E 的原因；(c) 用户明确只要静态展示且无交互时，可免 E2E，但仍须完成 (1) 中可自动化部分。\n' +
    '3) **依赖注意**：宿主对应用执行 `npm ci/install` 时默认 **--omit=dev**，Playwright 等在 devDependencies 中；在本目录跑 E2E 前需 **`npm install --include=dev`**，并通常需 **`npx playwright install chromium`**（或项目文档所写）。\n' +
    '4) **脚本与文档**：有测试时在 **package.json** 提供 **`test`**、可选 **`test:e2e`**、**`verify`**（串行跑通），README 用一两行说明命令；失败时阅读终端日志最小范围修改后再跑。'
  )
}

/**
 * 由主会话 / IM 通过 webapp_studio_invoke 委派时，追加在子 Agent system 前列，强调回传调用方。
 * @param {string} parentSessionId
 */
function buildWebAppStudioDelegateCallerBlock(parentSessionId) {
  const sid = String(parentSessionId || '').trim() || '（未知）'
  const short = sid.length > 48 ? `${sid.slice(0, 48)}…` : sid
  return (
    '[应用工作室 Agent · 委派执行]\n' +
    `你由 **其它会话** 通过工具 **webapp_studio_invoke** 调用（调用方会话标识：${short}）。\n` +
    '能力与在「应用工作室」内直接开发相同；可继续使用 sessions_spawn 扩展执行；若任务需要可修改当前应用之外的宿主代码、共享脚本或配置。产物仍由调用方会话向用户汇报。\n' +
    '**回传调用方**：最终回复的**第一段**请用 **【工作室结果】** 开头，用 1～3 句说明成败、改了什么、自测是否通过；其后可附细节。'
  )
}

module.exports = {
  buildWebAppStudioSandboxMemoryBlock,
  buildWebAppStudioDelegateCallerBlock
}
