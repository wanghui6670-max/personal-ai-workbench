# 个人 AI 项目管理工作台

这是一个**本地文件系统优先、AI 辅助、人保留最终决策权**的个人项目管理工作台。

## 当前数据边界

1. **得到大脑 CLI（`getnote`）**：个人笔记与会议待办的单向来源。
2. **Workbench**：分页读取、待办解析、稳定去重、收件箱、正式待办、今日、确认和项目总控。
3. **本地项目文件夹**：真实工作产物；Git 保存版本证据。
4. **飞书项目文档**：项目分析、阶段总结、复盘和上下文恢复叙事的唯一真源。
5. **飞书《每日工作日记》**：个人待办快照和每日总结的沉淀目标，不再作为个人待办来源。
6. **本机 ICS**：只镜像从待办文字中能够确定的日期或时刻，不猜测模糊日期和持续时长。

AI 不自动分类收件箱，不自动改截止日期，也不自动把任务加入今日。

## 主要能力

- 固定执行 `getnote`，分页读取最近笔记，并对每篇笔记调用 `getnote note todos <note_id> -o json`
- 使用得到大脑返回的 `meeting_todos.source` 和 `meeting_todos.items`，不让模型自行发明待办
- 以“来源笔记 ID + 待办文本 + 同文出现序号”生成稳定外部 ID
- 能确定日期的未完成事项进入正式待办；不能确定日期的事项进入收件箱等待用户处理
- 得到大脑明确返回 `completed=true` 时同步完成状态；不会根据事项消失擅自推断完成
- 任务快照先写飞书并读回，再原子更新本机 ICS 和 Workbench 缓存
- 用户触发“沉淀今日总结”，正文只写飞书，不复制到本地审计日志
- 项目主动同步、飞书项目记录、operationId 幂等和跨资源恢复
- 最近 3 天与临近截止事项的早晨对焦；今日安排仍由用户决定
- iPhone Shortcut `/api/capture`，支持 `captureId` 幂等和冲突检测
- AI-native 双面板、受限 MCP、backup v2、恢复、Docker 和 doctor

## 本地运行

要求：

- Node.js 20+
- Git
- 得到大脑 CLI `getnote`（启用个人待办来源时）
- `lark-cli`（启用飞书项目记录或每日工作日记时）

安装或更新得到大脑 CLI：

```bash
npx -y @getnote/cli@latest setup
```

可先执行只读自检：

```bash
getnote doctor -o json
```

启动工作台：

```bash
cp .env.example .env
npm run doctor
npm start
```

默认地址：

```text
http://127.0.0.1:4173
```

项目没有第三方 npm 运行依赖，不需要 `npm install`。

## 得到大脑 CLI → 飞书日记 → 本机日历

工作台始终执行固定二进制：

```text
getnote
```

受控只读命令：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote doctor -o json
```

`getnote notes` 用于分页列出最近笔记；`getnote note todos` 读取每篇笔记中由得到大脑明确识别的会议待办。若笔记没有明确待办章节，CLI 返回空列表，Workbench 不使用模型猜测。

同步事务：

```text
分页读取最近笔记
→ 逐篇读取 meeting_todos
→ 解析明确日期并生成稳定外部 ID
→ 写飞书任务快照并按 operationId 读回
→ 原子生成本机 ICS
→ 提交 Workbench 待办/收件箱缓存
```

规则：

- 待办文字中有明确日期：进入正式待办。
- 日期不可确定：进入收件箱，不猜日期。
- 有明确时刻但没有开始时刻：生成一个只含 `DTSTART` 的瞬时日历事件，不猜持续时长。
- 得到大脑明确标记完成：标记完成、移出今日、从下一版 ICS 移除。
- 没有完成证据：不根据“本次结果里没有出现”擅自判定完成。
- 同步不反向修改得到大脑，也不自动加入今日。
- “下周”“稍后”“尽快”等模糊表达不会自动变成日期。

飞书固定章节与记录类型：

```text
每日工作日记
[WORKBENCH_DAILY_TODOS]
[WORKBENCH_DAILY_SUMMARY]
[WORKBENCH_OP:<operationId>]
```

同一 operationId 已对应不同正文时返回冲突并停止。

完整合同见 [`docs/TASK_SOURCE_PIPELINE.md`](docs/TASK_SOURCE_PIPELINE.md)。

## 本机日历

生成路径：

```text
data/calendar/personal-ai-workbench.ics
```

目录权限 `0700`，文件权限 `0600`。每次同步原子重写完整日历；UID 由稳定外部待办 ID 哈希生成。

工作台只生成 ICS 文件，不调用系统日历 API，也不替用户排期。用户可在 macOS Calendar、Windows 日历或其他 iCalendar 客户端中导入或订阅。

## 项目记录

`PROJECT.md` 只是项目身份证，不保存进度说明、卡点、恢复摘要或总结正文。

飞书项目文档固定章节：

```text
项目分析与总结
```

项目记录格式：

```text
[WORKBENCH_ANALYSIS] [WORKBENCH_OP:<operationId>] ...
[WORKBENCH_SUMMARY] [WORKBENCH_OP:<operationId>] ...
```

项目页临时读取飞书正文，不使用 `localStorage`、`sessionStorage` 或 IndexedDB 保存项目叙事。

详见 [`docs/PROJECT_RECORDS.md`](docs/PROJECT_RECORDS.md)。

## MCP 工具

外部待办：

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个写操作需要用户确认。旧 `feishu_inbox_sync` 已从 AI/MCP 白名单移除。

项目记录：

```text
project_records_read
project_summary_append
```

MCP transport：`POST /api/mcp`。

## iPhone 快捷指令

`POST /api/capture` 是独立快速采集入口，不是得到大脑主来源。它只进入 Workbench 收件箱。

```json
{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "text": "刚刚想到的事情",
  "source": "iphone-shortcut"
}
```

同一 `captureId` + 同正文安全重放；同一 `captureId` + 不同正文返回冲突。

详见 [`docs/IPHONE_SHORTCUT.md`](docs/IPHONE_SHORTCUT.md)。

## 来源迁移与错误接入纠正

启用得到大脑管线时，旧的：

```text
config.dataSource.provider = feishu_doc
```

会被清除，飞书不再被 AI/MCP 当作个人待办来源。

如果已有配置包含误接入字段：

```text
provider = dida_cli
cliFlavor = ...
```

工作台会将该管线标记为“需要重新配置”并保持停用。用户明确保存新的得到大脑设置时，只清理 `source=dida_cli` 的机器导入待办和收件箱项；手工事项、Capture 事项、项目和飞书项目记录不受影响。

## 数据、备份与恢复

默认数据目录：

```text
state.json   机器状态、任务、收件箱和确认项
config.json  工作区、业务板块和集成设置
calendar/    可从得到大脑待办重新生成的 ICS 镜像
backups/     自动与手工 backup v2
migrations/  升级快照和迁移报告
captures/    Capture 幂等收据
recovery/    飞书跨资源事务恢复凭据
```

手工备份：

```bash
npm run backup
```

backup v2 的恢复字段保持为：

```json
{
  "backupVersion": 2,
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts` 只保存正文 SHA-256 和标识符。
- `projectRecordReceipts` 只保存机器进度、operationId 和飞书指针。
- backup v2 不包含项目工作区、飞书正文、CLI 登录状态、ICS 客户端配置或任何凭证。
- ICS 是可重建镜像，不是恢复真源。

恢复前停止工作台：

```bash
npm run restore -- /path/to/backup.json
npm run doctor
npm start
```

## 安全

非 localhost 部署至少设置：

```bash
WORKBENCH_PASSWORD="a-strong-password"
SESSION_SECRET="replace-with-a-long-random-secret"
TRUSTED_ORIGINS="https://workbench.example.com"
COOKIE_SECURE=1
```

外部采集使用独立 `CAPTURE_TOKEN`。工作台不读取、请求或保存得到大脑与飞书凭证，只调用部署用户已经登录的本机 CLI。

部署说明见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 测试

```bash
npm test
```

合同测试覆盖固定 `getnote` 命令、分页、字符串 note ID、`meeting_todos`、稳定去重、日期解析、飞书 operationId、ICS、真实 `JsonStore`、MCP 确认门、doctor、项目记录、Capture、backup v2 和恢复。

测试使用 fake CLI、fake Provider 和 fake Feishu client，不等同于 live 得到大脑、飞书、系统日历、OpenAI、浏览器、iPhone 或生产部署验证。
