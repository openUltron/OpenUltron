# 智能体能力路由与统一交付

## 背景与目标

主 Agent、子 Agent、渠道投递曾混在同一链路里，容易出现：**回复称已完成但文件未送达**、外部子 Agent 结果未稳定进入主会话、飞书特化逻辑渗透到通用流程。

**目标**：主 Agent 只做编排（派发、状态、对用户结论）；执行细节在子 Agent；**统一执行结果契约**；渠道通过适配器消费同一套交付语义。

**非目标**：一次性重写所有工具；替换现有会话存储格式；引入多租户分布式后端。

## 架构要点

1. **Capability Router**（`electron/ai/capability-router.js`）  
   从用户文本解析：`capability`（如 docs / sheets / bitable / browser / artifact）、`executionMode`（默认 internal，显式指令才 `external:codex` 等）、`deliveryPolicy`、`riskLevel`。当前为**启发式**，复杂意图仍依赖模型与系统提示。含「多维表格」的语句优先判为 **bitable**，避免被「表格」关键词误判为 sheets。

2. **Execution Envelope**（`electron/ai/execution-envelope.js`）  
   统一字段：`success`、`summary`、`artifacts[]`、`logs[]`、`tool_events[]`、`error { code, message, retriable }`、`metrics`。`sessions-spawn` 等路径应始终产出可被主流程消费的 envelope。

3. **产物与投递（设计中台）**  
   长期方向：**Artifact Hub**（artifact_id、run_id、渠道引用）与 **Channel Delivery**（`sendText` / `sendImage` / `sendFile` 等）只处理规范化 `DeliveryPayload`，避免从纯文本里猜路径。

4. **Run 状态机（目标）**  
   状态如 `queued` → `running` → `tool_running` → `completed` / `failed`；**完成事件只发一次**；重试由 `error.code` 与 `retriable` 约束。

## 飞书文档能力（P0 场景）

支持创建、读取、追加/改写（当前多为 copy_based 副本策略）、润色、导出发送等；**破坏性全文改写**需确认；定位歧义时让用户消歧。详细手测步骤见 [feishu-capability-checklist.md](./feishu-capability-checklist.md)。

## 落地状态（简表）

| 项 | 状态 |
|----|------|
| `execution-envelope.js` + `sessions-spawn` 挂 envelope | 已具备基础 |
| `capability-router.js` + `main.js` 注入 | 已有 |
| 全链路强制规范化（IM 完成路径、Feishu 投递与 envelope 对齐） | 进行中，见 [OPTIMIZATION-ROADMAP.md](../OPTIMIZATION-ROADMAP.md) P0 |
| Artifact Hub 单一真相源 | 部分实现，持续收敛 |
| 结构化观测日志（RouteDecision / DeliveryAttempt / RunState） | 部分：主会话 `runId` → 工具 IPC、`SubAgentDispatch` 的 `parentRunId`、`envelope.metrics.parent_run_id` |

## 验收方向（摘录）

- 「打包发我」要么发出 zip，要么**确定性失败**（可区分是否可重试）。
- 主会话**可见状态**与终端 run 结果一致；外部子 Agent 失败进入 envelope 并展示给用户。
- 能力路由器本身不承载渠道业务逻辑（渠道差异在 adapter）。
