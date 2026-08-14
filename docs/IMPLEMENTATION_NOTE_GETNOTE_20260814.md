# 得到大脑 CLI 来源纠正记录（2026-08-14）

## 背景

需求中的“得到 CLI”指的是**得到大脑 / Get笔记 CLI**，不是滴答清单。此前错误实现已经把个人待办来源接到另一套任务 CLI，因此本次变更按真实上游合同整体纠正。

## 已核实的上游合同

固定二进制：

```text
getnote
```

安装或更新：

```bash
npx -y @getnote/cli@latest setup
```

工作台使用的只读命令：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote doctor -o json
```

`getnote note todos` 读取的是每篇笔记中的：

```text
meeting_todos.source
meeting_todos.items[].text
meeting_todos.items[].completed
```

上游没有明确待办章节时返回空列表，不调用模型猜测。

## 纠正后的链路

```text
得到大脑最近笔记
→ 逐篇读取 meeting_todos
→ 稳定外部 ID 与明确日期解析
→ 飞书《每日工作日记》任务快照写入并读回
→ 私有本机 personal-ai-workbench.ics 原子重建
→ Workbench 待办 / 收件箱机器状态提交
```

## 迁移行为

历史错误配置若包含：

```text
provider=dida_cli
cliFlavor=...
```

系统会先将管线停用并要求重新配置。用户明确保存得到大脑设置后，仅清理 `source=dida_cli` 的机器导入待办和收件箱项，不删除手工、Capture、项目或其他来源数据。

## 日期边界

只接受可确定表达：明确年月日、月日、今天、明天、后天和明确时刻。模糊表达如“下周”“稍后”“尽快”进入收件箱，不生成猜测日期。

## 验证边界

自动化测试使用 fake `getnote`、fake 飞书 client 与临时数据目录。代码测试不等同于真实得到大脑会员、登录、API、飞书写入或系统日历导入验证。
