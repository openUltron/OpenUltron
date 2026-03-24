# Docs Hub

根目录 [`README.md`](../README.md) 负责产品介绍与快速开始；本目录聚焦**架构、协议、设计与实施计划**。

## 阅读路径

### 新同学 / 首次接触

1. [`MESSAGE-CONTRACT.md`](./MESSAGE-CONTRACT.md)  
2. [`OPTIMIZATION-ROADMAP.md`](./OPTIMIZATION-ROADMAP.md)  
3. [`MAIN-PROCESS-MODULARIZATION.md`](./MAIN-PROCESS-MODULARIZATION.md)  
4. [`WEB-APPS-SANDBOX-DESIGN.md`](./WEB-APPS-SANDBOX-DESIGN.md)

### 做功能开发

1. 先看领域设计文档（如 Web Apps / Gateway / Skills）  
2. 再看对应计划文档（`docs/plans/`）  
3. 最后回写路线图与状态（`OPTIMIZATION-ROADMAP.md`）

### 做重构与拆分

1. [`MAIN-PROCESS-MODULARIZATION.md`](./MAIN-PROCESS-MODULARIZATION.md)  
2. [`OPTIMIZATION-ROADMAP.md`](./OPTIMIZATION-ROADMAP.md)

---

## 文档分层

### A. 稳定规范（优先信任）

| 文档 | 用途 |
|------|------|
| [`MESSAGE-CONTRACT.md`](./MESSAGE-CONTRACT.md) | 消息契约、`meta`、工具结果 envelope、EventBus 约定 |
| [`MAIN-PROCESS-MODULARIZATION.md`](./MAIN-PROCESS-MODULARIZATION.md) | 主进程拆分原则、目录规范与风险控制 |
| [`GATEWAY-WEBSOCKET.md`](./GATEWAY-WEBSOCKET.md) | Gateway 事件与字段语义 |
| [`WEB-APPS-IPC-REFERENCE.md`](./WEB-APPS-IPC-REFERENCE.md) | Web 沙箱 IPC / HTTP 接口定义 |

### B. 设计与实现（可能持续迭代）

| 文档 | 用途 |
|------|------|
| [`WEB-APPS-SANDBOX-DESIGN.md`](./WEB-APPS-SANDBOX-DESIGN.md) | Web 沙箱整体设计与安全模型 |
| [`SKILLS-PACK-COMPAT.md`](./SKILLS-PACK-COMPAT.md) | Skills / ClawHub 兼容与打包约束 |
| [`OPENAI-CODEX-AND-CHAT-COMPLETIONS.md`](./OPENAI-CODEX-AND-CHAT-COMPLETIONS.md) | Codex/Responses 与 Chat Completions 线路差异 |
| [`WEB-APPS-INSTALL-ERRORS.md`](./WEB-APPS-INSTALL-ERRORS.md) | Web 应用安装错误码说明 |
| [`manifest-web-app-mvp.schema.json`](./manifest-web-app-mvp.schema.json) | Web App MVP manifest schema |

### C. 计划与路线图（以时间推进）

| 文档 | 用途 |
|------|------|
| [`OPTIMIZATION-ROADMAP.md`](./OPTIMIZATION-ROADMAP.md) | P0-P3 优先级与跨域演进 |
| [`plans/README.md`](./plans/README.md) | 专项计划目录索引（认知、能力路由） |

---

## 专项计划（`docs/plans/`）

见 [`plans/README.md`](./plans/README.md)。

建议把 `plans/` 下文档视为“工作文档”：  
设计稳定后，核心结论应回流到上面的“稳定规范 / 设计文档”中，避免仅存在于计划稿。

---

## 维护约定

- 新增文档前，先判断放在“稳定规范 / 设计实现 / 计划路线图”哪一层。
- API、消息、字段变更时，必须同步更新对应规范文档与引用链接。
- 计划完成后，优先更新状态并把最终结论回写到稳定文档，避免长期漂移。
