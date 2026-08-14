# 个人 AI 项目管理工作台

这是一个**本地文件系统优先、AI 辅助、人保留最终决策权**的个人项目管理工作台。

## 当前数据边界

1. **滴答清单 CLI**：个人待办事实的单向来源。
2. **Workbench**：解析、去重、收件箱、待办、今日、确认和项目总控。
3. **本地项目文件夹**：真实工作产物；Git 保存版本证据。
4. **飞书项目文档**：项目分析、阶段总结、复盘和上下文恢复叙事的唯一真源。
5. **飞书《每日工作日记》**：个人待办快照和每日总结的沉淀目标，不再作为待办来源。
6. **本机 ICS**：只镜像源任务已有日期与时段，不猜测日期或时长。

AI 不自动分类收件箱，不自动改截止日期，也不自动把任务加入今日。

## 主要能力

- 固定 `ticktick` CLI 单向读取任务；国际版使用 `ticktick.com`，国内版使用 `dida365.com`
- 外部 task ID 去重、截止日期解析、完成状态同步和外部元数据保留
- 有截止日期进入正式待办；无截止日期进入收件箱等待用户处理
- 任务快照先写飞书并读回，再原子更新本机 ICS 和 Workbench 缓存
- 用户触发“沉淀今日总结”，正文只写飞书，不复制到本地审计日志
- 项目主动同步、飞书项目记录、operationId 幂等和跨资源恢复
- 最近 3 天与临近截止事项的早晨对焦；今日安排仍由用户决定
- iPhone Shortcut `/api/capture`，支持 `captureId` 幂等和冲突检测
- AI-native 双面板、受限 MCP、备份恢复、Docker 和 doctor

## 本地运行

要求：

- Node.js 20+
- Git
- `ticktick` CLI（启用个人待办来源时）
- `lark-cli`（启用飞书项目记录或每日工作日记时）

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

## 滴答 CLI → 飞书日记 → 本机日历

工作台始终执行固定二进制：

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

同步事务：

```text
读取 CLI
→ 解析和外部 task ID 去重
→ 写飞书任务快照并按 operationId 读回
→ 原子生成本机 ICS
→ 提交 Workbench 待办/收件箱缓存
```

规则：

- 有截止日期：进入正式待办。
- 无截止日期：进入收件箱，不猜日期。
- 明确完成：标记完成、移出今日、从下一版 ICS 移除。
- 没有完成证据：不根据“列表里消失”擅自判定完成。
- 同步不反向修改滴答，也不自动加入今日。
- 全天任务保持全天；没有完整时段时不猜持续时间。

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

目录权限 `0700`，文件权限 `0600`。每次同步原子重写完整日历；UID 由外部 task ID 哈希生成。

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

`POST /api/capture` 是独立快速采集入口，不是滴答主任务源。它只进入 Workbench 收件箱。

```json
{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "text": "刚刚想到的事情",
  "source": "iphone-shortcut"
}
```

同一 `captureId` + 同正文安全重放；同一 `captureId` + 不同正文返回冲突。

详见 [`docs/IPHONE_SHORTCUT.md`](docs/IPHONE_SHORTCUT.md)。

## 从旧飞书收件箱来源升级

启用新管线时，旧的：

```text
config.dataSource.provider = feishu_doc
```

会被清除。飞书不再被 AI/MCP 当作个人待办来源。历史本地收件箱事项不会被自动删除，应先备份再逐项处理。

## 数据、备份与恢复

默认数据目录：

```text
state.json   机器状态、任务、收件箱和确认项
config.json  工作区、业务板块和集成设置
calendar/    可从滴答重新生成的 ICS 镜像
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

外部采集使用独立 `CAPTURE_TOKEN`。工作台不读取、请求或保存滴答与飞书凭证，只调用部署用户已经登录的本机 CLI。

部署说明见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 测试

```bash
npm test
```

合同测试覆盖 CLI allowlist、账户区域、任务映射、飞书 operationId、ICS、真实 `JsonStore`、MCP 确认门、doctor、项目记录、Capture、备份和恢复。

测试使用 fake CLI、fake Provider 和 fake Feishu client，不等同于 live 滴答、飞书、系统日历、OpenAI、浏览器、iPhone 或生产部署验证。
