# Personal AI Workbench 2.0｜macOS 真实主机 P0

> 目标：把 Workbench 2.0 部署到保存真实项目文件夹、并拥有 `getnote` 与 `lark-cli` 登录态的同一 macOS 用户下。P0 只验证个人工作台，不启用 Joycrew，不开放公网。

## 1. 主机裁决

当前产品是 local-first：

- 本地项目文件夹是真实工作文件来源；
- Git/GitHub 是代码与版本证据；
- 飞书项目云文档是项目分析、阶段总结、复盘和恢复叙事的唯一真源；
- 得到大脑 `getnote` 与飞书 `lark-cli` 使用当前操作系统用户的登录态；
- 本机 ICS 写入 `DATA_DIR/calendar/personal-ai-workbench.ics`。

因此第一台真实 P0 主机应是能直接访问这些资源的 Mac，而不是普通无状态云网页。远程访问、Tailscale、反向代理和 TLS 在本机 P0 通过后再启用。

## 2. P0 固定边界

```text
HOST=127.0.0.1
JOYCREW_ENABLED=0
HARNESS_ENABLED=0        # P0 期间建议关闭
AI_PROVIDER_ENABLED=0    # P0 只验证本机工作链
```

P0 不做：

- Joycrew、DataWeave、Local Bridge 或 Hermes 接入；
- 公网绑定；
- 自动同步或自动写飞书；
- 自动修改项目文件；
- 自动替换旧服务；
- 自动删除数据、日志或备份。

## 3. `.env` 必填绑定

从 `.env.example` 创建 `.env`，至少明确：

```env
HOST=127.0.0.1
PORT=44173
DATA_DIR=/Users/<user>/Library/Application Support/PersonalAIWorkbench/data
WORKSPACE_ROOT=/Users/<user>/AI-Work-OS
JOYCREW_ENABLED=0
HARNESS_ENABLED=0
AI_PROVIDER_ENABLED=0
```

要求：

- `DATA_DIR` 与 `WORKSPACE_ROOT` 都必须是绝对路径；
- 两个目录不得相同或互相嵌套；
- `WORKSPACE_ROOT` 必须指向现有真实项目根目录，不另建第二套项目体系；
- P0 只能绑定 localhost；
- 不要在 `.env` 中使用 shell 命令替换；
- `.env` 不提交到 Git。

`PORT=44173` 只是推荐测试端口。端口必须空闲；预检发现占用会停止，不会抢占未知进程。

## 4. 部署前准备

```bash
cd /path/to/personal-ai-workbench
git fetch origin
git switch main
git pull --ff-only
node --version
npm run doctor
```

要求：

- Node.js 24+；
- 当前分支为 `main`；
- 已跟踪文件没有本地修改；
- 旧 Workbench 进程已经停止；
- `getnote` 与 `lark-cli` 安装在同一 macOS 用户下；
- `WORKSPACE_ROOT` 可读写；
- `JOYCREW_ENABLED=0`。

## 5. 运行真实主机 P0

```bash
npm run p0:host
```

默认报告：

```text
<DATA_DIR>/p0/host-readiness.json
```

预检会执行：

```text
环境与路径绑定
→ main / commit / clean tracked tree
→ 确认旧端口未被占用
→ npm run doctor
→ 生成并验证 backup v2
→ 记录 DATA_DIR 内容哈希快照
→ 记录 WORKSPACE_ROOT 元数据快照
→ 随机 localhost 测试端口启动 Workbench
→ 读取 health、state、统一业务执行静态资源
→ 确认 Joycrew disabled
→ 停止测试进程
→ 再次快照并确认 DATA_DIR / WORKSPACE_ROOT 无漂移
```

如果外部待办管线已经启用，`doctor` 会真实执行只读检查：

```text
getnote doctor -o json
lark-cli --version
```

它不会执行 GetNote 写入、飞书写入或 Joycrew 调用。

### 预检硬拒绝

- 未设置绝对 `DATA_DIR` 或 `WORKSPACE_ROOT`；
- 两个目录重叠；
- 非 localhost 绑定；
- `JOYCREW_ENABLED=1`；
- 当前不是 `main`；
- 已跟踪文件有修改；
- 旧端口仍在使用；
- doctor 失败；
- backup 不是 v2 或发现运行凭据；
- 测试启动改变 DATA_DIR 或 WORKSPACE_ROOT；
- 健康检查、统一前端或 Joycrew 隔离失败。

## 6. 安装 macOS LaunchAgent

只有最近 24 小时内、同一 commit、同一应用目录、同一 `DATA_DIR`、同一 `WORKSPACE_ROOT` 的 P0 报告通过后，才允许安装：

```bash
npm run service:macos -- install
```

LaunchAgent：

```text
Label: com.dongjue.personal-ai-workbench
Plist: ~/Library/LaunchAgents/com.dongjue.personal-ai-workbench.plist
日志: ~/Library/Logs/PersonalAIWorkbench/
```

安全特性：

- 直接以当前 Node 可执行文件启动 `src/server.mjs`；
- 不使用 `bash -c`、`source`、`eval` 或命令拼接；
- Token、密码和 API Key 不进入 plist；
- 运行时仍由 Workbench 的安全 `.env` 解析器读取仓库根目录 `.env`；
- plist 权限为 `0600`；
- 安装前备份已有 plist；
- 新服务健康检查失败时，自动卸载新服务并恢复旧 plist；
- 不删除 DATA_DIR、WORKSPACE_ROOT、备份或日志。

常用命令：

```bash
npm run service:macos -- status
npm run service:macos -- restart
npm run service:macos -- uninstall
```

## 7. 现场验收

LaunchAgent 启动后依次检查：

1. 浏览器打开 `http://127.0.0.1:<PORT>`；
2. “我的今日”、个人收件箱、全部待办和项目页正常；
3. “业务执行”显示 Joycrew 未启用，但不影响个人页面；
4. 设置页显示真实 `WORKSPACE_ROOT`；
5. 手工执行一次得到大脑同步，确认明确日期与模糊日期分流正确；
6. 手工发布一次飞书每日任务快照并读回 operationId；
7. 从 iPhone Shortcut 发送一条带稳定 `captureId` 的测试记录，再重试同一请求；
8. 检查 `personal-ai-workbench.ics` 文件权限和内容；
9. 运行 `npm run backup`，记录备份路径和 SHA-256；
10. 重启 LaunchAgent，确认状态仍可读。

第 5–8 项涉及真实外部环境，必须保存实际回执；仓库自动测试不能替代。

## 8. 回滚

LaunchAgent 本身回滚：

```bash
npm run service:macos -- uninstall
```

这只停止并移除服务定义，不删除任何数据。

代码和数据回滚必须使用部署前已记录的明确基线：

```bash
npm run service:macos -- uninstall
git checkout <known-good-commit>
npm run restore -- <DATA_DIR>/backups/<known-good-backup>.json
npm run doctor
```

确认旧版本可启动后，再按旧版本的启动方式恢复服务。不要在不知道目标 commit 和 backup 的情况下执行回滚。

## 9. P0 通过条件

```yaml
host_preflight: passed
launch_agent_health: passed
joycrew_enabled: false
personal_workflows: passed
getnote_read_only: passed_or_pipeline_disabled
feishu_manual_readback: passed
iphone_capture_replay: passed
ics_file: passed
backup_recorded: true
rollback_baseline_recorded: true
public_exposure: false
```

全部通过后，下一阶段才是：在同一主机或受控私网中启动 Joycrew Mock Runtime，并接入 Workbench 的“业务执行”页面。
