# OpenUltron

中文 | [English](./README.en.md)

OpenUltron 是一款面向效率场景的 AI 桌面助手。  
你可以把它理解为「一个会执行任务、会调用工具、会持续记住上下文」的本地工作台。

不只是聊天，而是让 AI 真正帮你做事。

## 解决什么问题

| 常见痛点 | OpenUltron 的做法 |
|---------|------------------|
| AI 只会「说」，不会落地执行 | 内置工具链 + MCP：读文件、跑命令、浏览器、截图、发飞书等，产出可落盘、可回传 |
| 多个模型/多家供应商混用，容易切错或配错 | **全局模型池** + **模型 → 供应商绑定**；主会话按所选模型自动走对应 `baseUrl` / Key；应用内 **`/model`** 与设置页共用同一「主模型」配置 |
| 桌面里聊完，还要复制到 IM | 飞书 / Telegram / 钉钉接入，结果直接发到会话；飞书支持**个人空间文档**（User Access Token，可自动刷新） |
| 想快速做一个迷你页面/小工具，不想开整套工程 | **Web 沙箱应用**：侧栏「应用」安装或新建，**工作室**左预览、右 AI 改代码；带 CSP、网络白名单、可选 `npm install` 等安全与依赖策略（见设计文档） |
| 会话一多就忘、重装丢配置 | 本地会话历史、记忆与 `~/.openultron` 数据目录；支持备份 ZIP 与恢复 |
| 重复工作想自动化 | **定时任务**（含飞书 Token 刷新等，可按需关闭） |

## 为什么值得用

- 更像「执行型助理」，不是只会回答问题的聊天机器人  
- 一个窗口里完成：**提需求 → 执行 → 产出 → 回传到渠道**  
- **本地运行** + 可配置模型与代理，适合长期日常工作与敏感内容  

## 你能用它做什么

- 让 AI 生成网页、文档、脚本、报告，并把文件写到指定目录  
- 自动处理截图、文件、链接等任务产物，并可在对话里追踪  
- 对接 **飞书 / Telegram / 钉钉**，把结果直接发到会话里；在飞书里发 **`/model <模型ID>`**（首行）可与 App 内一致地切换**全局主模型**（须已在模型池中）  
- 用 **Skills** 和 **MCP** 扩展能力，接入你自己的工具与工作流  
- **主会话模型**：聊天输入 **`/model`** 选择模型，会**写入全局配置**（与「设置 → 配置」中的主模型一致）；也可用 AI 工具 **`ai_config_control`**（如 `switch_model`）在对话中修改  
- **Web 沙箱应用**：侧栏「应用」→ 应用库 **`/web-apps`**（新建 / 导入 zip / 安装示例）；**工作室** **`/web-app-studio`**（左侧预览 + 右侧 AI，沙箱目录在 `~/.openultron/web-apps/`）；详见 `docs/WEB-APPS-SANDBOX-DESIGN.md` 与 `docs/WEB-APPS-IPC-REFERENCE.md`  
- 管理多会话历史，持续追踪上下文与任务进度  

## 亮点能力

- **多模型与多供应商**：可配置多家 API、**模型池**与**模型绑定**；支持 OpenAI 兼容接口；需订阅/Codex 等场景可参考 `docs/OPENAI-CODEX-AND-CHAT-COMPLETIONS.md` 理解线路差异  
- **子 Agent**：复杂任务可 `sessions_spawn` 分发、结果回传主会话  
- **工具调用**：内置工具 + MCP；Web 应用工作室下可按设计合并 **`webapp__*`** 应用内工具（见实现清单）  
- **会话记忆与持久化**：任务上下文、项目记忆、知识库等按模块落盘  
- **Gateway**：本地 WebSocket 网关（默认端口见文档），便于外部脚本或自动化接入同一套对话能力  
- **定时任务**：周期性执行自动化（含飞书 User Token 刷新，可关闭）  
- **备份与恢复**：导出备份 ZIP、迁移与重装更安心  

## 典型场景

- **运营**：批量写活动文案、整理日报、自动发渠道  
- **开发**：生成页面原型、改代码、导出结果文件；用 **Web 工作室** 快速迭代沙箱小应用  
- **团队协作**：把 AI 产出直接同步到群聊/文档（飞书等）  
- **个人效率**：把重复性任务交给定时任务或对话中的工具调用持续执行  

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

- 应用数据目录：`~/.openultron/`（含 `openultron.json` 中的 AI 配置：**主模型、模型池、供应商与绑定** 等）
- 会话历史：`conversations/`
- 本地技能：`skills/`
- Web 沙箱应用：`web-apps/`（按应用 id / 版本分子目录）
- 日志文件：`logs/app.log`

## 技术栈（简要）

- Electron + Vue 3 + Vite
- Node.js 主进程能力
- 可扩展工具协议（MCP）

## 设计文档

- [优化与演进路线图（工程化 / 智能体能力）](./docs/OPTIMIZATION-ROADMAP.md)
- [主进程 main.js 模块化拆分蓝图](./docs/MAIN-PROCESS-MODULARIZATION.md)
- [OpenAI：Codex 与 Chat Completions（为何 Codex 能用但本应用报 429）](./docs/OPENAI-CODEX-AND-CHAT-COMPLETIONS.md)
- [技能包与 ClawHub 兼容说明](./docs/SKILLS-PACK-COMPAT.md)
- [Web 沙箱应用（可打包/安装/依赖声明）](./docs/WEB-APPS-SANDBOX-DESIGN.md)
- [Web 应用 IPC / HTTP 参考](./docs/WEB-APPS-IPC-REFERENCE.md)
- [Web 应用实现清单（进度勾选）](./docs/WEB-APPS-IMPLEMENTATION-CHECKLIST.md)  
  - 侧栏 **应用** → 应用库 **`/web-apps`**（新建 / 列表）；**打开** **`/app-open`**（仅全屏预览）；**工作室** **`/web-app-studio`**（左侧预览 + 右侧 AI）。

---

如果你希望 AI 不只是「会说」，而是「能交付」，OpenUltron 就是为这个目标设计的。
