# API 概览

所有普通 `/api/*` 请求在启用 `WORKBENCH_PASSWORD` 时需要登录 cookie。

所有 `POST`、`PATCH`、`DELETE` 请求必须发送 `Content-Type: application/json`。浏览器请求如果带 `Origin`，该值必须属于默认本机 origin 或 `TRUSTED_ORIGINS`；命令行/API 客户端可以不发 `Origin`。所有请求仍校验实际 `Host`，不会采信 `X-Forwarded-*` 自动放宽。

## AI-native 双面板与 MCP

左侧是人的工作面板，右侧是 AI 工作区。AI 不直接改 DOM，也不获得任意 shell、HTTP、URL 或文件系统权限。

- `GET /api/ai/tools`：读取白名单工具元数据。
- `POST /api/ai/plan`：生成工具预览。请求示例：`{"message":"查看收件箱","view":"today","id":null}`。
- `POST /api/ai/execute`：执行预览计划。会改变状态的工具必须传 `{"planId":"...","confirmed":true}`。
- `POST /api/mcp`：MCP-compatible JSON-RPC 入口，支持 `initialize`、`notifications/initialized`、`tools/list` 和 `tools/call`。

工具执行后，服务端重新读取持久化状态并返回 `readback:true`。模型只负责提出白名单工具调用，领域层仍负责所有业务不变量。

### 项目记录工具

#### `project_records_read`

只读，从项目绑定的飞书云文档读取最近分析与总结，不从本地状态读取正文。

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
- 游标不存在或失效时返回参数错误；
- 正文不会写入 `state.json` 或浏览器持久化存储。

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

#### `project_summary_append`

把用户明确提供并确认的阶段总结追加到项目绑定的飞书文档。

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

## 状态

- `GET /api/health`：只读 readiness。未就绪只返回 `503 {"ok":false,"status":"not_ready"}`。
- `GET /api/state`：完整前端状态；不返回 Provider endpoint 或凭证。
- `GET /api/export`：导出本地 state/config，不包含项目工作区和飞书正文。
- `POST /api/backup`：创建本地 state/config 备份。

### 项目机器进度 schema

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

`GET /api/state` 为兼容现有 UI，会在内存派生静态提示字符串；这些提示不是项目分析正文，也不写回 state。

## AI Provider

- 默认 Profile：`openai_luna`，使用 `OPENAI_API_KEY` 和可选 `OPENAI_MODEL`。
- 第三方 Profile 由部署管理员通过 `AI_PROVIDER_*` 配置。
- 模型不自动云切换；通过 `AI_PROVIDER_ACTIVE_MODEL` 显式选择当前模型。
- 配置无效、工作流不在白名单、网络范围不符或能力降级未批准时 fail closed，并回退本地业务规则。
- 详细配置见 `docs/AI_PROVIDER.md`。

## 收件箱

- `POST /api/inbox`：新增收件箱。
- `POST /api/inbox/sync`：从飞书每日工作日记同步 `[INBOX]` 条目。
- `POST /api/inbox/command`：根据用户明确指令处理收件箱。
- `POST /api/capture`：iPhone Shortcut / 外部采集；需要 Bearer `CAPTURE_TOKEN` 或有效登录会话。

项目名只有唯一完整名称命中时才允许直接处理；仅前缀命中或多个候选必须返回 `needsProjectSelection`，由用户提供 `targetProjectId`。

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

文档 URL 必须是官方飞书/Lark HTTPS 云文档链接。新增收件箱采用远端写入、block-ID 读回确认、本地提交的顺序。

## 项目

- `POST /api/projects`：从收件箱创建项目；必须传 `description`、`endDate`、`sourceInboxId`。
- `POST /api/projects/sync`：同步全部活跃已归类项目。
- `POST /api/projects/:id/sync`：同步单项目。
- `POST /api/projects/:id/classify`：用户明确归类。
- `PATCH /api/projects/:id`：编辑介绍、Git、飞书链接、结束日期、完成或归档状态。

项目新建和归类从第一次落盘开始就只写 identity-only `PROJECT.md`。

### 飞书项目文档 URL

`project.feishu` 允许空字符串或官方飞书/Lark HTTPS 云文档 URL：

- host：`*.feishu.cn`、`*.larksuite.com`、`*.larkoffice.com`；
- path：`/wiki/<token>`、`/docx/<token>`、`/docs/<token>`；
- 不允许账号密码、查询参数、URL 片段或 HTTP。

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

`progress` 目前作为兼容别名返回同一份 machine progress；不包含 `summary/resume/blocker`。

### 同步互斥

REST、右侧 AI 和 `/api/mcp` 共用领域层同步协调器：

- 单项目同步之间按项目互斥；
- 全项目同步与任何单项目同步互斥；
- 冲突返回 HTTP 409，错误码 `PROJECT_SYNC_BUSY`；
- 调用方不得并发自动重试。

### Stale 与跨资源部分提交

- `PROJECT_SYNC_STALE`：远端写入前发现项目或路径基准变化；没有新飞书记录。
- `PROJECT_RECORD_REMOTE_SAVED_LOCAL_PENDING`：飞书记录已经读回确认，但本地机器状态未提交。响应包含 `recovery.operationId/revisionId/blockId/recordedAt`。
- 飞书请求报错但远端结果不确定：本地保留 `remote_outcome_unknown` 恢复凭据，待确认中持续显示；下一次同步复用同一 operationId 查重。

恢复凭据只保存机器数据和指针，不保存分析正文。详见 `docs/PROJECT_RECORDS.md`。

批量同步对单项目错误返回项目级结果，不让一个项目阻断全部循环。

## 待办

- `PATCH /api/todos/:id`：编辑或完成待办。
- `POST /api/todos/today`：用户明确加入/移出今日。

新待办必须从收件箱产生且必须有合法截止日期。新备忘同样必须先进入收件箱。

## 早晨对话

- `POST /api/morning/chat`：分析最近 3 天和临近截止事项；不会写入 `todayPlan`。

`/api/capture`、项目同步和早晨对话使用有界内存的每客户端固定窗口限流。

## 业务板块

- `POST /api/businesses`
- `PATCH /api/businesses/:id`
- `DELETE /api/businesses/:id`

删除业务板块只删除配置，不删除原有本地目录；板块下仍有项目时拒绝删除。
