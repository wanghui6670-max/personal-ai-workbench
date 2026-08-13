# 个人 AI 项目管理工作台

这是一个**本地文件系统优先、AI 辅助、人保留最终决策权**的个人项目管理工作台。

它解决的核心问题是：工作被打断后，不再重新找资料、重新理解上下文、重新开始。

## 核心原则

1. 所有新事情先进入收件箱。
2. AI 不自动分类收件箱；只有用户下明确指令后才移动。
3. 项目是独立上下文边界。业务板块 → 项目 → 本地文件夹一一对应。
4. 本地项目文件夹保存真实工作产物；Git 保存版本证据。
5. 飞书项目云文档是项目分析、阶段总结、复盘和上下文恢复叙事的唯一真源。
6. Workbench 只保存最小机器状态、任务、确认项、路径、幂等收据和飞书记录指针。
7. 项目进度只在用户主动同步时刷新，不做后台自动安排。
8. 待办必须有截止日期；没有日期必须追问。
9. AI 可以分析和提醒，但不能自动把任务加入今日工作台。
10. AI 判断不准的内容进入“待确认”，业务归属不清的项目进入“待归类”，逾期项目独立管理。

## 数据边界

| 位置 | 保存内容 |
|---|---|
| 本地项目文件夹 | 原始资料、工作过程、代码、最终交付和归档 |
| Git | commit、remote、working tree 和版本证据 |
| Workbench `state.json` | 项目元数据、机器进度、收件箱、待办、今日、待确认和记录指针 |
| Workbench `captures/` | Capture 正文哈希与幂等标识，不保存正文 |
| Workbench `recovery/` | 飞书跨资源事务的机器恢复凭据，不保存分析正文 |
| 飞书项目文档 | 项目分析、阶段总结、复盘、卡点说明和上下文恢复叙事 |

`PROJECT.md` 只是项目身份证和入口索引，不保存项目分析、卡点或恢复摘要。

普通项目备忘仍是轻量本地记录；“飞书唯一真源”专门约束项目分析、阶段总结、复盘和恢复上下文。

## 已实现功能

- 收件箱快速记录与自然语言处理：归入项目 / 项目待办 / 独立待办 / 备忘 / 新建项目 / 删除
- AI 生成项目名称、介绍和业务归属建议；不确定时进入待归类
- 自动创建 identity-only 项目目录：`PROJECT.md / 01_原始资料 / 02_工作过程 / 03_最终交付 / 99_归档`
- 主动同步本地文件、Git commit、Git remote 和文本证据
- AI Provider 按“证据 → 冲突与缺口 → 最终结论”生成临时项目判断
- 项目分析先写飞书并按 block ID 读回，再提交本地机器状态
- 稳定 operationId、幂等重试、远端成功/本地失败恢复凭据
- REST、右侧 AI 与 MCP 共用项目同步互斥锁
- 项目页临时读取最近飞书分析与总结，支持分页且不做浏览器持久化
- 最近 3 天 + 临近截止事项的早晨对话；今日安排完全由用户决定
- 待办、待确认、待归类、逾期、归档和机器审计日志
- 飞书每日工作日记作为收件箱外部来源
- iPhone Shortcut / 外部采集 API，支持 `captureId` 去重、冲突检测和处理后安全重放
- JSON 原子写入、每日备份、手工备份、恢复和业务导出
- backup v2 同时保护 Capture 幂等收据与项目记录恢复凭据
- 可选访问密码、Host/Origin 安全边界、限流
- AI-native 双面板与受限 MCP 工具层
- Docker、doctor 和自动化合同测试

## 本地运行

要求：Node.js 20+。如需 Git 证据，还需安装 Git；启用飞书时还需在同一机器、同一用户下安装并登录 `lark-cli`。

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

`npm start`、`npm run doctor`、`npm run backup`、`npm run restore` 和迁移命令会读取项目根目录 `.env`。加载器只接受 `.env.example` 中声明的键，不执行 shell 语法、变量展开、`$()` 或反引号命令替换。不要使用 `source .env` 或 Windows `for /f` 加载该文件。

Docker Compose 改端口时使用 `WORKBENCH_PORT`，它会同时修改宿主机发布端口和容器内监听端口。

## AI Provider

默认配置：

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.6-luna"
```

默认 Profile 是 `openai_luna`，推理档位固定为 `xhigh`。项目创建、项目进度和早晨对话使用受本机校验的 Structured Outputs。

配置 Key、doctor 通过或设置页显示“已配置”，只证明参数准备就绪，不证明模型已真实联网。Provider 超时、拒绝、不可达或结构校验失败时回退本地规则，不会自动改变截止日期、收件箱或今日计划。

启用 Provider 后，项目描述、业务板块、项目/待办元数据、相对文件名和修改时间、Git 提交元数据及对话上下文可能发送给 Provider，并先做凭证脱敏。文件正文默认不出站；只有显式设置 `AI_SEND_FILE_CONTENT=1`，或默认 Profile 的兼容别名 `OPENAI_SEND_FILE_CONTENT=1`，才会发送受支持正文。脱敏不是完整 DLP，高敏感项目不应开启正文发送。

兼容服务配置见 [`docs/AI_PROVIDER.md`](docs/AI_PROVIDER.md)。第三方 Profile 默认关闭；能力不足时默认 fail closed，只有显式批准的降级才显示为 `degraded`。

## 真实项目目录

在“设置”中把工作区根目录改成真实项目根目录，例如：

```text
/Users/yourname/Work
```

新建已归类项目后：

```text
Work/
├── 01_动觉AI/
│   └── 某项目/
│       ├── PROJECT.md
│       ├── 01_原始资料/
│       ├── 02_工作过程/
│       ├── 03_最终交付/
│       └── 99_归档/
├── 02_实体门店/
├── 03_客户项目/
└── 04_个人内容/
```

服务必须运行在能访问真实项目文件的机器上，例如电脑、Mac mini、NAS、办公室服务器或挂载真实目录的 Docker 主机。普通无状态云函数不能直接读取笔记本上的本地路径。

部署说明见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 飞书每日工作日记收件箱

工作台可以把收件箱绑定到你自己的飞书云文档。只读取一级标题“收件箱”下以 `[INBOX]` 开头的段落或待办块。

本地新增收件箱事项时：

```text
写飞书
→ 读回唯一新增 block
→ 提交本地收件箱缓存
```

飞书不可达或读回失败时，本地不会伪装成已保存。仓库不保存真实工作文档链接或飞书凭证。

## 飞书项目分析与总结

每个项目可以绑定一个官方飞书/Lark HTTPS 云文档。工作台只操作固定章节：

```text
# 项目分析与总结
```

记录前缀：

```text
[WORKBENCH_ANALYSIS] [WORKBENCH_OP:<operationId>] ...
[WORKBENCH_SUMMARY] [WORKBENCH_OP:<operationId>] ...
```

项目页的“飞书项目记忆”面板直接从飞书读取最近记录，正文只存在当前页面内存，不使用 `localStorage`、`sessionStorage` 或 IndexedDB。

完整合同、恢复语义和迁移说明见 [`docs/PROJECT_RECORDS.md`](docs/PROJECT_RECORDS.md)。

## 从旧版本升级

第一次启动新版本时，如果旧状态中含有本地项目分析正文，工作台先创建不可覆盖快照：

```text
data/migrations/pre-narrative-v1-startup.json
```

随后本地状态只保留机器字段，并把需处理的项目放进待确认。原始正文不会被假装成已迁移到飞书。

先停止工作台并备份，然后 dry-run：

```bash
npm run migrate:project-records
```

确认报告后执行：

```bash
npm run migrate:project-records -- --apply
```

旧 `PROJECT.md` 会先保存为：

```text
PROJECT.md.pre-feishu-v1.bak
```

迁移可重入；相同 operationId 不会重复写飞书。

## iPhone 快捷指令采集

```text
POST /api/capture
Authorization: Bearer <CAPTURE_TOKEN>
Content-Type: application/json

{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "text": "刚刚想到的事情",
  "source": "iphone-shortcut"
}
```

每条新事项生成一个 UUID；同一事项的所有不确定重试复用同一个 `captureId`。同 ID + 同正文安全重放，同 ID + 不同正文返回冲突。处理后的事项重放不会复活。

绑定飞书每日工作日记后，链路为：

```text
iPhone
→ /api/capture
→ 飞书收件箱
→ 飞书 block-ID 读回
→ Workbench 收件箱与哈希收据
```

采集只进入收件箱，不自动成为任务。详见 [`docs/IPHONE_SHORTCUT.md`](docs/IPHONE_SHORTCUT.md)。

## AI-native 双面板与 MCP

左侧是人的工作面板，右侧是 AI 工作区。模型只能提出白名单 MCP 工具调用；本地注册表执行参数校验、确认门和领域规则。写入操作必须先显示影响范围并由用户确认，执行后重新读回状态。

- MCP transport：`POST /api/mcp`
- 工具列表：`GET /api/ai/tools`
- 项目记录读取：`project_records_read`
- 阶段总结写入：`project_summary_append`

这证明本地受限工具层已实现，不等同于外部 MCP Host、真实云模型或飞书已经完成 live 验收。

## 安全

绑定到非 localhost 地址时，程序默认要求 `WORKBENCH_PASSWORD`，否则拒绝启动。启用密码时必须设置至少 24 字符且非示例值的 `SESSION_SECRET`。

```bash
WORKBENCH_PASSWORD="a-strong-password"
SESSION_SECRET="replace-with-a-long-random-secret"
CAPTURE_TOKEN="another-long-random-token"
```

通过 HTTPS 反向代理、局域网 IP、自定义域名或 Tailscale 访问时，还要设置 `TRUSTED_ORIGINS`；HTTPS 下设置 `COOKIE_SECURE=1`。应用校验实际 `Host` 和 `Origin`，不采信 `X-Forwarded-*` 自动放宽。

## 数据、备份与恢复

默认数据目录：`./data`

```text
state.json   机器状态、任务、收件箱和确认项
config.json  工作区、业务板块和数据源配置
backups/     自动与手工 backup v2
migrations/  升级前原始快照和迁移报告
captures/    Capture 幂等收据；仅正文哈希和标识符
recovery/    飞书跨资源事务恢复凭据；不含分析正文
```

手工备份：

```bash
npm run backup
```

backup v2 包含 `state`、`config`、`captureReceipts` 和 `projectRecordReceipts`，不包含真实项目工作区、飞书叙事正文或凭证。

恢复前先停止工作台：

```bash
npm run restore -- /path/to/backup.json
```

恢复脚本会先创建安全备份，并对 state/config/两类凭据进行成组恢复与回滚。旧备份没有凭据字段时，会保留当前凭据目录而不是静默清空。

`GET /api/export` 只导出 state/config，适合业务检查，不是完整恢复包。备份默认与主数据在同一磁盘，不等同于异地灾备，也不包含真实项目工作区。

## 测试

```bash
npm test
```

合同测试覆盖：

- 新项目和新备忘不能绕过收件箱
- 待办必须有合法截止日期
- AI 不能自动安排今日
- 项目必须有计划结束日期
- 项目名歧义必须由用户选择
- 新建/归类项目从第一次写入就是 identity-only `PROJECT.md`
- 旧叙事先保存原始迁移快照
- `PROJECT.md` dry-run、备份和可重入迁移
- 飞书官方 URL 校验、换绑清除旧指针
- block-ID 读回、operationId 幂等和分页上限
- REST、AI、MCP 共用同步锁
- 远端成功/结果未知/本地失败的恢复重试
- 项目页正文不使用浏览器持久化
- HTTP Capture 接受 `captureId`、安全重放并拒绝正文冲突
- Capture 收据与项目恢复凭据进入 backup v2，恢复后继续幂等和对账

自动化测试使用 fake Provider 和 fake Feishu client，不请求或处理真实凭证，不等同于 live OpenAI、飞书、浏览器、iPhone 或部署验证。

## 目录

```text
src/        后端、AI、文件系统、领域规则和 MCP
public/     单页前端与飞书项目记忆面板
scripts/    doctor / backup / restore / migration
tests/      自动化合同测试
data/       本地持久化数据
workspace/  默认工作区
docs/       架构、API、部署、Provider、飞书和 iPhone 说明
```
