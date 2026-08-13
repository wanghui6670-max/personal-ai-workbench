# 个人 AI 项目管理工作台

这是一个**本地文件系统优先、AI 辅助、人保留最终决策权**的个人项目管理工作台。

它不是为了再造一个复杂的任务软件，而是解决一个具体问题：**工作被打断以后，不要重新找资料、重新理解上下文、重新开始。**

## 核心原则

1. 所有新事情先进入收件箱。
2. AI 不自动分类收件箱；你下自然语言指令后才移动。
3. 项目是上下文边界。业务板块 → 项目 → 本地文件夹一一对应。
4. 本地项目文件夹是资料的真实来源；工作台只保存状态和路径。
5. 项目创建时只固定开始日期和计划结束日期；中间阶段由 AI 根据资料识别。
6. 项目进度只在你点击“同步所有项目进度”或“同步此项目”时刷新。
7. 待办必须有截止日期。没有日期，系统必须追问。
8. AI 可以分析和提醒，但**绝不能自动把任务加入今日工作台**。
9. 今日工作由早晨对话后你自己拍板，且只对拍板当天有效；跨自然日不会沿用昨天的选择。
10. AI 判断不准的内容进入“待确认”，业务归属不清的项目进入“待归类”，逾期项目独立管理。

## 已实现功能

- 收件箱快速记录
- 收件箱自然语言处理：归入项目 / 项目待办 / 独立待办 / 备忘 / 新建项目 / 删除
- AI 生成项目名称、介绍、业务归属建议
- 业务归属不确定时自动进入待归类
- 自动创建标准本地目录：`PROJECT.md / 01_原始资料 / 02_工作过程 / 03_最终交付 / 99_归档`
- 手动一键同步全部项目进度
- 扫描本地文件修改时间、Git commit、Git remote、文本文件片段
- GPT-5.6 Luna（极高 / `xhigh`）按“证据 → 冲突与缺口 → 最终结论”生成当前进度、视觉百分比、卡点和极短上下文恢复摘要
- 无 OpenAI API Key 时使用本地规则继续工作
- 最近 3 天 + 临近截止事项的早晨 AI 对话
- 今日工作台完全由用户决定，并按本机自然日隔离
- 全部待办、待确认、待归类、逾期、归档、工作日志
- 项目完成与归档
- 业务板块管理
- JSON 数据原子写入 + 每日备份 + 手工备份 + JSON 导出
- 可选访问密码
- iPhone Shortcut / 外部采集 API
- 飞书每日工作日记作为收件箱外部来源：只读取“收件箱”章节下 `[INBOX]` 条目，写入先飞书后本地读回
- Docker 部署
- 环境自检与自动化测试

## 本地运行

要求：Node.js 20+；如需 Git 信息，还需要安装 Git。

```bash
cp .env.example .env
npm run doctor
npm start
```

默认地址：`http://127.0.0.1:4173`

项目没有第三方 npm 运行依赖，不需要 `npm install`。

`npm start`、`npm run doctor`、`npm run backup` 和 `npm run restore` 都会读取项目根目录的 `.env`。系统中已存在的同名环境变量优先（包括显式空值）；加载器只接受 `.env.example` 中声明的应用配置键，不执行 shell 语法、变量展开、`$()` 或反引号命令替换。不要使用 `source .env` 或 Windows `for /f` 加载该文件。

Docker Compose 改端口时使用 `WORKBENCH_PORT`，它会同时修改宿主机发布端口和容器内应用监听端口。例如设置 `WORKBENCH_PORT=8080` 后，从 `http://127.0.0.1:8080` 访问；不要只修改原生启动使用的 `PORT`。

## OpenAI

设置：

```bash
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.6-luna"
```

默认 AI 判断器是 `gpt-5.6-luna`，推理档位在代码中固定为极高（`xhigh`）。工作台通过 OpenAI Responses API 的 Structured Outputs 运行三段式分析工作流：先列出可核对的证据，再标明冲突与信息缺口，最后给出结构化业务结论。模型只返回简短、可审计的依据，不请求隐藏思维过程；分析信封仅用于本次本机校验，持久化时只保存业务结论，不保存依据草稿或隐藏思维。

稳定规则放在 developer instructions，项目、文件、Git 和对话数据作为不可信 user input 发送；返回结果会拒绝 incomplete/refusal，并在本机再次校验字段、类型、长度和候选 ID。Luna 的 `xhigh` 推理通常比低档位有更高延迟和调用成本；配置 Key、运行 `npm run doctor` 或在设置页看到“已配置”，都只证明请求参数已经就绪，不证明模型已经联网可达。OpenAI 超时、拒绝、不可达或结构化结果校验失败时，项目创建、项目进度和早晨对话都会回退到本地规则，不影响基础项目管理，也不会因此自动安排今日任务。

启用 Key 后，项目描述、业务板块、项目/待办元数据、相对文件名与修改时间、Git 提交元数据和早晨对话上下文会发送给 OpenAI，并在发送前做通用凭证脱敏。`PROJECT.md` 和可读文件正文默认只在本机处理；只有显式设置 `OPENAI_SEND_FILE_CONTENT=1` 才会把这两类正文加入请求，仍会脱敏。脱敏不能代替人工检查，不应对高敏感项目开启正文发送。请求使用 `store:false`，但这不等于承诺服务商零处理或零留存；请同时核对当前 OpenAI 数据政策。

## 你的真实项目目录

在“设置”里把工作区根目录改成你的真实项目根目录，例如：

```text
/Users/yourname/Work
```

之后新建已归类项目，会在现有文件系统下按以下结构创建：

```text
Work/
├── 01_动觉AI/
│   └── 某项目/
│       ├── PROJECT.md
│       ├── 01_原始资料/
│       ├── 02_工作过程/
│       ├── 03_最终交付/
│       └── 99_归档/
├── 02_实体门店/
├── 03_客户项目/
└── 04_个人内容/
```

## 部署前最重要的一件事

**如果你要读取你电脑上的真实项目文件，这个服务必须运行在能访问那些文件的机器上。**

适合：
- 你的 Mac / Windows 电脑
- Mac mini
- 家庭 NAS
- 办公室服务器
- Docker 主机（把项目目录挂载为 volume）

不适合直接期待：把网页部署到普通无状态云函数后，还能读取你笔记本电脑里的 `/Users/...` 文件。

详见 `docs/DEPLOYMENT.md`。

## 安全

如果 `HOST=0.0.0.0` 或绑定到非 localhost 地址，程序默认要求设置 `WORKBENCH_PASSWORD`，否则拒绝启动。只有你明确设置 `ALLOW_INSECURE_PUBLIC=1` 才会绕过。

建议：

```bash
WORKBENCH_PASSWORD="a-strong-password"
SESSION_SECRET=
CAPTURE_TOKEN="another-long-random-token"
```

上面的 `SESSION_SECRET` 故意留空；只要启用 `WORKBENCH_PASSWORD`，就必须在本机 `.env` 中填入自行生成的至少 24 字符随机值，即使服务只监听 localhost。空值或示例占位值会被启动安全门拒绝。

通过 HTTPS 反向代理、自定义域名、局域网 IP 或 Tailscale 地址访问时，还要设置完整的 `TRUSTED_ORIGINS`；HTTPS 下设置 `COOKIE_SECURE=1`。应用只校验实际 `Host` 和 `Origin`，不会因 `X-Forwarded-*` 头自动放宽。详见 `docs/DEPLOYMENT.md`。

## iPhone 快捷指令采集

外部采集接口：

```text
POST /api/capture
Authorization: Bearer <CAPTURE_TOKEN>
Content-Type: application/json

{"text":"刚刚想到的事情","source":"iphone-shortcut"}
```

所有采集内容仍然只进入收件箱，不会自动成为任务。

详见 `docs/IPHONE_SHORTCUT.md`。

## 飞书每日工作日记收件箱

工作台可以把收件箱绑定到飞书云文档《个人 AI 工作台｜每日工作日记》。在设置页填写文档 URL 后，点击“同步飞书收件箱”即可读回。系统只读取文档中一级标题“收件箱”下、以 `[INBOX]` 开头的段落/待办条目；每日工作记录、明确决定和待确认不会被误转成收件箱事项。

启用后，本地新增收件箱事项会先通过本机已登录的 `lark-cli` 写入飞书，并在文档读回确认该条目后才更新本地缓存。飞书不可达或读回失败时，本地不会伪装成已写入；已有本地收件箱仍可继续人工处理。lark-cli 需要在运行工作台的同一台机器上安装并以当前用户登录。

当前文档：<https://xcnn2pk8gpzl.feishu.cn/wiki/By6ow2cm0iXXQkkx2XRc7Ym5nOb>

## 数据与备份

默认数据目录：`./data`

- `state.json`：你的项目、待办、收件箱、日志
- `config.json`：工作区与业务板块设置
- `backups/`：自动/手工快照

每日自动快照在当天第一次修改状态或配置前创建，包含 `state.json` 与 `config.json`。手工快照也包含两者。它们不包含 `workspace/` 中的真实项目资料，且默认与主数据在同一磁盘，因此属于本机回滚点，不等同于完整灾备。

手工备份：

```bash
npm run backup
```

网页设置里也有“立即备份”和“导出 JSON”。

## 测试

```bash
npm test
```

关键约束都有回归测试：
- 新项目和新备忘不能绕过收件箱
- 待办没有截止日期不能创建
- 待办不能自动进入今日
- 项目没有合法计划结束日期不能创建
- 多个项目匹配时必须由用户选择，不能静默归类
- 项目归类后必须创建本地目录和 `PROJECT.md`

## 目录

```text
src/        后端、AI、文件系统、领域规则
public/     单页前端
scripts/    doctor / backup / restore
tests/      自动化测试
data/       持久化数据
workspace/  默认工作区（部署时建议映射到真实目录）
docs/       部署、架构、iPhone 说明
```

## 恢复备份

先停止工作台，再执行：

```bash
npm run restore -- /path/to/backup.json
```

恢复前脚本会再自动创建一次安全备份。
