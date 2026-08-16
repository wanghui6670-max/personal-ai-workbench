# Personal AI Workbench 3.0

**动觉 AI 工作台：个人工作连续性 + Joycrew AI 员工业务执行的统一入口。**

当前正式产品合同是 v3：

```text
个人工作事项：飞书云文档 → Workbench Inbox → AI 自动分析 → 用户确认 → Workbench 执行
内容素材：得到大脑 GetNote → 用户确认同步 → 自媒体 / 得到大脑内容（本地 Markdown）
项目成果：本地项目文件夹 + Git 证据
项目分析 / 总结 / 复盘：飞书项目云文档
企业业务执行：Joycrew → Run / Evidence / Approval / Deliverable
状态真相：Workbench state
```

权威文档：

- 产品来源合同：[`docs/WORKBENCH_V3_SOURCE_CONTRACT.md`](docs/WORKBENCH_V3_SOURCE_CONTRACT.md)
- 当前工程收口：[`docs/UNIFIED_CLOSURE_REVIEW_20260816.md`](docs/UNIFIED_CLOSURE_REVIEW_20260816.md)
- 跨服务合同：[`docs/JOYCREW_INTEGRATION.md`](docs/JOYCREW_INTEGRATION.md)

旧 GetNote Task Sync v2 代码仍保留用于历史兼容和迁移，但 `external_tasks_sync` 等旧任务工具不再进入当前交互式 AI/MCP 能力面。

## 产品边界

| 能力 | 当前权威系统 |
|---|---|
| 个人事项入口 | 飞书云文档“收件箱”章节 |
| 个人 Inbox / Todo / Today / 用户决定 | Personal AI Workbench |
| AI 自动分析 | 临时规划；只产生建议，不直接执行 |
| 得到大脑 | 自媒体内容来源；只读同步到本地内容库 |
| 本地项目成果 | 本地项目文件夹 |
| 版本与代码变化证据 | Git / GitHub |
| 项目分析、阶段总结、复盘、恢复叙事 | 飞书项目云文档 |
| 客户、企业项目、业务任务 | Joycrew 当前 Workspace / 上游业务源 |
| AI 员工、Run、Evidence、Approval、Deliverable | Joycrew |
| AI 员工实际执行 | Joycrew 配置的 Runtime / Hermes |

Joycrew 业务任务不会自动加入个人 Today，Workbench 个人待办也不会自动变成企业任务。

## v3 主工作流

### 今日与收件箱

- “今日工作台”和“收件箱”合并成同一工作面。
- 飞书同步后，新增/更新的 `[INBOX]` 事项进入 AI 审阅队列。
- 单条 AI 审阅只向模型提供当前目标事项和最多 30 个未归档项目的最小目录摘要，不发送其他 Inbox 原文、Todo 或确认项。
- 自动分析队列最多 2 条并发、100 条待处理；队列会持续补充，不再只分析前 12 条。
- 未变化事项的短时分析预览可在当前浏览器 session 内复用，减少刷新后的重复模型调用。
- AI 只能形成 `inbox_process` 建议或 clarification；所有写操作仍需用户点击“确认并处理”。
- AI 不自动加入 Today，不自动新建项目，不凭猜测删除来源事项。

### 项目现场与进度

“最近工作现场”和“项目进度”合并展示：

- 当前进度与状态；
- 最近活动；
- blocker；
- 打开项目与主动同步入口。

本地项目文件夹继续是真实工作产物源，Git 继续提供版本证据。

### 自媒体 / 得到大脑内容

得到大脑当前只承担内容采集：

```text
GetNote（只读）
→ 用户确认同步
→ <WORKSPACE_ROOT>/<业务序号>_自媒体/得到大脑内容/
→ Markdown + .getnote-content-index.json
```

不会创建 Todo，不会进入 Inbox，不会加入 Today，也不会写回 GetNote。拿不到真实原文字段的内容类型 fail closed，不用 AI 摘要冒充原文。

## Joycrew 业务执行

Workbench 通过服务端受控连接读取 Joycrew 的客户、企业项目、业务任务、AI 员工、Run、Evidence、审批和交付。

外部写操作继续采用：

```text
Preview → Confirm → Execute → Readback
```

浏览器不能传入 Joycrew Base URL、Token、任意 URL、Shell 命令或服务端文件路径。Joycrew 离线不能阻塞个人工作台 readiness。

## 运行要求

- Node.js 24+
- Git
- 飞书收件箱/项目记录启用时需要可用的 `lark-cli`
- GetNote 自媒体内容同步使用受控只读 `GetNoteReader`（`local_cli` 或 `private_http`）
- 可选：独立运行的 Joycrew 服务

## 本地开发

```bash
cp .env.example .env
npm run doctor
npm start
```

默认地址：

```text
http://127.0.0.1:4173
```

## macOS 正式常驻

开发启动和正式常驻不是同一件事。正式 macOS 安装使用：

```bash
./install-macos.command
npm run service:macos -- status
```

LaunchAgent 安装必须先校验 replacement plist，再切换旧服务；切换后的端口释放、bootstrap 或 health 失败必须尝试恢复旧服务，恢复失败必须显式同时报告原错误与恢复错误。详细流程见 [`docs/MACOS_ONE_CLICK.md`](docs/MACOS_ONE_CLICK.md)。

## Harness

```bash
npm run harness:install
npm run harness:check
npm run harness:e2e
npm run harness:employee:e2e
```

右侧 Harness Copilot 只使用固定白名单工具；外部改变必须经过现有确认门。

## 数据、备份与恢复

Workbench 本地状态和配置使用原子 JSON；运行时备份目录 `data/p0/` 已被 Git 忽略。

完整恢复包继续使用 backup v2：

```json
{
  "backupVersion": 2,
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts` 只保存 Capture 标识、正文 SHA-256 和处理引用。
- `projectRecordReceipts` 只保存 operationId、机器进度和飞书指针。
- `GET /api/export` 是查看/迁移用 JSON，不是完整恢复包。

## Docker

```bash
cp .env.example .env
docker compose up -d --build
```

默认只发布到 loopback。非 localhost 部署至少设置访问密码、足够强的 `SESSION_SECRET`、可信 origin 和 secure cookie。

## 验证

```bash
npm run test:files
npm run harness:install
npm run verify
docker build -t personal-ai-workbench:v3 .
```

CI 必须真实执行并通过：

1. Workbench contract tests；
2. Harness E2E；
3. Docker smoke。

自动化通过不等于真实飞书、GetNote、Joycrew、模型 Provider、iPhone Shortcut 或 macOS LaunchAgent 已完成现场验收；现场状态必须单独读回确认。
