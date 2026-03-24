# 专项计划索引（`docs/plans/`）

与 [`../README.md`](../README.md) 配合使用。  
本目录主要存放“进行中或分阶段推进”的设计与实施计划。

## 文档清单

| 文件 | 状态 | 说明 |
|------|------|------|
| [`agent-cognitive-architecture-plan.md`](./agent-cognitive-architecture-plan.md) | 进行中 | 认知层架构、C0-C3 路线、落地状态总表 |
| [`agent-capability-routing.md`](./agent-capability-routing.md) | 进行中 | 能力路由、执行信封、产物投递语义 |

## 使用建议

- 需求评审：先看 `agent-cognitive-architecture-plan.md`
- 执行与交付语义：看 `agent-capability-routing.md`
- 附件链路问题：以 `electron/ai/attachment-ingest.js` 实现与相关 IPC 接线为准
- 飞书联调回归：以 `feishu_doc_capability` 当前实现与执行日志为准

## 维护规则

- 计划有重大阶段变更时，优先更新本目录文档状态字段。
- 计划落地后，把“最终规则”回写到上层稳定文档（如消息契约、路线图、设计文档）。
- 若某计划文档长期不再维护，应在本文件标记“冻结/归档”，避免误用。

**历史说明**：过期执行清单已归档删除；执行记录以 git 历史与现有实现为准，后续以 `agent-cognitive-architecture-plan.md` 为主线维护。
