# Personal AI Workbench 2.0｜Mac 一键部署

> 适用范围：把已经合入 `main` 的 Personal AI Workbench 2.0 安装到保存真实项目文件、并拥有 `getnote` 与 `lark-cli` 登录态的同一台 Mac。P0 阶段不启用 Joycrew，不开放公网。

## 1. 最简单的使用方式

先让本地仓库取得最新 `main`，然后在 Finder 中打开仓库目录，双击 install-macos.command。

也可以在终端执行：

```bash
cd /path/to/personal-ai-workbench
./install-macos.command
```

当前用户的默认项目根目录会优先识别为：

```text
/Users/wanghui/AI-Work-OS
```

脚本实际使用的是：

```text
$HOME/AI-Work-OS
```

因此不会把用户名硬编码到程序中。该目录不存在时，安装会停止，不会另建第二套项目工作区。

## 2. 一键流程会做什么

```text
检查 macOS、Git、Node 24+
→ 确认已跟踪代码没有本地修改
→ 更新 origin/main 并 fast-forward 本地 main
→ 读取并保留现有 .env
→ 识别现有 WORKSPACE_ROOT
→ 优先保留仓库中已经存在的 data 数据
→ 没有旧数据时使用 ~/Library/Application Support/PersonalAIWorkbench/data
→ 备份原 .env
→ 写入 localhost / Joycrew disabled 的 P0 绑定
→ 暂停已有 Workbench LaunchAgent
→ 运行真实主机 P0
→ 生成并验证 backup v2
→ 检查 DATA_DIR 与 WORKSPACE_ROOT 没有目录漂移
→ 安装或升级 macOS LaunchAgent
→ 验证 health 与版本
→ 打开本机工作台页面
```

默认地址是：

```text
http://127.0.0.1:44173
```

已有 `.env` 明确设置 `PORT` 时，会保留原端口。

## 3. 数据保留规则

数据目录按以下顺序选择：

1. 命令行 `--data-dir`；
2. 现有 `.env` 的 `DATA_DIR`；
3. 仓库 `data/` 中已经存在任何真实数据时，继续使用该目录；
4. 否则使用：

```text
~/Library/Application Support/PersonalAIWorkbench/data
```

这意味着升级不会因为采用新的推荐目录而把旧 `state.json`、`config.json`、Capture 收据或备份留在另一处。

项目工作区按以下顺序选择：

1. 命令行 `--workspace`；
2. 现有 `.env` 的 `WORKSPACE_ROOT`；
3. `$HOME/AI-Work-OS`；
4. `$HOME/ai-work-os`；
5. Documents 目录下同名路径。

发现多个候选时会停止，并要求明确指定；不会猜测或合并目录。

## 4. P0 固定安全设置

一键部署只更新这些部署绑定：

```env
HOST=127.0.0.1
PORT=<现有端口或 44173>
DATA_DIR=<识别后的绝对路径>
WORKSPACE_ROOT=<识别后的绝对路径>
TRUSTED_ORIGINS=
COOKIE_SECURE=0
JOYCREW_ENABLED=0
HARNESS_ENABLED=0
AI_PROVIDER_ENABLED=0
ALLOW_INSECURE_PUBLIC=0
```

现有 `OPENAI_API_KEY`、Capture Token、密码、飞书设置以及其他未管理字段会保留，不会显示到终端，也不会写进 LaunchAgent plist。

P0 完成后，Harness、AI Provider 和 Joycrew 仍保持关闭。它们会在各自的现场验收阶段单独启用。

## 5. 配置备份与失败恢复

修改 `.env` 前会把原文件保存到：

```text
<DATA_DIR>/p0/env-backups/
```

如果预检、backup v2、目录快照、LaunchAgent 安装或健康检查任一步失败：

```text
恢复原 .env
→ 恢复进程环境
→ 原 LaunchAgent 此前处于运行状态时重新启动
→ 保留失败报告和原配置备份
→ 不删除 DATA_DIR
→ 不删除 WORKSPACE_ROOT
```

这就是“失败时恢复”的实际边界。未知端口占用不会被自动杀死；脚本会停止并报告。

## 6. 常用命令

自动识别并安装：

```bash
./install-macos.command
```

明确使用现有项目根目录：

```bash
./install-macos.command --workspace "/Users/wanghui/AI-Work-OS"
```

明确数据目录和端口：

```bash
./install-macos.command \
  --workspace "/Users/wanghui/AI-Work-OS" \
  --data-dir "/Users/wanghui/Library/Application Support/PersonalAIWorkbench/data" \
  --port 44173
```

只准备配置并执行真实主机 P0，不替换常驻服务：

```bash
./install-macos.command --prepare-only
```

安装后不自动打开浏览器：

```bash
./install-macos.command --no-open
```

脚本化执行时不等待最后的回车：

```bash
WORKBENCH_INSTALL_NO_PAUSE=1 ./install-macos.command
```

## 7. 安装后的检查

```bash
npm run service:macos -- status
```

预期：

```text
loaded: true
health.status: 200
health.body.ok: true
health.body.version: 2.0.0
```

日志：

```text
~/Library/Logs/PersonalAIWorkbench/workbench.log
~/Library/Logs/PersonalAIWorkbench/workbench.error.log
```

本地部署报告：

```text
<DATA_DIR>/p0/macos-bootstrap.json
<DATA_DIR>/p0/host-readiness.json
<DATA_DIR>/p0/macos-service.json
```

## 8. 服务控制

```bash
npm run service:macos -- status
npm run service:macos -- stop
npm run service:macos -- start
npm run service:macos -- restart
npm run service:macos -- uninstall
```

`stop` 只暂停服务并保留 plist。`uninstall` 删除 LaunchAgent 定义，但不删除数据、工作区、备份和日志。

## 9. 一键流程没有做什么

本流程不会：

- 启用 Joycrew、DataWeave 或 Hermes；
- 开放局域网或公网；
- 自动写入飞书；
- 自动执行得到大脑同步；
- 自动改变“我的今日”；
- 自动迁移到另一套项目目录；
- 自动删除旧数据；
- 自动处理未知端口进程；
- 声称已经完成 iPhone、飞书、GetNote 和 ICS 的真实现场回执。

服务启动后，仍需按 [`MACOS_HOST_P0.md`](MACOS_HOST_P0.md) 完成浏览器、GetNote、飞书、iPhone Capture 和 ICS 的人工现场验收。
