# 产品规则（v1.3 draft）

> 个人待办事实从固定 `ticktick` CLI 单向读取。飞书《每日工作日记》只保存任务快照和每日总结，不再作为个人待办来源。

## 产品定位

这是一个以业务板块和项目为上下文边界的个人 AI 项目管理工作台。目标不是增加管理动作，而是让用户在频繁被打断后快速恢复工作现场。

## 最高规则

**AI 可以分析、提醒、解释和执行明确指令，但不能替用户安排。**

以下动作必须由用户明确触发：

- 把任务加入今日工作台；
- 改变待办截止日期；
- 改变项目计划结束日期；
- 将收件箱事项归入项目或转成待办；
- 把待归类项目归入业务板块；
- 执行外部待办同步；
- 发布每日总结；
- 追加飞书项目阶段总结；
- 执行旧项目叙事迁移。

## 最高数据规则

- 滴答清单是个人待办事实源；Workbench 只读，不反向创建、修改或删除任务。
- 本地项目文件夹是真实工作产物源。
- Git 是版本证据源。
- 飞书项目文档是项目分析、阶段总结、复盘和上下文恢复叙事的唯一真源。
- 飞书每日工作日记是个人任务快照与每日总结的沉淀目标。
- Workbench 只保存运行需要的结构化状态、引用、同步游标、幂等收据和恢复凭据。
- 本机 ICS 是可重建日历镜像，不是任务真源。

项目分析正文、卡点说明、恢复摘要、阶段总结和复盘正文不得复制进 `state.json`、`PROJECT.md`、activity 日志或浏览器持久化存储。

## 个人待办来源

工作台只执行固定二进制：

```text
ticktick
```

账户区域：

```text
国际版：TICKTICK_HOST=ticktick.com
国内版：TICKTICK_HOST=dida365.com
```

受控命令：

```text
ticktick sync --json
ticktick tasks list --json
ticktick tasks completed --json
```

设置不得提供任意 shell、命令模板、二进制路径或凭证字段。

### 任务映射

- 以外部 task ID 去重，不按标题去重。
- 有截止日期的 active task 映射为正式待办。
- 没有截止日期的 active task 进入 Workbench 收件箱，等待用户明确日期或处理方式。
- 明确完成的外部任务标记为完成，并从今日工作台移除。
- `tasks completed` 不可用时，不根据 active 列表缺失推断完成。
- 外部任务同步不得自动加入今日。
- 外部任务同步不得修改项目日期或自动创建项目。

## 飞书每日工作日记

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

任务同步写入当日任务快照。每日总结只由用户点击或明确 AI 指令发布。

写入顺序：

```text
读取
→ operationId 查重
→ 写入
→ operationId 读回
```

- operationId 必须根据实际写入正文生成。
- 相同 operationId + 相同正文是安全重放。
- 相同 operationId + 不同正文返回 `409` 并停止。
- 写入和读回失败时，不提交本地成功状态。
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
- UID 由外部 task ID 哈希生成；
- 只包含未完成且有截止日期的外部任务；
- 明确开始和结束且非全天时生成定时事件；
- 全天任务保持全天；
- 缺少完整时段时生成全天截止事件，不猜时长；
- 每次同步重建日历，完成任务自然移除；
- 不调用系统日历 API，不自动安装或订阅。

## 外部待办同步事务

```text
CLI 完整读取
→ 生成任务快照和稳定 operationId
→ 飞书任务快照写入并读回
→ 本机 ICS 原子替换
→ Workbench 待办/收件箱状态提交
→ 不含正文的审计事件
```

飞书成功而后续步骤失败时，重试必须先按 operationId 查重，不能盲目追加第二条快照。

## 信息结构

1. 收件箱：iPhone Capture、手工输入和无截止外部任务的待处理入口。
2. 今日工作台：用户当天明确决定执行的待办。
3. 业务板块：一级导航和一级本地目录。
4. 项目：独立上下文容器。
5. 待确认：AI 不确定或跨资源事务需要人工核对的事项。
6. 待归类：业务归属不明确的项目。
7. 逾期：超过计划结束时间且未结束的项目。
8. 工作日志：机器审计日志，不保存项目或日记正文。
9. 飞书项目文档：项目长期叙事真源。
10. 飞书每日工作日记：个人任务快照和每日总结。
11. 本机 ICS：日历镜像。

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

`POST /api/capture` 是独立快速采集入口，不是滴答主任务源。

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
- ICS 不进入备份真源，可从滴答来源重建。
- 旧备份没有凭据字段时，保留当前凭据目录，而不是静默清空。
- 恢复任一阶段失败必须尝试整体回滚。

## 升级规则

启用新外部待办管线时：

```text
config.dataSource.provider = feishu_doc
```

被清除。历史本地收件箱事项保留，不能自动删除或自动合并到滴答任务。

## 验证边界

自动化测试使用 fake CLI、fake Provider、fake Feishu 和临时数据目录。

测试通过不等同于：

- 真实 TickTick/Dida365 登录有效；
- 真实飞书可读写；
- 真实系统日历成功导入；
- live OpenAI；
- 真实浏览器、iPhone 或生产部署已验收。
