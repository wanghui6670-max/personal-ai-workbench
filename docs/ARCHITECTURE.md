# 架构说明（v3.1）

## 1. 当前总体边界

```text
飞书云文档 [INBOX] ── 个人工作事项主入口
        ↓
Workbench Inbox     ── 个人待处理事实（按用户隔离）
        ↓
AI scoped review    ── 只分析目标 item，产生建议，不直接执行
        ↓ 用户确认
Workbench domain    ── Todo / Today / 项目归属 / 用户决定真源（按用户隔离）

得到大脑 GetNote    ── 自媒体内容来源（只读）
        ↓ 用户确认
自媒体本地内容库    ── Markdown + 最小索引

本地项目文件夹      ── 真实工作产物
Git                 ── 版本与代码变化证据
飞书项目文档        ── 项目分析、总结、复盘与恢复叙事真源
Joycrew             ── 企业项目 / AI 员工 / Run / Evidence / Approval / Deliverable
Harness             ── 右侧受控 Copilot；固定白名单工具
```

系统不替用户安排 Today。所有会改变 Workbench 或外部系统的动作继续受确认门保护。

## 1.1 多用户架构（v3.1 新增）

v3.1 引入多用户支持，部署到云服务器供 5-10 人小团队使用：

```text
用户登录（用户名/密码）
        ↓
JWT Cookie 认证
        ↓
storeAdapter.scope(userId)  ── 返回绑定 userId 的 store 代理
        ↓
业务层函数（无需改签名）
        ↓
SQLite（按 userId 字段隔离）
```

核心设计：

- **scopedStore 代理模式**：`store-adapter.mjs` 的 `scope(userId)` 返回自动绑定 userId 的 store 代理，业务层函数无需改签名。
- **DSH Copilot 隔离**：`harnessRunScope.currentUserId()` 获取当前执行用户 ID，使用对应 `scopedStore` 而非 `globalStore`。
- **存储后端可切换**：`STORE_BACKEND=sqlite`（多用户）/ `json`（单用户 fallback，`LEGACY_USER_ID='__legacy__'`）。
- **角色权限**：admin 可管理用户 + 查看全员数据；user 仅操作自己的数据。

## 2. 飞书个人事项入口

现有 `/api/inbox/sync` 和 MCP 工具 `feishu_inbox_sync` 负责读取飞书“收件箱”章节的 `[INBOX]` 条目并提交到 Workbench Inbox。

同步本身不：

- 创建 Today；
- 自动创建项目；
- 自动执行 AI 建议。

### AI scoped review

单条自动审阅使用 `view=inbox-review` 和目标 `itemId`。服务端 `src/ai-review-scope.mjs` 在进入模型前做两层收缩：

1. **状态收缩**：只保留目标 Inbox item 和最多 30 个未归档项目的目录摘要；其他 Inbox 原文、Todo、Today、confirmations 均不进入模型输入。
2. **工具收缩**：模型目录只暴露 `inbox_process`。即使模型或本地 fallback 产生别的 tool，registry 也会降级为 clarification。

浏览器 `public/workbench-v3.js` 使用有界自动分析队列：

- 同时最多 2 条；
- pending queue 最多 100 条；
- 队列持续补充，不只处理前 N 条；
- 未变化事项的预览在浏览器 session 内短时复用；
- item 文本/来源/创建基准变化后缓存失效；
- 真正执行仍调用 `/api/ai/execute` 且 `confirmed=true`。

## 3. Today / Inbox / 项目现场

v3 只合并用户工作面，不强行合并领域对象：

- `state.inbox` 继续表示待处理事项；
- `state.todayPlan` 继续表示用户明确选择的今日任务；
- “今日与收件箱”页面把 Today、Inbox、AI 建议、逾期、待归类和待确认放在同一决策面。

“最近工作现场”和“项目进度”合并为项目现场视图，但项目真实来源、Git 证据和同步事务边界不变。

## 4. 得到大脑内容管线

得到大脑不再作为个人待办主来源。当前交互式能力面只暴露：

```text
getnote_content_status
getnote_content_sync
```

内容流：

```text
GetNoteReader（read-only）
→ 最近笔记
→ 取得真实原文
→ safeAtomicWrite
→ <WORKSPACE_ROOT>/<业务序号>_自媒体/得到大脑内容/
```

固定安全规则：

- 不接受任意 shell / 二进制 / URL / 文件路径；
- 输出目录由 Workbench 业务目录派生；
- symlink / 普通文件检查；
- 临时文件 + rename 原子替换；
- 无真实原文字段时 fail closed；
- 不创建 Todo / Inbox / Today；
- 不写回 GetNote。

## 5. Legacy GetNote Task Sync v2

以下模块保留用于历史数据兼容、迁移和回归，但不再注册进交互式 AI/MCP registry：

```text
src/task-cli.mjs
src/external-task-reconcile.mjs
src/external-task-decisions.mjs
src/task-sync-domain.mjs
src/mcp/external-task-tools.mjs
```

旧链路仍存在已知 backlog（完成态翻回、snowflake JSON Number 精度、逐 note 串行 fetch、tombstone 容量等）。这些问题不重新定义 v3 的个人事项主入口。

## 6. 项目记录

本地项目文件夹是真实成果源，Git 提供版本证据。

`PROJECT.md` 只保存项目身份证和叙事真源声明，不保存阶段总结或复盘正文。长期项目叙事统一写入飞书项目文档固定章节：

```text
项目分析与总结
```

项目同步采用：

```text
读取本地文件 / Git 证据
→ 分析
→ 飞书写入 + operationId 读回
→ Workbench 机器状态提交
```

## 7. Joycrew / Harness

Workbench 是浏览器统一入口。Joycrew 提供企业业务执行面，Workbench 通过受控客户端访问。

Joycrew 写操作：

```text
Prepare → Preview → 用户确认 → Execute → Readback
```

Joycrew 连接使用受限网络分区与认证配置；浏览器不接触上游 token、任意 URL 或服务端路径。

核心 `/api/health` 是 Workbench readiness，不应同步等待远程 Joycrew probe。Joycrew 实时连通性走独立 `/api/joycrew/status`，避免上游超时拖慢个人工作台 readiness。

## 8. macOS LaunchAgent

正式常驻由 `scripts/macos-launch-agent.mjs` 管理。

安全切换顺序：

```text
P0 gate
→ 生成 replacement plist
→ plutil lint
→ bootout 旧服务
→ 等端口释放
→ 原子替换 plist
→ bootstrap
→ health + commit 读回
```

一旦 `bootout` 后进入 cutover，后续任何失败都必须尝试恢复旧服务。恢复旧版本 health 时只要求 `ok=true`，不能拿新版本号要求去否定旧版本恢复成功。若原操作和恢复都失败，必须同时报告两组错误。

`restart` 虽不改 plist，也必须在失败时恢复此前已 loaded 的服务。

## 9. 数据、Capture、备份与恢复

`POST /api/capture` 使用稳定 `captureId` 做幂等，同一次采集的网络重试必须复用同一个 `captureId`。

backup v2 继续包含：

```json
{
  "backupVersion": 2,
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts` 只保存 Capture 标识、正文 hash 和处理引用；
- `projectRecordReceipts` 只保存 operationId、机器进度和飞书指针；
- 项目正文、飞书正文、凭证、GetNote 登录态和 Joycrew token 不属于备份内容；
- `data/p0/` 是运行时安装/备份目录，必须保持 Git ignored；
- 恢复任一阶段失败必须尝试整体回滚，不能留下部分恢复状态。

## 10. 部署与门禁

当前产品版本：**3.1.0**。

CI 最新 HEAD 必须真实执行：

1. runtime syntax checks；
2. Workbench contract tests；
3. Harness E2E；
4. Docker smoke。

Docker smoke 直接校验 `health.version === 3.0.0`、v3 前端资产、当前 MCP 工具面和 Joycrew fail-isolation。

当前 GitHub `main` 是否启用 branch protection / required checks 属于仓库托管层配置，应与上述 CI 门禁同时开启；仅靠团队流程约定不能视为强制保护。
