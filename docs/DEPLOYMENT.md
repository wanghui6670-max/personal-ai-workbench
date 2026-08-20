# 部署说明

> 当前 R1 部署合同以 `RELEASE_R1_CONTRACT.md` 和 `WORKBENCH_V3_SOURCE_CONTRACT.md` 为准。本文后半保留的 GetNote Task Sync、每日工作日记、VPS 和 Docker 内容只用于历史兼容或开发验证，不能覆盖 v3 来源合同。

R1 正式运行画像：`local_single_user`。正式服务运行在一台受信任 Mac、一个 macOS 用户、一个 Node 进程和一个独占 `DATA_DIR` 上，由 LaunchAgent 常驻并默认只监听 loopback。

当前个人事项主链固定为：

```text
飞书云文档中的明确待办（个人工作事项主入口）
→ 用户主动同步
→ Workbench Inbox
→ AI 建议或人工处理
→ 用户确认 Todo
→ 用户决定 Today
```

GetNote 只作为经用户确认的自媒体内容来源，不再是个人待办来源。Legacy GetNote Task Sync v2 只为历史数据兼容保留，不属于 R1。

R1 主机必须能访问：

- 持久化数据目录；
- 真实项目工作区；
- 当前飞书明确待办来源；
- 可选：GetNote 内容来源、飞书项目记录、Provider 或 DSH 的受控运行时；
- 已启用能力所需的本机 CLI，但不把 CLI 登录态打包进仓库或镜像。

普通无状态云函数不能直接读取真实项目工作区，也不能天然持有得到大脑或飞书 CLI 登录态。

## 1. 可选 GetNote 内容来源的两种运行形态

GetNote 内容同步业务层复用 `GetNoteReader`。其中 `fetchTodos` 只供 Legacy Task Sync 回归，不进入当前交互式个人待办主链：

```text
listNotes
fetchTodos
fetchNote
status
```

### 本地/原生：`local_cli`

```dotenv
GETNOTE_RUNTIME_MODE=local_cli
```

工作台进程所在用户必须安装并授权 `getnote`。

### 历史 VPS/Docker 兼容：`private_http`

```text
VPS 宿主机 getnote CLI
        ↓
只读 GetNote Runtime sidecar
        ↓ private_http + service token
Workbench Docker
```

Workbench 镜像不安装 getnote CLI、不烘焙得到大脑凭证。CLI 登录态留在 VPS 宿主机。

Workbench `.env`：

```dotenv
GETNOTE_RUNTIME_MODE=private_http
GETNOTE_RUNTIME_BASE_URL=http://host.docker.internal:4310
GETNOTE_RUNTIME_SERVICE_TOKEN=<至少 32 字符随机值>
```

Runtime 只允许 loopback/私网/Docker 内部地址，不允许公网 origin 或 redirect。

## 2. VPS 宿主机 GetNote CLI

安装或更新：

```bash
npx -y @getnote/cli@latest setup
```

本地 CLI transport 的固定只读命令：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote note <note_id> -o json
getnote doctor -o json
```

Workbench 不读取、请求或保存 CLI token、cookie 或登录文件。

宿主机可做只读验证：

```bash
getnote doctor -o json
getnote notes --limit 20 -o json
```

不要把认证输出、配置目录或登录文件提交到 Git。

## 3. GetNote Runtime sidecar

仓库提供：

```bash
npm run getnote:runtime
```

sidecar 只提供：

```text
GET /health
GET /v1/notes
GET /v1/notes/:id/todos
GET /v1/notes/:id
```

数据路由需要 bearer service token；没有任意 shell、任意 argv 或写 GetNote 接口。

推荐默认绑定：

```dotenv
GETNOTE_RUNTIME_HOST=127.0.0.1
GETNOTE_RUNTIME_PORT=4310
GETNOTE_RUNTIME_SERVICE_TOKEN=<至少 32 字符随机值>
```

如果 Workbench Docker 必须从 bridge 网络访问宿主机 sidecar，应只在确认 VPS 防火墙和容器网络边界后使用私网 bind，并显式：

```dotenv
GETNOTE_RUNTIME_ALLOW_PRIVATE_BIND=1
```

不要把 sidecar 直接暴露到公网。

## 4. Legacy GetNote Task Sync v2（不属于 R1）

本节只描述保留源码的历史行为，不能作为当前部署入口、doctor 成功标准或 R1 现场验收链。当前运行不得把 `external_tasks_sync`、`external_task_integration_update` 或 `daily_summary_publish` 重新注册到交互式 MCP/AI 工具面。

每次用户主动同步读取：

```text
最近 N 篇笔记
+
Workbench 中仍未完成事项对应的旧 sourceNoteId
```

去重后读取明确 `meeting_todos`。没有明确待办章节时接受空列表，不使用模型猜测。

核心事务：

```text
GetNote read
→ Normalize / Reconcile
→ Workbench state 原子提交
```

然后才执行：

```text
Workbench committed
       ├─→ 飞书每日任务快照（可选）
       └─→ ICS 原子重建（可选）
```

飞书或 ICS 失败不回滚 Workbench。

任务配置显式保存 IANA 时区，默认：

```text
Asia/Shanghai
```

因此“下午 3 点”等无 offset 时间不依赖 VPS 系统时区。

## 5. Legacy 飞书每日工作日记 sink

本节的“每日工作日记”是旧 GetNote Task Sync 的可选沉淀 sink；它与当前作为个人工作事项主入口的“飞书明确待办文档”不是同一个职责。每日工作日记 sink 不属于 R1 主链，也不是启用 GetNote 内容同步的前置条件。

未配置飞书 URL 时：

- GetNote → Workbench 核心同步正常；
- `journal.status=not_configured`；
- 不要求 `lark-cli`；
- “发布每日总结”不可用，直到用户配置飞书日记目标。

若要启用飞书 sink，设置官方 Feishu/Lark HTTPS 文档，例如：

```text
https://<tenant>.feishu.cn/wiki/<document-token>
```

前置条件：

1. 执行飞书 sink 的宿主环境安装 `lark-cli`；
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

## 6. 私有 ICS 日历

路径：

```text
<data-dir>/calendar/personal-ai-workbench.ics
```

规则：

- 目录权限 `0700`；
- 文件权限 `0600`；
- 临时文件 + 原子替换；
- 写失败清理临时文件；
- 稳定 UID 来自 GetNote 外部待办 ID 哈希；
- 只包含未完成且已确定日期的事项；
- 全天事项使用 `VALUE=DATE`；
- 无 offset 的明确本地时刻使用任务 `TZID`；
- 只有明确截止时刻时生成瞬时事件，不猜持续时间；
- 模糊日期事项不进入日历，而是进入 Workbench Inbox。

工作台只生成 ICS，不调用系统日历 API。ICS 失败不回滚 Workbench 核心同步。

## 7. doctor

```bash
npm run doctor
```

doctor 必须按当前启用能力分别报告：

- 检查 Node.js、Git、数据目录与工作区；
- 检查飞书明确待办主入口的配置与所需 `lark-cli`，但不把配置存在冒充真实读写成功；
- 仅在启用 GetNote 内容来源时检查其只读 Runtime；
- `local_cli`：运行 `getnote doctor -o json`；
- `private_http`：通过 Reader 对 sidecar 做只读连通性和鉴权检查，不要求 Workbench 容器内存在 getnote CLI；
- Legacy 每日工作日记和 ICS 只能作为兼容检查单独显示，不能成为 v3 主链成功的替代证据。

doctor 不执行得到大脑写入、飞书写入或系统日历导入；普通输出和 `--json` 通过都不等于真实业务现场验收。

## 8. Legacy 错误来源配置迁移

如果现有配置包含此前误接入产生的：

```text
provider = dida_cli
cliFlavor = ...
```

新版本会把外部待办管线停用并显示“需要重新配置”。部署者应：

1. 先执行 `npm run backup`；
2. 在设置中确认 GetNote Runtime、最近笔记扫描数量、任务时区、可选飞书日记和 ICS；
3. 保存设置；
4. 用户明确执行一次得到大脑同步。

保存新的得到大脑设置时，只清理 `source=dida_cli` 的机器导入 Todo 和 Inbox。手工事项、Capture、项目、项目飞书记录和其他来源数据不删除。

## 9. 局域网 / Tailscale / 内网

本节不属于默认 R1。启用任何非 loopback 绑定前必须另立 `local_private_mobile` 或远程部署合同，并单独完成身份、Origin、Cookie、网络和回滚验收。

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

## 10. iPhone Shortcut

默认 loopback 的 R1 不承诺另一台 iPhone 可以访问 Mac。本节只保留 Capture 协议说明；真实手机连接必须先批准并完成上一节的安全私网画像。

`POST /api/capture` 是独立快速采集入口，不是得到大脑主来源。

```text
CAPTURE_TOKEN=<独立长随机 token>
```

每条新事项生成 `captureId`；同一次不确定重试复用原 ID。采集只进入 Workbench Inbox，不自动成为正式 Todo 或加入 Today。

详见 [`IPHONE_SHORTCUT.md`](IPHONE_SHORTCUT.md)。

## 11. Docker

Docker 在 R1 中只作为构建和 CI smoke 面，不是正式运行入口。它必须保持 fail closed，不能使用 `ALLOW_INSECURE_PUBLIC=1` 的结果冒充正式部署证据。

```bash
docker compose config
docker compose up -d --build
```

容器内：

```text
/data       工作台持久化数据和 ICS
/workspace  真实项目目录
```

默认 Workbench 镜像不包含个人 `getnote`、`lark-cli` 或登录状态。

**推荐不要为了 GetNote 把 CLI 和凭证塞进 Workbench 镜像。** VPS 上使用宿主机 CLI + 只读 sidecar；Workbench 通过 `private_http` 访问。

Docker Compose 已提供：

```text
host.docker.internal:host-gateway
```

因此宿主机 sidecar 可通过 `host.docker.internal:<port>` 被容器访问；sidecar 是否需要非 loopback bind，必须根据实际 Docker/VPS 网络测试后决定，不能直接公网暴露。

## 12. Readiness

`GET /api/health` 只证明本地 state/config、数据目录和工作区可用，不证明：

- 得到大脑会员或登录仍有效；
- GetNote Runtime 当前可达；
- 得到大脑 API 当前可达；
- 飞书当前可达或有编辑权限；
- ICS 已被日历客户端成功导入；
- OpenAI 当前可达；
- 真实浏览器已验收；默认 R1 不包含 iPhone 远程连接。

飞书主入口和其他已启用依赖由 `npm run doctor` 的独立诊断补充检查，但只有真实 canary 读回才算现场验收。

## 13. AI Provider

默认 Profile：

```text
OPENAI_API_KEY=<你的 Key>
OPENAI_MODEL=gpt-5.6-luna
```

推理档位固定 `xhigh`。Provider 失败时回退本地规则，不自动改变截止日期、Inbox 或 Today。

详见 [`AI_PROVIDER.md`](AI_PROVIDER.md)。

## 14. 数据目录

```text
state.json   项目、任务、Inbox、Today、确认项和机器指针
config.json  工作区、业务板块和外部任务管线设置
calendar/    可重建 ICS 镜像
backups/     自动与手工 backup v2
migrations/  升级快照和迁移报告
captures/    Capture 哈希收据
recovery/    飞书跨资源事务恢复凭据
```

ICS 是可重建镜像，不是待办真源。

## 15. backup v2

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

## 16. 恢复

先停止工作台：

```bash
npm run restore -- /path/to/backup.json
npm run doctor
npm start
```

恢复脚本会先创建恢复前安全备份。backup v2 成组替换 state、可选 config、`captureReceipts` 和 `projectRecordReceipts`；恢复任一阶段失败会尝试回滚全部已修改部分。

恢复后由用户明确执行一次得到大脑同步，重新生成派生 ICS；没有自动后台同步。

## 17. 灾备边界

完整灾备至少保护：

1. `/data`；
2. `/workspace`；
3. 远端 Git；
4. 飞书项目文档和已启用的每日工作日记；
5. 得到大脑账户和宿主机 CLI 恢复方式；
6. 若使用飞书 sink，飞书 CLI 登录恢复方式；
7. GetNote Runtime service token 的安全恢复方式。

部署者自行定义加密、保留期、异机复制、RPO/RTO 和恢复演练。

## 18. 云部署限制

云部署不属于 R1。

无状态 Serverless 环境不能直接读取真实项目目录，也不适合持有个人 CLI 登录态或长期私有数据目录。

远程部署应使用长期主机：持久化 `/data` 和 `/workspace`，让宿主机承担 CLI 登录环境，再通过受控私网 sidecar 给 Workbench 容器提供最小只读能力。
