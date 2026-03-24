# 主进程模块化现状（2026）

`electron/main.js` 已从历史超大文件收敛为精简入口（当前约 456 行）。  
当前架构中，`main.js` 主要负责生命周期与装配，业务能力已下沉到 `electron/main-process/*` 与 `electron/ai/*`。

本文档作为主进程模块化的**当前真相源**，不再维护逐条迁移流水账。

---

## 1. 当前架构

```text
electron/main.js
  -> main-process/*            # 启动装配、窗口、协议、IM、Gateway、工具访问
  -> main-process/ipc/*        # 按域注册 IPC channel
  -> ai/*                      # 编排器、工具、记忆、流式调用、MCP 客户端
```

### 入口职责（`main.js`）

- 进程生命周期（ready/activate/before-quit）
- 聚合依赖并调用 `register*` / `bootstrap*`
- 少量顶层顺序控制（避免初始化时序问题）

### 模块职责（`main-process/*`）

- IPC 注册模块：每个模块负责单一领域 channel
- 启动与装配模块：IM / Gateway / 窗口 / 协议等
- 通用 helper：配置、模型验证、artifact、安全日志等

### AI 运行时（`ai/*`）

- `orchestrator`：上下文拼装、工具循环、重试、fallback
- `tool-registry` + 工具实现
- 会话与记忆持久化
- LLM 流式调用与错误分类

---

## 2. 持续优化焦点

以下属于“工程持续优化”，不是“未拆分完成”：

1. **Gateway 装配进一步解耦**  
2. **飞书入站消息处理链进一步去耦**  
3. **bootstrap/lifecycle 可观测性增强**（启动链路日志、失败定位）

与产品侧优先级对齐：见 [`OPTIMIZATION-ROADMAP.md`](./OPTIMIZATION-ROADMAP.md)。

---

## 3. 设计约束（持续遵守）

- IPC 模块只做注册与薄粘合，不承载复杂业务逻辑。
- 禁止业务模块反向 `require main.js`，统一通过 `deps` 注入。
- 新增领域能力优先放入 `main-process/ipc/<domain>.js`。
- 保持 channel 名、入参、返回值和事件语义向后兼容。

---

## 4. 回归检查建议

- `rg "registerChannel\\(" electron/main.js`：确认入口未反向膨胀
- 关键烟测：聊天、工具调用、渠道消息、Web 沙箱、MCP 状态
- 关键日志：`runId`、tool result、error 分类是否完整

---

## 5. 相关文档

- [`README.md`](./README.md)（docs 总索引）
- [`OPTIMIZATION-ROADMAP.md`](./OPTIMIZATION-ROADMAP.md)
- [`MESSAGE-CONTRACT.md`](./MESSAGE-CONTRACT.md)
