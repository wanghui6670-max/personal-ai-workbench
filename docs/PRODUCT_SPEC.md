# 产品规则（v1.4 draft）

> 得到大脑是个人笔记和明确会议待办事实源；Personal AI Workbench 是个人任务状态、Inbox 和 Today 决定真源。飞书《每日工作日记》是任务快照和每日总结的可选沉淀目标，不再作为个人待办来源。

## 产品定位

这是一个以业务板块和项目为上下文边界的个人 AI 项目管理工作台。目标不是增加管理动作，而是让用户在频繁被打断后快速恢复工作现场。

## 最高规则

**AI 可以分析、提醒、解释和执行明确指令，但不能替用户安排。**

以下动作必须由用户明确触发：

- 把任务加入今日工作台；
- 改变 Workbench 本地待办截止日期；
- 改变项目计划结束日期；
- 将收件箱事项归入项目或转成待办；
- 把待归类项目归入业务板块；
- 执行得到大脑待办同步；
- 发布每日总结；
- 追加飞书项目阶段总结；
- 执行旧项目叙事迁移。

## 最高数据规则

- 得到大脑是个人笔记与明确会议待办事实源；Workbench 只读，不反向创建、修改或删除得到大脑内容。
- Personal AI Workbench 是个人 Todo、Inbox、Today 选择、用户项目归属、优先级和本地 tags 的状态真源。
- 本地项目文件夹是真实工作产物源。
- Git 是版本证据源。
- 飞书项目文档是项目分析、阶段总结、复盘和上下文恢复叙事的唯一真源。
- 飞书《每日工作日记》是个人任务快照与每日总结的可选沉淀目标，不是个人待办来源。
- Workbench 只保存运行需要的结构化状态、来源引用、幂等收据和恢复凭据。
- 本机 ICS 是可重建日历镜像，不是任务真源。

项目分析正文、卡点说明、恢复摘要、阶段总结和复盘正文不得复制进 `state.json`、`PROJECT.md`、activity 日志或浏览器持久化存储。

## 个人待办来源

业务层只依赖统一只读 `GetNoteReader`：

```text
listNotes
fetchTodos
fetchNote
status
```

`local_cli` transport 固定使用：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote note <note_id> -o json
getnote doctor -o json
```

VPS/Docker 可以通过 `private_http` 连接宿主机只读 Runtime sidecar；Workbench 容器不需要拥有 getnote CLI 或其登录凭证。设置不得提供任意 shell、命令模板、二进制路径或任意 URL。

### 上游待办语义

- 每次同步读取“最近 N 篇”以及 Workbench 中仍未完成 GetNote Todo/Inbox 对应的旧 `sourceNoteId`，按 note ID 去重。
- `getnote note todos` / `fetchTodos` 返回 `meeting_todos.source` 与 `meeting_todos.items`。
- `items[].text` 是待办原文，`completed=true` 是得到大脑明确提供的完成事实。
- 若笔记没有明确待办章节，上游返回空列表；Workbench 不使用模型猜测或从整篇正文自行生成正式 Todo。
- 来源笔记 ID、标题、链接、创建/更新时间与 `meeting_todos.source` 被保留为可追溯元数据。
- 某事项本轮缺失，不推断已完成。旧未完成 note 继续被有界追踪。

### 稳定身份

优先使用上游稳定 todo ID：

```text
todo_id / todoId / task_id / taskId / id
```

有 source todo ID 时，以 `noteId + sourceTodoId` 派生外部 ID；文本编辑不改变身份。

没有稳定 source ID 时，继续使用历史兼容公式：

```text
noteId + 规范化待办文本 + 同文出现序号
```

旧 fingerprint 向 source ID 的迁移必须无歧义；fallback 文案改名也只有同 note 恰好一旧一新时才自动继承。不能按相似度批量猜测合并。

### 日期与时区

- 明确日期映射为正式 Todo。
- 相对日期锚点固定为 `note.createdAt → note.updatedAt → 当前日期 fallback`，不能把后续编辑时间优先当作“今天/明天”的参照。
- 只有月份和日期时，以来源笔记参照年份解释，不自动滚到下一年。
- “下周”“稍后”“尽快”等模糊表达不得自动转成日期。
- 任务携带显式 IANA 时区，默认 `Asia/Shanghai`；VPS 系统时区不能改变任务含义。
- 明确本地时刻的 ICS 使用任务时区；只有明确截止时刻时生成瞬时事件，不猜持续时间。

### Workbench 用户所有权

来源同步可以更新：

- 来源标题；
- 来源明确日期/时刻；
- 来源笔记引用；
- source todo ID；
- 上游明确完成状态。

来源同步不得擅自覆盖：

- `projectId`；
- 本地 priority / priorityLabel；
- 本地 tags；
- Today 选择。

Todo 与 Inbox 因来源日期出现/消失互相迁移时，Workbench 实体 ID 和上述用户字段继续保留。

如果来源日期消失：

- 未选 Today 的 Todo → Inbox；
- 已选 Today 的 Todo → 保留 Todo 与 Today，记录 `sourceDueDate=null`，表示来源计划已撤回但用户今日决定仍有效。

只有得到大脑明确 `completed=true` 时，已有 Todo 才标记完成并从 Today 移除。

## GetNote Task Sync 核心事务

强事务只有：

```text
读取 GetNote（最近 N + 未完成旧 note）
→ Normalize / Reconcile
→ Workbench state 原子提交
```

只有这三步失败，才算核心同步失败。

Workbench 提交成功后再执行：

```text
Workbench committed
       │
       ├─→ 飞书任务快照（可选 sink）
       └─→ ICS 原子重建（可选 sink）
```

飞书或 ICS 失败时：

- 不回滚 Workbench；
- 返回各自 sink 错误状态；
- `lastSyncStatus=ok_with_sink_errors`；
- 留下不含任务正文的机器审计事件；
- 后续通过用户再次显式同步重试。

外部同步不得自动加入 Today、替用户排优先级、修改项目计划或自动创建项目。

## 飞书每日工作日记

飞书日记 URL **不是启用 GetNote Task Sync 的必填项**。

未配置时：

```text
journal.status = not_configured
```

核心 GetNote → Workbench 同步仍然成功。

固定章节：

```text
每日工作日记
```

固定前缀：

```text
[WORKBENCH_DAILY_TODOS]
[WORKBENCH_DAILY_SUMMARY]
[WORKBENCH_OP:<operationId>]
```

配置飞书 sink 后，任务同步会尝试沉淀当日任务快照。每日总结只由用户点击或明确 AI 指令发布，并且每日总结要求已配置飞书日记 URL。

飞书写入流程：

```text
读取
→ operationId 查重
→ 写入
→ operationId 读回
```

- operationId 必须根据实际写入正文生成。
- 相同 operationId + 相同正文是安全重放。
- 相同 operationId + 不同正文返回 `409` 并停止。
- 飞书 sink 写入/读回失败只影响该 sink 状态，不撤销已经成功的 Workbench 核心提交。
- 飞书日记正文不得复制到本地 activity。

## 本机日历

固定输出：

```text
data/calendar/personal-ai-workbench.ics
```

规则：

- 目录权限 `0700`，文件权限 `0600`；
- 临时文件写入后原子替换；
- 失败时清理临时文件；
- UID 由稳定外部待办 ID 哈希生成；
- 只包含未完成且已确定日期的得到大脑待办；
- 全天任务使用 `VALUE=DATE`；
- 无 offset 的明确时刻使用任务 IANA `TZID`，不依赖 VPS 系统时区；
- 已带 offset 的时刻可规范化为 UTC；
- 只有明确截止时刻时生成瞬时事件，不补造 `DTEND`；
- 每次同步完整重建日历，完成任务自然移除；
- 不调用系统日历 API，不自动安装或订阅。

ICS 失败只影响日历 sink，不回滚 Workbench 核心任务提交。

## 信息结构

1. 收件箱：iPhone Capture、手工输入和无明确日期外部待办的待处理入口。
2. 今日工作台：用户当天明确决定执行的待办。
3. 业务板块：一级导航和一级本地目录。
4. 项目：独立上下文容器。
5. 待确认：AI 不确定或跨资源事务需要人工核对的事项。
6. 待归类：业务归属不明确的项目。
7. 逾期：超过计划结束时间且未结束的项目。
8. 工作日志：机器审计日志，不保存项目或日记正文。
9. 飞书项目文档：项目长期叙事真源。
10. 飞书每日工作日记：可选个人任务快照和每日总结 sink。
11. 本机 ICS：可重建日历镜像。

## 项目规则

- 创建输入：自然语言项目描述 + 用户明确的计划结束日期。
- 开始日期：默认创建当天。
- 中间阶段由 AI 从项目资料识别，不要求用户维护。
- 不存在自动“暂停”状态。
- 只有真实文件变化或 Git 证据才能推动项目工作痕迹。
- 项目进度只在用户主动同步时计算。
- 不自动生成下一步动作或改变日期。

## 项目文件夹

```text
业务板块/
└── 项目/
    ├── PROJECT.md
    ├── 01_原始资料/
    ├── 02_工作过程/
    ├── 03_最终交付/
    └── 99_归档/
```

`PROJECT.md` 只保存身份、业务、日期、Git、飞书项目文档链接和叙事真源声明。

禁止保存：

```text
summary
resume
blocker
阶段总结
复盘正文
```

## 项目飞书记录

固定章节：

```text
项目分析与总结
```

记录：

```text
[WORKBENCH_ANALYSIS] [WORKBENCH_OP:<operationId>] ...
[WORKBENCH_SUMMARY] [WORKBENCH_OP:<operationId>] ...
```

项目同步先写飞书并读回，再提交本地机器进度和飞书指针。项目页按需从飞书临时读取，不做浏览器正文持久化。

## AI 与 MCP

模型只能提出白名单 MCP 工具调用；本地注册表负责 schema 校验、确认门、领域规则和执行后状态读回。

外部待办工具：

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个工具需要确认。旧 `feishu_inbox_sync` 不再属于白名单。

项目记录工具：

```text
project_records_read
project_summary_append
```

Provider 不可达、输出不合约或参数不合法时，显式使用本地安全回退。AI 失败不能改变收件箱、日期或今日计划。

## iPhone Capture

`POST /api/capture` 是独立快速采集入口，不是得到大脑主来源。

每条采集必须有 `captureId`：

- 同一 `captureId` + 同正文：安全重放；
- 同一 `captureId` + 不同正文：`409`；
- 采集只进入收件箱，不自动成为待办或加入今日。

Capture 收据只保存正文 SHA-256 和标识符，不保存正文。

## backup v2

```json
{
  "backupVersion": 2,
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts` 不保存 Capture 正文。
- `projectRecordReceipts` 不保存项目分析或总结正文。
- ICS 不进入备份真源，可从得到大脑来源重建。
- **旧备份没有凭据字段时，保留当前凭据目录**，而不是静默清空。
- 恢复任一阶段失败必须尝试整体回滚。

## 升级与错误接入纠正

启用新的得到大脑外部待办管线时：

```text
config.dataSource.provider = feishu_doc
```

被清除。历史手工收件箱事项保留。

若发现此前误写入的：

```text
provider = dida_cli
cliFlavor = ...
```

系统必须停用该配置并要求用户重新确认。用户保存新的得到大脑设置后，仅删除 `source=dida_cli` 的机器导入待办和收件箱项；不得删除手工、Capture、项目或其他来源数据。

## 验证边界

自动化测试使用 fake CLI / fake private Runtime、fake Provider、fake Feishu 和临时数据目录。

测试通过不等同于：

- 真实得到大脑会员与登录状态有效；
- 真实得到大脑 API 当前可达；
- 真实 GetNote Runtime sidecar 已部署；
- 真实飞书可读写；
- 真实系统日历成功导入；
- live OpenAI；
- 真实浏览器、iPhone 或生产部署已验收。
