# 部署说明

## 方案 A：直接运行在你的电脑（最符合当前需求）

```bash
cp .env.example .env
npm run doctor
npm start
```

把“工作区根目录”设置成你的真实项目根目录。

### 飞书每日工作日记数据源

收件箱可以绑定飞书云文档《个人 AI 工作台｜每日工作日记》：

<https://xcnn2pk8gpzl.feishu.cn/wiki/By6ow2cm0iXXQkkx2XRc7Ym5nOb>

这份文档是收件箱的外部真实来源。工作台只读取一级标题“收件箱”下、以 `[INBOX]` 开头的段落或待办；“每日工作日记”“明确决定”“待确认”等其他章节不会自动变成收件箱事项。工作台不会替你分类、补截止日期或加入今日计划。

启用前置条件：

1. 在**运行工作台的同一台机器、同一个操作系统用户**下安装 `lark-cli`。
2. 用飞书用户身份完成授权，并确认该用户对目标文档有读取和编辑权限。不要把 access token、appSecret、cookie 或 `.env` 内容复制到项目文件或聊天中。
3. 在该机器上确认命令可见并检查登录状态（输出不要粘贴凭证）：

```bash
command -v lark-cli
lark-cli auth status --json --verify
```

4. 打开工作台“设置”，填写上面的文档 URL，保存后点击“同步飞书收件箱”。设置会保存文档 URL 和同步状态，不保存飞书凭证。

同步和写入都是可读回的：新增收件箱时先通过 `lark-cli docs +update --api-version v2 --as user` 写飞书，再用 `docs +fetch --api-version v2 --detail with-ids` 读回；读回失败时不会提交本地缓存。飞书文档中删除未处理的 `[INBOX]` 条目后，下一次手动同步会移除对应本地缓存，但不会删除已经转成项目或待办的业务记录。

如果 `lark-cli` 不存在、未登录、无权限或网络不可用，工作台会显示同步错误；本地已有收件箱仍可人工处理。该集成依赖本机 CLI，不会在没有凭证的情况下静默改用另一套 API。

Docker 注意：当前镜像只负责工作台本身，不内置你的 `lark-cli` 用户登录态。若必须使用飞书收件箱数据源，应优先采用上面的原生运行方式；仅把 `/data` 和 `/workspace` 挂载进 Docker 并不能让容器访问宿主机的飞书登录态。若未来把 CLI 和授权安全地注入容器，需要单独设计凭证存储、PATH 和轮换策略，不能把本机授权文件直接打包进镜像。

如果只在本机使用，保持：

```text
HOST=127.0.0.1
```

## 方案 B：局域网 / Tailscale / 内网机器

设置：

```text
HOST=0.0.0.0
WORKBENCH_PASSWORD=<强密码>
SESSION_SECRET=<长随机字符串>
```

推荐通过 Tailscale / 内网访问，而不是直接开放公网端口。

## 方案 C：Docker

Compose 在没有 `.env` 时也能完成配置检查：

```bash
docker compose config
```

实际启动前：

1. 复制 `.env.example` 为 `.env`。
2. 至少设置非空的 `WORKBENCH_PASSWORD` 和 24 字符以上的 `SESSION_SECRET`。容器内部必须监听 `0.0.0.0` 才能接收 Docker 端口转发，因此应用的公开绑定安全门仍会生效；不要把空密码当成本地免认证启动方式。
3. 在 `.env` 中把 `WORKBENCH_WORKSPACE_PATH` 设置为真实项目目录的宿主机绝对路径。该目录以读写方式挂载，因为新建/归类项目会创建目录并写入 `PROJECT.md`。
4. 运行：

```bash
docker compose up -d --build
```

Docker 内：
- `/data` = 工作台持久化数据
- `/workspace` = 真实项目目录

镜像不会复制本机 `data/`、`workspace/` 或 `.env`。首次挂载空的 `/data` 时，应用会自行创建最小的 `state.json`、`config.json` 和 `backups/`。

默认只发布到宿主机 `127.0.0.1:4173`。需要局域网访问时，必须显式设置以下值，并保留上面的密码与会话密钥：

```text
WORKBENCH_BIND_ADDRESS=0.0.0.0
```

可选的 Compose 变量：

- `WORKBENCH_PORT`：同时设置宿主机发布端口、容器端口和应用监听端口，默认 `4173`。例如设为 `8080` 后访问 `http://127.0.0.1:8080`；Docker Compose 下不要只改原生运行使用的 `PORT`
- `WORKBENCH_DATA_PATH`：宿主机数据目录，默认 `./data`
- `WORKBENCH_WORKSPACE_PATH`：宿主机真实项目目录，默认 `./workspace`
- `WORKBENCH_UID` / `WORKBENCH_GID`：容器进程 UID/GID，默认均为 `1000`

镜像默认以 Node 镜像内的非 root 用户（UID/GID `1000:1000`）运行。Linux 宿主机上的 bind mount 必须允许这个 UID/GID 读写；更合适的做法通常是在 `.env` 中把 `WORKBENCH_UID`、`WORKBENCH_GID` 设成当前宿主用户的数字 ID，并确保数据目录和真实工作区对该用户可写，避免使用 `chmod 777`。macOS/Windows Docker Desktop 通常由文件共享层处理身份映射，但目录仍须已授权给 Docker Desktop。

容器健康检查使用镜像自带的 Node.js，按容器实际 `PORT` 请求 `/api/health`，不额外安装 curl。该端点只在 state/config 可读且合法，数据、备份、工作区和所有业务目录存在、类型正确、非 symlink、未越界且具备运行所需的读写/进入权限时返回 `200`；其他情况返回 `503`，Docker 会标记为 unhealthy。

readiness 只使用文件系统查询和权限 `access` 检查，不创建探针文件、目录或备份。因此它能证明当前进程的文件系统依赖可用，但不能预知磁盘耗尽、后续权限变化，也不代表 OpenAI 或浏览器功能已验收。

## Luna AI 判断配置

需要 AI 判断时，在 `.env` 中设置：

```text
OPENAI_API_KEY=<你的 Key>
OPENAI_MODEL=gpt-5.6-luna
```

应用将推理档位固定为极高（`xhigh`），并按“证据 → 冲突与缺口 → 最终结论”生成受本机校验的结构化结果。`xhigh` 会提高响应延迟和调用成本，应结合实际项目观察耗时与回退率。`npm run doctor` 只核对本机配置，不主动联网、不产生模型费用；它显示“已配置（未联网验证）”不等于 OpenAI 或该模型当前可达。请求超时、拒绝、不可达或输出校验失败时，系统使用本地规则回退。

正文出站边界没有因模型升级而改变：`PROJECT.md` 和可读文件正文默认不发送。只有明确设置 `OPENAI_SEND_FILE_CONTENT=1` 才会发送这两类正文；高敏感项目不应开启。

## 云部署的限制

普通 Vercel/Netlify Serverless 等无状态运行环境无法直接读取你笔记本的本地文件系统。这个项目可以做成纯云任务系统，但那会违背当前 PRD 的“本地项目文件夹是真实来源”。

如果一定要远程部署同时读取本地文件，需要：
- 在本地机器运行一个 agent / 服务并建立安全通道，或
- 把项目文件同步/挂载到远程主机。

当前 v1.2.0 选择更简单可靠的路径：**服务与项目文件处在同一台可访问文件系统的机器上。**

## 反向代理

可以用 Caddy / Nginx 做 HTTPS。应用本身只需要一个 HTTP 端口。

反向代理或自定义域名必须显式配置浏览器实际访问的 origin（协议、主机名和端口必须一致），多个值用逗号分隔：

```text
TRUSTED_ORIGINS=https://workbench.example.com,https://workbench.internal.example:8443
COOKIE_SECURE=1
```

代理应保留与 `TRUSTED_ORIGINS` 对应的原始 `Host`。应用不会信任 `X-Forwarded-Host`、`X-Forwarded-Proto` 等转发头来放宽 Host/Origin 校验；只设置这些头不能通过安全门。HTTPS 部署必须设置 `COOKIE_SECURE=1`，否则登录 Cookie 不会带 `Secure` 属性。

只要启用 `WORKBENCH_PASSWORD`，即使应用只监听 `127.0.0.1`，启动时也会要求至少 24 字符且非默认值的 `SESSION_SECRET`。配置中含有非本机的 `TRUSTED_ORIGINS` 时还会按公开暴露强制要求启用密码。不要把公网代理的上游 `Host` 重写成 `127.0.0.1`/`localhost` 后省略 `TRUSTED_ORIGINS`；应用无法仅凭该请求识别隐藏在本机地址后的公网代理，这种部署不受支持。

默认本机访问 `http://127.0.0.1:<PORT>` 和 `http://localhost:<PORT>` 无需设置 `TRUSTED_ORIGINS`。局域网 IP、Tailscale 地址和自定义域名不属于默认本机 origin，必须逐项显式填写。

## 环境变量

- `PORT`：端口，默认 4173
- `HOST`：默认 127.0.0.1
- `DATA_DIR`：持久化数据目录
- `WORKSPACE_ROOT`：覆盖界面里的工作区根目录
- `WORKBENCH_PASSWORD`：访问密码
- `SESSION_SECRET`：登录 cookie 签名密钥；启用 `WORKBENCH_PASSWORD` 时必须为至少 24 字符且不能使用默认值
- `CAPTURE_TOKEN`：快捷指令采集 token
- `TRUSTED_ORIGINS`：反向代理或远程浏览器允许使用的完整 origin，多个值用逗号分隔
- `COOKIE_SECURE=1`：HTTPS 部署时让登录 Cookie 带 `Secure` 属性
- `OPENAI_API_KEY`：可选；未设置时使用本地规则
- `OPENAI_MODEL`：默认 `gpt-5.6-luna`；推理档位固定为 `xhigh`
- `OPENAI_SEND_FILE_CONTENT=1`：显式允许发送 `PROJECT.md` 和可读文件正文；默认关闭
- `ALLOW_INSECURE_PUBLIC=1`：允许无密码绑定公开接口，不建议

## 恢复数据

原生运行时先用实际采用的进程管理器停止服务，再恢复、重启并读回：

```bash
npm run restore -- /path/to/backup.json
npm start
```

不要用宽泛的 `pkill node` 停止服务，以免误停其他 Node 程序。恢复脚本会在覆盖前再备份一次当前数据。启动后登录工作台，通过“今日工作台 / 全部待办 / 项目”读回关键记录；也可以用 `GET /api/state` 核对。

Docker Compose 恢复时，备份文件必须位于宿主机 `WORKBENCH_DATA_PATH` 内。以下示例假设文件在该目录的 `backups/` 下：

```bash
docker compose stop workbench
docker compose run --rm --no-deps workbench node scripts/restore.mjs /data/backups/backup-YYYY-MM-DDTHH-MM-SS-UUID.json
docker compose up -d workbench
docker compose ps
```

随后登录网页或读取 `/api/state` 核对目标记录。不要在服务仍运行并可能写入状态时恢复。

备份边界：自动每日快照是“每天首次状态或配置变更前”的本机回滚点，手工备份包含 `state.json` 与 `config.json`；两者都不包含 `/workspace` 的真实项目资料。默认备份还与主数据位于同一宿主目录，不等于异机灾备。若需要灾备，必须另行备份 `/data` 与 `/workspace`，并自行定义加密、保留期、RPO/RTO 与恢复演练。
