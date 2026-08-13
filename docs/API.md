# API 概览

所有普通 `/api/*` 请求在启用 `WORKBENCH_PASSWORD` 时需要有效登录 cookie。

所有 `POST`、`PATCH`、`DELETE` 请求必须发送 `Content-Type: application/json`。浏览器请求如果带 `Origin`，该值必须属于默认本机 origin 或 `TRUSTED_ORIGINS`。所有请求仍校验实际 `Host`，不会采信 `X-Forwarded-*` 自动放宽。

## 1. 健康、状态、导出与备份

### `GET /api/health`

只读 readiness。未就绪返回：

```json
{"ok":false,"status":"not_ready"}
```

`200` 只证明当前文件系统和配置可用，不证明 OpenAI、飞书、浏览器或 iPhone 已 live 验证。

### `GET /api/state`

返回前端派生状态。项目分析正文不在本地持久化；为了兼容 UI，响应会在内存中派生静态说明字符串。

### `GET /api/export`

导出当前 `state` 和 `config`，用于检查或迁移业务数据。它不是完整恢复包，不包含：

- `/workspace`；
- Capture 幂等收据；
- 项目记录跨资源恢复凭据；
- 飞书项目叙事正文；
- 任何凭证。

需要可恢复的完整本地控制面快照时使用 `POST /api/backup` 或 `npm run backup`。

### `POST /api/backup`

请求体：

```json
{}
```

返回本机备份文件路径。backup v2 内容：

```json
{
  "backupVersion": 2,
  "backedUpAt": "2026-08-13T10:00:00.000Z",
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

`captureReceipts` 只保存正文 SHA-256 和标识符；`projectRecordReceipts` 只保存机器进度、operationId 和飞书指针。两者都不保存项目分析或 Capture 正文。

恢复通过 CLI 完成：

```bash
npm run restore -- /path/to/backup.json
```

恢复时应停止工作台进程。详见 `docs/DEPLOYMENT.md`。

## 2. iPhone / 外部采集

### `POST /api/capture`

此接口位于普通登录检查之前，但必须满足以下任一授权：

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

字段：

- `captureId`：8–128 位安全 ID；推荐 UUID。为兼容旧客户端可省略，但可靠重试必须显式提供。
- `text`：必填、非空。
- `source`：可选兼容标签。服务端不会信任该字段决定持久化来源；实际来源固定由服务端写为 `iphone-shortcut` 或飞书读回后的 `feishu_doc`。

幂等规则：

- 新 `captureId`：成功返回 `201`、`replayed:false`。
- 同 ID + 同正文：返回原结果，通常为 `200`、`replayed:true`，不重复写飞书或收件箱。
- 同 ID + 不同正文：返回 `409 CAPTURE_ID_CONFLICT`。
- 已处理事项重放：`processed:true`、`item:null`，不会重新进入收件箱。
- 限流：`429`，按 `Retry-After` 使用原 ID 重试。

响应示例：

```json
{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "replayed": false,
  "processed": false,
  "item": {
    "id": "in_...",
    "text": "联系设计师确认海报终稿",
    "source": "feishu_doc",
    "feishuBlockId": "block_...",
    "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552"
  }
}
```

完整 Shortcut 设置见 `docs/IPHONE_SHORTCUT.md`。

## 3. AI-native 双面板与 MCP

左侧是人的工作面板，右侧是 AI 工作区。AI 不直接修改 DOM，也不获得任意 shell、HTTP、URL 或文件系统权限。

- `GET /api/ai/tools`：读取白名单工具元数据。
- `POST /api/ai/plan`：生成工具预览。
- `POST /api/ai/execute`：执行预览计划；会改变状态的工具必须显式确认。
- `POST /api/mcp`：MCP-compatible JSON-RPC 入口，支持 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`。

工具执行后服务端重新读取持久化状态并返回 `readback:true`。模型只提出白名单调用；领域层负责业务不变量、锁、确认和持久化。

### `project_records_read`

只读，从项目绑定的飞书云文档读取最近分析与总结：

```json
{
  "jsonrpc": "2.0",
  "id": "read-1",
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

约束：

- `limit` 默认 20，硬上限 100；
- 最新记录优先；
- `nextCursor` 非空时可继续读取；
- 无效游标返回参数错误；
- 正文不写入 `state.json` 或浏览器持久化存储。

业务结果：

```json
{
  "projectId": "p_xxx",
  "documentUrl": "https://example.feishu.cn/wiki/token",
  "revisionId": "12",
  "nextCursor": "block_older",
  "records": [
    {
      "blockId": "block_12",
      "kind": "analysis",
      "operationId": "pa_...",
      "text": "项目分析正文"
    }
  ]
}
```

### `project_summary_append`

把用户明确提供并确认的阶段总结追加到项目飞书文档：

```json
{
  "jsonrpc": "2.0",
  "id": "summary-1",
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

正文最大 6000 字符。成功后本地只保存机器记录指针和不含正文的审计事件。

## 4. 项目机器进度 schema

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

## 5. AI Provider

- 默认 Profile：`openai_luna`。
- 默认模型：`gpt-5.6-luna`，推理档位固定 `xhigh`。
- 第三方 Profile 由部署管理员通过 `AI_PROVIDER_*` 配置。
- 模型不自动切换；通过 `AI_PROVIDER_ACTIVE_MODEL` 显式选择。
- 配置无效、工作流不在白名单、网络范围不符或能力降级未批准时 fail closed，并回退本地业务规则。
- 详细配置见 `docs/AI_PROVIDER.md`。

配置存在不等于 live 可达。

## 6. 收件箱

- `POST /api/inbox`：新增收件箱。
- `POST /api/inbox/sync`：从飞书每日工作日记同步 `[INBOX]` 条目。
- `POST /api/inbox/command`：按用户明确指令处理收件箱。
- `POST /api/capture`：iPhone / 外部采集，见上文。

项目名只有唯一完整名称命中时才允许直接处理。仅前缀命中或多个候选时返回 `needsProjectSelection`，由用户提供 `targetProjectId`。

### 收件箱数据源

`PATCH /api/config` 可设置：

```json
{
  "dataSource": {
    "provider": "feishu_doc",
    "documentUrl": "https://example.feishu.cn/wiki/token",
    "inboxHeading": "收件箱",
    "inboxPrefix": "[INBOX]"
  }
}
```

文档 URL 必须是官方飞书/Lark HTTPS 云文档链接。新增收件箱采用远端写入、block-ID 读回、本地提交的顺序。

本地 ack 只保存 block ID、正文 SHA-256 和时间，不保存历史正文。远端正文被编辑时重新进入收件箱；远端删除会移除仍未处理的本地缓存和关联确认。

## 7. 项目

- `POST /api/projects`：从收件箱创建项目；必须传 `description`、`endDate`、`sourceInboxId`。
- `POST /api/projects/sync`：同步全部活跃且已归类项目。
- `POST /api/projects/:id/sync`：同步单项目。
- `POST /api/projects/:id/classify`：用户明确归类。
- `PATCH /api/projects/:id`：编辑介绍、Git、飞书链接、结束日期、完成或归档状态。

项目新建和归类从第一次落盘开始就只写 identity-only `PROJECT.md`。

### 飞书项目文档 URL

`project.feishu` 允许空字符串或官方飞书/Lark HTTPS 云文档 URL：

- host：`*.feishu.cn`、`*.larksuite.com`、`*.larkoffice.com`；
- path：`/wiki/<token>`、`/docx/<token>`、`/docs/<token>`；
- 不允许账号密码、查询参数、URL fragment 或 HTTP。

换绑或解绑项目文档时，旧 revision/block/operation 指针原子清除。

### 同步响应

同步接口不返回项目分析正文，只返回机器状态、扫描信息和飞书记录指针：

```json
{
  "machineProgress": {
    "percent": 52,
    "status": "进行中",
    "hasBlocker": true,
    "lastActivity": "2026-08-13T01:00:00.000Z",
    "syncedAt": "2026-08-13T02:00:00.000Z",
    "confidence": 0.78,
    "feishuRevisionId": "12",
    "feishuRecordBlockId": "block_12",
    "feishuRecordedAt": "2026-08-13T02:00:00.000Z",
    "feishuOperationId": "pa_..."
  },
  "scan": {},
  "record": {
    "saved": true,
    "replayed": false,
    "documentUrl": "https://example.feishu.cn/wiki/token",
    "revisionId": "12",
    "blockId": "block_12",
    "recordedAt": "2026-08-13T02:00:00.000Z",
    "operationId": "pa_..."
  }
}
```

`progress` 作为兼容别名返回同一份 machine progress；不包含 `summary/resume/blocker`。

### 同步互斥

REST、右侧 AI 和 `/api/mcp` 共用领域层同步协调器：

- 单项目同步按项目互斥；
- 全项目同步与任何单项目同步互斥；
- 冲突返回 HTTP `409`，错误码 `PROJECT_SYNC_BUSY`；
- 调用方不得并发自动重试。

### Stale 与跨资源部分提交

- `PROJECT_SYNC_STALE`：远端写入前发现项目或路径基准变化；没有新飞书记录。
- `PROJECT_RECORD_REMOTE_SAVED_LOCAL_PENDING`：飞书记录已读回，但本地机器状态未提交。响应含 `recovery.operationId/revisionId/blockId/recordedAt`。
- 飞书请求报错但远端结果不确定：保留 `remote_outcome_unknown` 恢复凭据；下一次同步复用同一 operationId 查重。

恢复凭据不保存分析正文，并包含在 backup v2 中。详见 `docs/PROJECT_RECORDS.md`。

## 8. 待办、早晨对话和业务板块

### 待办

- `PATCH /api/todos/:id`
- `POST /api/todos/today`

新待办必须从收件箱产生且必须有合法截止日期。AI 不能自动加入今日计划。

### 早晨对话

- `POST /api/morning/chat`

分析最近 3 天和临近截止事项；不会写入 `todayPlan`。

### 业务板块

- `POST /api/businesses`
- `PATCH /api/businesses/:id`
- `DELETE /api/businesses/:id`

删除业务板块只删除配置，不删除真实目录；板块下仍有项目时拒绝删除。

`/api/capture`、项目同步和早晨对话使用有界内存、按客户端划分的固定窗口限流。
