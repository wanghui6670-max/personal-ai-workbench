# 架构说明

## 1. 总体边界

```text
滴答清单账户       ── 个人待办事实源
固定 ticktick CLI ── 单向任务读取适配器
本地项目文件夹     ── 真实工作产物
Git                ── 版本与代码变化证据
Workbench state    ── 最小机器状态、任务、确认和指针
飞书每日工作日记   ── 个人任务快照与每日总结 sink
飞书项目文档       ── 项目分析、总结、复盘和恢复叙事真源
本机 ICS           ── 可重建日历镜像
Capture receipts   ── 正文哈希与幂等标识
Recovery receipts  ── 飞书跨资源事务机器凭据
AI Provider         ── 临时分析，不成为资料真源
```

系统不替用户安排今日工作。AI 只能分析、建议和执行用户明确确认的白名单操作。

## 2. 外部待办源

### `src/task-cli.mjs`

- 只执行固定 `ticktick` 二进制；
- 国际版设置 `TICKTICK_HOST=ticktick.com`；
- 国内版设置 `TICKTICK_HOST=dida365.com`；
- 命令固定为 `sync --json`、`tasks list --json`、`tasks completed --json`；
- 从受限 JSON envelope 提取任务数组；
- 归一化外部 ID、标题、截止日期、时段、全天、时区、完成状态、优先级和标签；
- 已完成列表不可用时继续导入 active tasks，但不根据缺失推断完成；
- 设置不能提供任意 shell、二进制路径或命令模板。

### `src/task-sync-domain.mjs`

负责外部任务领域事务：

```text
CLI 完整读取
→ 生成实际飞书快照正文和稳定 operationId
→ 飞书任务快照写入并读回
→ 本机 ICS 原子替换
→ Workbench 待办/收件箱状态提交
→ 不含正文的审计事件
```

映射规则：

- 有截止日期的 active task → 正式待办；
- 无截止日期的 active task → `source=dida_cli` 收件箱；
- 明确完成 → 待办完成、退出今日；
- 外部 task ID 去重，不按标题去重；
- 不自动加入今日；
- 不反向修改滴答任务；
- 启用新管线时清除旧 `config.dataSource.provider=feishu_doc`。

## 3. 飞书每日工作日记 sink

### `src/feishu-daily-journal.mjs`

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
- 每日总结只能由用户明确触发。

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
- UID 由外部 task ID 的 SHA-256 派生；
- active + dueDate 才进入日历；
- 非全天且具有完整开始/结束时间时生成 UTC 定时事件；
- 全天任务或缺少完整时段时生成全天事件；
- 不猜测日期、时长或优先级；
- 完成任务在下一次完整重写时退出日历。

ICS 是可重建镜像，不属于 backup 真源，也不代表系统日历客户端已经导入成功。

## 5. HTTP 服务与前端

### `src/server.mjs`

- Node HTTP 与静态资源；
- Host / Origin / Content-Type 边界；
- Cookie 登录、Capture Bearer token、限流；
- REST、AI plan/execute 和 MCP-compatible JSON-RPC；
- API 错误脱敏。

外部待办主路径通过 MCP 工具调用，不新增任意 shell REST 接口。

### `public/dida-integration.js`

- 在设置页展示账户区域、飞书工作日记 URL、ICS 开关与名称；
- 接管旧“同步飞书”按钮，显示“同步滴答待办”；
- 提供“沉淀今日总结”；
- 用户点击是写操作确认；
- 不把任务或日记正文写入 `localStorage`、`sessionStorage` 或 IndexedDB。

### `public/dida-integration.css`

只提供集成设置、来源状态和操作回执样式，不定义业务状态。

## 6. MCP 控制面

### `src/mcp/external-task-tools.mjs`

```text
external_task_integration_read
external_task_integration_update
external_tasks_sync
daily_summary_publish
```

后三个工具需要确认。

### `src/mcp/registry.mjs`

- 合并工作台、项目记录和外部任务工具；
- 本地 schema 校验；
- 写工具确认门；
- 规划后和执行后重新读取状态；
- 旧 `feishu_inbox_sync` 从工具列表移除；
- “同步滴答待办”“沉淀今日总结”由确定性 planner 安全映射；
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

Capture 是独立快速采集入口，不是滴答主任务源，不自动成为正式待办或加入今日。

## 9. Store、备份和恢复

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
- 外部任务管线配置；
- `ticktick` 与账户区域；
- `lark-cli`；
- ICS 路径；
- AI 配置与访问密码。

外部管线启用后，缺少 `ticktick` 或 `lark-cli` 使 doctor 失败。doctor 不执行 live 同步或写入。

## 11. 测试边界

合同测试使用 fake CLI、fake Feishu client、fake Provider 和临时数据目录，覆盖：

- CLI allowlist 与账户区域；
- 外部任务映射和真实 JsonStore；
- 飞书 operationId 重放/冲突；
- ICS 全天/定时事件、权限和原子写；
- MCP 确认门和旧工具退休；
- browser 静态合同；
- doctor 缺少依赖；
- 项目、Capture、备份和恢复原有合同。

测试不等同于 live TickTick/Dida365、飞书、系统日历、OpenAI、浏览器、iPhone 或生产部署验证。
