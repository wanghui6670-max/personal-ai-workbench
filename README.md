# Personal AI Workbench 2.0

**动觉 AI 工作台：个人工作连续性 + Joycrew AI 员工业务执行的统一产品。**

Personal AI Workbench 是唯一日常入口。它保留个人今日、收件箱、GetNote 会议待办、本地项目文件、Git 证据和飞书项目记忆，同时通过服务端受控连接接入 Joycrew 的客户、企业项目、AI 员工、Run、Evidence、审批和交付。

产品基线见 [`docs/UNIFIED_PRODUCT_V2.md`](docs/UNIFIED_PRODUCT_V2.md)，跨服务合同见 [`docs/JOYCREW_INTEGRATION.md`](docs/JOYCREW_INTEGRATION.md)。

```text
左侧导航                  中间正式页面                   右侧 Harness Copilot
个人今日 / 收件箱           个人项目 / 业务执行            连续对话 / 工具轨迹
个人待办 / 工作日志         Run / Evidence / Approval      读取 + 操作预览
             │                        │                          │
             └──────── Personal AI Workbench Server ────────────┘
                                      │
                              Trusted Proxy / Session
                                      │
                           Joycrew → DataWeave / Runtime
```

## 产品边界

| 能力 | 权威系统 |
|---|---|
| 个人收件箱、个人待办、我的今日 | Personal AI Workbench |
| GetNote 会议待办 | 得到大脑；Workbench 单向只读 |
| 本地项目成果 | 本地项目文件夹 |
| 代码版本与变更证据 | Git / GitHub |
| 项目分析、阶段总结、复盘与恢复叙事 | 飞书项目云文档 |
| 个人任务快照与每日总结 | 飞书《每日工作日记》 |
| 客户、企业项目、业务任务 | Joycrew 当前 Workspace / 上游业务源 |
| AI 员工、Run、Evidence、Approval、Deliverable | Joycrew |
| 飞书、本机与服务器数据的按需查询 | DataWeave |
| AI 员工实际执行 | Joycrew 配置的 Runtime / Hermes |

两套任务不会自动互相覆盖：Joycrew 业务任务不会自动加入“我的今日”，Workbench 个人待办也不会自动变成企业任务。

## v2.0 主要能力

### 个人工作台

- 固定 `getnote` CLI 分页读取最近笔记及 `meeting_todos`；不从整篇笔记猜任务。
- 有明确日期的事项进入正式待办；日期不明确的事项进入个人收件箱。
- iPhone Shortcut `/api/capture` 使用 `captureId` 幂等，网络重试不会重复采集。
- “我的今日”只包含用户明确加入的待办；AI 不自动安排。
- 本地项目目录是真实成果源，Git 提供变更证据。
- 飞书项目文档是项目分析、阶段总结、复盘和上下文恢复的唯一长期叙事真源。
- 飞书每日工作日记承载任务快照与用户触发的每日总结。
- 本机 ICS 固定生成到 `data/calendar/personal-ai-workbench.ics`，它是可重建日历镜像，不是任务真源。

### 统一业务执行

导航中的“业务执行”页面原生显示：

- Joycrew 连接状态、持久化、身份和 Runtime；
- 企业项目、客户、业务任务；
- 已授权 AI 员工及 Skill 版本；
- 最近 Run 与 Evidence Package；
- 写回审批；
- 正式交付及 Run/Evidence 来源链。

创建 Run、生成交付、批准或拒绝写回时采用两阶段合同：

```text
页面或 Harness 提出动作
→ Workbench 生成短时、不可伪造的操作预览
→ 用户在“业务执行”页面检查影响范围
→ 用户点击确认
→ Workbench 服务端调用 Joycrew
→ Joycrew 再次执行身份、Grant、源状态和审批校验
→ Workbench 读回结果
```

未确认的预览不会调用 Joycrew；重复提交已执行预览不会重复创建 Run 或交付。

### Harness 统一 Copilot

右侧 DeepSeek Harness 现在可以在同一会话中：

- 读取个人今日、收件箱、待办、项目和工作日志；
- 读取飞书项目记录；
- 读取 Joycrew 项目、客户、业务任务、员工、Run、Evidence、审批和交付；
- 打开“业务执行”页面；
- 为 Run、交付和审批生成操作预览。

Harness 不拥有 Shell、终端、任意 Web、文件系统写入、Cron、Workflow 或 Subagent。`*_prepare` 工具只生成预览；没有页面确认回执时，Copilot 不得声称外部动作已执行。

## 运行要求

- Node.js 24+
- Git
- `getnote`（启用得到大脑待办源时）
- `lark-cli`（启用飞书项目记录或每日工作日记时）
- 可选：独立运行的 Joycrew 服务

## 本地启动

```bash
cp .env.example .env
npm run doctor
npm start
```

默认地址：

```text
http://127.0.0.1:4173
```

Workbench 主应用没有普通 npm 运行依赖；Harness 依赖隔离在 `harness/` 中。源码首次启用 Harness：

```bash
npm run harness:install
npm run harness:check
npm run harness:e2e
```

## 接入 Joycrew

推荐让 Joycrew 使用 `trusted_proxy`，由 Workbench 作为唯一浏览器入口：

### Joycrew 侧

```dotenv
JOYCREW_AUTH_MODE=trusted_proxy
JOYCREW_TRUSTED_PROXY_TOKEN=<至少 24 字节随机值>
JOYCREW_PERSISTENCE=postgres
JOYCREW_RUNTIME_MODE=mock
```

真实 Pilot 验证后再将 Runtime 切换为 Hermes。

### Workbench 侧

```dotenv
JOYCREW_ENABLED=1
JOYCREW_BASE_URL=http://127.0.0.1:4000
JOYCREW_NETWORK_ZONE=local_loopback
JOYCREW_AUTH_MODE=trusted_proxy
JOYCREW_TRUSTED_PROXY_TOKEN=<与 Joycrew 相同>
JOYCREW_WORKSPACE_ID=ws-dongjue
JOYCREW_USER_ID=user-chris
JOYCREW_ROLE=admin
```

这些值只由 Workbench 服务端读取，不返回浏览器、不进入 `state.json`、备份或项目文件。

公网 Joycrew 必须使用 HTTPS，并将 `JOYCREW_NETWORK_ZONE` 设置为 `public_https`。Docker 中 Joycrew 运行在宿主机时，可使用：

```dotenv
JOYCREW_BASE_URL=http://host.docker.internal:4000
JOYCREW_NETWORK_ZONE=private_http
```

完整合同见 [`docs/JOYCREW_INTEGRATION.md`](docs/JOYCREW_INTEGRATION.md)。

## 得到大脑 → 飞书日记 → 本机日历

固定只读命令：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote doctor -o json
```

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

- 只接受得到大脑明确提供的待办，不让模型从笔记正文自行发明。
- “下周”“稍后”“尽快”等模糊表达不自动变成日期。
- 只有上游明确 `completed=true` 才同步完成，不根据事项消失推断完成。
- 不反向修改得到大脑，也不自动加入今日。

## 项目记录

`PROJECT.md` 只是项目身份证，不保存进度叙事、卡点、恢复摘要或总结正文。

飞书项目文档固定章节：

```text
项目分析与总结
```

项目页临时读取飞书正文，不使用 `localStorage`、`sessionStorage` 或 IndexedDB 保存项目叙事。

## API 边界

Personal Workbench：

```text
POST /api/capture
GET  /api/state
POST /api/mcp
POST /api/harness/navigator
```

统一 Joycrew BFF：

```text
GET  /api/joycrew/status
GET  /api/joycrew/overview
GET  /api/joycrew/projects/:projectId
GET  /api/joycrew/actions
POST /api/joycrew/actions/prepare
POST /api/joycrew/actions/:actionId/execute
POST /api/joycrew/actions/:actionId/cancel
```

浏览器不能传入 Joycrew Base URL、Token、任意 URL、Shell 命令或服务端文件路径。

## 数据、备份与恢复

默认数据目录：

```text
state.json   个人机器状态、任务、收件箱和确认项
config.json  工作区、业务板块和非秘密集成设置
calendar/    可从 GetNote 待办重建的 ICS
backups/     backup v2
captures/    Capture 幂等收据
recovery/    飞书跨资源事务恢复凭据
```

Workbench 的完整恢复包继续使用 backup v2：

```json
{
  "backupVersion": 2,
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts` 只保存 Capture 标识、正文 SHA-256 和处理引用，不保存 Capture 正文。
- `projectRecordReceipts` 只保存 operationId、机器进度和飞书指针，不保存项目分析或总结正文。
- 旧备份没有 `captureReceipts` 或 `projectRecordReceipts` 时保留当前凭据目录；恢复任一阶段失败必须尝试整体回滚。
- `GET /api/export` 是查看和迁移用 JSON，不是完整恢复包。

Joycrew 数据、Token、Run、Evidence、Approval 和 Deliverable 不复制进 Workbench 备份。Joycrew 操作预览只保存在当前 Workbench 进程内存，默认 10 分钟过期。

## Docker

```bash
cp .env.example .env
docker compose up -d --build
```

默认只发布到 `127.0.0.1`。非 localhost 部署至少设置：

```dotenv
WORKBENCH_PASSWORD=<强密码>
SESSION_SECRET=<至少 24 字符随机值>
TRUSTED_ORIGINS=https://workbench.example.com
COOKIE_SECURE=1
```

## 验证

```bash
npm test
npm run harness:install
npm run verify
docker build -t personal-ai-workbench:v2 .
```

CI 覆盖：

- Workbench 全量合同测试；
- Joycrew 客户端认证、网络边界、错误映射和响应体上限；
- 操作预览、确认、重复执行和路径穿越拒绝；
- Joycrew MCP 读取与 preview-only 工具；
- Harness 固定工具目录和确定性 Agent→工具 E2E；
- Joycrew 未启用时的 Docker 主产品可用性。

自动化通过不等于真实 GetNote、飞书、系统日历、模型 Provider、Joycrew、DataWeave、Hermes、Mac Local Bridge 或生产部署已经完成现场验证。外部服务不可用时必须明确报错，不使用旧缓存冒充实时结果，也不影响个人工作台继续运行。


## 不确定结果保护

Joycrew 写操作在网络中断、响应丢失或返回不可验证结果时会标记为“结果不确定”。同一个预览不会自动重试，避免重复创建 Run、交付或写回；用户应先刷新业务状态核对，再决定是否生成新的预览。
