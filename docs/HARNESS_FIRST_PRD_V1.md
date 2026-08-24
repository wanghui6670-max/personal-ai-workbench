# Harness-First 重构 PRD v1

## 0. 产品结论

Personal AI Workbench 不再拥有 Harness。新的主体系是 **Harness Platform → Capabilities/Packs → Apps**。

第一性原理得到的根问题不是“怎样做更多工作台功能”，而是：如何给 AI 一个长期存在、可扩展、有状态、有权限、有工具、有时间入口、可审计的运行环境。

因此 Core 只保留七类不可再拆的合同：

1. Registry：系统现在拥有哪些能力。
2. Agent：谁在工作、允许使用什么。
3. Session：当前目标、上下文、决策、工件和检查点。
4. Tool：可执行的最小动作。
5. Approval：现实世界改变前的统一权限门。
6. Scheduler：时间/条件触发的 Agent 入口。
7. Event/Trace：所有执行都可回放、可审计。

## 1. Superpowers 工程方法

本项目采用以下强制开发循环：

`First Principles → Design → Acceptance Tests → Small Implementation Slice → Run Tests → Review → Commit`

禁止“看到功能就直接写进 Workbench”。任何新增能力先回答：

- 它是 Core 原语吗？
- 是 Capability / Plugin / Skill / Agent / View / Pack 中的哪一种？
- 能否在不修改 Core 的情况下安装？
- 写操作需要什么 Approval？
- 如何通过 Session 与 Event 保留连续性？

## 2. 硬架构边界

### Platform / Kernel
不得依赖 Feishu、Joycrew、GetNote、AIHot、GitHub 或任何具体业务名词。

### Capability Registry
负责安装 Pack 并注册 Capability、Tool、Agent、Schedule、Skill、View 元数据。重复 ID 必须 fail closed。

### Tool Contract
每个 Tool 必须声明：name、risk、execute；可选声明 validateInput、idempotent、reversible、approval。

风险级别：
- `read`：默认自动执行。
- `local_write`：默认自动执行，但仍进入 Event/Trace。
- `external_write`：默认 Confirm。
- `destructive`：必须 Explicit Approval。

### Session
Session 不是聊天记录。它是工作连续性的结构化真相：goal、context refs、events、decisions、artifacts、approvals、checkpoints、compacted memory。

### Scheduler
Scheduler 不直接调用业务函数，只负责创建/恢复 Session 并交给 Agent Runtime。

## 3. Workbench 的新身份

Personal AI Workbench 变成 `personal-workbench` Pack/App，当前 v3 的 Inbox、Todo、Project、Capture 迁移为 Business Capabilities；飞书、GitHub、本地文件、GetNote、Joycrew 迁移为插件或外部能力适配器。

用户体验可以在迁移期维持不变，但运行时主权必须逐步从 `src/server.mjs` 转移到 Platform。

## 4. Proof-of-Architecture

AIHot 被定义为第一道架构验收题：

> 不修改 Platform Core，只新增 AIHot Pack，即可注册只读信息源、Tool、Research Agent、Skill、Daily Scheduler 和可选 View。

如果接入 AIHot 必须修改 Kernel/Runtime，则 Harness-first 架构判定失败。

## 5. 当前切片验收

- [x] Core 不引用任何 Workbench/Feishu/Joycrew/AIHot 业务实现。
- [x] Pack 可动态注册 Capability、Tool、Agent、Schedule。
- [x] Tool 风险进入统一 Approval Engine。
- [x] Session 可原子持久化、记录 Tool Event 和 Checkpoint。
- [x] Scheduler 可计算下一次执行时间。
- [x] AIHot mock Pack 在不改 Core 情况下安装并被 Agent 调用。
- [x] Personal Workbench 已有独立 Pack manifest，开始降级为 App/Pack。

## 6. 下一迁移顺序

1. 将现有 `src/mcp/registry.mjs` 的通用 Tool 元数据与确认逻辑迁移到 Platform Tool/Approval contract。
2. 为 Feishu/Project/Joycrew 建立 Adapter Pack，先只读，再迁写入。
3. 把 Harness Navigator 降级成 Agent Profile，而不是产品主角。
4. 把 `src/server.mjs` 缩成 bootstrap：boot kernel → load packs → start transport/apps。
5. 保持 v3 UI 可用，直到 Workbench App 使用新 Registry 的读路径和写路径都通过回归测试。
6. 最后移除旧的重复 Planner/Approval wiring。
