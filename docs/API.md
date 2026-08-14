# API 概览

所有普通 `/api/*` 请求在启用 `WORKBENCH_PASSWORD` 时需要有效登录 cookie。

所有 `POST`、`PATCH`、`DELETE` 请求必须发送 `Content-Type: application/json`。浏览器请求如果带 `Origin`，该值必须属于默认本机 origin 或 `TRUSTED_ORIGINS`。所有请求仍校验实际 `Host`，不会采信 `X-Forwarded-*` 自动放宽。

个人待办的正式来源是固定 `ticktick` CLI；飞书《每日工作日记》是任务快照和每日总结的沉淀目标。本机日历通过私有 ICS 文件生成。外部任务主链路使用受限 MCP 工具，不提供任意 shell 或任意文件路径 API。

## 1. 健康、状态、导出与备份

### `GET /api/health`

只读 readiness。未就绪返回：

```json
{"ok":false,"status":"not_ready"}
```

`200` 只证明当前文件系统和配置可用，不证明 TickTick/Dida365、飞书、系统日历、OpenAI、浏览器或 iPhone 已 live 验证。

### `GET /api/state`

返回前端派生状态和非敏感集成设置。项目分析正文、飞书每日总结正文和 CLI 凭证不在响应中。

外部任务管线设置位于：

```text
config.settings.externalTaskPipeline
```

可能包含：

```json
{
  "enabled": true,
  "provider": "dida_cli",
  "cliFlavor": "dida365",
  "journalDocumentUrl": "https://example.feishu.cn/wiki/token",
  "journalHeading": "每日工作日记",
  "calendarEnabled": true,
  "calendarName": "个人 AI 工作台",
  "lastSyncAt": "2026-08-14T02:00:00.000Z",
  "lastSyncStatus": "ok",
  "lastCalendarPath": "/private/data/calendar/personal-ai-workbench.ics"
}
```

`cliFlavor` 表示账户区域，不是任意可执行文件名：

```text
ticktick → TICKTICK_HOST=ticktick.com
dida365  → TICKTICK_HOST=dida365.com
```

### `GET /api/export`

导出当前 `state` 和 `config`，用于检查或迁移业务数据。它不是完整恢复包，不包含：

- `/workspace`；
- Capture 幂等收据；
- 项目记录跨资源恢复凭据；
- 飞书项目或每日工作日记正文；
- CLI 登录状态；
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

### MCP 调用格式

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

## 3. 外部待办管线 MCP 工具

### `external_task_integration_read`

只读，返回滴答账户区域、飞书日记目标、本机日历设置和最近同步机器状态，不返回 CLI 或飞书凭证。

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
  "cliFlavor": "dida365",
  "journalDocumentUrl": "https://example.feishu.cn/wiki/token",
  "journalHeading": "每日工作日记",
  "calendarEnabled": true,
  "calendarName": "个人 AI 工作台"
}
```

约束：

- `cliFlavor` 只允许 `ticktick` 或 `dida365`；
- 程序始终执行固定 `ticktick` 二进制；
- 启用时必须提供官方 Feishu/Lark HTTPS 文档 URL；
- 不接受命令模板、shell、二进制路径、ICS 路径或凭证；
- 启用后清除旧 `config.dataSource.provider=feishu_doc` 个人收件箱来源；
- 历史本地收件箱事项不会自动删除。

### `external_tasks_sync`

需要确认。事务顺序：

```text
ticktick CLI 完整读取
→ 解析并按外部 task ID 去重
→ 生成实际飞书快照正文和 operationId
→ 飞书写入并读回
→ 私有 ICS 原子替换
→ Workbench 待办/收件箱状态提交
→ 不含正文的审计事件
```

映射：

- active + 有截止日期 → 正式待办；
- active + 无截止日期 → Workbench 收件箱；
- CLI 明确完成 → 标记完成并移出今日；
- `tasks completed` 不可用 → 不根据 active 列表缺失推断完成；
- 同步不会自动加入今日，也不会反向修改滴答任务。

成功结果示例：

```json
{
  "provider": "dida_cli",
  "cliFlavor": "dida365",
  "host": "dida365.com",
  "activeCount": 12,
  "completedCount": 3,
  "changes": {
    "created": 2,
    "updated": 4,
    "completed": 1,
    "undated": 2
  },
  "journal": {
    "operationId": "tasks-2026-08-14-...",
    "blockId": "block_...",
    "replayed": false
  },
  "calendar": {
    "enabled": true,
    "path": "/private/data/calendar/personal-ai-workbench.ics",
    "eventCount": 10,
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

系统根据当天明确完成的滴答任务、今日到期事项和 Workbench 关键动作生成总结，并写入飞书固定章节。正文不复制到本地 activity。

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
- 只包含未完成且有截止日期的外部任务；
- 非全天且具有完整开始/结束时间时生成定时事件；
- 全天任务或缺少完整时段时生成全天事件；
- UID 由外部 task ID 的 SHA-256 派生；
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
- Capture 是独立快速采集入口，不是滴答主任务源。
- Capture 不自动成为待办或加入今日。

## 7. 收件箱

- `POST /api/inbox`：手工新增待处理事项。
- `POST /api/inbox/command`：按用户明确指令处理。
- `POST /api/inbox/sync`：旧飞书 `[INBOX]` 来源兼容接口；新 UI 和 AI/MCP 不调用。
- `POST /api/capture`：iPhone / 外部快速采集。

正式待办仍必须有合法截止日期。无截止日期的滴答任务进入收件箱，等待用户明确处理，不会被自动赋予日期。

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

`summary`、`resume`、`blocker` 和其他项目叙事字段会被校验器拒绝。

项目同步接口不返回分析正文，只返回机器状态、扫描信息和飞书记录指针。

### 项目同步互斥与跨资源状态

- `PROJECT_SYNC_BUSY`：REST、AI 和 MCP 共用同步协调器；调用方不得并发自动重试。
- `PROJECT_SYNC_STALE`：远端写入前发现项目或路径基准变化；没有新飞书记录。
- `PROJECT_RECORD_REMOTE_SAVED_LOCAL_PENDING`：飞书已读回，但本地机器状态未提交；响应含恢复指针。
- 远端结果不确定：保留 `remote_outcome_unknown` 恢复凭据；下一次同步复用同一 operationId 查重。

恢复凭据不保存分析正文，并包含在 backup v2 中。详见 `docs/PROJECT_RECORDS.md`。

## 10. 待办、早晨对话和业务板块

### 待办

- `PATCH /api/todos/:id`
- `POST /api/todos/today`

AI 不能自动加入今日。已完成待办加入今日返回 `409 TODO_ALREADY_COMPLETED`。

### 早晨对话

- `POST /api/morning/chat`

分析最近 3 天和临近截止事项；不会写入 `todayPlan`。

### 业务板块

- `POST /api/businesses`
- `PATCH /api/businesses/:id`
- `DELETE /api/businesses/:id`

删除业务板块只删除配置，不删除真实目录；板块下仍有项目时拒绝删除。

## 11. AI Provider

- 默认 Profile：`openai_luna`。
- 默认模型：`gpt-5.6-luna`，推理档位固定 `xhigh`。
- 第三方 Profile 由部署管理员通过 `AI_PROVIDER_*` 配置。
- 模型不自动切换；通过 `AI_PROVIDER_ACTIVE_MODEL` 显式选择。
- 配置无效、网络失败、输出不合约或工具不在白名单时 fail closed，并回退本地业务规则。
- 配置存在不等于 live 可达。

详细配置见 `docs/AI_PROVIDER.md`。

## 12. 限流与验证边界

`/api/capture`、项目同步和早晨对话使用有界内存、按客户端划分的固定窗口限流。

自动化测试使用 fake CLI、fake Feishu、fake Provider 和临时数据目录。测试通过不等同于 live TickTick/Dida365、飞书、系统日历、OpenAI、真实浏览器、iPhone 或生产部署验证。
