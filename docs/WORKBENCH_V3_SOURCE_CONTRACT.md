# Personal AI Workbench v3 — 信息来源与 AI 处理合同

> 状态：**Normative / 当前有效**  
> 生效日期：2026-08-16  
> 本文档覆盖并取代 `README.md`、`docs/PRODUCT_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/API.md`、`docs/TASK_SOURCE_PIPELINE.md` 中与“个人事项主来源 / GetNote 待办同步 / 飞书是否为收件箱来源”相关的 v2 描述。旧文档中的 GetNote Task Sync v2 章节仅保留为历史兼容实现说明，不再定义当前产品入口。

## 1. 一句话合同

```text
个人工作事项：飞书云文档 → Workbench Inbox → AI 自动分析 → 用户确认 → Workbench 执行
内容素材：得到大脑 GetNote → 用户确认同步 → 自媒体 / 得到大脑内容（本地 Markdown）
状态真相：Workbench state
```

**不得再把得到大脑 `meeting_todos` 作为个人待办的产品级主来源。**

## 2. 个人工作事项：飞书是主入口

### 2.1 来源

- 主来源：飞书云文档中的“收件箱”章节与明确的 `[INBOX]` 条目。
- 读回实现：现有 `/api/inbox/sync` 与 MCP 工具 `feishu_inbox_sync`。
- 飞书同步只负责把来源事实读回 Workbench Inbox，不直接创建 Today 任务、不直接创建项目。
- Workbench 本地 `state.json` 继续是任务状态、用户决定、Today 选择、项目归属等个人状态的真相源。

### 2.2 AI 自动分析，但不自动执行

同步飞书后，工作台可以自动对读回的 Inbox 条目执行 AI **分析/规划**：

```text
Feishu [INBOX]
→ Workbench Inbox commit
→ /api/ai/plan
→ 可审计建议（优先 inbox_process）
→ 用户查看
→ 用户点击“确认并处理”
→ /api/ai/execute { confirmed: true }
→ Workbench domain transaction
```

硬边界：

1. **分析不等于执行。** 自动分析阶段不允许修改 Workbench 状态。
2. 任何 `inbox_process` 写操作继续受 MCP `requiresConfirmation=true` 和 `/api/ai/execute` 的确认门禁保护。
3. AI 不得自动加入 Today。
4. AI 不得自动新建项目。
5. 项目归属不唯一、缺少截止日期、需要新建项目或信息不足时，必须返回 clarification / “需要你决定”。
6. AI 不得仅凭猜测删除来源事项；删除建议必须有原始信息中的明确删除/丢弃意图，并且仍需用户确认。
7. AI plan 过期、目标 item 已变化或参数未通过 schema 校验时，必须 fail closed，重新分析。

## 3. 今日工作台与收件箱合并

v3 的主工作面是“**今日与收件箱**”，把以下信息放在同一页面：

- 今天明确要做的事项（Today，仍由用户明确加入）；
- 飞书同步回来的 Inbox；
- AI 对 Inbox 的自动分析和建议；
- 需要用户拍板的 clarification / 待确认；
- 逾期、待归类等需要关注的状态。

数据模型暂不强行合并 `todayPlan` 与 `inbox` 两个领域对象；本轮合并的是**用户工作面与决策流**，避免破坏已经验证过的状态机。

## 4. 最近工作现场与项目进度合并

v3 把“最近工作现场”和“项目进度”合并为同一项目现场视图。每个项目至少同时展示：

- 当前进度百分比 / 状态；
- 最近活动时间；
- 最近工作动作；
- 是否存在 blocker；
- 打开项目与主动刷新进度入口。

项目真实来源、项目文件同步、Git 证据和既有项目记录事务边界保持不变。

## 5. 得到大脑：只保留“自媒体内容来源”

### 5.1 产品定位

得到大脑不再进入个人待办主链路。v3 对用户暴露的 GetNote 能力只有：

- `getnote_content_status`：只读查看本地内容同步状态；
- `getnote_content_sync`：**用户确认后**，从 GetNote 只读拉取最近笔记原文并保存到本地内容库。

旧的以下工具不再注册进交互式 AI/MCP registry：

- `external_task_integration_read`
- `external_task_integration_update`
- `external_tasks_sync`
- `daily_summary_publish`

旧模块可暂时留在代码库用于迁移、历史数据兼容和回归，不构成当前产品能力面。

### 5.2 本地目录

第一次确认同步时，如果不存在“自媒体”业务，Workbench 创建一个业务板块，并使用固定内容子目录：

```text
<WORKSPACE_ROOT>/<业务序号>_自媒体/得到大脑内容/
```

目录中：

- 每篇可获得真实原文的 GetNote 笔记保存为稳定文件名的 Markdown；
- `.getnote-content-index.json` 保存最小同步索引、内容 hash、来源 note ID 和更新时间；
- 内容变化更新同一文件，不因为标题改变制造重复文件；
- 不自动删除本地历史文件。

### 5.3 内容真实性与安全

- GetNote 读取面保持 read-only。
- 内容同步工具不接受任意命令、任意 URL 或任意文件路径。
- 输出目录由 Workbench 业务目录和固定 `得到大脑内容` 子目录派生。
- 目录、索引和目标文件执行 symlink / 普通文件检查。
- 文件使用临时文件 + rename 原子写入。
- 对 `MEETING` / `AUDIO` / `WEB` / `MEDIA` 等类型，如果 API 没有提供对应的真实原文字段，单篇 **fail closed**；不得把 AI 摘要冒充来源原文写入内容库。
- GetNote 内容同步不会创建 Todo、不会进入 Inbox、不会加入 Today、不会写回 GetNote。

## 6. 交互能力面

当前 AI/MCP registry 应满足：

| 能力 | 是否暴露 | 是否需确认 |
|---|---:|---:|
| `feishu_inbox_sync` | 是 | 是 |
| `inbox_process` | 是 | 是 |
| `todo_today` | 是 | 是 |
| `getnote_content_status` | 是 | 否 |
| `getnote_content_sync` | 是 | 是 |
| `external_tasks_sync` | 否 | — |
| `external_task_integration_update` | 否 | — |

自然语言路由也必须遵守同一边界：

- “同步飞书收件箱” → `feishu_inbox_sync`；
- “同步得到大脑内容到自媒体” → `getnote_content_sync`；
- “查看得到大脑内容同步到哪里” → `getnote_content_status`；
- “同步得到大脑待办” → clarification，提示待办入口已经迁移到飞书。

## 7. 验收门禁

合并 v3 前，最新 HEAD 必须真实执行并通过：

1. Workbench contract tests；
2. Harness E2E；
3. Docker smoke。

任何一项没有获得 runner、没有执行步骤或 conclusion 不是 `success`，均不得视为通过。
