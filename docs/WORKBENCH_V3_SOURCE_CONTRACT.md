# Personal AI Workbench v3 — 信息来源与 AI 处理合同

> 状态：**Normative / 当前有效**  
> 生效日期：2026-08-16  
> 本文档覆盖并取代旧文档中与“个人事项主来源 / GetNote 待办同步 / 飞书是否为收件箱来源”相关的 v2 描述。旧 GetNote Task Sync v2 仅保留为历史兼容实现说明，不再定义当前产品入口。

## 1. 一句话合同

```text
个人工作事实：飞书工作日记 → 增量识别新增/变化内容 → Workbench 待处理流 → AI 分类/建议 → 用户确认 → Workbench 执行
内容素材：得到大脑 GetNote → 用户确认同步 → 自媒体 / 得到大脑内容（本地 Markdown）
状态真相：Workbench state
```

**不得再把得到大脑 `meeting_todos` 作为个人待办的产品级主来源。**

## 2. 飞书工作日记是个人工作事实主入口

### 2.1 飞书文档允许混合内容

用户不需要为了 Workbench 重构自己的日记格式。同一份飞书工作日记可以同时包含：

- 明确待办；
- 项目进展；
- 分析与思考；
- 日常记录；
- 需要用户后续决定的内容；
- 显式 `[INBOX]` 条目。

兼容规则：

1. 如果文档存在一级标题 `收件箱`，该章节继续按旧合同读取其中 `[INBOX]` 条目，保持向后兼容。
2. 如果没有 `收件箱` 章节，Workbench 进入 **mixed diary** 模式，读取整篇文档中有 block ID 的 `p / checkbox / li` 内容，并保留最近的 h1/h2/h3 标题路径作为上下文。
3. `[INBOX]` 是强信号，但不再是混合日记模式的唯一可读格式。
4. Workbench 不把整本日记直接转成 Todo，也不直接改变 Today 或项目状态。

### 2.2 增量同步与首次绑定

同步接口仍为 `/api/inbox/sync`，MCP 工具名暂时继续使用 `feishu_inbox_sync` 以保持兼容；产品语义已经是“飞书日记增量同步”。

混合日记模式必须满足：

- 每个飞书 block 以 `blockId + contentHash` 形成最小来源指纹；
- 同一个 block 内容未变化时不得重复进入待处理流；
- 同一个 block 内容发生变化时，应作为新的来源事实重新进入 AI 分析；
- 来源 block 被删除时，对应尚未处理的本地待处理项撤下；
- 首次绑定不得把整本历史日记全部灌入当前工作面：最多把文档头部 30 条 + 尾部 30 条送入待处理流，其余历史只建立 hash 基线；
- 首次建立基线的旧 block 后续如果被修改，仍会重新进入待处理流。

首次绑定的 30 + 30 是**防历史洪水的有界窗口**，不是“只永久读取 60 条”；后续新增/变化扫描覆盖整篇文档。

### 2.3 Workbench 向飞书写入

用户从 Workbench / iPhone Capture 新增事项时，不能把内容随意插入用户日记正文。

- 如果原文档已有配置的 `收件箱` 章节，则继续写入该章节；
- 如果是混合日记且没有该章节，Workbench 可以在文档末尾自动创建专用一级标题 `Workbench 收件箱`；
- Workbench 自己写入的新事项使用 `[INBOX]` 前缀；
- 自动创建 `Workbench 收件箱` 不改变、不移动、不重写原有日记正文。

## 3. AI 自动分类，但不自动执行

飞书日记新增/变化内容进入 Workbench 后，AI 对**单条内容**进行分析。服务端必须把单条日记审阅限制为：

- 当前目标 block 的正文；
- 该 block 的飞书标题路径 / 块类型；
- 最多 30 个未归档项目的目录级摘要；
- 唯一允许提议的写工具 `inbox_process`。

不得把其他 Inbox 原文、Todo、Today、确认项或项目长正文一起发送给 AI Provider。

AI 首先判断内容属于：

```text
待办 / 项目进展 / 分析思考 / 日常记录 / 需要用户决定
```

建议规则：

- **待办**：可建议创建待办；没有明确截止日期必须 clarification；
- **项目进展**：项目唯一匹配时可建议归入项目记录；不唯一必须 clarification；
- **分析思考 / 日常记录**：默认建议保存为备忘，不自动变成任务；
- **需要用户决定 / 信息不足 / 需要新项目**：必须 clarification；
- AI 不得自动加入 Today；
- AI 不得自动新建项目；
- AI 不得删除飞书原文；
- AI 不得因猜测而处理内容。

处理链路：

```text
Feishu diary block
→ Workbench 待处理流 commit
→ /api/ai/plan (inbox-review)
→ 可审计建议
→ 用户查看
→ 用户点击“确认并处理”
→ /api/ai/execute { confirmed: true }
→ Workbench domain transaction
```

**分析不等于执行。** 任何会改变 Workbench 状态的动作仍受 `requiresConfirmation=true` 保护。

## 4. 今日工作台与待处理流

v3 主工作面把以下内容放在同一页面：

- 今天已经明确确认要做的事项；
- 飞书日记新增/变化后进入的待处理内容；
- AI 对这些内容的自动分类和建议；
- 需要用户拍板的 clarification / 待确认；
- 逾期、待归类等需要关注的状态。

`todayPlan` 与 Inbox/待处理流仍然是不同领域对象；合并的是用户工作面，不允许 AI 因为“识别成待办”就自动把内容加入 Today。

## 5. 最近工作现场与项目进度

v3 把“最近工作现场”和“项目进度”合并为同一项目现场视图。每个项目至少同时展示：

- 当前进度百分比 / 状态；
- 最近活动时间；
- 最近工作动作；
- 是否存在 blocker；
- 打开项目与主动刷新进度入口。

项目分析正文和总结记录继续只写入绑定的飞书项目文档；机器进度与状态继续由 Workbench state 管理。

## 6. 得到大脑：只保留自媒体内容来源

得到大脑不再进入个人待办主链路。v3 对用户暴露：

- `getnote_content_status`：只读查看本地内容同步状态；
- `getnote_content_sync`：用户确认后，从 GetNote 只读拉取可获得真实原文的笔记并保存到本地内容库。

旧 `external_tasks_sync` / `external_task_integration_update` 等待办工具不再注册进交互式 AI/MCP registry。

固定本地内容目录：

```text
<WORKSPACE_ROOT>/<业务序号>_自媒体/得到大脑内容/
```

GetNote 内容同步不会创建 Todo、不会进入待处理流、不会加入 Today、不会写回 GetNote。

## 7. 当前交互能力面

| 能力 | 是否暴露 | 是否需确认 |
|---|---:|---:|
| `feishu_inbox_sync`（兼容名，语义=飞书日记增量同步） | 是 | 是 |
| `inbox_process` | 是 | 是 |
| `todo_today` | 是 | 是 |
| `getnote_content_status` | 是 | 否 |
| `getnote_content_sync` | 是 | 是 |
| `external_tasks_sync` | 否 | — |
| `external_task_integration_update` | 否 | — |

自然语言路由必须遵守：

- “同步飞书日记 / 同步工作日记” → `feishu_inbox_sync`；
- “同步得到大脑内容到自媒体” → `getnote_content_sync`；
- “同步得到大脑待办” → clarification，提示个人工作事实主入口已经迁移到飞书日记。

## 8. 验收门禁

涉及飞书混合日记同步的变更，最新 HEAD 必须真实执行并通过：

1. Workbench contract tests；
2. Browser Boot Smoke（如果前端有变更）；
3. Harness E2E；
4. Docker smoke。

任何一项没有获得 runner、没有执行步骤或 conclusion 不是 `success`，均不得视为通过。
