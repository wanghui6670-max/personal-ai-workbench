# 部署说明

Personal AI Workbench v1.2.0 是本地文件系统优先的应用。服务进程必须能够直接访问持久化数据目录和真实项目工作区；普通无状态云函数不能直接读取笔记本上的项目目录。

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

在工作台“设置”中把工作区根目录改成真实项目根目录。`npm run doctor` 只检查本机配置和文件系统条件，不主动调用 OpenAI 或飞书，也不证明外部服务当前可达。

### 飞书每日工作日记收件箱

在设置页填写你自己的官方飞书/Lark HTTPS 云文档链接，例如：

```text
https://<tenant>.feishu.cn/wiki/<document-token>
```

工作台只读取一级标题“收件箱”下以 `[INBOX]` 开头的段落或待办。其他章节不会自动变成收件箱事项，也不会自动安排到今日。

启用前置条件：

1. 在运行工作台的同一台机器、同一个操作系统用户下安装 `lark-cli`。
2. 用飞书用户身份完成授权，并确认该用户对目标文档有读取和编辑权限。
3. 仅在本机检查 CLI 和登录状态；不要把 token、app secret、cookie、授权文件或 `.env` 输出复制到项目、日志或聊天中。

```bash
command -v lark-cli
lark-cli auth status --json --verify
```

新增收件箱采用：

```text
写飞书
→ 按 block ID 读回
→ 读回确认后提交本地缓存
```

飞书读取、写入或读回失败时，工作台不会伪装成已同步。

### 飞书项目分析与总结

每个项目可绑定独立的官方飞书/Lark HTTPS 云文档。项目分析、阶段总结、卡点说明和上下文恢复叙事只写固定的“项目分析与总结”章节；本地仅保存机器进度、revision/block/operation 指针和恢复凭据。

完整边界见 [`PROJECT_RECORDS.md`](PROJECT_RECORDS.md)。

## 2. 局域网、Tailscale 或内网部署

需要从另一台设备访问时，至少设置：

```text
HOST=0.0.0.0
WORKBENCH_PASSWORD=<强密码>
SESSION_SECRET=<至少 24 字符的长随机字符串>
TRUSTED_ORIGINS=http://<受信任主机或IP>:4173
```

建议使用可信局域网、Tailscale 或受控内网，而不是直接开放公网端口。

### iPhone 快捷指令采集

```text
CAPTURE_TOKEN=<独立的长随机采集 token>
```

快捷指令请求：

```text
POST http://<Mac局域网IP>:4173/api/capture
Authorization: Bearer <CAPTURE_TOKEN>
```

请求必须为每条新事项生成一个 `captureId`，并在不确定重试时复用同一个 ID。iPhone 不携带飞书凭证；工作台使用运行用户已经登录的 `lark-cli`。详细配置见 [`IPHONE_SHORTCUT.md`](IPHONE_SHORTCUT.md)。

局域网地址变化后，应同时更新快捷指令 URL 和 `TRUSTED_ORIGINS`，再重启工作台。

## 3. Docker Compose

先检查配置：

```bash
docker compose config
```

启动前：

1. 复制 `.env.example` 为 `.env`。
2. 设置非空的 `WORKBENCH_PASSWORD` 和至少 24 字符的 `SESSION_SECRET`。
3. 把 `WORKBENCH_WORKSPACE_PATH` 设置为宿主机真实项目目录的绝对路径。
4. 确保数据目录和工作区对容器运行 UID/GID 可写。
5. 启动：

```bash
docker compose up -d --build
```

容器内：

```text
/data       工作台持久化数据
/workspace  真实项目目录
```

镜像不会复制本机 `.env`、`data/` 或 `workspace/`。首次挂载空 `/data` 时会创建：

```text
state.json
config.json
backups/
migrations/
captures/
recovery/
```

默认只发布到宿主机 `127.0.0.1:4173`。确需局域网发布时设置：

```text
WORKBENCH_BIND_ADDRESS=0.0.0.0
```

并保留密码、会话密钥和受信任 origin。

可选 Compose 变量：

- `WORKBENCH_PORT`：同时设置宿主机发布端口、容器端口和应用 `PORT`，默认 `4173`
- `WORKBENCH_DATA_PATH`：宿主机数据目录，默认 `./data`
- `WORKBENCH_WORKSPACE_PATH`：宿主机真实项目目录，默认 `./workspace`
- `WORKBENCH_UID` / `WORKBENCH_GID`：容器进程 UID/GID，默认 `1000:1000`

不要使用 `chmod 777` 解决挂载权限。Linux 上应让目录归属或 ACL 与容器 UID/GID 对齐。

### Docker 与飞书 CLI

当前镜像不内置你的 `lark-cli` 用户登录态。仅挂载 `/data` 和 `/workspace` 不会让容器自动获得飞书授权。需要飞书集成时优先使用原生运行；把授权文件直接打包进镜像不受支持。

## 4. Readiness 与健康检查

容器健康检查使用镜像自带 Node.js 请求 `/api/health`。

只有 state/config 可读且合法、数据目录和工作区路径安全且具备所需权限时返回 `200`；其他情况返回通用 `503 not_ready`。

readiness 只证明当前文件系统依赖可用，不证明：

- OpenAI 当前可达；
- 飞书当前可达或有编辑权限；
- 浏览器和真实 iPhone 已验收；
- 磁盘未来不会耗尽。

## 5. AI Provider

默认 Luna Profile：

```text
OPENAI_API_KEY=<你的 Key>
OPENAI_MODEL=gpt-5.6-luna
```

项目把推理档位固定为 `xhigh`，并使用结构化结果与本机校验。超时、拒绝、不可达或输出校验失败时回退本地规则。

`npm run doctor` 显示“已配置（未联网验证）”不等于 live success。文件正文默认不出站；只有显式开启受支持的正文发送开关时才会发送，且高敏感项目不应启用。

第三方 Provider 的固定 endpoint、origin allowlist、模型、凭证和显式降级门见 [`AI_PROVIDER.md`](AI_PROVIDER.md)。未进行真实 endpoint smoke test 前，只能称本地合同已通过。

## 6. 反向代理与公开暴露

HTTPS 反向代理示例：

```text
TRUSTED_ORIGINS=https://workbench.example.com
COOKIE_SECURE=1
```

多个 origin 用逗号分隔。协议、主机和端口必须与浏览器实际访问地址一致。

代理应保留对应的实际 `Host`。应用不会信任 `X-Forwarded-Host`、`X-Forwarded-Proto` 自动放宽安全检查。不要把公网代理的上游 Host 重写为 localhost 后省略 `TRUSTED_ORIGINS`。

只要启用 `WORKBENCH_PASSWORD`，即使监听 localhost，也必须设置非示例值且至少 24 字符的 `SESSION_SECRET`。公开绑定或非本机 origin 在默认情况下没有密码会拒绝启动。

## 7. 主要环境变量

- `PORT`：应用端口，默认 `4173`
- `HOST`：监听地址，默认 `127.0.0.1`
- `DATA_DIR`：持久化数据目录
- `WORKSPACE_ROOT`：覆盖配置中的工作区根目录
- `WORKBENCH_PASSWORD`：访问密码
- `SESSION_SECRET`：登录 cookie 签名密钥
- `CAPTURE_TOKEN`：iPhone / 外部采集专用 Bearer token
- `TRUSTED_ORIGINS`：允许的完整浏览器 origin，多个值逗号分隔
- `COOKIE_SECURE=1`：HTTPS 时给登录 Cookie 加 `Secure`
- `OPENAI_API_KEY`：默认 Luna Profile 凭证
- `OPENAI_MODEL`：默认 `gpt-5.6-luna`
- `OPENAI_SEND_FILE_CONTENT=1`：显式允许默认 Profile 发送受支持文件正文；默认关闭
- `AI_PROVIDER_*`：第三方 Provider 固定适配配置
- `ALLOW_INSECURE_PUBLIC=1`：明确允许无密码公开绑定；不建议使用

## 8. 数据目录

```text
state.json   机器状态、任务、收件箱、确认项和飞书指针
config.json  工作区、业务板块和数据源配置
backups/     自动每日快照与手工备份
migrations/  升级前原始快照、PROJECT.md 备份和迁移报告
captures/    Capture 幂等收据；只含正文 SHA-256 和标识符
recovery/    飞书跨资源事务恢复凭据；只含机器数据和指针
```

`captures/` 与 `recovery/` 都是恢复正确性的一部分，不是可随意删除的缓存。

## 9. 备份 v2

`npm run backup` 和每日快照生成 JSON backup v2：

```json
{
  "backupVersion": 2,
  "backedUpAt": "...",
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

包含：

- 持久化 state；不包含运行时派生的临时确认；
- config；
- Capture 哈希收据，用于恢复后继续去重；
- 飞书项目记录恢复凭据，用于恢复后继续 operationId 对账。

不包含：

- `/workspace` 中的真实项目资料；
- 飞书项目分析或总结正文；
- OpenAI / 飞书凭证、cookie、`.env` 或 `lark-cli` 登录文件。

自动每日快照是当天第一次状态或配置变更前的本机回滚点。手工备份和每日快照默认与主数据位于同一宿主目录，不等同于异机灾备。

## 10. 原生恢复

先用实际进程管理器停止工作台，再执行：

```bash
npm run restore -- /path/to/backup.json
npm start
```

不要使用宽泛的 `pkill node`，以免误停其他 Node 进程。

恢复脚本会先创建恢复前安全备份。backup v2 会同时替换 state、可选 config、Capture 收据和项目恢复凭据；任一阶段失败时会尝试回滚全部已修改部分。

旧备份若没有 `captureReceipts` 或 `projectRecordReceipts` 字段，恢复时会保留当前凭据目录，而不是把它们静默清空。这保证向后兼容，但也意味着旧备份不是这些凭据的历史快照。

恢复后至少核对：

- 今日工作台、全部待办和项目列表；
- 一条已处理 Capture 使用原 `captureId` 重放时不会复活；
- 待确认中仍能显示未完成的项目记录对账项；
- `GET /api/health` 返回就绪。

## 11. Docker Compose 恢复

备份文件需位于宿主机 `WORKBENCH_DATA_PATH` 内。示例：

```bash
docker compose stop workbench
docker compose run --rm --no-deps workbench node scripts/restore.mjs /data/backups/backup-YYYY-MM-DDTHH-MM-SS-UUID.json
docker compose up -d workbench
docker compose ps
```

不要在服务仍运行并可能写状态或凭据时恢复。恢复完成后登录网页或读取 `/api/state` 核对业务记录。

## 12. 灾备边界

完整灾备至少要分别保护：

1. `/data`：工作台状态、配置、备份、迁移快照和恢复凭据；
2. `/workspace`：真实项目资料和 Git 工作树；
3. 远端 Git 仓库；
4. 飞书项目文档。

应由部署者自行定义加密、保留期、异机复制、RPO/RTO 和恢复演练。仓库中的本地测试不构成生产灾备演练。

## 13. 云部署限制

Vercel、Netlify Serverless 等无状态环境不能直接读取你电脑的本地项目路径。若一定要远程部署，需要在项目文件所在机器运行受控 agent/服务，或把项目工作区安全挂载到远程主机；这属于另一套架构，不是当前 v1.2.0 的默认部署模型。
