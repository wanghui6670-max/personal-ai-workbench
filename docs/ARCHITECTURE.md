# 架构说明

## 1. 设计目标

Personal AI Workbench 是本地优先的个人项目控制层：

```text
本地项目文件夹  ── 真实工作产物
Git              ── 版本与代码变化证据
Workbench state  ── 最小机器状态、任务、确认和指针
飞书每日工作日记  ── 收件箱外部来源
飞书项目文档      ── 项目分析、总结、复盘和恢复叙事唯一真源
AI Provider       ── 临时分析，不成为资料真源
```

系统不替用户安排今日工作；AI 只能分析、建议和执行用户明确确认的白名单操作。

## 2. 运行组件

### `src/server.mjs`

- Node HTTP 服务和静态资源；
- Host / Origin / Content-Type 请求边界；
- Cookie 登录、Capture Bearer token、限流；
- REST、AI plan/execute 和 MCP-compatible JSON-RPC transport；
- API 响应错误脱敏。

### `src/store.mjs`

- `state.json` / `config.json` 原子写入；
- 私有目录和文件权限；
- 写队列、每日备份、手工备份、恢复和回滚；
- 旧项目叙事不可覆盖快照；
- 飞书跨资源事务恢复凭据；
- 读取时派生未解决恢复凭据的待确认提示。

### `src/domain.mjs`

唯一生产领域入口。它显式复用 `domain-core.mjs` 中仍符合现有产品规则的收件箱、待办、今日、业务板块和早晨对话功能，但不重新导出旧项目同步、项目更新或旧 `PROJECT.md` 写入路径。

负责：

- identity-only 项目创建和归类；
- 项目基准、飞书链接、完成和归档更新；
- 项目同步事务；
- 飞书项目记录读取和阶段总结；
- 机器进度和记录指针提交；
- stale、busy 和跨资源部分提交错误语义。

### `src/projects.mjs`

负责本地证据扫描、Git 元数据和目录路径安全。项目新建/归类不再调用其中的旧叙事 writer；新路径由 `src/project-directory.mjs` 和 `src/project-identity.mjs` 建立。

### `src/project-directory.mjs`

- 创建项目目录和四个标准子目录；
- 第一次落盘即写 identity-only `PROJECT.md`；
- 独占项目目录，拒绝覆盖已有目录；
- 失败时只回滚本次创建且尚未被修改的文件和目录。

### `src/project-identity.mjs`

- 生成项目身份证受管区块；
- 保留 `PROJECT.md` 中的用户自定义正文；
- 校验受管区块数量、Project ID、symlink 和 hardlink；
- 支持 dry-run、可重入迁移和不可覆盖原文件备份。

### `src/project-record-contract.mjs`

集中定义：

- 官方飞书/Lark 文档 URL allowlist；
- 固定章节和记录前缀；
- 记录长度和分页上限；
- operationId 生成和标记；
- 飞书指针清除规则。

### `src/feishu.mjs`

两个独立 client：

1. **每日工作日记收件箱 client**
   - 只读取“收件箱”一级章节的 `[INBOX]`；
   - 按 block ID 去重；
   - 写入后按新增 block-ID 差集读回。

2. **项目记录 client**
   - 只操作“项目分析与总结”章节；
   - 只识别 `[WORKBENCH_ANALYSIS]` / `[WORKBENCH_SUMMARY]`；
   - operationId 查重；
   - 写入后读回唯一 operationId/block；
   - 同一操作安全重放，不重复追加。

两者通过本机 `lark-cli` 和当前用户身份访问飞书，不在 state 中保存飞书凭证。

### `src/project-sync-coordinator.mjs`

领域层唯一同步协调器：

- 单项目 lease；
- 全项目 lease；
- REST、AI execute 和 MCP 工具全部复用；
- 返回 `PROJECT_SYNC_BUSY`，而不是让多个入口重复写飞书。

### `src/mcp/*`

- `tools.mjs`：工作台实体工具；
- `project-record-tools.mjs`：飞书项目记录工具；
- `registry.mjs`：白名单、schema、确认门、执行和状态读回。

模型只能提出工具名和参数，不能直接执行任意代码或访问任意 URL。

### `public/project-records.js`

项目页的临时飞书记忆面板：

- 通过 `/api/mcp` 调用 `project_records_read`；
- 最新记录优先和 cursor 分页；
- 使用 DOM `textContent` 渲染远端正文；
- 不使用 `localStorage`、`sessionStorage`、IndexedDB 或 cookie 保存叙事；
- 只允许打开通过官方 host 校验的项目文档。

## 3. 持久化模型

### 项目机器进度

```json
{
  "percent": 52,
  "status": "进行中",
  "hasBlocker": true,
  "lastActivity": "2026-08-13T01:00:00.000Z",
  "syncedAt": "2026-08-13T02:00:00.000Z",
  "confidence": 0.78,
  "feishuRevisionId": "12",
  "feishuRecordBlockId": "block_12",
  "feishuRecordedAt": "2026-08-13T02:00:00.000Z",
  "feishuOperationId": "pa_..."
}
```

持久化校验器拒绝 `summary`、`resume`、`blocker` 和任意未知 progress 字段。

### Activity

Activity 只保存不含项目分析正文的动作，例如：

```text
项目进度已同步
阶段总结已保存到飞书
项目链接已更新
```

### Recovery receipt

```text
data/recovery/project-record-<operationId>.json
```

只保存 operationId、项目 ID、文档和 block 指针、机器进度、快照哈希及事务阶段，不含项目分析或总结正文。

## 4. 项目同步时序

```text
用户明确点击同步 / 确认 MCP 工具
        │
        ▼
领域层获得统一 sync lease
        │
        ▼
读取本地文件、Git 和本地规则
        │
        ▼
可选 AI Provider 临时分析
        │
        ▼
stale-before-remote 检查
        │
        ▼
生成稳定 operationId + 写 recovery receipt
        │
        ▼
飞书查重 / 写入 / block-ID 读回
        │
        ▼
更新 receipt 为 remote_saved_local_pending
        │
        ▼
第二次项目快照检查 + 提交 machine progress
        │
        ▼
删除 receipt + best-effort 更新 PROJECT.md 身份索引
```

同步响应不返回项目分析正文。正文通过 `project_records_read` 从飞书读取。

## 5. 失败语义

### `PROJECT_SYNC_STALE`

远端写入前项目或路径基准变化。没有新增飞书记录，用户需要重新手动同步。

### `PROJECT_SYNC_BUSY`

另一条 REST、AI 或 MCP 同步已经持有 lease。不得并发自动重试。

### `remote_outcome_unknown`

飞书调用报错，无法确定远端是否已经落盘。receipt 保留，待确认持续显示；下一次同步使用同一 operationId 先查重。

### `PROJECT_RECORD_REMOTE_SAVED_LOCAL_PENDING`

飞书已经读回确认，但本地状态提交失败或项目随后变更。receipt 保存 block pointer；下一次同步安全重放。

## 6. 旧数据迁移

第一次启动：

1. 读取原始 `state.json`；
2. 检测旧 `progress.summary/resume/blocker` 和旧同步日志；
3. 在任何覆盖前写 `data/migrations/pre-narrative-v1-startup.json`；
4. 本地 state 归一化为 machine-only；
5. 创建 `legacy_project_narrative_pending` 待确认。

显式迁移：

```bash
npm run migrate:project-records
npm run migrate:project-records -- --apply
```

- dry-run 默认；
- 已绑定飞书的项目按稳定 operationId 写迁移记录；
- 未绑定飞书的项目保持待确认；
- 旧 `PROJECT.md` 先备份为 `.pre-feishu-v1.bak`；
- 迁移报告保存在 `data/migrations/`；
- 重复执行不重复写远端。

## 7. AI Provider 边界

Provider 接收稳定 developer instructions 和不可信 user input。所有业务工作流返回统一结构化合同，并在本机再次校验。

默认不发送文件正文；只有显式 `AI_SEND_FILE_CONTENT=1` 才允许受支持正文出站。凭证脱敏是 guardrail，不是完整 DLP。

Provider 配置存在、doctor 通过或合同测试成功，不等于 live endpoint 可达。

## 8. 安全边界

- 默认只监听 loopback；公开绑定要求密码或明确不安全开关；
- 启用密码时 SESSION_SECRET 必须是非示例长随机值；
- 所有 mutation 要求 JSON 和可信 Origin；
- Capture 需要专用 Bearer token 或有效会话；
- 工作区、业务目录、项目目录和 `PROJECT.md` 拒绝 symlink/hardlink/path traversal；
- Git 调用禁用 hooks、fsmonitor、系统/全局配置和交互提示；
- Provider endpoint、飞书文档 URL、MCP 工具和参数均为白名单合同。

## 9. 备份与灾备

每日和手工备份包含 state/config，不包含真实项目工作区和飞书正文。迁移快照和恢复凭据位于同一数据目录，因此仍需操作系统级或异地备份，才能构成完整灾备。

## 10. 验证边界

CI 在无真实凭证环境运行：

- Node 24 语法检查；
- AI、业务、文件系统、飞书 fake client、迁移、恢复、MCP 和浏览器静态合同测试。

CI 通过不等于已完成 live OpenAI、飞书、浏览器、iPhone 或生产部署验证。
