# 个人 AI 项目管理工作台

这是一个**本地文件系统优先、AI 辅助、人保留最终决策权**的个人项目管理工作台。

它解决的核心问题是：工作被打断后，不再重新找资料、重新理解上下文、重新开始。

## 核心原则

1. 滴答清单 CLI 是个人待办事实的单向来源。
2. 有截止日期的外部任务进入正式待办；没有截止日期的任务进入收件箱，等待用户处理。
3. AI 不自动分类收件箱，也不自动把任务加入今日工作台。
4. 项目是独立上下文边界。业务板块 → 项目 → 本地文件夹一一对应。
5. 本地项目文件夹保存真实工作产物；Git 保存版本证据。
6. 飞书项目云文档是项目分析、阶段总结、复盘和上下文恢复叙事的唯一真源。
7. 飞书《每日工作日记》保存个人待办快照和每日总结，不再作为个人待办来源。
8. Workbench 只保存机器状态、任务、确认项、路径、幂等收据和飞书记录指针。
9. 本机 ICS 日历只镜像滴答任务已有日期与时段，不猜测日期、时长或优先级。
10. 项目进度和外部任务只在用户主动同步时刷新，不做后台自动安排。

## 数据边界

| 位置 | 保存内容 |
|---|---|
| 滴答清单 | 个人待办事实；工作台只读，不反向修改 |
| 本地项目文件夹 | 原始资料、工作过程、代码、最终交付和归档 |
| Git | commit、remote、working tree 和版本证据 |
| Workbench `state.json` | 项目元数据、机器进度、待办缓存、收件箱、今日和待确认 |
| Workbench `captures/` | Capture 正文哈希与幂等标识，不保存正文 |
| Workbench `recovery/` | 飞书跨资源事务的机器恢复凭据，不保存分析正文 |
| 飞书项目文档 | 项目分析、阶段总结、复盘、卡点说明和上下文恢复叙事 |
| 飞书每日工作日记 | 滴答待办快照、每日总结和个人工作时间线 |
| `data/calendar/personal-ai-workbench.ics` | 本机日历镜像 |

`PROJECT.md` 只是项目身份证和入口索引，不保存项目分析、卡点或恢复摘要。

## 已实现功能

- 固定 `ticktick` CLI 单向读取任务；国际版使用 `ticktick.com`，国内版使用 `dida365.com`
- 外部 task ID 去重、截止日期解析、完成状态同步和外部元数据保留
- 无截止日期任务进入待处理收件箱；不会自动生成日期
- 任务快照先写飞书每日工作日记并读回，再更新本机日历和本地状态
- 用户触发“沉淀今日总结”，正文只写飞书，不复制到本地审计日志
- 私有、原子、稳定 UID 的本机 ICS 日历
- 收件箱自然语言处理：归入项目 / 项目待办 / 独立待办 / 备忘 / 新建项目 / 删除
- AI 生成项目名称、介绍和业务归属建议；不确定时进入待归类
- identity-only 项目目录：`PROJECT.md / 01_原始资料 / 02_工作过程 / 03_最终交付 / 99_归档`
- 主动同步本地文件、Git commit、Git remote 和文本证据
- 项目分析先写飞书并按 block ID 读回，再提交本地机器状态
- 稳定 operationId、幂等重试、远端成功/本地失败恢复凭据
- REST、右侧 AI 与 MCP 共用项目同步互斥锁
- 项目页临时读取最近飞书分析与总结，支持分页且不做浏览器持久化
- 最近 3 天 + 临近截止事项的早晨对焦；今日安排完全由用户决定
- iPhone Shortcut / 外部采集 API，支持 `captureId` 去重和冲突检测
- JSON 原子写入、每日备份、手工备份、恢复和业务导出
- 可选访问密码、Host/Origin 安全边界和限流
- AI-native 双面板与受限 MCP 工具层
- Docker、doctor 和自动化合同测试

## 本地运行

要求：

- Node.js 20+
- Git（项目版本证据）
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

`npm start`、`npm run doctor`、`npm run backup`、`npm run restore` 和迁移命令会读取项目根目录 `.env`。加载器只接受 `.env.example` 中声明的键，不执行 shell 语法、变量展开、`$()` 或反引号命令替换。

## 滴答 CLI → 飞书日记 → 本机日历

工作台始终执行固定的：

```text
ticktick
```

设置中的账户区域决定环境变量：

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

同步流程：

```text
读取 CLI
→ 解析和外部 task ID 去重
→ 写飞书任务快照并按 operationId 读回
→ 原子生成本机 ICS
→ 提交 Workbench 待办/收件箱缓存
```

规则：

- 有截止日期：进入正式待办。
- 无截止日期：进入收件箱，等待你明确处理。
- 明确完成：标记完成、移出今日、从下一版日历移除。
- 不在 active 列表且没有完成证据：不擅自判定完成。
- 同步不会自动加入今日，也不会反向修改滴答任务。
- 全天任务保持全天；缺少完整时段时不猜测日历时长。

飞书固定章节：

```text
每日工作日记
```

记录类型：

```text
[WORKBENCH_DAILY_TODOS]
[WORKBENCH_DAILY_SUMMARY]
```

完整合同见 [`docs/TASK_SOURCE_PIPELINE.md`](docs/TASK_SOURCE_PIPELINE.md)。

## 本机日历

生成路径：

```text
data/calendar/personal-ai-workbench.ics
```

目录权限为 `0700`，文件权限为 `0600`。每次同步原子重写完整日历，UID 由外部任务 ID 哈希生成。

该文件可以由 macOS Calendar、Windows 日历或其他支持 iCalendar 的本机软件导入或订阅。工作台只生成文件，不会在未确认的情况下调用系统日历 API 或替用户安排时间。

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

完整合同和迁移说明见 [`docs/PROJECT_RECORDS.md`](docs/PROJECT_RECORDS.md)。

## AI Provider

默认 Profile 是 `openai_luna`，默认模型 `gpt-5.6-luna`，推理档位 `xhigh`。项目创建、项目进度和早晨对焦使用本机校验的结构化输出。

配置 Key、doctor 通过或设置页显示“已配置”，只证明参数准备就绪，不证明模型已真实联网。Provider 失败时回退本地规则，不会自动改变截止日期、收件箱或今日计划。

文件正文默认不出站。兼容服务配置见 [`docs/AI_PROVIDER.md`](docs/AI_PROVIDER.md)。

## AI-native 双面板与 MCP

左侧是人的工作面板，右侧是 AI 工作区。模型只能提出白名单 MCP 工具调用；本地注册表执行参数校验、确认门和领域规则。

外部待办工具：

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个写操作都需要用户确认。旧 `feishu_inbox_sync` 已从 AI/MCP 白名单移除。

项目记录工具：

```text
project_records_read
project_summary_append
```

MCP transport：`POST /api/mcp`。

## iPhone 快捷指令采集

`POST /api/capture` 仍是独立的快速采集入口，不是滴答主任务源。采集只进入工作台收件箱，不自动成为正式待办，也不自动加入今日。

```json
{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "text": "刚刚想到的事情",
  "source": "iphone-shortcut"
}
```

同 ID + 同正文安全重放；同 ID + 不同正文返回冲突。详见 [`docs/IPHONE_SHORTCUT.md`](docs/IPHONE_SHORTCUT.md)。

## 真实项目目录

在“设置”中把工作区根目录改成真实项目根目录，例如：

```text
/Users/yourname/Work
```

服务必须运行在能访问真实项目文件、`ticktick` 登录状态、`lark-cli` 登录状态和本机数据目录的机器上，例如电脑、Mac mini、NAS 或办公室服务器。

普通无状态云函数不能直接读取笔记本本地路径，也不能天然访问本机 CLI 登录状态。

部署说明见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 从旧飞书收件箱来源升级

启用新的外部待办管线时，旧的：

```text
config.dataSource.provider = feishu_doc
```

会被清除。飞书不再被 AI/MCP 当作个人待办来源。

历史本地收件箱事项不会被自动删除。用户应先备份，再逐项处理历史事项。

## 数据、备份与恢复

默认数据目录：`./data`

```text
state.json   机器状态、任务、收件箱和确认项
config.json  工作区、业务板块和集成设置
calendar/    本机 ICS 日历镜像
backups/     自动与手工 backup v2
migrations/  升级前原始快照和迁移报告
captures/    Capture 幂等收据
recovery/    飞书跨资源事务恢复凭据
```

手工备份：

```bash
npm run backup
```

恢复前停止工作台：

```bash
npm run restore -- /path/to/backup.json
```

backup v2 不包含真实项目工作区、飞书正文、CLI 登录数据或任何凭证。ICS 可从滴答来源重新生成，不作为恢复真源。

## 安全

绑定到非 localhost 地址时，程序默认要求 `WORKBENCH_PASSWORD`。启用密码时必须设置至少 24 字符且非示例值的 `SESSION_SECRET`。

```bash
WORKBENCH_PASSWORD="a-strong-password"
SESSION_SECRET="replace-with-a-long-random-secret"
CAPTURE_TOKEN="another-long-random-token"
```

通过 HTTPS 反向代理、局域网 IP、自定义域名或 Tailscale 访问时，还要设置 `TRUSTED_ORIGINS`；HTTPS 下设置 `COOKIE_SECURE=1`。

工作台不读取、请求或保存滴答与飞书凭证；它只调用部署用户已经登录的本机 CLI。

## 测试

```bash
npm test
```

合同测试覆盖：

- CLI 固定命令 allowlist 与账户区域选择
- 外部 task ID 去重、截止/无截止/完成状态映射
- 飞书任务快照与每日总结 operationId 幂等和冲突关闭
- 本机 ICS 全天/定时事件、稳定 UID、私有权限和原子写入
- 新管线不会自动安排今日或反向修改任务
- 真实 `JsonStore` 持久化、MCP 确认门和浏览器静态合同
- 项目飞书记录、迁移、恢复、Capture 幂等和安全边界

自动化测试使用 fake CLI、fake Provider 和 fake Feishu client，不请求或处理真实凭证，不等同于 live 滴答、飞书、系统日历、OpenAI、浏览器、iPhone 或部署验证。

## 目录

```text
src/        后端、AI、任务源、日历、文件系统、领域规则和 MCP
public/     单页前端与集成设置层
docs/       架构、API、部署、任务源、飞书、Provider 和 iPhone 说明
scripts/    doctor / backup / restore / migration
tests/      自动化合同测试
data/       本地持久化数据和 ICS
workspace/  默认项目工作区
```
