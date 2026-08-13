# API 概览

所有普通 `/api/*` 请求在启用 `WORKBENCH_PASSWORD` 时需要登录 cookie。

所有 `POST`、`PATCH`、`DELETE` 请求都必须发送 `Content-Type: application/json`。浏览器请求如果带 `Origin`，该值必须属于默认本机 origin 或 `TRUSTED_ORIGINS`；命令行/API 客户端可以不发 `Origin`。所有请求仍会校验实际 `Host`，不会采信 `X-Forwarded-*` 头。

## 状态

- `GET /api/health` 只读 readiness 检查。它会读取并校验 state/config，检查数据目录、备份目录、工作区和所有业务目录的类型、symlink 边界与访问权限。就绪时返回 `200`，其中 `version` 为当前应用版本 `1.2.0`；未就绪时只返回 `503 {"ok":false,"status":"not_ready"}`，不回显路径、数据或底层错误。公开未登录请求不返回 `workspaceRoot`
- `GET /api/state` 完整前端状态；AI 启用时 `aiConfig` 只暴露非敏感的 `provider`、`profileId`、`adapter`、`model`、`activeModel`、`availableModels`、`configuredModels`、`reasoningEffort`、`structuredOutputMode`、`configured`、`enabled` 和 `degraded`，不返回 endpoint 或凭证
- `GET /api/export` 导出 JSON
- `POST /api/backup` 创建备份


## AI Provider

- 默认 Profile 是 `openai_luna`，继续使用 `OPENAI_API_KEY` 和可选 `OPENAI_MODEL`。
- 第三方接入由部署管理员通过 `AI_PROVIDER_*` 环境变量配置；当前程序内置 `openai_responses_compatible` 与 `openai_chat_completions_compatible` 两类 Adapter。一个网关可登记 `gpt-5.6-luna` 与 `grok-4.6` 两个模型，但通过 `AI_PROVIDER_ACTIVE_MODEL` 明确选择当前请求使用的模型，不自动云切换。
- 没有用于写入任意 Provider URL、Header 或 API key 的业务 API。配置无效、工作流不在白名单、网络区域不符或能力降级未批准时，AI 调用 fail-closed 并由现有业务函数回退本地规则。
- 具体配置和验证命令见 `docs/AI_PROVIDER.md`。

## 收件箱

- `POST /api/inbox` 新增收件箱
- `POST /api/inbox/sync` 从已配置的飞书每日工作日记读回收件箱；只读取“收件箱”一级章节下以 `[INBOX]` 开头的条目，不自动分类、不自动加入今日
- `POST /api/inbox/command` 根据用户明确自然语言指令处理一条收件箱。项目名只匹配到一个项目时可直接处理；同名或共同前缀命中多个项目时，响应 `needsProjectSelection` 与 `projectCandidates`，收件箱保持不变。用户再次提交时必须带候选中的 `targetProjectId`
- `POST /api/capture` 外部/快捷指令采集；必须使用 Bearer `CAPTURE_TOKEN`，或在启用访问密码后携带有效登录 cookie

### 数据源配置

- `PATCH /api/config` 除工作区和设置外，可传 `dataSource`：`null` 表示关闭；或 `{ "provider": "feishu_doc", "documentUrl": "https://.../wiki/...", "inboxHeading": "收件箱", "inboxPrefix": "[INBOX]" }`
- 绑定飞书后，`POST /api/inbox` 会先调用本机 `lark-cli docs +update --api-version v2` 写入收件箱章节并用 `+fetch` 读回，读回成功后才写本地状态；失败不会更新本地收件箱
- `GET /api/state` 的 `config.dataSource` 只包含状态、URL 和同步时间，不包含 access token、appSecret 或 cookie

## 项目

- `POST /api/projects` 从收件箱创建项目（必须传 `description`, `endDate`, `sourceInboxId`；成功后原子消费该收件箱事项）
- `POST /api/projects/sync` 同步全部活跃已归类项目
- `POST /api/projects/:id/sync` 同步单项目
- `POST /api/projects/:id/classify` 用户明确归类
- `PATCH /api/projects/:id` 用户明确编辑项目基准/链接/完成/归档状态

同步接口按客户端限流；同一项目不能并发同步，全量同步期间也不接受单项目同步。限流返回 `429` 与 `Retry-After`，同步冲突返回 `409`。

若 AI Provider 分析期间项目或路径基准被用户修改，本次过期结果会被丢弃。单项目同步返回 HTTP `409` 和错误码 `PROJECT_SYNC_STALE`；批量同步整体仍返回 HTTP `200`，对应项目结果为 `{ "ok": false, "stale": true, "code": "PROJECT_SYNC_STALE" }`，且不会生成 `sync_failed` 待确认。客户端应读回最新项目状态并提示用户重新手动同步，不得自动重试。

## 待办

- `PATCH /api/todos/:id` 编辑/完成待办
- `POST /api/todos/today` 用户明确加入/移出今日；计划按服务机器自然日隔离，跨日首次操作先清空旧日选择

新备忘没有直写 API；必须先 `POST /api/inbox`，再通过 `POST /api/inbox/command` 由用户明确处理。

## 早晨对话

- `POST /api/morning/chat` 对最近 3 天和临近截止事项进行对话分析；不会写入 todayPlan

`/api/capture`、单/全项目同步与早晨对话均使用有界内存的每客户端固定窗口限流。默认窗口和额度可通过 `.env.example` 中的 `WORKBENCH_*_RATE_LIMIT` 设置调整，但程序会强制安全上限。

## 业务板块

- `POST /api/businesses`
- `PATCH /api/businesses/:id`
- `DELETE /api/businesses/:id`
