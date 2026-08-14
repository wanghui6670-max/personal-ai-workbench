# API 概览

所有普通 `/api/*` 请求在启用 `WORKBENCH_PASSWORD` 时需要有效登录 cookie。

所有 `POST`、`PATCH`、`DELETE` 请求必须发送 `Content-Type: application/json`。浏览器请求如果带 `Origin`，该值必须属于默认本机 origin 或 `TRUSTED_ORIGINS`。所有请求仍校验实际 `Host`，不会采信 `X-Forwarded-*` 自动放宽。

个人待办的正式来源是固定得到大脑 CLI `getnote`；飞书《每日工作日记》是任务快照和每日总结的沉淀目标。本机日历通过私有 ICS 文件生成。飞书不再是个人待办来源。外部任务主链路使用受限 MCP 工具，不提供任意 shell、任意二进制或任意文件路径 API。

## 1. 健康、状态、导出与备份

### `GET /api/health`

只读 readiness。未就绪返回：

```json
{"ok":false,"status":"not_ready"}
```

`200` 只证明当前文件系统和配置可用，不证明得到大脑、飞书、系统日历、OpenAI、浏览器或 iPhone 已 live 验证。

### `GET /api/state`

返回前端派生状态和非敏感集成设置。项目分析正文、飞书每日总结正文和 CLI 凭证不在响应中。

外部任务管线设置位于：

```text
config.settings.externalTaskPipeline
```

示例：

```json
{
  "enabled": true,
  "provider": "getnote_cli",
  "noteLimit": 100,
  "journalDocumentUrl": "https://example.feishu.cn/wiki/token",
  "journalHeading": "每日工作日记",
  "calendarEnabled": true,
  "calendarName": "个人 AI 工作台",
  "lastSyncAt": "2026-08-14T02:00:00.000Z",
  "lastSyncStatus": "ok",
  "lastSourceNoteCount": 42,
  "lastParsedTodoCount": 18,
  "lastCalendarPath": "/private/data/calendar/personal-ai-workbench.ics"
}
```

若读取到历史误配置 `provider=dida_cli` 或 `cliFlavor`，领域规范化结果会把集成停用并返回 `lastSyncStatus=needs_reconfiguration`，直到用户明确保存得到大脑设置。

### `GET /api/export`

`GET /api/export` 导出当前 `state` 和 `config`，用于检查或迁移业务数据。它**不是完整恢复包**，不包含：

- `/workspace`；
- Capture 幂等收据；
- 项目记录跨资源恢复凭据；
- 飞书项目或每日工作日记正文；
- 得到大脑或飞书 CLI 登录状态；
- 本机日历客户端配置；
- 任何凭证。

需要可恢复的完整本地控制面快照时使用 `POST /api/backup` 或 `npm run backup`。

### `POST /api/backup`

请求体：

```json
{}
```

backup v2：

```json
{
  "backupVersion": 2,
  "backedUpAt": "2026-08-14T02:00:00.000Z",
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts` 只保存正文 SHA-256 和标识符。
- `projectRecordReceipts` 只保存机器进度、operationId 和飞书指针。
- 两者都不保存项目分析、每日总结或 Capture 正文。
- ICS 是可重建镜像，不属于恢复真源。

恢复：

```bash
npm run restore -- /path/to/backup.json
```

旧备份没有 `captureReceipts` 或 `projectRecordReceipts` 字段时，恢复器保留当前凭据目录，而不是静默清空。详见 `docs/DEPLOYMENT.md`。

## 2. AI-native 双面板与 MCP

- `GET /api/ai/tools`：读取白名单工具元数据。
- `POST /api/ai/plan`：生成工具预览。
- `POST /api/ai/execute`：执行预览；写工具必须显式确认。
- `POST /api/mcp`：MCP-compatible JSON-RPC，支持 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`。

模型只提出白名单调用；本地注册表负责 schema 校验、确认门、互斥锁、领域规则和执行后状态读回。

MCP 调用格式：

```json
{
  "jsonrpc": "2.0",
  "id": "call-1",
  "method": "tools/call",
  "params": {
    "name": "external_tasks_sync",
    "arguments": {},
    "confirmed": true
  }
}
```

未确认写工具返回 `MCP_CONFIRMATION_REQUIRED`。

## 3. 得到大脑外部待办管线

### 固定 CLI 合同

程序只执行：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote doctor -o json
```

- `getnote notes` 分页返回最近笔记；note ID 按字符串处理。
- `getnote note todos` 返回 `meeting_todos.source` 和 `meeting_todos.items`。
- 没有明确待办章节时，接受空列表；不使用模型猜测。
- 设置不能提供 shell、二进制路径、命令模板、认证 token 或自定义 CLI 参数。

### `external_task_integration_read`

只读，返回最近笔记扫描数量、飞书日记目标、本机日历设置和最近同步机器状态，不返回得到大脑或飞书凭证。

```json
{
  "jsonrpc": "2.0",
  "id": "integration-read",
  "method": "tools/call",
  "params": {
    "name": "external_task_integration_read",
    "arguments": {}
  }
}
```

### `external_task_integration_update`

写操作，需要确认。允许字段：

```json
{
  "enabled": true,
  "noteLimit": 100,
  "journalDocumentUrl": "https://example.feishu.cn/wiki/token",
  "journalHeading": "每日工作日记",
  "calendarEnabled": true,
  "calendarName": "个人 AI 工作台"
}
```

约束：

- `noteLimit` 必须是 20–500 的整数；
- 程序始终执行固定 `getnote` 二进制；
- 启用时必须提供官方 Feishu/Lark HTTPS 文档 URL；
- 不接受命令模板、shell、二进制路径、ICS 路径或凭证；
- 启用后清除旧 `config.dataSource.provider=feishu_doc` 个人收件箱来源；
- 若历史配置误用了 `provider=dida_cli` 或 `cliFlavor`，用户确认新设置时仅清理 `source=dida_cli` 的机器导入待办和收件箱项；手工与 Capture 数据保留。

### `external_tasks_sync`

需要确认。事务顺序：

```text
分页读取最近笔记
→ 对每篇笔记执行 getnote note todos
→ 解析 meeting_todos 并生成稳定外部 ID
→ 生成实际飞书快照正文和 operationId
→ 飞书写入并读回
→ 私有 ICS 原子替换
→ Workbench 待办/收件箱状态提交
→ 不含正文的审计事件
```

稳定外部 ID：

```text
SHA-256(来源 note ID + 规范化待办文本 + 同文出现序号)
```

映射：

- 未完成 + 有明确日期 → 正式待办；
- 未完成 + 日期不确定 → Workbench 收件箱；
- `completed=true` → 已有待办标记完成并移出今日；
- 本轮扫描缺失 → 不推断完成；
- 同步不会自动加入今日，也不会反向修改得到大脑。

成功结果示例：

```json
{
  "provider": "getnote_cli",
  "fetchedAt": "2026-08-14T02:00:00.000Z",
  "noteCount": 42,
  "todoCount": 18,
  "activeCount": 15,
  "completedCount": 3,
  "changes": {
    "created": 2,
    "updated": 4,
    "completed": 1,
    "undated": 3,
    "scheduled": 12
  },
  "journal": {
    "operationId": "tasks-2026-08-14-...",
    "blockId": "block_...",
    "replayed": false
  },
  "calendar": {
    "enabled": true,
    "path": "/private/data/calendar/personal-ai-workbench.ics",
    "eventCount": 12,
    "writtenAt": "2026-08-14T02:00:00.000Z"
  }
}
```

### `daily_summary_publish`

需要确认。可选参数：

```json
{
  "notes": "今天确认了供应商，并完成交付检查。"
}
```

系统根据当天明确完成的得到大脑待办、今日到期事项和 Workbench 关键动作生成总结，并写入飞书固定章节。正文不复制到本地 activity。

幂等规则：

- 同一 operationId + 同正文：安全重放；
- 同一 operationId + 不同正文：`409 FEISHU_DAILY_JOURNAL_OPERATION_CONFLICT`；
- 写入后必须按 operationId 唯一读回，并校验正文一致。

### 外部管线互斥

以下三个写操作共用一把互斥租约：

```text
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

冲突返回 `409 EXTERNAL_TASK_PIPELINE_BUSY`。调用方不得并发自动重试。

## 4. 本机 ICS 日历合同

固定路径：

```text
<data-dir>/calendar/personal-ai-workbench.ics
```

- 目录权限 `0700`；
- 文件权限 `0600`；
- 临时文件写入后原子 rename；
- 失败时清理临时文件；
- 只包含未完成且已确定日期的得到大脑待办；
- 非全天且具有完整开始/结束时间时生成定时事件；
- 只有明确截止时刻时生成只含 `DTSTART` 的瞬时事件，不猜 `DTEND`；
- 只有明确日期时生成全天事件；
- UID 由稳定外部 ID 的 SHA-256 派生；
- DESCRIPTION 包含来源笔记 ID、标题和链接；
- 不调用系统日历 API，不自动导入或订阅。

没有单独的“写任意本机日历路径”API。

## 5. 飞书个人工作日记合同

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

飞书不再是个人待办来源。旧 `POST /api/inbox/sync` 和 `config.dataSource.provider=feishu_doc` 仅为旧安装/独立 Capture 兼容保留，不属于 AI/MCP 个人待办主路径，也不会由新 UI 调用。

## 6. iPhone / 外部采集

### `POST /api/capture`

位于普通登录检查之前，但必须满足以下任一授权：

- `Authorization: Bearer <CAPTURE_TOKEN>`；
- 有效登录会话。

推荐请求：

```json
{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "text": "联系设计师确认海报终稿",
  "source": "iphone-shortcut"
}
```

- `captureId`：8–128 位安全 ID；推荐 UUID。
- 同 ID + 同正文：安全重放。
- 同 ID + 不同正文：`409 CAPTURE_ID_CONFLICT`。
- 已处理事项重放不会重新进入收件箱。
- Capture 是独立快速采集入口，不是得到大脑主来源。
- Capture 不自动成为待办或加入今日。

## 7. 收件箱

- `POST /api/inbox`：手工新增待处理事项。
- `POST /api/inbox/command`：按用户明确指令处理。
- `POST /api/inbox/sync`：旧飞书 `[INBOX]` 来源兼容接口；新 UI 和 AI/MCP 不调用。
- `POST /api/capture`：iPhone / 外部快速采集。

正式待办仍必须有合法截止日期。无明确日期的得到大脑待办进入收件箱，等待用户明确处理，不会被自动赋予日期。

项目名只有唯一完整名称命中时才允许直接处理。仅前缀命中或多个候选时返回 `needsProjectSelection`。

## 8. 项目飞书记录工具

### `project_records_read`

只读，从项目绑定的飞书文档读取最近分析与总结：

```json
{
  "jsonrpc": "2.0",
  "id": "project-read",
  "method": "tools/call",
  "params": {
    "name": "project_records_read",
    "arguments": {
      "projectId": "p_xxx",
      "limit": 20,
      "beforeBlockId": "optional_cursor"
    }
  }
}
```

- `limit` 默认 20，硬上限 100；
- 最新记录优先；
- 正文不写入 `state.json` 或浏览器持久化存储。

### `project_summary_append`

需要确认，把用户明确提供的阶段总结追加到项目飞书文档：

```json
{
  "jsonrpc": "2.0",
  "id": "project-summary",
  "method": "tools/call",
  "params": {
    "name": "project_summary_append",
    "arguments": {
      "projectId": "p_xxx",
      "text": "阶段总结正文"
    },
    "confirmed": true
  }
}
```

正文最大 6000 字符。本地只保存机器记录指针和不含正文的审计事件。

## 9. 项目 REST API

- `POST /api/projects`：从收件箱创建项目；必须传 `description`、`endDate`、`sourceInboxId`。
- `POST /api/projects/sync`：同步全部活跃且已归类项目。
- `POST /api/projects/:id/sync`：同步单项目。
- `POST /api/projects/:id/classify`：用户明确归类。
- `PATCH /api/projects/:id`：编辑介绍、Git、飞书链接、结束日期、完成或归档状态。

项目新建和归类从第一次落盘开始就只写 identity-only `PROJECT.md`。

持久化 `project.progress` 只允许：

```text
percent
status
hasBlocker
lastActivity
syncedAt
confidence
feishuRevisionId
feishuRecordBlockId
feishuRecordedAt
feishuOperationId
```

项目分析、卡点、恢复摘要、阶段总结和复盘正文只保存飞书项目文档。

## 10. 今日与待办 API

- `POST /api/today`：用户明确设置今日任务集合。
- `POST /api/todos`：创建正式待办；必须提供合法截止日期。
- `PATCH /api/todos/:id`：修改标题、上下文、日期或完成状态。

已完成待办不能加入今日。外部同步不会自动调用 `POST /api/today`。

## 11. 配置、业务板块与认证

- `PATCH /api/config`：更新工作区和非敏感设置。
- `POST /api/businesses`：新增业务板块。
- `PATCH /api/businesses/:id`：重命名业务板块。
- `DELETE /api/businesses/:id`：删除空业务板块。
- `GET /api/auth/status`、`POST /api/auth/login`、`POST /api/auth/logout`：本地访问控制。

外部任务集成不通过普通配置 API 接受命令字符串；必须走受 schema 约束且需要确认的 MCP 工具。

## 12. 错误边界

常见错误码：

```text
MCP_CONFIRMATION_REQUIRED
EXTERNAL_TASK_PIPELINE_BUSY
EXTERNAL_TASK_CLI_MISSING
EXTERNAL_TASK_SOURCE_INVALID_JSON
EXTERNAL_TASK_SOURCE_SCHEMA
EXTERNAL_TASK_INTEGRATION_NOT_CONFIGURED
INVALID_FEISHU_JOURNAL
FEISHU_DAILY_JOURNAL_OPERATION_CONFLICT
LOCAL_CALENDAR_WRITE_FAILED
CAPTURE_ID_CONFLICT
```

错误响应不得包含 CLI stdout 原文、认证资料、飞书正文或本地绝对工作内容。
