# 部署说明

Personal AI Workbench 必须运行在能访问以下资源的长期主机上：

- 持久化数据目录；
- 真实项目工作区；
- 已登录的 `ticktick` CLI；
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

设置页配置真实项目工作区、滴答账户区域、飞书《每日工作日记》URL、本机日历开关和日历名称。

## 2. 滴答 CLI

程序只执行固定二进制：

```text
ticktick
```

账户区域通过环境变量选择：

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

CLI 必须安装并登录在运行工作台的同一操作系统用户下。工作台不读取、请求或保存 CLI token、cookie 或登录文件。

`tasks completed` 不可用时，工作台仍导入 active tasks，但不把缺失任务擅自判为完成。

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
- 稳定 UID 来自外部 task ID 哈希；
- 只包含未完成且有截止日期的任务；
- 全天任务保持全天；
- 没有完整开始/结束时段时不猜持续时间。

工作台只生成 ICS，不调用系统日历 API。部署后由用户在 macOS Calendar、Windows 日历或其他 iCalendar 客户端中导入或订阅。

## 5. doctor

```bash
npm run doctor
```

启用外部任务管线后会检查：

- Node.js、Git；
- 数据目录与工作区；
- `ticktick`；
- 账户区域对应的 `TICKTICK_HOST`；
- `lark-cli`；
- 飞书工作日记配置；
- ICS 路径。

doctor 不执行真实任务同步、飞书写入或系统日历导入，因此通过不等于 live 验证。

## 6. 局域网 / Tailscale / 内网

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

## 7. iPhone Shortcut

`POST /api/capture` 是独立快速采集入口，不是滴答主任务源。

```text
CAPTURE_TOKEN=<独立长随机 token>
```

每条新事项生成 `captureId`；同一次不确定重试复用原 ID。采集只进入 Workbench 收件箱，不自动成为正式待办或加入今日。

详见 [`IPHONE_SHORTCUT.md`](IPHONE_SHORTCUT.md)。

## 8. Docker

```bash
docker compose config
docker compose up -d --build
```

容器内：

```text
/data       工作台持久化数据和 ICS
/workspace  真实项目目录
```

默认镜像不会包含个人 `ticktick`、`lark-cli` 或登录状态。启用新管线时优先使用原生运行。

需要容器化时，部署者必须自行安装受控版本 CLI、以非 root 用户提供登录状态、持久化 `/data`、挂载真实 `/workspace`，且不得把个人凭证烘焙进公开镜像。

## 9. Readiness

`GET /api/health` 只证明本地 state/config、数据目录和工作区可用，不证明：

- TickTick/Dida365 当前可达；
- CLI 登录仍有效；
- 飞书当前可达或有编辑权限；
- ICS 已被日历客户端成功导入；
- OpenAI 当前可达；
- 真实浏览器和 iPhone 已验收。

## 10. AI Provider

默认 Profile：

```text
OPENAI_API_KEY=<你的 Key>
OPENAI_MODEL=gpt-5.6-luna
```

推理档位固定 `xhigh`。Provider 失败时回退本地规则，不自动改变截止日期、收件箱或今日。

详见 [`AI_PROVIDER.md`](AI_PROVIDER.md)。

## 11. 数据目录

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

## 12. backup v2

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

旧备份若没有 `captureReceipts` 或 `projectRecordReceipts` 字段时，恢复时保留当前凭据目录，而不是静默清空。这保证向后兼容，但旧备份不是这些凭据的历史快照。

## 13. 恢复

先停止工作台：

```bash
npm run restore -- /path/to/backup.json
npm run doctor
npm start
```

恢复脚本会先创建恢复前安全备份。backup v2 成组替换 state、可选 config、`captureReceipts` 和 `projectRecordReceipts`；恢复任一阶段失败会尝试回滚全部已修改部分。

恢复后由用户明确执行一次滴答同步，重新生成 ICS。

## 14. 灾备边界

完整灾备至少保护：

1. `/data`；
2. `/workspace`；
3. 远端 Git；
4. 飞书项目文档和每日工作日记；
5. 滴答账户；
6. CLI 登录恢复方式。

部署者自行定义加密、保留期、异机复制、RPO/RTO 和恢复演练。

## 15. 云部署限制

无状态 Serverless 环境不能直接读取本地项目目录，也不能天然访问本机 CLI 登录态或生成本机日历文件。

若必须远程部署，需要把项目工作区、数据目录和 CLI 登录环境安全地迁移到长期主机。这不是默认部署模型。
