# 优化与演进路线图（智能体 / 工程化）

本文档把「深度分析」收敛为**可执行优先级**，与 `WEB-APPS-SANDBOX-DESIGN.md`、`docs/plans/agent-capability-routing.md` 等对齐，便于迭代时对照。

**认知层专项**（角色 / 记忆 / 上下文 / 压缩 / 学习 / 验证 / Hook）见 **`docs/plans/agent-cognitive-architecture-plan.md`**（当前状态与下一阶段行动项）。**消息与 EventBus**：**`docs/MESSAGE-CONTRACT.md`**。

---

## 已落地的工程优化（摘要）

| 项 | 说明 |
|----|------|
| **模型配置** | `electron/ai/ai-config-normalize.js`：`modelPool` / `modelBindings` 等与 `ai-save-config`、`ai_config_control` 共用 |
| **渠道 `/model`** | `main-process/inbound-model-command.js` + `main.js` 注入 |
| **主进程 IPC 拆分** | 大量 `registerChannel` 已迁入 `main-process/ipc/*`；模块化进度与收尾焦点统一维护在 **`docs/MAIN-PROCESS-MODULARIZATION.md`** |
| **编排与任务取消** | `AbortSignal` 贯穿 `execute_command` → Shell 进程组；MCP `callTool` 在 stdio/HTTP 侧可中断等待；`classifyStopPreviousIntent` 关键词短路；同 session 叠 `runId` 可观测日志；工具 context 优先使用当前 `chatRunId` |
| **拆分蓝图** | **`docs/MAIN-PROCESS-MODULARIZATION.md`**（原则、目录、风险） |

---

## P0 — 体验与一致性（建议下一迭代）

1. **Capability Router + Execution Envelope 全链路**  
   - 说明与落地状态：`docs/plans/agent-capability-routing.md`  
   - 目标：子 Agent / 渠道回传 **统一成功-失败-产物** 语义，减少「说完成但没收齐」类问题。  
   - 现状：`electron/ai/execution-envelope.js` 已有基础，需在 `sessions_spawn` 完成路径与 Feishu 等投递侧 **强制规范化**。

2. **关键路径自动化测试**  
   - 已覆盖（Vitest）：`ai-config-normalize.js`、`resolve-provider-config.js`、`capability-router.js`、`execution-envelope.js`、`openai-responses.js`、`run-id.js`。  
   - 可按需扩展：流式边界用例、更多供应商适配回归等。  
   - 工具：Vitest + Node 环境即可，不必先上 E2E。

---

## P1 — Web 沙箱规模化

见 `WEB-APPS-SANDBOX-DESIGN.md` 的实现状态与后续章节；重点：

- `webapp__*` 工具数量 **硬上限** 或与现有 `slimMode` 联动。  
- 预览与 `file_operation` 写入同一目录时的 **刷新/竞态**（文件监视或显式 reload）。  
- `handler: node` **并发上限** 与 invoke **统一错误结构**（`code` / `message` / 可重试）。

---

## P2 — 可观测性与运维

- **`runId`**（`electron/ai/run-id.js`）：`wrappedSender` 对 token / tool / usage / complete / error 统一注入；Gateway WebSocket 转发；`sessions_spawn` / `parentRunId` / `execution-envelope.metrics` 等与上文 P0 对齐。  
- 错误分类（`_classifyLlmError`）可 **落盘统计**（供应商 / 模型维度）。  
- **`main.js` 继续瘦身**：Gateway 装配、飞书入站大段、bootstrap — 见 **`docs/MAIN-PROCESS-MODULARIZATION.md`**。

---

## P3 — 产品边界（刻意不做 vs 后续）

| 边界 | 说明 |
|------|------|
| **非目标** | 多租户 SaaS、云端容器 IDE、任意无签名第三方等同「整机 root」执行。 |
| **后续可选** | 应用包签名/策展市场、更细粒度权限 UX、结构化 Trace 导出。 |

---

## 如何更新本文档

完成功能或重构后，在对应 **P 级**下勾选项或追加一行「已完成 + 提交/PR 引用」；大方向变更先改 `docs/plans/` 下对应文档或产品主设计文档，再同步本节。
