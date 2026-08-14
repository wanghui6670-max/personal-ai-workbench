# 滴答 CLI → 飞书工作日记 → 本机日历

## 1. 新的数据边界

个人工作台不再把飞书云文档同时作为待办来源和记录目标。

- **滴答清单 CLI**：待办事实的单向来源。
- **Personal AI Workbench**：解析、去重、显示、人工确认和项目上下文控制。
- **飞书云文档《每日工作日记》**：待办快照和每日总结的长期沉淀目标。
- **本机 ICS 文件**：明确日期和时间的日历镜像。

项目分析、阶段总结、复盘和恢复摘要仍然只保存到各项目绑定的飞书项目文档；本页描述的是个人层面的待办和每日工作日记。

## 2. CLI 与账户区域

工作台只执行一个固定二进制：

```text
ticktick
```

设置中的 `ticktick / dida365` 表示账户区域，不是任意可执行文件名：

```text
国际版：TICKTICK_HOST=ticktick.com
国内版：TICKTICK_HOST=dida365.com
```

不会从设置中执行任意 shell 命令，也不会保存 CLI 密码或令牌。

同步使用的受控命令表：

```text
ticktick sync --json
ticktick tasks list --json
ticktick tasks completed --json
```

`tasks completed` 不可用时，工作台会继续导入当前未完成任务，但不会把“没有出现在列表里”的任务擅自判为完成。

## 3. 待办映射

任务按外部 task ID 去重，不按标题去重。

### 有截止日期

进入正式待办，保留：

- 外部任务 ID；
- 标题与说明；
- 截止日期；
- 源中已有的开始/结束时间；
- 时区、全天标记、优先级和标签；
- 完成状态。

同步不会自动把待办加入“今日工作台”。工作台不反向修改滴答任务。

### 没有截止日期

进入工作台收件箱，来源标记为 `dida_cli`，等待用户明确截止日期或处理方式。系统不会生成一个猜测日期。

### 已完成任务

只有 CLI 明确返回已完成状态时，工作台才会：

- 把对应待办标记完成；
- 从“今日工作台”移除；
- 从下一版本机 ICS 日历中移除。

## 4. 飞书每日工作日记

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

同一 operationId 若已经对应不同正文，系统返回冲突并停止，不把它误判为安全重放。

任务同步会沉淀一份当日待办快照。每日总结由用户点击“沉淀今日总结”或明确要求 AI 执行后写入；不会后台自动发布。

## 5. 本机日历

工作台在私有数据目录中原子生成：

```text
data/calendar/personal-ai-workbench.ics
```

规则：

- 文件权限为 `0600`，目录权限为 `0700`；
- 只包含未完成且有截止日期的滴答任务；
- 有明确开始和结束时间且不是全天任务时，生成定时事件；
- 全天任务，或只有截止日期、没有完整时段时，生成全天事件；
- 不会猜测时长或替用户排期；
- 每次同步重写完整日历，因此完成任务会自然移除；
- UID 由外部任务 ID 哈希生成，保持稳定；
- 写入采用临时文件加原子替换，失败时清理临时文件。

该 ICS 文件可由 macOS Calendar、Windows 日历或其他支持 iCalendar 的本机软件导入或订阅。

## 6. 事务顺序

一次同步按以下顺序执行：

```text
滴答 CLI 完整读取
→ 生成稳定任务快照 operationId
→ 飞书写入与读回
→ 本机 ICS 原子写入
→ 工作台待办/收件箱状态提交
→ 保存不含正文的同步审计事件
```

如果飞书写入成功但后续步骤失败，重试会先按同一 operationId 查重，不盲目追加第二份任务快照。

## 7. MCP 工具

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个写操作都需要用户确认。旧的 `feishu_inbox_sync` 已从 AI/MCP 白名单移除。

## 8. 部署机器前置条件

启用管线的机器必须同时具备：

```text
ticktick CLI
lark-cli
```

并分别完成本机登录。`npm run doctor` 会检查二进制、账户区域、飞书日记配置和本机 ICS 路径，但不会执行真实外部写入。

Docker 只有在容器内同时安装 CLI、挂载其登录状态并持久化 `DATA_DIR` 时才能使用该管线；默认镜像不应被理解为已经包含个人 CLI 凭证。

## 9. 验证边界

仓库合同测试使用 fake CLI、fake 飞书和临时本地目录，不接触真实凭证。

代码合并前仍需要在部署机器上分别确认：

- `ticktick` 命令与实际 JSON 输出；
- CLI 已登录且能读取完整任务列表；
- 国内版账户确实使用 `TICKTICK_HOST=dida365.com`；
- `lark-cli` 已登录且有目标飞书文档读写权限；
- 本机日历软件能够导入或订阅生成的 ICS 文件。
