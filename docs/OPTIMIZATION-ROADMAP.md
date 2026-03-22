# 优化与演进路线图（智能体 / 工程化）

本文档把「深度分析」收敛为**可执行优先级**，与现有设计文档（如 `WEB-APPS-SANDBOX-DESIGN.md`、`docs/plans/*agent-capability-routing*`）对齐，便于迭代时对照。

---

## 已落地的工程优化（示例）

| 项 | 说明 |
|----|------|
| **`electron/ai/ai-config-normalize.js`** | 统一 `modelPool` / `modelBindings` 规范化与 `finalizeAiModelFields`，供 `ai-save-config`、`applyGlobalDefaultModel`、`ai_config_control` 共用，减少三处逻辑漂移。 |
| **`electron/main-process/inbound-model-command.js`** | 渠道首行 `/model` 解析与全局默认模型写入；`main.js` 通过 `createInboundModelCommandHandlers(deps)` 注入依赖。 |
| **`docs/MAIN-PROCESS-MODULARIZATION.md`** | `main.js` 按域拆分蓝图：目录约定、`registerChannel` 分组、迁移顺序、风险与检查清单。 |

---

## P0 — 体验与一致性（建议下一迭代）

1. **Capability Router + Execution Envelope 全链路**  
   - 设计：`docs/plans/2026-03-12-agent-capability-routing-design.md`  
   - 实现计划：`docs/plans/2026-03-12-agent-capability-routing-implementation.md`  
   - 目标：子 Agent / 渠道回传 **统一成功-失败-产物** 语义，减少「说完成但没收齐」类问题。  
   - 现状：`electron/ai/execution-envelope.js` 已有基础，需在 `sessions_spawn` 完成路径与 Feishu 等投递侧 **强制规范化**。

2. **关键路径自动化测试**  
   - 优先：`openai-responses.js`（Codex vs Platform 请求体差异）、`resolve-provider-config.js` / 模型路由、`ai-config-normalize.js`。  
   - 工具：Vitest + Node 环境即可，不必先上 E2E。

---

## P1 — Web 沙箱规模化

见 `WEB-APPS-SANDBOX-DESIGN.md` §19 与实现清单；重点：

- `webapp__*` 工具数量 **硬上限** 或与现有 `slimMode` 联动。  
- 预览与 `file_operation` 写入同一目录时的 **刷新/竞态**（文件监视或显式 reload）。  
- `handler: node` **并发上限** 与 invoke **统一错误结构**（`code` / `message` / 可重试）。

---

## P2 — 可观测性与运维

- 为每次 `startChat` / 子 Agent run 打 **统一 `runId`**，日志与 tool 结果可关联。  
- 错误分类（已有 `_classifyLlmError`）可 **落盘统计**，便于看「哪家供应商、哪类模型」故障率高。  
- `main.js` **按域拆分**（渠道、Gateway、配置、MCP），降低单文件认知成本。  
  - 实施指南：**`docs/MAIN-PROCESS-MODULARIZATION.md`**（分阶段迁出 `main-process/ipc/*`，避免循环依赖）。

---

## P3 — 产品边界（刻意不做 vs 后续）

| 边界 | 说明 |
|------|------|
| **非目标** | 多租户 SaaS、云端容器 IDE、任意无签名第三方等同「整机 root」执行。 |
| **后续可选** | 应用包签名/策展市场、更细粒度权限 UX、结构化 Trace 导出。 |

---

## 如何更新本文档

完成功能或重构后，在对应 **P 级**下勾选项或追加一行「已完成 + 提交/PR 引用」；大方向变更先改 `docs/plans/*` 或产品主设计文档，再同步本节。
