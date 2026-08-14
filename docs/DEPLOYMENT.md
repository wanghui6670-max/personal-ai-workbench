# 部署说明

Personal AI Workbench 是本地文件系统优先的应用。服务进程必须能够直接访问：

- 持久化数据目录；
- 真实项目工作区；
- 已登录的 `ticktick` CLI；
- 已登录的 `lark-cli`；
- 本机日历 ICS 输出目录。

本文档中的命令和占位符不代表真实凭证、真实飞书文档或 live 验证结果。

## 1. 推荐拓扑：原生运行在项目所在机器

```bash
cp .env.example .env
npm run doctor
npm start
```

默认只监听：

```text
HOST=127.0.0.1
PORT=4173
```

在工作台“设置”中配置：

1. 真实项目工作区；
2. 滴答账户区域；
3. 飞书《每日工作日记》URL；
4. 是否生成本机 ICS 日历；
5. 日历名称。

## 2. 滴答 CLI

程序固定执行：

```text
ticktick
```

不会从配置中执行任意命令。

账户区域：

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

安装后应在运行工作台的同一操作系统用户下完成登录。不要把 token、cookie、配置目录或命令输出中的敏感信息复制到仓库、日志或聊天。

`tasks completed` 不可用时，工作台仍可导入 active tasks，但不会把缺失任务擅自判定为完成。

## 3. 飞书每日工作日记

飞书不再作为个人待办来源，而是沉淀目标。

设置中填写官方 Feishu/Lark HTTPS 文档链接，例如：

```text
https://<tenant>.feishu.cn/wiki/<document-token>
```

前置条件：

1. 在运行工作台的同一台机器、同一个用户下安装 `lark-cli`；
2. 以飞书用户身份完成授权；
3. 确认目标文档可读可写；
4. 不把授权文件或凭证打包进仓库或镜像。

任务快照和每日总结只操作固定章节：

```text
每日工作日记
```

记录前缀：

```text
[WORKBENCH_DAILY_TODOS]
[WORKBENCH_DAILY_SUMMARY]
```

写入顺序：

```text
读取
→ 按 operationId 查重
→ 写入
→ 按 operationId 读回确认
```

同一 operationId 若已对应不同正文，工作台返回冲突并停止。

完整合同见 [`TASK_SOURCE_PIPELINE.md`](TASK_SOURCE_PIPELINE.md)。

## 4. 本机日历

生成文件：

```text
<data-dir>/calendar/personal-ai-workbench.ics
```

默认数据目录下对应：

```text
./data/calendar/personal-ai-workbench.ics
```

安全边界：

- 目录权限 `0700`；
- 文件权限 `0600`；
- 写临时文件后原子替换；
- 失败时清理临时文件；
- UID 来自外部任务 ID 哈希；
- 完成任务在下一次同步时退出日历；
- 全天任务保持全天；
- 没有完整时段时不猜测时长。

工作台只生成 ICS 文件，不调用系统日历 API。部署完成后，由用户在 macOS Calendar、Windows 日历或其他客户端中导入或订阅该文件。

## 5. 环境自检

```bash
npm run doctor
```

启用外部任务管线后，doctor 会检查：

- Node.js；
- Git；
- 数据目录和工作区可写性；
- `ticktick` 二进制；
- 账户区域对应的 `TICKTICK_HOST`；
- `lark-cli` 二进制；
- 飞书工作日记配置；
- 本机 ICS 路径。

doctor 不会执行真实任务同步、飞书写入或系统日历导入，因此“通过”不等同于 live 验证。

## 6. 局域网、Tailscale 或内网部署

需要从其他设备访问时，至少设置：

```text
HOST=0.0.0.0
WORKBENCH_PASSWORD=<强密码>
SESSION_SECRET=<至少 24 字符的长随机字符串>
TRUSTED_ORIGINS=http://<受信任主机或IP>:4173
```

建议使用可信局域网、Tailscale 或受控内网，不要直接开放公网端口。

HTTPS 时设置：

```text
COOKIE_SECURE=1
```

应用校验实际 `Host` 和 `Origin`，不会采信 `X-Forwarded-*` 自动放宽。

## 7. iPhone Shortcut

`POST /api/capture` 仍是独立快速采集入口，不是滴答主任务源。

```text
CAPTURE_TOKEN=<独立长随机 token>
```

每条新事项生成一个 `captureId`；同一次不确定重试复用原 ID。采集只进入工作台收件箱，不自动成为正式待办或加入今日。

详见 [`IPHONE_SHORTCUT.md`](IPHONE_SHORTCUT.md)。

## 8. Docker Compose

```bash
docker compose config
docker compose up -d --build
```

容器内：

```text
/data       工作台持久化数据和 ICS
/workspace  真实项目目录
```

默认镜像不会包含：

- 你的 `ticktick` 二进制或登录状态；
- 你的 `lark-cli` 登录状态；
- 飞书授权文件；
- 系统日历客户端。

因此启用新管线时优先使用原生运行。

需要容器化时，部署者必须自行：

1. 安装受控版本的 `ticktick` 和 `lark-cli`；
2. 以非 root 用户提供登录状态；
3. 持久化 `/data`；
4. 挂载真实 `/workspace`；
5. 确保 CLI 配置目录权限正确；
6. 不把个人凭证烘焙进公开镜像。

仅挂载 `/data` 和 `/workspace` 不会自动获得 CLI 授权。

## 9. Readiness

`GET /api/health` 只证明本地 state/config、数据目录和工作区可用，不证明：

- TickTick/Dida365 当前可达；
- `ticktick` 登录仍有效；
- 飞书当前可达或有编辑权限；
- ICS 已被某个日历客户端成功导入；
- OpenAI 当前可达；
- 浏览器和真实 iPhone 已验收。

## 10. AI Provider

默认 Luna Profile：

```text
OPENAI_API_KEY=<你的 Key>
OPENAI_MODEL=gpt-5.6-luna
```

推理档位固定为 `xhigh`。Provider 失败时回退本地规则，不会自动改变截止日期、收件箱或今日计划。

配置和 doctor 只证明参数存在，不证明 live success。详见 [`AI_PROVIDER.md`](AI_PROVIDER.md)。

## 11. 数据目录

```text
state.json   项目、任务、收件箱、今日、确认项和机器指针
config.json  工作区、业务板块和外部任务管线设置
calendar/    可重建的本机 ICS 日历镜像
backups/     自动每日快照与手工 backup v2
migrations/  升级快照和迁移报告
captures/    Capture 哈希收据
recovery/    飞书跨资源事务恢复凭据
```

ICS 是可重建镜像，不是待办真源。滴答清单仍是外部任务事实源。

## 12. 备份与恢复

手工备份：

```bash
npm run backup
```

恢复前停止工作台：

```bash
npm run restore -- /path/to/backup.json
npm start
```

backup v2 包含：

- state；
- config；
- Capture 幂等收据；
- 项目飞书记录恢复凭据。

不包含：

- `/workspace` 中的真实项目资料；
- 飞书正文；
- CLI 登录状态或凭证；
- `.env`；
- OpenAI、飞书或滴答凭证；
- 本机日历客户端配置。

恢复后应重新运行：

```bash
npm run doctor
```

然后由用户明确执行一次滴答同步，重新生成 ICS。

## 13. 灾备边界

完整灾备至少分别保护：

1. `/data`；
2. `/workspace`；
3. 远端 Git 仓库；
4. 飞书项目文档和每日工作日记；
5. CLI 登录恢复方式；
6. 滴答清单账户本身。

部署者应自行定义加密、保留期、异机复制、RPO/RTO 和恢复演练。

## 14. 云部署限制

无状态 Serverless 环境不能直接读取本地项目目录，也不能天然访问本机 CLI 登录态或生成本机日历文件。

若必须远程部署，需要在项目文件所在机器运行受控服务，或把工作区、数据目录和 CLI 登录环境安全地迁移到长期主机。这属于另一套架构，不是默认部署模型。
