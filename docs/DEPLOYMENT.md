# 部署说明

Personal AI Workbench 必须运行在能访问以下资源的长期主机上：

- 持久化数据目录；
- 真实项目工作区；
- 已安装、具备可用会员权限并完成登录的得到大脑 `getnote` CLI；
- 已登录的 `lark-cli`；
- 本机 ICS 输出目录。

普通无状态云函数不能直接读取笔记本项目，也不能天然访问本机 CLI 登录态。

## 1. 推荐：原生运行

```bash
cp .env.example .env
npm run doctor
npm start
```

默认：

```text
HOST=127.0.0.1
PORT=4173
```

设置页配置真实项目工作区、得到大脑最近笔记扫描数量、飞书《每日工作日记》URL、本机日历开关和日历名称。

## 2. 得到大脑 CLI

安装或更新：

```bash
npx -y @getnote/cli@latest setup
```

程序只执行固定二进制：

```text
getnote
```

受控只读命令：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote doctor -o json
```

CLI 必须安装并登录在运行工作台的同一操作系统用户下。工作台不读取、请求或保存 CLI token、cookie 或登录文件。

`getnote notes` 分页读取最近笔记；`getnote note todos` 读取每篇笔记的 `meeting_todos.source` 和 `meeting_todos.items`。没有明确待办章节时，上游返回空列表，工作台不使用模型猜测。

部署前可直接检查：

```bash
getnote doctor -o json
getnote notes --limit 20 -o json
```

不要把这些命令的认证输出、配置目录或登录文件提交到 Git。

## 3. 飞书每日工作日记

飞书是沉淀目标，不再是个人待办来源。

设置官方 Feishu/Lark HTTPS 文档，例如：

```text
https://<tenant>.feishu.cn/wiki/<document-token>
```

前置条件：

1. 同一机器、同一用户安装 `lark-cli`；
2. 以飞书用户身份完成授权；
3. 目标文档可读可写；
4. 不把授权文件或凭证打包进仓库或镜像。

固定章节和前缀：

```text
每日工作日记
[WORKBENCH_DAILY_TODOS]
[WORKBENCH_DAILY_SUMMARY]
[WORKBENCH_OP:<operationId>]
```

写入采用：

```text
读取 → operationId 查重 → 写入 → operationId 读回
```

同一 operationId 若已对应不同正文，返回冲突并停止。

详见 [`TASK_SOURCE_PIPELINE.md`](TASK_SOURCE_PIPELINE.md)。

## 4. 本机 ICS 日历

路径：

```text
<data-dir>/calendar/personal-ai-workbench.ics
```

规则：

- 目录权限 `0700`；
- 文件权限 `0600`；
- 临时文件加原子替换；
- 写失败清理临时文件；
- 稳定 UID 来自得到大脑外部待办 ID 哈希；
- 只包含未完成且已确定日期的事项；
- 有完整开始/结束时段时生成定时事件；
- 只有明确截止时刻时生成瞬时事件，不猜持续时间；
- 只有明确日期时生成全天事件；
- 模糊日期事项不会进入日历，而是进入工作台收件箱。

工作台只生成 ICS，不调用系统日历 API。部署后由用户在 macOS Calendar、Windows 日历或其他 iCalendar 客户端中导入或订阅。

## 5. doctor

```bash
npm run doctor
```

启用外部任务管线后会检查：

- Node.js、Git；
- 数据目录与工作区；
- 得到大脑集成配置；
- `getnote doctor -o json` 的安装、会员、登录和 API 连通性；
- `lark-cli`；
- 飞书工作日记配置；
- ICS 路径。

doctor 不执行得到大脑写入、飞书写入或系统日历导入，因此通过不等于 live 验证。

## 6. 错误来源配置迁移

如果现有配置包含此前误接入产生的：

```text
provider = dida_cli
cliFlavor = ...
```

新版本会把外部待办管线停用并显示“需要重新配置”。部署者应：

1. 先执行 `npm run backup`；
2. 在设置中确认 `getnote`、最近笔记扫描数量、飞书日记和本机日历；
3. 保存设置；
4. 执行一次得到大脑同步。

保存新的得到大脑设置时，只清理 `source=dida_cli` 的机器导入待办和收件箱项。手工事项、Capture、项目、项目飞书记录和其他来源数据不删除。

## 7. 局域网 / Tailscale / 内网

```text
HOST=0.0.0.0
WORKBENCH_PASSWORD=<强密码>
SESSION_SECRET=<至少 24 字符随机字符串>
TRUSTED_ORIGINS=http://<受信任主机或IP>:4173
```

HTTPS 时设置：

```text
COOKIE_SECURE=1
```

应用校验实际 Host 和 Origin，不采信 `X-Forwarded-*` 自动放宽。

## 8. iPhone Shortcut

`POST /api/capture` 是独立快速采集入口，不是得到大脑主来源。

```text
CAPTURE_TOKEN=<独立长随机 token>
```

每条新事项生成 `captureId`；同一次不确定重试复用原 ID。采集只进入 Workbench 收件箱，不自动成为正式待办或加入今日。

详见 [`IPHONE_SHORTCUT.md`](IPHONE_SHORTCUT.md)。

## 9. Docker

```bash
docker compose config
docker compose up -d --build
```

容器内：

```text
/data       工作台持久化数据和 ICS
/workspace  真实项目目录
```

默认镜像不会包含个人 `getnote`、`lark-cli` 或登录状态。启用新管线时优先使用原生运行。

需要容器化时，部署者必须自行安装受控版本 CLI、以非 root 用户提供登录状态、持久化 `/data`、挂载真实 `/workspace`，且不得把个人凭证烘焙进公开镜像。

容器内还必须能够运行：

```text
getnote doctor -o json
getnote notes --limit 20 -o json
getnote note todos <note_id> -o json
```

## 10. Readiness

`GET /api/health` 只证明本地 state/config、数据目录和工作区可用，不证明：

- 得到大脑会员或登录仍有效；
- 得到大脑 API 当前可达；
- 飞书当前可达或有编辑权限；
- ICS 已被日历客户端成功导入；
- OpenAI 当前可达；
- 真实浏览器和 iPhone 已验收。

## 11. AI Provider

默认 Profile：

```text
OPENAI_API_KEY=<你的 Key>
OPENAI_MODEL=gpt-5.6-luna
```

推理档位固定 `xhigh`。Provider 失败时回退本地规则，不自动改变截止日期、收件箱或今日。

详见 [`AI_PROVIDER.md`](AI_PROVIDER.md)。

## 12. 数据目录

```text
state.json   项目、任务、收件箱、今日、确认项和机器指针
config.json  工作区、业务板块和外部任务管线设置
calendar/    可重建 ICS 镜像
backups/     自动与手工 backup v2
migrations/  升级快照和迁移报告
captures/    Capture 哈希收据
recovery/    飞书跨资源事务恢复凭据
```

ICS 是可重建镜像，不是待办真源。

## 13. backup v2

```bash
npm run backup
```

精确恢复字段：

```json
{
  "backupVersion": 2,
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts`：正文 SHA-256 和标识符。
- `projectRecordReceipts`：机器进度、operationId 和飞书指针。

不包含项目工作区、飞书正文、CLI 登录状态、`.env`、ICS 客户端配置或任何凭证。

**旧备份若没有 `captureReceipts` 或 `projectRecordReceipts` 字段时**，恢复时保留当前凭据目录，而不是静默清空。这保证向后兼容，但旧备份不是这些凭据的历史快照。

## 14. 恢复

先停止工作台：

```bash
npm run restore -- /path/to/backup.json
npm run doctor
npm start
```

恢复脚本会先创建恢复前安全备份。backup v2 成组替换 state、可选 config、`captureReceipts` 和 `projectRecordReceipts`；恢复任一阶段失败会尝试回滚全部已修改部分。

恢复后由用户明确执行一次得到大脑同步，重新生成 ICS。

## 15. 灾备边界

完整灾备至少保护：

1. `/data`；
2. `/workspace`；
3. 远端 Git；
4. 飞书项目文档和每日工作日记；
5. 得到大脑账户和 CLI 恢复方式；
6. 飞书 CLI 登录恢复方式。

部署者自行定义加密、保留期、异机复制、RPO/RTO 和恢复演练。

## 16. 云部署限制

无状态 Serverless 环境不能直接读取本地项目目录，也不能天然访问本机 CLI 登录态或生成本机日历文件。

若必须远程部署，需要把项目工作区、数据目录和 CLI 登录环境安全地迁移到长期主机。这不是默认部署模型。
