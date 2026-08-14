# 得到大脑 CLI → 飞书工作日记 → 本机日历

## 1. 数据边界

个人工作台不再把飞书云文档同时作为待办来源和记录目标。

- **得到大脑 CLI（`getnote`）**：个人笔记与会议待办的单向来源。
- **Personal AI Workbench**：分页读取、待办解析、稳定去重、日期识别、人工确认和项目上下文控制。
- **飞书云文档《每日工作日记》**：待办快照和每日总结的长期沉淀目标。
- **本机 ICS 文件**：能够确定日期或时刻的待办日历镜像。

项目分析、阶段总结、复盘和恢复摘要仍然只保存到各项目绑定的飞书项目文档；本页描述的是个人层面的待办和每日工作日记。

## 2. 得到大脑 CLI 合同

工作台只执行一个固定二进制：

```text
getnote
```

不会从设置中执行任意 shell 命令，也不会接受二进制路径、命令模板、认证 token 或 CLI 密码。

同步使用的受控只读命令：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote doctor -o json
```

`getnote notes` 分页读取最近笔记。每个 note ID 按字符串保存和传递，避免雪花 ID 被 JavaScript 数字截断。

`getnote note todos` 返回：

```json
{
  "meeting_todos": {
    "source": "summary_section",
    "items": [
      {"text": "8月20日下午3点前提交方案", "completed": false}
    ]
  }
}
```

如果笔记没有明确待办章节，得到大脑返回空列表；Workbench 接受空列表，**不使用模型猜测**、不从整篇正文自行生成任务。

## 3. 稳定身份

每条得到大脑待办的稳定外部 ID 基于：

```text
来源 note ID
+ 规范化待办文本
+ 同一笔记内相同文本的出现序号
```

然后使用 SHA-256 派生安全 ID。

因此：

- 同一句话出现在不同笔记中，不会被误合并；
- 同一笔记中重复出现相同待办，仍能分别保留；
- 待办顺序变化不会改变 ID；
- 不按标题跨笔记去重。

同时保留：

- 来源 note ID；
- 来源笔记标题；
- 来源笔记 URL；
- 来源笔记类型；
- `meeting_todos.source`；
- 上游 `completed` 状态。

## 4. 日期和时刻解析

Workbench 只从待办文字中识别可确定的表达：

```text
2026-08-20
2026年8月20日
8月20日
今天 / 明天 / 后天
18:30
下午3点 / 下午3点半
```

参照日期优先使用来源笔记的更新时间，其次使用创建时间。

### 有明确日期

进入正式待办，保留：

- 稳定外部 ID；
- 原始待办文本；
- 截止日期；
- 明确截止时刻；
- 来源笔记引用；
- 完成状态。

同步不会自动把待办加入“今日工作台”。工作台不反向修改得到大脑内容。

### 没有明确日期

以下表达不会被自动解释：

```text
下周
月底前
稍后
尽快
有空时
```

它们进入工作台收件箱，来源标记为 `getnote_cli`，等待用户明确日期或处理方式。系统不会生成猜测日期。

### 明确完成

只有 `getnote note todos` 明确返回 `completed=true` 时，工作台才会：

- 把已有对应待办标记完成；
- 从“今日工作台”移除；
- 从下一版本机 ICS 日历中移除。

如果本轮扫描没有出现某条旧待办，系统不会据此判定完成，因为最近笔记扫描窗口不等于完整历史任务数据库。

## 5. 飞书每日工作日记

固定章节：

```text
每日工作日记
```

固定记录类型：

```text
[WORKBENCH_DAILY_TODOS]
[WORKBENCH_DAILY_SUMMARY]
```

每条记录带稳定的：

```text
[WORKBENCH_OP:<operationId>]
```

写入采用：

```text
读取 → 查重 → 写入 → 按 operationId 读回确认
```

同一 operationId 若已经对应不同正文，系统返回 `FEISHU_DAILY_JOURNAL_OPERATION_CONFLICT` 并停止，不把它误判为安全重放。

任务同步会沉淀一份当日待办快照。每日总结由用户点击“沉淀今日总结”或明确要求 AI 执行后写入；不会后台自动发布。

飞书日记正文只保存到飞书。本地 activity 只写不含正文的审计事件。

## 6. 本机日历

工作台在私有数据目录中原子生成：

```text
data/calendar/personal-ai-workbench.ics
```

规则：

- 文件权限为 `0600`，目录权限为 `0700`；
- 只包含未完成且已确定日期的得到大脑待办；
- 有明确开始和结束时间且不是全天任务时，生成定时事件；
- 只有明确截止时刻、没有开始时刻时，生成只含 `DTSTART` 的瞬时事件；
- 只有日期时，生成全天事件；
- 不会猜测持续时长或替用户排期；
- 每次同步重写完整日历，因此完成任务会自然移除；
- UID 由稳定外部 ID 哈希生成；
- DESCRIPTION 包含来源笔记 ID、标题与链接；
- 写入采用临时文件加原子替换，失败时清理临时文件。

该 ICS 文件可由 macOS Calendar、Windows 日历或其他支持 iCalendar 的本机软件导入或订阅。工作台不调用系统日历 API。

## 7. 事务顺序

一次同步按以下顺序执行：

```text
分页读取最近笔记
→ 逐篇读取 meeting_todos
→ 解析日期并生成稳定外部 ID
→ 生成稳定任务快照 operationId
→ 飞书写入与读回
→ 本机 ICS 原子写入
→ 工作台待办/收件箱状态提交
→ 保存不含正文的同步审计事件
```

如果飞书写入成功但后续步骤失败，重试会先按同一 operationId 查重，不盲目追加第二份任务快照。

设置更新、任务同步和每日总结共用一把 mutation lease；并发冲突返回：

```text
EXTERNAL_TASK_PIPELINE_BUSY
```

## 8. MCP 工具

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个写操作都需要用户确认。旧的 `feishu_inbox_sync` 已从 AI/MCP 白名单移除。

确定性 planner 支持：

```text
同步得到大脑待办
从 Get笔记 拉取会议待办
沉淀今日总结
```

## 9. 错误来源纠正

此前若错误配置了：

```text
provider = dida_cli
cliFlavor = ...
```

规范化层会：

1. 把管线停用；
2. 设置 `lastSyncStatus=needs_reconfiguration`；
3. 要求用户重新确认得到大脑、飞书日记与本机日历设置。

用户确认保存新设置后，只删除 `source=dida_cli` 的机器导入待办和收件箱项，不删除手工事项、Capture、项目或其他来源数据。

## 10. 部署机器前置条件

启用管线的机器必须同时具备：

```text
getnote CLI
lark-cli
```

得到大脑 CLI 可通过以下命令安装或更新：

```bash
npx -y @getnote/cli@latest setup
```

并分别完成本机登录。`npm run doctor` 会执行只读的 `getnote doctor -o json`，检查安装、会员、登录、API 连通性、飞书日记配置和本机 ICS 路径，但不会执行真实外部写入。

Docker 只有在容器内同时安装 CLI、挂载其登录状态并持久化 `DATA_DIR` 时才能使用该管线；默认镜像不应被理解为已经包含个人 CLI 凭证。

## 11. 验证边界

仓库合同测试使用 fake CLI、fake 飞书和临时本地目录，不接触真实凭证。

代码合并前仍需要在部署机器上分别确认：

- `getnote doctor -o json` 成功；
- `getnote notes --limit 20 -o json` 返回真实笔记；
- 任选一篇会议笔记执行 `getnote note todos <note_id> -o json`，输出与实际账户一致；
- `lark-cli` 已登录且有目标飞书文档读写权限；
- 本机日历软件能够导入或订阅生成的 ICS 文件。
