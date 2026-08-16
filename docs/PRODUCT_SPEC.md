# 产品规则（v3.0）

> 当前有效来源合同：飞书云文档是个人工作事项主入口；Personal AI Workbench 是个人状态与用户决定真源；得到大脑只保留为自媒体内容来源。完整来源合同见 `docs/WORKBENCH_V3_SOURCE_CONTRACT.md`。

## 产品定位

这是一个以业务板块和项目为上下文边界的个人 AI 工作台。目标不是增加管理动作，而是让用户在频繁被打断后快速恢复工作现场，并把外部信息先收进同一个可确认的处理队列。

## 最高规则

**AI 可以分析、提醒、解释和提出白名单操作，但不能替用户安排，也不能把“分析”当成“执行”。**

以下动作必须由用户明确确认：

- 把任务加入或移出 Today；
- 改变 Workbench 本地待办截止日期；
- 改变项目计划结束日期；
- 将收件箱事项归入项目、转成待办、备忘或删除；
- 新建项目或把待归类项目放入业务板块；
- 同步飞书收件箱；
- 同步得到大脑内容到自媒体本地内容库；
- 追加飞书项目阶段总结；
- 执行 Joycrew 的 Run、交付或审批写操作。

## 最高数据规则

- 飞书云文档“收件箱”章节是个人工作事项主入口。
- Personal AI Workbench 是 Todo、Inbox、Today、项目归属、优先级、用户日期和确认结果的状态真源。
- 本地项目文件夹是真实工作产物源。
- Git 是版本证据源。
- 飞书项目文档是项目分析、阶段总结、复盘和上下文恢复叙事的唯一长期真源。
- 得到大脑 GetNote 是自媒体内容来源；Workbench 只读，不反向修改 GetNote。
- Workbench 只保存运行需要的结构化状态、来源引用、幂等收据和恢复凭据。

项目分析正文、卡点说明、恢复摘要、阶段总结和复盘正文不得复制进 `state.json`、`PROJECT.md` 或 activity 日志。

## 个人工作事项主链路

```text
飞书 [INBOX]
→ /api/inbox/sync
→ Workbench Inbox 原子提交
→ AI 自动分析 /api/ai/plan
→ 用户确认
→ /api/ai/execute
→ Workbench domain transaction
```

规则：

- 飞书同步本身不创建 Today、不自动创建项目。
- 单条 AI 审阅只允许针对目标 Inbox item 生成 `inbox_process` 预览或 clarification。
- 自动审阅只使用目标 item 与未归档项目目录的最小必要上下文；不得把其他 Inbox 原文、Todo、Today 或确认项一起发给模型。
- 自动分析队列必须有并发和容量上限；不能一次性并发整批模型请求。
- 未变化事项允许短时复用已有分析预览，减少重复模型调用。
- 项目归属不唯一、缺少截止日期、需要新建项目或信息不足时必须停在“需要你决定”。
- 删除建议必须能从原始事项里看到明确删除/丢弃意图，且仍需人工确认。
- AI 不自动加入 Today。

## Today

- Today 只包含用户明确加入的待办。
- AI 可以建议，但不得自动加入或移出。
- 完成待办后从 Today 移除。
- 外部来源变化不得擅自撤销用户已经明确做出的 Today 决定。

## 项目现场与进度

“最近工作现场”和“项目进度”在同一视图展示：

- 当前进度百分比与状态；
- 最近活动；
- blocker；
- 打开项目；
- 用户主动同步项目进度。

项目进度只有真实文件变化、Git 证据或明确项目记录才能推动；不自动生成下一步动作或改变计划日期。

## 得到大脑：自媒体内容来源

当前对用户暴露的 GetNote 能力只有：

```text
getnote_content_status
getnote_content_sync
```

`getnote_content_sync` 需要用户确认，并固定写入：

```text
<WORKSPACE_ROOT>/<业务序号>_自媒体/得到大脑内容/
```

规则：

- 只读 GetNote；
- 不创建 Todo；
- 不进入 Inbox；
- 不加入 Today；
- 不写回 GetNote；
- 不接受任意命令、任意 URL 或任意文件路径；
- 对无法获得真实原文字段的内容类型 fail closed，不把 AI 摘要冒充来源原文；
- 文件使用稳定文件名、内容 hash 和原子替换，不自动删除本地历史文件。

旧 GetNote Task Sync v2 的 `external_tasks_sync`、`external_task_integration_update` 等代码仅作为历史兼容实现保留，不属于当前交互式 AI/MCP 能力面。

## 业务板块与项目

- 创建项目输入：自然语言项目描述 + 用户明确的计划结束日期。
- 开始日期默认创建当天。
- 中间阶段可由 AI 从项目资料识别。
- 不存在自动“暂停”状态。
- 项目完成由用户明确确认。

项目目录：

```text
业务板块/
└── 项目/
    ├── PROJECT.md
    ├── 01_原始资料/
    ├── 02_工作过程/
    ├── 03_最终交付/
    └── 99_归档/
```

`PROJECT.md` 只保存身份、业务、日期、Git、飞书项目文档链接和叙事真源声明，不保存项目总结正文。

## 飞书项目记录

固定章节：

```text
项目分析与总结
```

项目同步先写飞书并读回，再提交本地机器进度和飞书指针。项目页按需读取飞书正文，不把项目叙事持久化到浏览器。

## Joycrew 与 Harness

- Personal AI Workbench 是浏览器唯一日常入口。
- Joycrew 提供客户、企业项目、业务任务、AI 员工、Run、Evidence、Approval 和 Deliverable。
- 两套任务不会自动互相覆盖。
- Joycrew 写操作采用 `Preview → Confirm → Execute → Readback`。
- Harness 只能使用固定白名单工具，不拥有任意 Shell、任意 Web 或任意文件系统写入。
- Joycrew 离线不能阻塞个人工作台本机 readiness。

## iPhone Capture

`POST /api/capture` 是独立快速采集入口。

- 同一 `captureId` + 同正文：安全重放；
- 同一 `captureId` + 不同正文：冲突；
- Capture 只进入 Inbox，不自动成为待办或 Today。

Capture 收据只保存正文 SHA-256 和标识符，不保存正文。

## backup v2

恢复包格式继续保持：

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
- 旧备份没有凭据字段时，保留当前凭据目录，而不是静默清空。
- 恢复任一阶段失败必须尝试整体回滚。

## macOS 常驻

正式常驻使用 LaunchAgent，不把 `npm start` 当作正式上线完成。

安装切换必须：

1. 先生成并 lint replacement plist；
2. 再停止旧服务；
3. 等端口释放；
4. bootstrap 新服务；
5. health + commit 读回；
6. 任一步失败都尝试恢复旧服务；
7. 如果恢复也失败，必须同时报告原错误和恢复错误，不能吞错。

`restart` 同样必须有故障恢复，不允许把“重启失败”变成静默停机。

## 版本与验收

当前产品版本：**3.0.0**。

合并到 `main` 前，最新 HEAD 必须真实执行并通过：

1. Workbench contract tests；
2. Harness E2E；
3. Docker smoke。

自动化通过不等于真实飞书、GetNote、Joycrew、模型 Provider、iPhone Shortcut 或 macOS LaunchAgent 已完成现场验收；现场状态必须单独读回。
