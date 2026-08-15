# 得到大脑 → Workbench Task Sync v2 → 飞书 / ICS

## 1. 数据边界

个人工作台不把飞书同时当作任务来源和任务状态真源。

- **得到大脑（`getnote`）**：个人笔记与明确 `meeting_todos` 的单向外部来源。
- **Personal AI Workbench**：个人任务状态、Inbox、Today 选择和用户项目归属的真源。
- **飞书云文档《每日工作日记》**：可选的待办快照和每日总结沉淀 sink。
- **ICS 文件**：可选的、可重建的日历镜像 sink。

Task Sync 不反向修改得到大脑。飞书和 ICS 失败都不能回滚已经提交的 Workbench 任务状态。

## 2. GetNote Reader 合同

业务层只依赖统一只读 `GetNoteReader`：

```text
listNotes
fetchTodos
fetchNote
status
```

本地 CLI transport 固定执行：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote note <note_id> -o json
getnote doctor -o json
```

不会从设置中接收任意 shell、argv 模板或外部命令。VPS/Docker 也可以通过受控私网 Runtime sidecar 使用同一 Reader 合同。

如果笔记没有明确待办章节，得到大脑返回空列表；Workbench 接受空列表，**不使用模型猜测**、不从整篇正文自行生成正式任务。正文 AI 解析属于独立的 GetNote Insight 链路。

## 3. 扫描窗口与旧任务追踪

每次手动同步读取两组笔记：

```text
A. 最近 N 篇笔记
+
B. Workbench 中仍未完成的 GetNote Todo / Inbox 对应 sourceNoteId
```

两组按 `noteId` 去重后再读取 `meeting_todos`。

因此旧会议即使已经离开“最近 N 篇”，只要其中仍有 Workbench 未完成外部事项，就会继续追踪来源状态。只有上游明确返回 `completed=true` 才确认完成；某条任务本轮没有出现，绝不据此猜测完成。

该策略仍然是有界、按需的，不做得到大脑全量镜像或后台扫描。

## 4. 稳定任务身份

### 4.1 上游提供稳定 todo ID

若 `meeting_todos.items[]` 提供以下任一稳定字段：

```text
todo_id / todoId / task_id / taskId / id
```

Workbench 以：

```text
noteId + sourceTodoId
```

派生外部 ID。待办文案编辑不会改变身份。

### 4.2 上游没有稳定 todo ID

才退化到：

```text
noteId
+ 规范化待办文本
+ 同文案出现序号
```

并标记 `externalIdentityKind=fallback_text`。

若旧版本文本指纹和新解析结果不一致，只允许两种保守迁移：

1. 新结果开始提供稳定 source todo ID，且 `noteId + 规范化标题` 唯一匹配旧实体；
2. 同一 note 中去掉所有精确匹配后，恰好只剩一个旧实体和一个新的 fallback 实体。

其他歧义场景不自动合并。

## 5. 日期、相对时间和时区

Workbench 只从待办文字中识别可确定表达：

```text
2026-08-20
2026年8月20日
8月20日
今天 / 明天 / 后天
18:30
下午3点 / 下午3点半
```

相对日期锚点顺序固定为：

```text
note.createdAt
→ note.updatedAt
→ 当前日期 fallback
```

**updatedAt 不再优先**，避免旧会议后来编辑后把“今天/明天”整体漂移。

任务配置必须携带显式 IANA 时区，例如：

```text
Asia/Shanghai
```

定时 ICS 事件使用该 `TZID`，不能依赖 VPS 的系统时区解释无 offset 的本地时间。

以下模糊表达仍然不自动转成正式日期：

```text
下周
月底前
稍后
尽快
有空时
```

## 6. Workbench 状态对账

### 有明确日期

进入正式 Todo。新建任务不会自动加入 Today。

来源同步可以更新：

- 标题；
- 来源日期 / 时刻；
- 来源笔记引用；
- 上游完成状态。

来源同步不得覆盖用户拥有的：

- `projectId`；
- 本地 priority / priorityLabel；
- 本地 tags；
- Today 选择。

### 无明确日期

默认进入 Inbox。

如果某个已存在 Todo 的来源日期后来被移除：

- **未被用户选入 Today**：转回 Inbox；
- **已经被用户选入 Today**：保留现有 Workbench Todo 和 Today 选择，标记 `externalStatus=active_without_due_date_today_preserved`，并把 `sourceDueDate` 设为 `null`。

这是“来源计划”和“用户已经做出的今日决定”的边界。来源变化不能擅自撤销 Today。

### 明确完成

只有 `getnote note todos` 明确返回 `completed=true` 时：

- 对应 Todo 标记完成；
- 从 Today 移除；
- 下一版 ICS 自然移除。

## 7. 核心事务边界

一次同步的强事务只包含：

```text
读取 GetNote
→ Normalize / Reconcile
→ Workbench state 原子提交
```

只有这三步失败，`external_tasks_sync` 才视为核心同步失败。

状态提交成功后才执行派生 sink：

```text
Workbench committed
       │
       ├─→ 飞书每日任务快照
       └─→ ICS 原子重建
```

飞书或 ICS 失败时：

- 不回滚 Workbench；
- 返回各自 `status=error` 和短错误信息；
- `lastSyncStatus=ok_with_sink_errors`；
- 本地留下不含任务正文的 `external_task_sink_failed` 审计事件；
- 允许之后重试派生输出。

因此不会再出现“飞书临时不可用 → 得到大脑任务也无法进入 Workbench”。

## 8. 飞书每日工作日记

飞书 URL **不是启用 Task Sync 的必填项**。

配置后，任务同步会尝试沉淀当日快照；未配置时返回：

```text
journal.status = not_configured
```

飞书写入仍使用稳定 operationId：

```text
读取 → 查重 → 写入 → 按 operationId 读回确认
```

同一 operationId 若已经对应不同正文，返回 `FEISHU_DAILY_JOURNAL_OPERATION_CONFLICT`。

每日总结是显式用户动作，仍然要求已经配置飞书每日工作日记 URL；未配置时返回 `FEISHU_DAILY_JOURNAL_NOT_CONFIGURED`。不会后台自动发布。

## 9. ICS 日历镜像

工作台在私有数据目录中原子生成：

```text
data/calendar/personal-ai-workbench.ics
```

规则：

- 文件 `0600`，目录 `0700`；
- 只镜像未完成且有明确日期的来源任务；
- 全天事项使用 `VALUE=DATE`；
- 明确本地时刻使用 `TZID=<配置时区>`；
- 已带 offset 的时间可以规范成 UTC；
- 不猜持续时长；
- UID 由稳定外部 ID 派生；
- 每次完整重建，因此来源明确完成后自然消失。

ICS 是派生镜像，不是 Workbench 的任务真源。

## 10. MCP 与人工控制

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个写操作需要用户确认。旧的 `feishu_inbox_sync` 已从 AI/MCP 白名单移除。

同步仍然是用户主动触发；不增加定时后台扫描。

## 11. 部署前置条件

### 核心 GetNote Task Sync

只要求目标运行环境能通过 `GetNoteReader` 读到真实得到大脑数据。

VPS 推荐：

```text
VPS 宿主机 getnote CLI
→ 只读 GetNote Runtime sidecar
→ Workbench Docker private_http reader
```

### 可选飞书 sink

只有启用飞书每日任务快照或每日总结时，宿主环境才需要有效的 `lark-cli` 登录和目标文档权限。

### 验证

真实环境至少分别验证：

```text
getnote doctor -o json
getnote notes --limit 20 -o json
getnote note todos <note_id> -o json
```

仓库合同测试继续使用 fake reader、fake 飞书和临时目录，不接触真实凭证。
