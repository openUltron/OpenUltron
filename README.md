# OpenUltron

中文 | [English](./README.en.md)

OpenUltron 是一款面向效率场景的 AI 桌面助手。  
你可以把它理解为「一个会执行任务、会调用工具、会持续记住上下文」的本地工作台。

不只是聊天，而是让 AI 真正帮你做事。

## 为什么值得用

- 更像“执行型助理”，不是只会回答问题的聊天机器人
- 一个窗口里就能完成：提需求、执行、产出、回传
- 本地运行 + 可控配置，适合长期日常工作

## 你能用它做什么

- 让 AI 帮你生成网页、文档、脚本、报告
- 自动处理截图、文件、链接等任务产物
- 对接飞书 / Telegram / 钉钉，把结果直接发到会话里；飞书支持**个人空间文档**（授权 User Access Token 后可将文档创建到个人空间，Token 自动刷新）
- 用 Skills 和 MCP 扩展能力，接入你自己的工作流
- **Web 沙箱应用**：在侧栏「应用」中安装/新建迷你前端（`~/.openultron/web-apps/`），**工作室**内左侧预览、右侧 AI 协助改 `index.html` / `manifest`；详见 `docs/WEB-APPS-SANDBOX-DESIGN.md` 与 `docs/WEB-APPS-IPC-REFERENCE.md`
- 管理多会话历史，持续追踪上下文与任务进度

## 亮点能力

- 多模型接入：可配置不同 AI 服务与模型
- 子 Agent 执行：复杂任务可分发、可回传
- 工具调用体系：内置工具 + MCP 工具生态
- 会话记忆与持久化：任务上下文不断档
- 定时任务：周期性执行自动化工作（含飞书 User Token 自动刷新，可关闭）
- 数据备份与恢复：迁移和重装更安心

## 典型场景

- 运营：批量写活动文案、整理日报、自动发渠道
- 开发：生成页面原型、改代码、导出结果文件
- 团队协作：把 AI 产出直接同步到群聊/文档
- 个人效率：把重复性任务交给 AI 持续执行

## 快速开始

```bash
npm install
npm run electron:dev
```

启动后你可以直接在应用内配置模型与通知渠道，然后开始派发任务。

## 常用命令

```bash
# 前端开发
npm run dev

# 构建前端
npm run build

# 启动 Electron
npm run electron

# 联合调试（推荐）
npm run electron:dev

# 构建桌面应用
npm run electron:build
npm run electron:build:mac
npm run electron:build:win
npm run electron:build:linux

# 发布脚本
npm run release
npm run release:x64
npm run release:all
```

## 数据与目录

- 应用数据目录：`~/.openultron/`
- 会话历史：`conversations/`
- 本地技能：`skills/`
- 日志文件：`logs/app.log`

## 技术栈（简要）

- Electron + Vue 3 + Vite
- Node.js 主进程能力
- 可扩展工具协议（MCP）

## 设计文档

- [技能包与 ClawHub 兼容说明](./docs/SKILLS-PACK-COMPAT.md)
- [Web 沙箱应用（可打包/安装/依赖声明）](./docs/WEB-APPS-SANDBOX-DESIGN.md)
- [Web 应用实现清单（进度勾选）](./docs/WEB-APPS-IMPLEMENTATION-CHECKLIST.md)  
  - 侧栏 **应用** → 应用库 **`/web-apps`**（新建 / 列表）；**打开** **`/app-open`**（仅全屏预览）；**工作室** **`/web-app-studio`**（左侧预览 + 右侧 AI）。

---

如果你希望 AI 不只是“会说”，而是“能交付”，OpenUltron 就是为这个目标设计的。
