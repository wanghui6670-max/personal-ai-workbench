# API 概览（v3.0）

所有普通 `/api/*` 请求在启用 `WORKBENCH_PASSWORD` 时需要有效登录 cookie。所有 `POST`、`PATCH`、`DELETE` 请求必须发送 `Content-Type: application/json`。

当前来源合同：

```text
飞书云文档 → Workbench Inbox → AI scoped review → 用户确认 → Workbench 执行
得到大脑 GetNote → 用户确认 → 自媒体本地内容库
```

旧 GetNote Task Sync v2 API/工具只保留为历史兼容实现，不属于当前交互式 AI/MCP 主能力面。

## 1. 健康与状态

### `GET /api/health`

只读 Workbench readiness。未就绪返回：

```json
{"ok":false,"status":"not_ready"}
```

`200` 只证明当前 Workbench 文件系统/配置可用，不证明飞书、GetNote、Joycrew、模型 Provider、浏览器、iPhone 或 macOS LaunchAgent 已完成 live 验收。

Joycrew 实时连通性不应阻塞核心 health；使用独立：

```text
GET /api/joycrew/status
```

### `GET /api/state`

返回前端派生状态和非敏感配置。项目分析正文、飞书正文、GetNote service token、CLI 凭证和 Joycrew token 不在响应中。

## 2. 飞书收件箱

### `POST /api/inbox/sync`

从配置好的飞书云文档“收件箱”章节读回 `[INBOX]` 条目并同步到 Workbench Inbox。

该操作：

- 不自动加入 Today；
- 不自动创建项目；
- 不自动执行 AI 建议。

对应 MCP 工具：

```text
feishu_inbox_sync
```

写操作需要确认。

## 3. AI 规划与执行

### `GET /api/ai/tools`

返回当前 MCP 白名单工具元数据。

### `POST /api/ai/plan`

普通右侧 AI：

```json
{
  "message": "查看收件箱",
  "view": "today",
  "id": null
}
```

飞书单条自动审阅使用专用 scope：

```json
{
  "message": "只分析当前这条飞书事项……",
  "view": "inbox-review",
  "id": "<target-inbox-item-id>"
}
```

`inbox-review` 硬边界：

- 模型状态只包含目标 Inbox item；
- 最多附带 30 个未归档项目的目录摘要；
- 其他 Inbox 原文、Todo、Today、confirmations 不进入模型输入；
- 模型工具目录只暴露 `inbox_process`；
- 任何跨 item 或其他 tool 提议都降级为 clarification。

### `POST /api/ai/execute`

```json
{
  "planId": "plan-...",
  "confirmed": true
}
```

会改变状态的工具必须显式确认。预览默认短时有效，过期后必须重新分析。

### `POST /api/mcp`

MCP-compatible JSON-RPC，支持 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`。

当前关键工具：

```text
feishu_inbox_sync            write / confirm
inbox_process                write / confirm
todo_today                   write / confirm
getnote_content_status       read-only
getnote_content_sync         write / confirm
```

旧 `external_tasks_sync` / `external_task_integration_update` 不应出现在当前 registry 的 `tools/list`。

## 4. Inbox / Todo / Today

### `POST /api/inbox`

新增一条 Workbench Inbox 事项。新事项第一站仍然是 Inbox。

### `POST /api/inbox/command`

按用户明确命令处理指定 Inbox item。领域规则继续要求：

- 新 Todo 有明确截止日期；
- 新项目必须有明确计划结束日期；
- Today 不自动加入；
- 项目不明确时返回人工选择/clarification。

### `PATCH /api/todos/:id`

更新已有 Todo。

### `POST /api/todos/today`

把 Todo 加入或移出 Today，只接受用户明确动作。

## 5. GetNote 自媒体内容

当前用户能力面：

```text
getnote_content_status
getnote_content_sync
```

`getnote_content_sync` 只读取得到大脑真实原文，并固定写入：

```text
<WORKSPACE_ROOT>/<业务序号>_自媒体/得到大脑内容/
```

不创建 Todo、Inbox 或 Today，也不写回 GetNote；不接受任意 URL、命令或文件路径。

旧 GetNote Task Sync v2 模块仍可存在于代码库用于历史兼容，但不再定义当前个人事项入口。

## 6. 项目

```text
POST  /api/projects
POST  /api/projects/sync
POST  /api/projects/:id/sync
PATCH /api/projects/:id
```

项目文件夹与 Git 仍是真实工作证据；项目分析/阶段总结/复盘正文继续以飞书项目文档为长期叙事真源。

## 7. iPhone Capture

### `POST /api/capture`

请求示例：

```json
{
  "captureId": "稳定 UUID；网络重试必须复用",
  "text": "刚想到的事项"
}
```

- 同一 `captureId` + 同正文：安全重放；
- 同一 `captureId` + 不同正文：冲突；
- Capture 只进入 Inbox，不自动创建 Todo/Today。

## 8. Joycrew

```text
GET  /api/joycrew/status
GET  /api/joycrew/overview
GET  /api/joycrew/projects/:projectId
GET  /api/joycrew/actions
POST /api/joycrew/actions/prepare
POST /api/joycrew/actions/:actionId/execute
POST /api/joycrew/actions/:actionId/cancel
```

外部改变继续采用 `Preview → Confirm → Execute → Readback`，浏览器不能传入任意 Joycrew URL、token、shell 或服务端路径。

## 9. 导出、备份与恢复

### `GET /api/export`

`GET /api/export` 是当前 state/config 的查看和迁移 JSON，**不是完整恢复包**。它不包含项目工作区、飞书正文、GetNote 登录态、Joycrew token 或完整幂等凭据目录。

### `POST /api/backup`

backup v2：

```json
{
  "backupVersion": 2,
  "backedUpAt": "2026-08-16T00:00:00.000Z",
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts` 只保存 `captureId`、正文 SHA-256 与处理引用，不保存正文；
- `projectRecordReceipts` 只保存 operationId、机器进度和飞书指针，不保存项目分析正文；
- 恢复任一阶段失败必须尝试整体回滚；
- `data/p0/` 只属于运行时安装/备份数据，必须保持 Git ignored。

## 10. macOS 服务

正式常驻通过：

```bash
./install-macos.command
npm run service:macos -- status
```

LaunchAgent install 必须先 lint replacement plist 再停止旧服务；进入 cutover 后，端口释放、bootstrap、health 或 commit 读回失败必须尝试恢复旧服务。若恢复也失败，错误必须同时包含原失败和恢复失败。

## 11. 版本与自动化边界

当前产品版本：**3.0.0**。

CI 通过只说明当前 HEAD 的合同测试、Harness E2E 和 Docker smoke 已执行成功；不等于真实外部服务或 macOS 现场已验收。
