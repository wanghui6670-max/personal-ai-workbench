> ⚠️ **历史审查提示（2026-08-16）**：本文件以 `c698133` / GetNote Task Sync v2 为基线，保留当时的仓库与本机现场审查证据。当前产品来源边界请以 [`WORKBENCH_V3_SOURCE_CONTRACT.md`](./WORKBENCH_V3_SOURCE_CONTRACT.md) 为准；当前工程优先级、已关闭项与遗漏项请以 [`UNIFIED_CLOSURE_REVIEW_20260816.md`](./UNIFIED_CLOSURE_REVIEW_20260816.md) 为准。本文件中的 `8080`、`nohup`、LaunchAgent loaded 状态、Joycrew `:4000` 等“现网”描述均为当时截面，不代表当前 Mac 已重新验证。

# Personal AI Workbench 深审报告

- 日期：2026-08-16
- 审查口径：工作台 `dev-workflow` §13（01–07）+ `product-requirements` 三问/五段 + `code-review-and-quality` 五轴
- 基线：`c6981337b65c54c142287eb1935dd7b42809453b`（`origin/main`，PR #28 GetNote Task Sync v2）
- 范围：仓内合同、GetNote v2 实现与测试、macOS 安装器、现网读回
- 未做：不改产品行为、不读 `.env` / `state.json` / `config.json` 正文、不声称 live GetNote / 飞书 / Joycrew / iPhone 已验收
- 现网（审查当时）：`http://127.0.0.1:8080/api/health` → `ok=true`，`version=2.0.0`；进程为 `nohup node src/server.mjs`，不是 LaunchAgent
- 增补：独立运维审查已复核安装回滚、P0 与 `--preserve-runtime`、Joycrew health 探针和文档漂移；独立 GetNote 审查已复核 Today / due / fingerprint / sink / CLI 隔离，并补上完成态翻回与雪花 ID 两条 Required

## 0. 总裁决

**合同测试可以通过；05 上线不能宣告完成；公开仓存在误提交运行时密钥备份的路径。**

| 门 | 裁决 |
|---|---|
| 03 合同层（`npm run test:files`） | **PASS** — 86/86 |
| GetNote v2 红线（Today / 用户日期 / fingerprint / sink） | **PASS-WITH-GAPS** — 不构成回滚；完成态与雪花 ID 仍有合同缺口 |
| 05 本机常驻上线 | **NO** — LaunchAgent 未 loaded |
| 对外产品 / 06 增长 | **NO** — 现在不付钱 |
| 允许声明 live GetNote / 飞书 / Joycrew / iPhone 已验收 | **NO** |
| 允许把本审查文档推到 GitHub | **YES** — 不含凭证、不含 `data/p0` |

建议下一刀只做两件事：修 LaunchAgent 失败回滚，以及忽略 `data/p0/`。**在安装器修好之前，不要再跑会 `bootout` 的 `install`。** 未批准前不写新功能。

## 1. 路径与阶段

这是已在跑的本机产品，不是新开需求。

- 对内：Chris 的日常入口；01 可跳过。
- 对外：未过三问，06 不成立。
- 整仓：Architectural。
- 当前主阶段：**05 上线未收口**；现场 bug 走 **04**。
- 工作台档案：没有 `projects/personal-ai-workbench/`，`INDEX.md` 无本行。仓内合同在 `docs/`，不是五段 SPEC。

### 01 三问

| 问 | 答案 | 判定 |
|---|---|---|
| 用户是谁 | Chris。被打断后要恢复今日 / Inbox / 项目，并从一个入口看 Joycrew 业务执行 | 对内清楚 |
| 凭什么现在付钱 | 没有外部付费 | 06 未成立 |
| 最可能死在哪 | 1) 待办身份靠 `text_fingerprint`；2) LaunchAgent 安装失败会卸掉正在跑的服务；3) 产品同时承诺个人连续性与 Joycrew 业务执行，后者现场不可用 | 对内主风险是运维，不是赛道 |

### 02 五段

| 段 | 仓内证据 | 缺口 |
|---|---|---|
| 问题 | `docs/UNIFIED_PRODUCT_V2.md`：唯一日常入口 | 工作台档案层没有 slug |
| 方案 | GetNote 只读 → Workbench 状态真源 → 可选飞书/ICS；Joycrew Preview→Confirm | `PRODUCT_SPEC.md` 标题仍是 **v1.4 draft** |
| 约束 | 人在回路、CLI 白名单、loopback、backup v2 | 未跟踪 `CLAUDE.md` 与现行合同相反 |
| 明确不做 | AI 不安排今日、不猜待办、不自动改期 | CHANGELOG 停在 2.0.0，其后 95 个提交无版本记录 |
| 成功标准 | V2 验收清单已勾；GetNote 决策合同有回归点 | 本机 05（LaunchAgent 常驻、Joycrew 可达）未写成可勾选句 |

## 2. 01–07 对照

| 阶段 | 完成线 | 证据 | 裁决 |
|---|---|---|---|
| 01 | 三问 | 对内用户清楚；付钱未验证 | 对内可跳；对外未过 |
| 02 | 五段齐 | 仓内合同强，标签/进仓路由漂移 | 部分通过 |
| 03 | 无批准不写码；TDD | 86/86 绿；CI 含 syntax + contract + harness e2e + docker smoke | 合同层通过 |
| 04 | 有复现才算修完 | `launchctl bootstrap` I/O error 已复现，未修 | 未通过 |
| 05 | 清单 + 回滚 + 常驻 | health 200，数据目录正确；LaunchAgent 未挂上 | 未通过 |
| 06 | 先问付不付钱 | 现在不付钱 | 不进 |
| 07 | 同一流程第 2 次 | `macos-bootstrap` 已在 08-15 与 08-16 失败 | 先修根因，再固化 |

## 3. 五轴审查

### 3.1 Correctness

**已对齐（有测试）：**

- 同步不自动加入 Today。`applyGetnoteTaskSnapshot` 只在已有 `todayPlan` 成员上来源日期消失时保留 Today（`todayPreserved`）。`tests/external-task-reconcile.test.mjs` 覆盖。
- 用户 `projectId / priority / tags` 在 fingerprint 一对一对账时保留。同文件 `one-to-one text fingerprint rename` 覆盖。
- 同 note 多项同时改文案不自动合并。`ambiguous same-note text changes` 覆盖。
- `dismissed` / `project_created` 会写入 `externalTaskDecisions`，后续同 `externalId` 被 `suppressed`。`tests/external-task-user-decisions.test.mjs` 覆盖。
- Inbox → Todo 保持同一实体 ID，并切 `dueDateOwner=user`。同测试覆盖。
- 只有来源 `completed=true` 才把 Todo 标完成并移出 Today。本轮缺失不推断完成（实现默证，缺正测）。
- 核心事务先 `updateState`，飞书/ICS 在提交后跑；sink 失败只记 `ok_with_sink_errors`，不回滚。`src/task-sync-domain.mjs` `syncExternalTasks`。
- `private_http` 拒绝公网 host、URL 凭证、query、fragment、redirect。`src/getnote-runtime.mjs` `runtimeBaseUrl`。
- CLI 子进程环境是 allowlist，不含 `AI_PROVIDER_API_KEY` / `JOYCREW_*` / `SESSION_SECRET` / `WORKBENCH_PASSWORD`。`tests/external-cli-env.test.mjs` 覆盖。
- localhost 无密码可启动；公开绑定且无密码时拒绝，除非 `ALLOW_INSECURE_PUBLIC=1`。`src/server.mjs`。

**Required：**

1. **安装失败会先卸掉旧服务，再吞掉恢复失败。**  
   `scripts/macos-launch-agent.mjs` `install()`：先 `bootout()`，再写新 plist 并 `bootstrap()`。`bootstrap` 失败进入 `catch`：再次 `bootout()`，写回旧 plist，然后 `bootstrap().catch(()=>undefined)`。  
   2026-08-16 现场：P0 8 项绿 → bootstrap I/O error → LaunchAgent 消失 → 8080 空窗。  
   `docs/MACOS_ONE_CLICK.md` §8 写「原 LaunchAgent 之前在运行时重新启动」，实现把恢复失败吞掉，与文档不符。  
   测试 `tests/macos-launch-agent-bootstrap.test.mjs` 只断言「不要立即 kickstart」，不覆盖失败回滚。  
   **改法：** 新 plist 校验通过后再 bootout；恢复 bootstrap 失败必须显式报错，不能 `undefined`。回滚成功要以 `launchctl print` + health 为准。

2. **`GET /api/health` 的 `joycrew.available` 恒为 `false`，不能当现场探针。**  
   `src/server.mjs` 健康检查调用 `joycrewClient.status()`，而 `JoycrewClient.status()` 写死 `available:false`。真正探活是 `probe()`，走 `GET /api/joycrew/status`。  
   现网 `enabled=true, available=false` **不能单独证明** `:4000` 已死（这次碰巧端口确实没进程）。Joycrew 离线隔离本身成立：4000 挂了不影响个人台 `health 200`。  
   **改法：** loopback / 已登录的 `/api/health` 改调 `probe()`，或删掉恒假的 `available`。

3. **未跟踪 `CLAUDE.md` 与现行 GetNote 合同相反。**  
   现文件写：`当前 main：4c83764`、`Node 20+`、`getnote notes --since-id`、以及「待办从笔记标题与内容提取（不再调用 note todos）」。  
   现行实现与 `docs/PRODUCT_SPEC.md` / `src/getnote-runtime.mjs` 是 `Node 24+`、`--cursor`、`getnote note todos`。  
   它现在未入库；一旦 `git add .` 会把错误进仓路由推到 GitHub。  
   **改法：** 重写后再跟踪，或删除，不要原样提交。

4. **用户在 Workbench 把 GetNote Todo 标完成后，下次同步若来源仍 active，会被强制翻回未完成。**  
   `applyGetnoteTaskSnapshot()` 对 `effectiveActive` 命中的已有 Todo 无条件写 `done:false`（`src/external-task-reconcile.mjs` 约 167 / 224 行）。`todoByExternalId()` 也不过滤已完成项。  
   `docs/PRODUCT_SPEC.md` 写「Workbench 是个人 Todo 的状态真源」，但同步允许保留的用户字段只列了 `projectId` / priority / tags / Today，完成态没有对等保护。现有测试只覆盖来源 `completed=true` → 本地完成。  
   **改法：** 已有 Todo 且 `done===true` 时，除非来源明确 `completed=true`，不要把 `done` 改回 `false`。补一条 `updateTodo({done:true})` 后再 sync 的行为测试。

5. **noteId / cursor 仍可能先被 `JSON.parse` 收成 Number，再 `String()`，与「不经 JavaScript Number」合同不一致。**  
   `src/getnote-runtime.mjs` `parseJsonText()` 直接 `JSON.parse`。`src/task-cli.mjs` `firstText()` 再 `String(value)`。超过 `Number.MAX_SAFE_INTEGER` 的雪花 ID（如 `1896830231705320746`）会先截断再进 fingerprint。  
   `docs/TASK_SOURCE_PIPELINE.md` / `docs/ARCHITECTURE.md` 要求 note ID 和 cursor 按字符串处理。`tests/task-cli.test.mjs` 只用带引号的字符串字面量，没有覆盖 JSON 数字。  
   **改法：** 解析时把超长整数保留成字符串，并补 `{"note_id": 1896830231705320746}` 回归。

**Optional：**

6. `externalTaskDecisions` 上限 `MAX_DECISIONS=2000`。超出后旧 tombstone 被丢掉，同 `externalId` 可能复活。无测试。个人用量暂可后补。
7. `PRODUCT_SPEC.md` 标题仍是 v1.4 draft；CHANGELOG 停在 2.0.0，PR #28 未入版本记录。`product.mjs` 仍报 `2.0.0`，无法用版本号区分 `09877cc` 与 `c698133`。LaunchAgent 用 `WORKBENCH_BUILD_COMMIT` 补了这一点，文档没有。
8. README / `docs/DEPLOYMENT.md` 只写 `npm start` + `:4173`，官方一键 / LaunchAgent / `:44173` 只活在 `MACOS_ONE_CLICK.md`。
9. `MACOS_ONE_CLICK.md` §4 写「P0 前暂停已有 LaunchAgent」，代码和测试明确禁止预停。
10. 公开文档含本机路径 `/Users/wanghui/AI-Work-OS`；`.env.example` / README 默认 `ws-dongjue` / `user-chris`（不是密钥，但是可关联身份）。
11. memo / project_note 两条终结路径没有独立回归；MCP `external_tasks_sync` 只测确认门，没跑 `confirmed:true` 后的提交/sink。

### 3.2 Readability

- GetNote v2 拆分清楚：`task-cli` 解析、`external-task-reconcile` 对账、`external-task-decisions` tombstone、`task-sync-domain` 事务边界、`external-cli-env` 隔离。
- `src/domain.mjs` 806 行，接近审查阈值；项目创建与 GetNote 决策写在同一文件。继续往里塞会变结构债。
- `hasLocalDueOverride` 的遗留推断注释清楚，测试覆盖了保守保留。

### 3.3 Architecture

- 个人台与 Joycrew 边界在 V2 基线里清楚：两套任务不互相同步；Joycrew 离线不影响个人台启动。`:4000` 无进程时个人台仍可 `health 200`，符合 fail-isolation。`/api/health` 上的 `available=false` 不能单独当探活证据，见 §3.1 #2。
- `--preserve-runtime` **不是**这次停机原因。它只跳过 `JOYCREW_ENABLED=0` 门，并保留 Runtime 键。P0 绿 ≠ 05 完成。
- 并行叙事未收口：本仓仍是日常入口；`projects/joycrew/sdd/merge-personal-app` 已 accepted「终局只留 joycrew」。两仓继续分头演进会分叉。这是产品决策，不是本 PR 的实现 bug。
- `_ops/20260815_personal-ai-workbench-deploy/paw` 是另一份旧检出，不要再当运行源。
- `preserve-runtime` 只改绑定字段，不关 Joycrew / Harness / AI。`macosUpgradeUpdates` + `tests/macos-bootstrap.test.mjs` 覆盖。P0 预检在临时环境里关 Joycrew，与现场保留 Runtime 不冲突。

### 3.4 Security

**Critical（公开仓误提交路径）：**

5. **`data/p0/` 未被 gitignore，且含完整 `.env` 备份。**  
   `scripts/macos-bootstrap.mjs` 把升级前 `.env` 写到 `<DATA_DIR>/p0/env-backups/`。  
   本机 `DATA_DIR` 现指向 Application Support，但仓库里仍有未跟踪的 `data/p0/env-backups/.env-before-bootstrap-*.`。  
   审查当时 `.gitignore` 只忽略 `data/state.json`、`data/config.json`、`data/backups/`，**不忽略 `data/p0/`**。  
   `git add .` 或 `git add data` 会把运行时密钥推进这个公开仓。  
   **本审查提交已把 `data/p0/` 加入 `.gitignore`，且不加入这些文件。**  
   **改法：** 保持忽略；确认远程从未跟踪过该目录。

**Required：**

6. 现网 `authEnabled=false`。绑定 `127.0.0.1` 时产品允许。LaunchAgent 一旦修好，密码门仍是空的。本机单用户可接受，不要把 8080 暴露到非 loopback。

**已对齐：**

- 主应用无第三方运行依赖。
- Capture 收据只存哈希。
- 公开文档合同测试禁止仓库专属飞书 URL（`tests/documentation-contract.test.mjs`）。
- `docs/MACOS_ONE_CLICK.md` 出现本机路径 `/Users/wanghui/AI-Work-OS`，是安装示例，不是密钥。

### 3.5 Performance

- GetNote 有界：最近 N（20–500）+ 未完成旧 note，按 note ID 去重。
- CLI / private_http 有 timeout 与 16MB 上限。
- 未见无界列表或 N+1 新债。
- `harness/` 本机约 343M，属安装产物，不应当作审查对象入库。

## 4. 测试与验证

| 检查 | 结果 |
|---|---|
| `npm run test:files` | 86 files passed, 0 failed（2026-08-16） |
| CI | `ci.yml`：syntax + contract tests + harness e2e + docker smoke（Joycrew 关闭） |
| 现网 health | `ok=true`，`v2.0.0`，workspace=`/Users/wanghui/AI-Work-OS` |
| 现网 AI / Harness | 开启；Harness `read_only` / `idle` |
| 现网 Joycrew | `enabled=true`，`configured=true`；`/api/health.available` 恒假，不能当探针；`:4000` 当时无进程 |
| LaunchAgent | `launchctl print` 找不到服务（exit 113） |
| live GetNote 同步 | 本审查未跑 |

测试缺口：

- 安装器 `bootout → bootstrap 失败 → 恢复也失败` 无回归。
- 用户本地 `done=true` 后来源仍 active：无行为测试。
- JSON 数字字面量 noteId / cursor：无回归。
- 本轮缺失 ≠ 完成：只有实现默证。
- memo / project_note 抑制、MCP sync 执行、metadata 写入失败、ICS 0700 / 失败清 tmp：缺正测。
- `MAX_DECISIONS` 淘汰无测试。
- `CLAUDE.md` 不在 documentation-contract 覆盖里。
- 没有真实 `getnote` / `lark-cli` / Joycrew `:4000` 现场门。

## 5. 文档漂移清单

| 文件 | 过时句 / 状态 | 现行 |
|---|---|---|
| 未跟踪 `CLAUDE.md` | `4c83764`、Node 20+、`--since-id`、不再调用 `note todos` | `c698133`、Node 24+、`--cursor`、`getnote note todos` |
| `docs/PRODUCT_SPEC.md` | 标题 `v1.4 draft` | 内容已含 Task Sync v2；权威顺序在 V2 基线 |
| `CHANGELOG.md` | 止于 2.0.0 / 2026-08-14 | main 此后至少 95 个提交，含 PR #28 |
| `src/product.mjs` | `PRODUCT_VERSION='2.0.0'` | 无法区分本机旧进程 `09877cc` 与现 `c698133` |
| `docs/MACOS_ONE_CLICK.md` §4 | P0 前暂停已有 LaunchAgent | 升级期保持旧服务；测试禁止预停 |
| `docs/MACOS_ONE_CLICK.md` §8 | 失败时恢复旧 LaunchAgent | 恢复 bootstrap 失败被吞掉 |
| `README.md` / `docs/DEPLOYMENT.md` | 只写 `npm start` + `:4173` | 本机正式路径是 `install-macos.command` + LaunchAgent |
| 工作台 `projects/INDEX.md` | 无本项目 | 代码仓已是日常入口 |

## 6. 05 上线缺口

完成线要同时满足：

1. LaunchAgent `state=running`，`WORKBENCH_BUILD_COMMIT` 等于 `git rev-parse HEAD`。
2. `127.0.0.1:<PORT>/api/health` 200，且进程由 launchd 拉起。
3. 失败回滚后旧服务仍在，或明确失败且旧服务被重新拉起（有日志，不吞错）。
4. `data/p0/` 不会进入 git。
5. Joycrew 现场验收另开，不和本次 GetNote v2 绑定。

当前：1/2 不满足（nohup 顶着 8080）；3 已在 08-16 打脸；4 本审查已 ignore `data/p0/`；5 未做。

## 7. 建议顺序

1. `.gitignore` 增加 `data/p0/`（本审查已做），并确认 GitHub 上没有该目录。
2. 修 `install()`：先写新 plist，bootstrap 成功后再认为切换完成；恢复失败要抛错。补测试。**修好之前不要再跑会 bootout 的 install。**
3. 在图形会话 Terminal 重装 LaunchAgent，读回 `launchctl print` + health。现网 nohup 先保住，避免二次空窗。
4. health 与文档对齐：`/api/health` 不要再露出恒假的 `joycrew.available`。
5. 重写或删除未跟踪 `CLAUDE.md`；补 CHANGELOG / SPEC 标题；README/DEPLOYMENT 链到一键安装。
6. GetNote 下一刀（不挡 05）：本地完成不被来源翻回；雪花 ID 不经 `JSON.parse` Number。
7. Chris 拍板：是否建档 `projects/personal-ai-workbench/`；本仓是否继续当唯一入口；Joycrew `:4000` 现在要不要拉。

不要做：06 SEO；在安装第二次失败未根治前再包一层安装器；把 `data/p0`、`.env`、`preview.html` 原样进仓。

## 8. 本提交包含什么

- 本文件。
- `.gitignore` 增加 `data/p0/`，避免公开仓误收 `.env` 备份。这是审查发现的安全门，不是产品功能。

不包含：`CLAUDE.md`、`public/preview.html`、任何 `data/p0/**`、任何运行时配置。
