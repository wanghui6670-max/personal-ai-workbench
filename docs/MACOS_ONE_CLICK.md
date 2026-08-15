# Personal AI Workbench 2.0｜Mac 一键部署

> 适用范围：把已经合入 `main` 的 Personal AI Workbench 安装或升级到保存真实项目文件、并拥有本机工具登录态的同一台 Mac。

## 1. 最简单的使用方式

在本地仓库中直接双击 install-macos.command：

```text
install-macos.command
```

或执行：

```bash
cd /path/to/personal-ai-workbench
./install-macos.command
```

入口脚本会先：

```text
检查 Git / Node
→ git fetch origin main
→ 切换 main
→ git pull --ff-only origin main
→ 再进入本机部署
```

因此本地部署使用的代码必须与最新 `origin/main` 一致。

默认项目根目录优先识别：

```text
$HOME/AI-Work-OS
```

当前用户通常对应：

```text
/Users/wanghui/AI-Work-OS
```

目录不存在时部署会停止，不会另建第二套项目工作区。

## 2. 首次安装和后续升级不是同一种操作

这是当前部署行为最重要的规则。

### 首次安装

第一次在一台 Mac 上安装时，仍使用最保守的 P0：

```env
HOST=127.0.0.1
JOYCREW_ENABLED=0
HARNESS_ENABLED=0
AI_PROVIDER_ENABLED=0
ALLOW_INSECURE_PUBLIC=0
```

目的只是先证明：

- 数据目录正确；
- 项目目录正确；
- backup v2 正常；
- 本机只读启动不改变业务文件；
- LaunchAgent 能安全启动当前代码。

### 后续升级

检测到已有 Workbench LaunchAgent 或已有服务清单后，一键部署进入：

```text
upgrade
```

此时只更新：

```text
代码
HOST / PORT
DATA_DIR
WORKSPACE_ROOT
本机安全绑定
LaunchAgent
```

**不会再把已有的 Joycrew、Harness、AI Provider 配置重置为 0。**

也就是说，已经现场验证并启用的：

```text
JOYCREW_*
HARNESS_*
AI_PROVIDER_*
OPENAI_API_KEY / OPENAI_MODEL
```

会继续保存在 `.env` 中。

P0 预检仍会在一个临时、只读、三类 Runtime 都关闭的子进程环境中运行，但不会改写升级后的真实 `.env`。

## 3. 修复旧安装器已经造成的 Runtime 配置丢失

旧的一键部署逻辑曾在每次部署时强制写入：

```env
JOYCREW_ENABLED=0
HARNESS_ENABLED=0
AI_PROVIDER_ENABLED=0
```

所以代码虽然已经更新，实际启动后却会表现得像旧版工作台。

旧逻辑在覆盖 `.env` 前会保存精确备份，并把备份路径写入：

```text
<DATA_DIR>/p0/macos-bootstrap.json
```

新版升级会检查上一轮部署记录。

只有同时满足以下条件时才自动恢复：

1. 当前三类 Runtime 都处于关闭状态；
2. 上一轮部署记录明确指向一个部署前 `.env` 备份；
3. 那份备份中至少有一类 Runtime 曾明确启用；
4. 备份文件仍位于当前 `DATA_DIR` 内。

满足后会从**那一份精确的部署前备份**自动恢复 Runtime 相关字段。

自动恢复范围仅包括：

```text
JOYCREW_*
HARNESS_*
AI_PROVIDER_*
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_SEND_FILE_CONTENT
AI_SEND_FILE_CONTENT
```

不会用旧备份覆盖：

```text
PORT
DATA_DIR
WORKSPACE_ROOT
CAPTURE_TOKEN
其他非 Runtime 配置
```

终端只打印恢复了多少个字段和备份路径，不打印 Secret 值。

如果你明确希望重新进入首次 P0 安全模式，可以使用：

```bash
./install-macos.command --fresh-p0
```

## 4. 一键流程现在实际做什么

```text
检查 macOS、Git、Node 24+
→ 确认已跟踪代码没有本地修改
→ 更新 origin/main 并 fast-forward 本地 main
→ 读取现有 .env
→ 识别 WORKSPACE_ROOT / DATA_DIR
→ 判断 first_install 或 upgrade
→ 必要时从上一轮精确备份自动恢复被旧安装器清掉的 Runtime 配置
→ 备份当前 .env
→ 更新 localhost 与目录绑定
→ 暂停已有 Workbench LaunchAgent
→ 用隔离的 P0 环境运行真实主机预检
→ 生成并验证 backup v2
→ 检查 DATA_DIR 与 WORKSPACE_ROOT 没有目录漂移
→ 安装或升级 LaunchAgent
→ 把当前完整 Git commit 写入 LaunchAgent
→ 验证服务健康与已安装 commit
→ 打开本机工作台页面
```

默认地址：

```text
http://127.0.0.1:44173
```

已有 `.env` 明确设置 `PORT` 时默认沿用；命令行 `--port` 可以覆盖。

## 5. 为什么部署后不会再看到旧 JS/CSS

Workbench 当前静态文件名是稳定的，例如：

```text
app.js
harness-navigator.js
joycrew-integration.js
styles.css
```

如果这些文件使用长时间浏览器缓存，新服务启动以后 Safari 仍可能继续执行旧脚本。

因此现在：

```text
.html
.js
.css
.webmanifest
```

全部使用：

```http
Cache-Control: no-store, max-age=0
```

图片等不会影响业务逻辑的静态资源仍可短时缓存。

这保证重新部署后，浏览器不会拿上一版本 JS/CSS 冒充当前版本。

## 6. LaunchAgent 与 Git commit 绑定

产品版本目前可能仍显示：

```text
2.0.0
```

仅比较这个版本号无法区分不同提交。

安装时会把当前完整 40 位 Git SHA 写入 LaunchAgent：

```text
WORKBENCH_BUILD_COMMIT
```

服务安装清单同时记录：

```text
<DATA_DIR>/p0/macos-service.json
```

`status` 会比较：

```text
当前 git rev-parse HEAD
vs.
LaunchAgent 中的 WORKBENCH_BUILD_COMMIT
```

不一致时状态检查失败，不会再把旧 LaunchAgent 当成新版本。

## 7. 数据保留规则

数据目录按以下顺序选择：

1. `--data-dir`；
2. 现有 `.env` 的 `DATA_DIR`；
3. 仓库 `data/` 中已经存在真实数据时继续使用；
4. 否则使用：

```text
~/Library/Application Support/PersonalAIWorkbench/data
```

项目工作区按以下顺序选择：

1. `--workspace`；
2. 现有 `.env` 的 `WORKSPACE_ROOT`；
3. `$HOME/AI-Work-OS`；
4. `$HOME/ai-work-os`；
5. Documents 下的同名目录。

发现多个候选时停止，不猜测、不合并目录。

## 8. 配置备份与失败时恢复

修改 `.env` 前仍会保存到：

```text
<DATA_DIR>/p0/env-backups/
```

如果预检、backup、目录快照、LaunchAgent 安装或健康检查失败：

```text
恢复本轮修改前的 .env
→ 恢复进程环境
→ 原 LaunchAgent 之前在运行时重新启动
→ 保留失败报告和配置备份
→ 不删除 DATA_DIR
→ 不删除 WORKSPACE_ROOT
```

未知端口占用不会被自动杀死。

## 9. 常用命令

正常首次安装或后续升级：

```bash
./install-macos.command
```

显式要求按升级模式保留 Runtime：

```bash
./install-macos.command --preserve-runtime
```

显式重做首次 P0 安全配置：

```bash
./install-macos.command --fresh-p0
```

明确目录和端口：

```bash
./install-macos.command \
  --workspace "/Users/wanghui/AI-Work-OS" \
  --data-dir "/Users/wanghui/Library/Application Support/PersonalAIWorkbench/data" \
  --port 44173
```

只准备配置并执行真实主机 P0：

```bash
./install-macos.command --prepare-only
```

安装后不自动打开浏览器：

```bash
./install-macos.command --no-open
```

脚本化执行时不等待最后回车：

```bash
WORKBENCH_INSTALL_NO_PAUSE=1 ./install-macos.command
```

## 10. 安装后的检查

```bash
npm run service:macos -- status
```

预期至少看到：

```text
loaded: true
commitMatches: true
health.status: 200
health.body.ok: true
health.body.version: 2.0.0
```

同时可以检查：

```bash
git rev-parse HEAD
```

它应与 `status` 输出中的：

```text
installedCommit
```

完全一致。

日志：

```text
~/Library/Logs/PersonalAIWorkbench/workbench.log
~/Library/Logs/PersonalAIWorkbench/workbench.error.log
```

部署报告：

```text
<DATA_DIR>/p0/macos-bootstrap.json
<DATA_DIR>/p0/host-readiness.json
<DATA_DIR>/p0/macos-service.json
```

## 11. 服务控制

```bash
npm run service:macos -- status
npm run service:macos -- stop
npm run service:macos -- start
npm run service:macos -- restart
npm run service:macos -- uninstall
```

`stop` 只暂停服务并保留 plist。`uninstall` 删除 LaunchAgent 定义，但不删除数据、工作区、备份和日志。

## 12. 不变的安全边界

本机一键部署仍不会：

- 开放公网；
- 自动写飞书；
- 自动扩大本机或服务器目录授权；
- 删除历史数据；
- 杀死未知端口进程；
- 自动把新的 Harness Tool 权限授予 AI 员工。

首次安装仍从安全 P0 开始；后续升级只是**不再错误地撤销已经完成现场验收的能力**。
