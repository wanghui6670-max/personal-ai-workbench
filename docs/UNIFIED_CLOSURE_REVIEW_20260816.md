# Personal AI Workbench 统一收口审查（2026-08-16）

> 状态：**Current closure review / 当前工程收口审查**  
> 基线：`0289d5f7fe0ec661a18a3884e423846021f1f168`（`main`）  
> 产品来源合同：以 `docs/WORKBENCH_V3_SOURCE_CONTRACT.md` 为准。  
> 本文不是新的产品合同；它负责把 2026-08-16 之前混在一起的 GetNote v2 审查、macOS 运维审查、v3 改造结果和遗留债务重新分层。

## 0. 总结论

当前仓库已经完成 v3 主链路切换：

```text
个人工作事项：飞书云文档 → Workbench Inbox → AI 分析 → 用户确认 → Workbench 执行
内容素材：GetNote → 用户确认 → 自媒体 / 得到大脑内容（本地 Markdown）
状态真相：Workbench state
```

PR #29 已合并，合并提交为 `68a2dabd852bc0c1d01a4184adacb05ed09a79b9`；该提交的 Workbench contracts、Harness E2E、Docker smoke 在 `main` push 后真实执行并通过。之后 `0289d5f` 只继续补充审查文档，没有修改运行代码。

**当前不能把 `docs/DEV_WORKFLOW_REVIEW_20260816.md` 单独当作现行产品总合同。** 它仍以 GetNote Task Sync v2 为主体，是重要历史审查证据，但其中“个人待办主来源”“测试数量”“现网 8080/nohup/LaunchAgent 状态”等结论带有明确时间截面。

### 当前优先级

| 优先级 | 事项 | 当前状态 |
|---|---|---|
| P0 | macOS LaunchAgent install / restart 连续性与失败回滚 | **OPEN** |
| P0 | v3 AI 自动分析的数据最小化、调用风暴与 >12 条队列饥饿 | **OPEN** |
| P0 | 主文档与版本号仍停留 v2 / 2.0.0 | **OPEN** |
| P0 | `main` 未启用 branch protection / required checks | **OPEN** |
| P1 | Joycrew health 语义与探活入口 | **OPEN** |
| P1 | 公开仓完整历史 secret scan 尚未形成可重复证据 | **UNVERIFIED** |
| P2 | GetNote v2 legacy：完成态翻回、snowflake JSON Number、N+1、tombstone 容量与缺测 | **BACKLOG / 不阻塞 v3 主链路** |
| Closed | `data/p0/` 当前被 gitignore，GitHub 路径历史未发现提交 | **CLOSED（限该路径）** |
| Closed | v3 来源边界和 GetNote 自媒体内容管线 | **MERGED + CI GREEN** |

---

## 1. 哪些旧结论已经被 v3 覆盖

### 1.1 GetNote 不再是个人待办产品主来源

`docs/WORKBENCH_V3_SOURCE_CONTRACT.md` 已明确覆盖 README / PRODUCT_SPEC / ARCHITECTURE / API / TASK_SOURCE_PIPELINE 中与个人事项来源冲突的 v2 描述。

因此：

- `external_tasks_sync`、`external_task_integration_*`、`daily_summary_publish` 不再注册到交互式 AI/MCP 能力面；
- “同步得到大脑待办”必须返回 clarification；
- GetNote 对用户保留的产品能力是 `getnote_content_status` / `getnote_content_sync`；
- GetNote v2 的完成态、fingerprint、sink 等问题仍值得修复，但属于历史数据 / 兼容层，不得重新把产品主链路改回 GetNote。

### 1.2 旧报告中的 live 状态只能视为历史现场

旧报告记录的：

- `127.0.0.1:8080`；
- `nohup node src/server.mjs`；
- LaunchAgent 未 loaded；
- Joycrew `:4000` 当时无进程；

都是审查当时的现场事实。**本次仓库审查没有重新访问 Chris 的 Mac，不把这些状态写成“当前仍然如此”。**

05 上线验收仍应要求真实 Mac 上重新读回：

1. `launchctl print gui/<uid>/com.dongjue.personal-ai-workbench`；
2. `/api/health`；
3. plist 中 `WORKBENCH_BUILD_COMMIT`；
4. 实际监听端口与进程归属；
5. 失败回滚演练结果。

---

## 2. 当前 P0-1：LaunchAgent 切换不是原子操作

旧报告已经发现“bootstrap 失败后恢复失败被吞掉”，但当前源码还有两个更具体的连续性缺口。

### 2.1 `install()` 在恢复保护区之外先停旧服务

当前顺序是：

```text
读取旧 plist / 备份
→ bootout 旧服务
→ waitForPortFree
→ 构建 / lint / 替换 plist
→ bootstrap 新服务
→ health
```

`bootout()` 和 `waitForPortFree()` 发生在安装主体 `try/catch` 之前。于是：

- 旧服务已经停掉；
- 如果端口迟迟不释放或这里抛错；
- 恢复旧 plist / 旧 LaunchAgent 的 catch 根本不会执行。

这比“恢复 bootstrap 失败被吞掉”更早形成停机窗口。

### 2.2 `restart()` 也没有故障恢复

`restart()` 是：

```text
bootout → waitForPortFree → bootstrap → waitForHealth
```

任一步失败后，没有恢复到“调用 restart 前健康状态”的事务保证。

### 2.3 完成线

应把 install / restart 都改成“可验证切换事务”：

- 新 plist 先生成并 lint，所有不需要停服务的检查都必须在 `bootout` 前完成；
- 记录 `wasLoaded`、旧 plist、旧 commit、旧 health；
- 从第一次 `bootout` 开始进入统一 recovery scope；
- 任何端口释放、rename、bootstrap、health、commit 校验失败都必须尝试恢复；
- 恢复失败不得 `.catch(()=>undefined)`；必须抛出独立 `ROLLBACK_FAILED` 类错误并保留原始错误；
- 回滚成功的判据不是“bootstrap 命令返回 0”，而是 `launchctl print + health + expected commit`；
- `install` 和 `restart` 都补故障注入回归测试。

在这项修完并做真实 Mac 验收之前，05 常驻上线不应宣告完成。

---

## 3. 当前 P0-2：v3 AI 自动分析的作用域与调用模型不够安全

这是旧 GetNote 审查没有覆盖的 v3 新问题。

### 3.1 UI 说“只分析这一条”，服务端却发送更大工作台上下文

`public/workbench-v3.js` 对每条飞书 Inbox 构造“只分析这一条”的请求；但 `planAIConsole()` 的模型输入同时包含：

- 最多 50 条 Inbox 的 `id/text/source/createdAt`；
- 最多 50 个项目的名称、介绍、结束时间等；
- 最多 80 个 Todo 的标题、项目、截止日期和完成态；
- Today 与 confirmations。

因此分析 A 条事项时，无关的 B/C/D Inbox 原文也可能被发送给已配置 AI Provider。

这不是代码执行权限问题，而是**数据最小化、隐私边界、Token 成本和审计语义**问题。

### 3.2 自动分析只取前 12 条，存在队列饥饿

`AUTO_ANALYZE_LIMIT=12`，每次只对当前 Inbox 前 12 条执行 `autoAnalyze()`。

如果前 12 条一直留在 Inbox：

- 第 13 条及以后不会进入自动分析集合；
- “同步过来的信息自动分析”并不成立于任意数量；
- UI 没有明确说明这个上限。

### 3.3 12 条会并发触发，而且建议只存在浏览器内存

当前循环使用 `void analyzeItem(item)`，会并发触发最多 12 次 `/api/ai/plan`；`inboxPlans` 只存在浏览器内存。

结果：

- 一次同步可能瞬间产生多次模型请求；
- 每次请求又重复携带较大的工作台上下文；
- 页面刷新 / 重启后建议丢失，前 12 条会重新分析；
- 没有持久化的 `source item hash → analysis status`，无法区分“内容没变但 UI 重载”与“需要重新分析”。

### 3.4 建议完成线

优先改为服务端可审计的 scoped review：

```text
Feishu item
→ scoped planner（只给当前 item + 最小必要项目/待办候选）
→ bounded queue（例如 2–3 并发）
→ analysis receipt / item content hash
→ UI 展示建议
→ 用户确认
→ inbox_process
```

最低要求：

- 自动分析只发送目标 item 原文；
- 只有在项目匹配需要时才补充候选项目元数据，默认不发送其它 Inbox 原文；
- 对外模型数据范围在设置 / 文档中明确；
- 受控并发 + backoff；
- >12 条可以逐批继续，不产生永久饥饿；
- 同一内容 hash 不因页面刷新无条件重复调用模型。

---

## 4. 当前 P0-3：文档权威顺序和版本仍未真正收口

虽然 `WORKBENCH_V3_SOURCE_CONTRACT.md` 声明覆盖旧文档，但主入口仍存在相反叙事：

- `README.md` 仍介绍 GetNote 会议待办为事实源；
- `docs/PRODUCT_SPEC.md` 仍是 `v1.4 draft`，并写“得到大脑是个人明确会议待办事实源，飞书不再作为个人待办来源”；
- `CHANGELOG.md` 最高仍为 `2.0.0 - 2026-08-14`；
- `src/product.mjs` 仍返回 `PRODUCT_VERSION='2.0.0'`。

覆盖声明只能临时止血，不能作为长期信息架构。

### 完成线

应在同一文档收口 PR 中：

1. README 的产品边界改成 v3；
2. PRODUCT_SPEC 升级并移除 v2 主来源冲突；
3. ARCHITECTURE / API / TASK_SOURCE_PIPELINE 对齐 v3；
4. CHANGELOG 增加 v3 来源迁移、合并视图、自媒体 GetNote 内容库；
5. 明确版本策略：产品 SemVer 与 `WORKBENCH_BUILD_COMMIT` 分工；
6. `DEV_WORKFLOW_REVIEW_20260816.md` 顶部增加“历史审查 / 被本统一收口审查与 v3 来源合同部分覆盖”的醒目标记。

---

## 5. 当前 P0-4：主分支门禁没有仓库级强制

当前 GitHub `main` 显示 `protected=false`，required status checks enforcement 为 off。

这意味着：

- 团队流程虽然要求 Workbench contracts / Harness E2E / Docker smoke 全绿后才合并；
- 但 GitHub 本身没有阻止直接 push main 或绕过检查的仓库级保护。

对于已经公开、并把 `main` 当正式版本来源的仓库，这是工程治理缺口。

### 完成线

建议开启 branch protection / ruleset：

- 禁止直接 push main（保留明确管理员 break-glass 策略）；
- PR 必须通过 `test`、`harness-e2e`、`docker-smoke`；
- require branch up to date before merge；
- 禁止 force push / branch deletion；
- 如后续有多人协作，再增加 review requirement / CODEOWNERS。

---

## 6. P1：Joycrew health 语义需要修，但不要把核心 readiness 变成远程阻塞探针

旧报告判断正确：`joycrewClient.status()` 的 `available` 固定为 `false`；真正探活的是 `probe()`。

但不建议简单把 `/api/health` 改成每次 `await probe()`：Joycrew 默认网络 timeout 是 20 秒，可能让远端异常拖慢个人 Workbench 的 readiness，破坏 fail-isolation。

更合理的合同：

- `/api/health`：只报告 Workbench 自身 readiness + Joycrew `enabled/configured`，不声称 live available；
- `/api/joycrew/status`：显式实时 probe；
- 如果 UI 需要在主 health 显示 availability，使用短超时异步探针 + TTL cache，不让 `/api/health` 同步依赖 Joycrew。

---

## 7. P1：公开仓 secret 风险只关闭了 `data/p0` 这一条，不等于完成全历史扫描

已验证：

- `.gitignore` 当前包含 `data/p0/`；
- GitHub `commits?path=data/p0` 返回空列表，未发现该路径曾被提交。

因此旧报告中的 `data/p0/env-backups` 误提交风险对**当前路径**可以关闭。

但这不是完整 secret-history audit。公开仓仍建议做一次可重复的历史扫描，并把结果留证，至少覆盖：

- `.env` / token / session / proxy key 常见模式；
- 历史大文件 / 删除文件；
- 公开文档中的真实租户 URL、个人路径和身份默认值；
- GitHub Actions / release artifact 中是否曾携带运行时配置。

在没有这份结果前，只能说“`data/p0` 路径未进入 GitHub 历史”，不能说“公开仓历史已无敏感信息”。

---

## 8. P2：GetNote v2 legacy backlog

以下问题真实存在，但 v3 已经撤掉 GetNote 个人待办交互能力，不应阻塞飞书主链路：

### 8.1 本地完成态可能被来源 active 翻回

`applyGetnoteTaskSnapshot()` 命中 active 的 existing Todo 时会写 `done:false`。因此历史 / 兼容模式下，用户本地完成过的 GetNote Todo 可能在来源仍 active 时被重新打开。

### 8.2 Snowflake 大整数可能经 JSON Number 丢精度

`getnote-runtime` 使用普通 `JSON.parse`；如果上游返回未加引号且超过 `Number.MAX_SAFE_INTEGER` 的 note_id / cursor，值可能在 `String()` 之前已经失真。

### 8.3 旧 GetNote Task Sync 有 bounded N+1 / 串行外部调用债务

Task Sync 最多扫描 500 recent notes + 500 tracked notes，并逐 note 串行 `fetchTodos(noteId)`。所以旧报告“未见 N+1 新债”的表述应撤回。

### 8.4 其他 legacy 缺口

- `externalTaskDecisions` 最大 2000，淘汰后旧来源可能复活；
- memo / project_note 独立终结路径缺正测；
- 本轮缺失 ≠ 完成缺显式正测；
- MCP legacy sync 真执行、metadata failure、ICS 权限/tmp 清理等缺少部分行为回归。

这些应留在 compatibility backlog；除非重新启用 GetNote Task Sync 产品面，否则不应优先于 v3 P0。

---

## 9. 已关闭 / 已确认事项

### 9.1 v3 主链路已经进入 main

已完成：

- 飞书作为个人事项主同步入口；
- Today + Inbox 工作面合并；
- 项目现场 + 项目进度合并；
- GetNote 下沉为自媒体内容来源；
- legacy GetNote task tools 退出交互 registry；
- v3 新模块进入 syntax / contract / Docker 能力检查；
- PR #29 最新 HEAD 合并前全绿，合并后的 main push CI 也全绿。

### 9.2 `data/p0` GitHub 路径历史未发现提交

此项按当前可见 GitHub 历史关闭，但不替代全历史 secret scan。

---

## 10. 下一刀建议（不要并行扩功能）

### Slice A — 先做当前 P0 工程修复

1. LaunchAgent install/restart 事务化回滚 + 故障注入测试；
2. v3 AI scoped review：目标 item 最小上下文、受控并发、>12 队列继续、避免刷新重复分析；
3. README / SPEC / ARCH / API / CHANGELOG / PRODUCT_VERSION 收口；
4. GitHub main branch protection / required checks。

### Slice B — 再做真实 Mac 05 验收

1. 在实际目标 Mac 上执行 P0 preflight；
2. 安装/升级 LaunchAgent；
3. `launchctl print` + health + commit 三向读回；
4. 人工注入一次失败，确认旧服务能恢复；
5. Joycrew 独立 probe，不把其离线变成 Workbench readiness 失败。

### Slice C — compatibility backlog

- GetNote done flip；
- snowflake JSON parser；
- GetNote N+1 / timeout；
- tombstone 容量与遗留缺测。

在 Slice A/B 完成前，不建议继续增加新的同步源、第二套 AI 队列或新的 macOS 安装包装层。

---

## 11. 事实边界

本报告基于 GitHub 当前 `main` 源码、文档和 CI 可见结果。

本报告**没有**：

- 访问 Chris 当前 Mac 的 `launchctl`；
- 读取本机 `.env`、`state.json`、`config.json` 正文；
- 声称当前 live Feishu / GetNote / Joycrew / iPhone 已验收；
- 执行完整 Git 历史 secret 扫描。

因此现场状态必须和仓库事实分开：仓库 P0 可以修完，但 05 完成必须靠目标 Mac 的真实读回证据。