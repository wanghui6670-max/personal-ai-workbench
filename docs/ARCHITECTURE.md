# 架构说明

## 1. 总体边界

```text
得到大脑             ── 个人笔记与明确 meeting_todos 事实源
GetNoteReader        ── 统一只读读取合同；local_cli / private_http
Workbench state      ── 个人任务、Inbox、Today 选择与本地任务状态真源
本地项目文件夹       ── 真实工作产物
Git                  ── 版本与代码变化证据
飞书每日工作日记     ── 个人任务快照与每日总结 sink
飞书项目文档         ── 项目分析、总结、复盘和恢复叙事真源
本机 ICS             ── 可重建日历镜像
Capture receipts     ── 正文哈希与幂等标识
Recovery receipts    ── 飞书跨资源事务机器凭据
AI Provider          ── 临时分析，不成为资料真源
```

系统不替用户安排今日工作。AI 只能分析、建议和执行用户明确确认的白名单操作。

## 2. 得到大脑外部待办源

### `src/getnote-runtime.mjs`

业务层只依赖统一只读接口：

```text
listNotes
fetchTodos
fetchNote
status
```

`local_cli` 只执行固定 `getnote` 读命令：

```text
getnote notes --limit <20-500> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote note <note_id> -o json
```

`private_http` 只允许 loopback、私网 IP、Docker 内部名称、`host.docker.internal` 或 `.internal/.local` 目标，并使用 32+ 字符 service token。它不接受公网 origin、redirect、任意 URL、任意 argv 或任意命令。

VPS 推荐形态：

```text
VPS 宿主机 getnote CLI
        ↓
只读 GetNote Runtime sidecar
        ↓ private_http
Workbench Docker
```

CLI 登录和凭证因此留在宿主机，不打进 Workbench 镜像。

### `src/task-cli.mjs`

适配器职责：

- 分页读取最近 N 篇笔记，所有 note ID 按字符串处理；
- 额外读取 Workbench 仍未完成 GetNote Todo / Inbox 对应的旧 `sourceNoteId`；
- 两组笔记按 note ID 去重后逐篇执行 `fetchTodos` / `getnote note todos`；
- 只读取 `meeting_todos.source` 和 `meeting_todos.items`；
- 上游没有明确待办章节时接受空列表，不使用模型猜测；
- 如果 item 有 `todo_id / todoId / task_id / taskId / id`，优先用 `noteId + sourceTodoId` 派生稳定外部 ID；
- 没有 source todo ID 时，继续使用历史兼容的 `noteId + 规范化文本 + 同文序号` fingerprint；
- 相对日期锚点固定为 `createdAt → updatedAt → 当前日期 fallback`；
- 显式携带 IANA 时区，默认 `Asia/Shanghai`；
- 对“下周”“稍后”“尽快”等模糊表达返回无日期；
- 设置不能提供任意 shell、二进制路径、命令模板或凭证。

### `src/external-task-reconcile.mjs`

负责来源身份和 Workbench 本地状态对账：

- 新 source todo ID 只在同 note + 同规范化标题唯一匹配时迁移旧 fingerprint 实体；
- fallback 文案变化只在同 note 恰好一旧一新的无歧义场景自动继承；
- 已存在 Todo 更新时保留用户拥有的 `projectId / priority / priorityLabel / tags / createdAt`；
- Todo 与 Inbox 因来源日期出现/消失互相迁移时保留 Workbench 实体 ID 和上述本地字段；
- 已经由用户选入 Today 的 Todo，即使来源日期后来消失，也保留 Todo 与 Today 选择，并以 `sourceDueDate=null` 表示来源计划已撤回；
- 只有来源明确 `completed=true` 才标记完成并移出 Today；
- 某条来源任务本轮没有出现，不据此猜测完成。

### `src/task-sync-domain.mjs`

一次同步的核心事务边界：

```text
读取 GetNote（最近 N + 未完成旧 note）
→ Normalize / Reconcile
→ Workbench state 原子提交
```

只有以上步骤失败，才算核心同步失败。

Workbench 提交成功后才执行派生输出：

```text
Workbench committed
       │
       ├─→ 飞书每日任务快照
       └─→ 私有 ICS 原子重建
```

飞书或 ICS 失败时：

- 不回滚 Workbench；
- 返回各自 sink `status=error`；
- `lastSyncStatus=ok_with_sink_errors`；
- 留下不含任务正文的 sink failure 审计事件；
- 后续可以通过再次显式同步重试。

映射规则：

- 有明确日期的未完成 item → 正式 Todo；
- 无法确定日期的未完成 item → Inbox；
- 新建事项不自动加入 Today；
- 来源同步不替用户排优先级或修改项目归属；
- `completed=true` → 已有 Todo 完成并退出 Today；
- 不反向修改得到大脑；
- 启用新管线时清除旧 `config.dataSource.provider=feishu_doc` 个人收件箱主来源。

### 错误来源迁移

若历史配置包含 `provider=dida_cli` 或 `cliFlavor`，规范化层会将集成停用并标记为需要重新配置。用户明确保存得到大脑配置后，领域层只移除 `source=dida_cli` 的机器导入 Todo 和 Inbox，不触碰手工、Capture、项目或其他来源数据。

## 3. 飞书每日工作日记 sink

### `src/feishu-daily-journal.mjs`

飞书日记是**可选派生 sink**，不是启用 GetNote Task Sync 的前置条件。未配置 URL 时，核心同步仍可成功，返回 `journal.status=not_configured`。

固定章节：

```text
每日工作日记
```

固定记录：

```text
[WORKBENCH_DAILY_TODOS]
[WORKBENCH_DAILY_SUMMARY]
[WORKBENCH_OP:<operationId>]
```

流程：

```text
fetch
→ operationId 查重
→ block_insert_after
→ fetch readback
→ 唯一 operationId / block 校验
```

- 同 ID + 同正文安全重放；
- 同 ID + 不同正文返回冲突；
- 写后读回正文必须一致；
- 任务快照和每日总结正文只保存飞书，不进入本地 activity；
- 每日总结只能由用户明确触发；
- 每日总结要求已经配置飞书日记 URL，但这不影响 GetNote → Workbench 核心同步。

`src/feishu.mjs` 中旧的“飞书收件箱来源 client”仅作为历史 REST/Capture 兼容实现保留，不再进入 AI/MCP 个人待办白名单。项目记录 client 继续承担项目分析与总结。

## 4. 本机日历

### `src/local-calendar.mjs`

固定文件：

```text
<data-dir>/calendar/personal-ai-workbench.ics
```

- 目录 `0700`，文件 `0600`；
- 临时文件 + 原子 rename；
- 失败清理临时文件；
- UID 由稳定外部待办 ID 的 SHA-256 派生；
- 未完成 + dueDate 才进入日历；
- 全天事项使用 `VALUE=DATE`；
- 无 offset 的明确本地时刻使用任务 `TZID`，不依赖 VPS 系统时区；
- 已带 offset 的时刻可规范化为 UTC；
- 只有明确截止时刻时生成只含 `DTSTART` 的瞬时事件，不猜持续时间；
- 不猜测日期、时长或优先级；
- 完成任务在下一次完整重写时退出日历；
- DESCRIPTION 保留来源笔记 ID、标题、链接和时区。

ICS 是可重建镜像，不属于 backup 真源，也不代表系统日历客户端已经导入成功。ICS 写失败不回滚 Workbench 任务提交。

## 5. HTTP 服务与前端

### `src/server.mjs`

- Node HTTP 与静态资源；
- Host / Origin / Content-Type 边界；
- Cookie 登录、Capture Bearer token、限流；
- REST、AI plan/execute 和 MCP-compatible JSON-RPC；
- API 错误脱敏。

外部待办主路径通过 MCP 工具调用，不新增任意 shell REST 接口。

### `public/getnote-integration.js`

- 在设置页展示最近笔记扫描数量、任务 IANA 时区、可选飞书工作日记 URL、ICS 开关与名称；
- 接管旧“同步飞书”按钮，显示“同步得到大脑待办”；
- 状态区分别展示核心同步、飞书 sink 和 ICS sink；
- 提供“沉淀今日总结”；未配置飞书日记时只阻止该动作，不阻止任务同步；
- 用户点击是写操作确认；
- 对历史错误来源配置显示“需要重新配置”，不把它误显示为已启用；
- 不把任务或日记正文写入 `localStorage`、`sessionStorage` 或 IndexedDB。

### `public/getnote-integration.css`

只提供集成设置、来源状态和操作回执样式，不定义业务状态。

## 6. MCP 控制面

### `src/mcp/external-task-tools.mjs`

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个工具需要确认，写操作共享一把 mutation lease。

### `src/mcp/registry.mjs`

- 合并工作台、项目记录和外部任务工具；
- 本地 schema 校验；
- 写工具确认门；
- 规划后和执行后重新读取状态；
- 旧 `feishu_inbox_sync` 从工具列表移除；
- “同步得到大脑待办”“从 Get笔记 拉取待办”“沉淀今日总结”由确定性 planner 安全映射；
- Provider 失败时回退本地 planner。

## 7. 项目领域

### `src/domain.mjs`

唯一项目生产领域入口：

- identity-only 项目创建和归类；
- 项目基准、飞书链接、完成和归档；
- 项目证据扫描和主动同步；
- 项目飞书记录读取与阶段总结；
- 机器进度和飞书指针提交；
- stale、busy 和跨资源部分提交错误。

### 项目数据边界

`PROJECT.md` 只保存项目身份和入口。

本地机器进度只允许：

```text
percent
status
hasBlocker
lastActivity
syncedAt
confidence
feishuRevisionId
feishuRecordBlockId
feishuRecordedAt
feishuOperationId
```

项目分析、卡点、恢复摘要、阶段总结和复盘正文只保存到绑定的飞书项目文档。

## 8. Capture

### `src/capture-contract.mjs`

每条采集使用 `captureId`：

- 同 ID + 同正文安全重放；
- 同 ID + 不同正文返回 `CAPTURE_ID_CONFLICT`；
- 可靠网络重试复用同一个 ID。

### `src/capture-domain.mjs`

```text
验证 captureId / 计算正文哈希
→ 查询本地收据
→ 可选兼容飞书 marker 查重/写入
→ 提交 Workbench 收件箱
→ 写哈希收据
```

Capture 是独立快速采集入口，不是得到大脑主来源，不自动成为正式待办或加入今日。

## 9. Store、backup v2 和恢复

### `src/store.mjs`

- `state.json` / `config.json` 原子写入；
- 私有目录和文件权限；
- 写队列、每日备份、手工备份、恢复和回滚；
- Capture 幂等收据和项目飞书恢复凭据；
- backup v2 与旧备份兼容。

### `src/receipt-backup.mjs`

backup v2：

```json
{
  "backupVersion": 2,
  "state": {},
  "config": {},
  "captureReceipts": [],
  "projectRecordReceipts": []
}
```

- `captureReceipts`：Capture ID、正文 SHA-256、Inbox ID、飞书 block ID 和时间；
- `projectRecordReceipts`：operationId、项目 ID、飞书指针、机器进度和事务阶段；
- 不接受 Capture 正文、项目分析正文或任意未知字段；
- ICS 不进入备份真源。

旧备份没有 `captureReceipts` 或 `projectRecordReceipts` 字段时，保留当前凭据目录。

恢复使用 staging/rename 成组替换。**恢复任一阶段失败时，恢复器尝试回滚所有已经修改的 state、config 和凭据目录。**

## 10. doctor

`scripts/doctor.mjs` 检查：

- Node、Git；
- 数据目录、工作区和业务板块；
- 得到大脑外部任务管线配置；
- `GETNOTE_RUNTIME_MODE=local_cli` 时运行 `getnote doctor -o json`；
- `GETNOTE_RUNTIME_MODE=private_http` 时通过统一 Reader 对 sidecar 做只读鉴权/连通性检查，不要求 Workbench 容器内存在 getnote CLI；
- 只有配置飞书每日工作日记 sink 时才要求 `lark-cli`；
- ICS 路径；
- AI 配置与访问密码。

外部管线启用后，GetNote 读取运行时不可用使 doctor 失败；飞书未配置时缺少 `lark-cli` 不影响核心同步 readiness。doctor 不执行得到大脑写入、飞书写入或系统日历导入。

## 11. 测试边界

合同测试使用 fake CLI / fake GetNote Runtime、fake Feishu client、fake Provider 和临时数据目录，覆盖：

- 固定 `getnote` 命令、Reader transport 边界、分页和字符串 note ID；
- 最近 N 篇 + 未完成旧 note 追踪；
- `meeting_todos.source/items` 与空待办列表；
- source todo ID 优先、legacy fallback ID 兼容和保守身份迁移；
- `createdAt` 相对日期锚点与显式 IANA 时区；
- Todo/Inbox 跨状态时的 Workbench 实体 ID、项目、优先级、tags 和 Today 所有权；
- Workbench-first 事务顺序与飞书/ICS sink fail-isolation；
- 飞书 operationId 重放/冲突；
- ICS 全天、TZID 定时、瞬时事件、权限和原子写；
- MCP 确认门和旧工具退休；
- browser 静态合同；
- doctor 的 local_cli / private_http 与可选飞书依赖；
- 项目、Capture、backup v2 和恢复原有合同。

测试不等同于 live 得到大脑、飞书、系统日历、OpenAI、浏览器、iPhone 或生产部署验证。
