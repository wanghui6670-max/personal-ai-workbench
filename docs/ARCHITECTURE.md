# 架构说明

## 设计目标

工作台负责“控制和最小机器状态”，文件系统负责“真实工作产物”，Git 负责“版本证据”，飞书项目云文档负责“项目分析、阶段总结、复盘与长期叙事记忆”，其他 AI 工具负责“具体生产工作”。

核心数据边界：

```text
本地项目文件夹  ── 真实工作产物
Git              ── 版本与代码变化证据
Workbench state  ── 最小机器状态、确认、任务、指针
飞书项目文档      ── 项目分析/总结/复盘正文唯一真源
```

任何项目分析正文、卡点说明、上下文恢复摘要、阶段总结和复盘正文都不得复制进 `state.json`、`PROJECT.md` 或 activity 日志。

## AI-native 双面板

桌面端固定为“左人右 AI”：左侧保留导航、收件箱、项目、待办、今日、日志和缓冲区，右侧固定 AI 工作区。右侧不是独立聊天页面，而是统一工具控制面板：自然语言先交给已配置的当前模型，以 `ai_console` 结构化工作流提出一个白名单 MCP 工具调用或澄清问题；模型不执行工具。若模型未配置或输出不合约，则回退本地确定性规划器。界面显示工具、参数和影响范围；涉及写入时等待用户确认；调用白名单工具后重新读取并派生 `/api/state`，左侧立即收敛到持久化结果。

`src/mcp/tools.mjs` 提供原有工作台工具，`src/mcp/project-record-tools.mjs` 提供飞书项目记录工具，`src/mcp/registry.mjs` 合并白名单并同时服务浏览器控制台和 `/api/mcp` JSON-RPC transport。

新增项目叙事工具：

- `project_records_read`：只读，直接从项目绑定的飞书云文档读取分析和总结；不做本地正文缓存。
- `project_summary_append`：写入，必须用户确认，只向当前项目绑定的飞书文档追加阶段总结。

工具不接受任意飞书 URL、shell、任意文件系统路径或凭证。项目文档地址只能来自 `project.feishu`。

```text
人的左侧面板  <── /api/state 读回 ── 领域层 / state.json
      ↑                                  ↑
      └── AI 工具调用预览 → 确认门 → MCP 工具注册表
                                             │
                                             └── 受限飞书项目记录适配层
```

## 数据边界

### Workbench 本地状态

可以保存：

- 项目 ID、名称、业务归属、计划日期；
- 本地路径、Git URL、飞书项目文档 URL；
- `percent`、`status`、`hasBlocker`、`lastActivity`、`syncedAt`、`confidence`；
- 最近成功写入飞书的 revision/block/recordedAt 指针；
- 待办、今日计划、待确认和机器审计日志。

不得保存：

- 项目分析正文；
- 卡点正文；
- 上下文恢复摘要；
- 阶段总结/复盘正文；
- Provider 原始响应或隐藏推理。

`src/store.mjs` 在读写归一化时会把旧版 `progress.summary/resume/blocker` 迁移掉，只保留机器字段。旧 `project_synced` activity 中的正文也会被归一化为不含分析内容的审计事件。

### 本地项目文件夹

保存原始资料、工作过程、最终交付和归档。`PROJECT.md` 仍存在，但只作为项目身份证：Project ID、业务、介绍、日期、Git、飞书文档链接以及“分析与总结真源：飞书云文档”声明。

`PROJECT.md` 不再保存进度说明、卡点、恢复摘要或总结正文。

### Git

用于代码/版本变化证据和仓库入口。Git 元数据可以参与项目进度判断，但 Git 不是项目叙事记录真源。

### 飞书每日工作日记

继续只承担收件箱外部真源。只读取一级“收件箱”章节下 `[INBOX]` 条目。本地 state 只保存收件箱缓存与同步状态。

### 飞书项目文档

每个项目通过 `project.feishu` 最多绑定一个项目文档。工作台只操作固定一级章节：

```text
# 项目分析与总结
```

只识别两类工作台记录：

```text
[WORKBENCH_ANALYSIS] ...
[WORKBENCH_SUMMARY] ...
```

其他飞书正文不会被解释为机器状态。

## 飞书收件箱同步

工作台通过本机已登录的 `lark-cli` 使用飞书用户身份访问文档。同步流程：读取文档全文 → 定位一级标题“收件箱” → 只解析 `[INBOX]` 块 → 按稳定 block ID 去重 → 更新本地缓存。

新增收件箱采用：

```text
fetch before IDs
→ block_insert_after
→ fetch readback
→ 用新增 block ID 差集唯一确认
→ 本地提交缓存
```

飞书权限、lark-cli、网络或读回失败时，服务返回可见错误，不把本地写入误报为外部已保存。

## 飞书项目记录适配层

`src/feishu.mjs` 同时提供收件箱 client 和项目记录 client，但两者拥有不同固定合同。

项目记录 client：

1. 读取绑定项目文档；
2. 找到 `项目分析与总结` 一级章节；
3. 若不存在，使用文档末尾的安全 block 作为锚点创建该章节；
4. 只追加 `[WORKBENCH_ANALYSIS]` 或 `[WORKBENCH_SUMMARY]`；
5. 写入后重新读取；
6. 通过写入前后 block-ID 差集唯一确认新增记录；
7. 只把 revision/block pointer 返回给领域层。

项目记录 client 不接受任意章节名、不接受任意 Provider URL，也不把整篇项目文档复制进 Workbench state。

## 项目进度同步

项目进度不是持续后台监控，而是按需同步。

```text
用户主动同步
→ 读取本地文件/Git 证据
→ 本地 fallback + 可选 AI 判断
→ 得到临时 narrative decision
→ 检查项目快照是否仍有效
→ 若已绑定 project.feishu：先写飞书分析 + 读回确认
→ 本地只提交 machine progress + 飞书 pointer
→ 把 PROJECT.md 收敛为 identity-only
```

机器进度字段：

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
```

人类叙事字段 `summary/resume/blocker` 只存在于本次分析内存和飞书记录中，不进入持久化状态。

### 未绑定飞书项目文档

系统允许继续计算并保存机器进度，但不保存分析正文，并增加 `project_feishu_missing` 待确认。这样不会因为飞书尚未绑定而丢失驾驶舱排序能力，也不会退回本地第二份分析记录。

### 本地目录不可用

不重建目录、不把旧百分比清零。保留最后已知机器进度，置信度降到低值，`hasBlocker=true`，进入待确认。

### 并发与 remote-first 边界

在远端写入之前，服务先比较分析开始时的项目快照。如果已过期，直接返回 `409 PROJECT_SYNC_STALE`，不写飞书。

飞书写入和读回之后，本地提交前再次比较项目快照。如果这段很短的远端 I/O 窗口里用户改变了项目状态，本地旧分析仍被拒绝。此时刚追加的飞书记录作为带时间戳的历史分析保留，不会覆盖 Workbench 新状态；用户可重新同步获得新的正式指针。系统不宣称飞书和本地 JSON 之间存在跨系统原子事务。

## 项目阶段总结

阶段总结不是本地 note。`project_summary_append` 只把用户确认的正文写入绑定的飞书项目文档，并在本地留下不含正文的机器审计事件，例如“阶段总结已保存到飞书项目文档”。

读取阶段总结使用 `project_records_read`，直接读飞书，不复制正文到 state。

## UI 兼容层

现有 UI 仍需要 `progress.summary/resume/blocker` 形状。`deriveState()` 只在响应时生成固定提示文案，例如：

- “机器进度已同步；项目分析正文保存在飞书项目文档。”
- “存在卡点，详情见飞书项目文档。”
- “上下文恢复摘要请从飞书项目文档读取。”

这些是静态 UI 提示，不是项目分析内容，也不会写入 state。

## AI 判断工作流

项目创建、项目进度、早晨对话和 AI 控制平面继续共用受控判断链：

1. **证据**：引用本次输入中可核对的项目、文件、Git、待办或活动证据；
2. **冲突与缺口**：显式标注矛盾或不足；
3. **最终结论**：输出业务所需结构化字段，接受本机 schema 和业务不变量校验。

分析信封不请求模型披露内部思维链。Provider 超时、拒绝、不可达或结果校验失败时，调用方使用本地规则继续；默认不把同一数据自动发送到另一云 Provider。

## AI Provider 与出站隐私边界

- 未配置可用 Profile 时使用本地回退规则，不发起外部 AI 请求。
- Provider 注册表仅允许已注册 Profile；普通业务请求不能传任意 URL、method、path、header 或凭证。
- 公网 endpoint 必须 HTTPS；loopback 匿名调用只允许显式 `local_loopback`。
- 默认 `openai_luna` 保持 `gpt-5.6-luna`、`xhigh`、strict JSON Schema、`store:false` 和有界超时。
- 项目进度默认只发送项目/文件/Git 元数据和本地 fallback；`AI_SEND_FILE_CONTENT=1` 才允许正文出站。
- 固定业务规则与不受信数据保持角色分离；所有 Provider 结果仍须本机校验。
- 云到云自动 fallback 默认关闭。

飞书项目文档本身不会因为启用了 AI Provider 自动整篇出站。若未来让模型读取飞书项目历史作为分析上下文，必须单独定义最小读取范围、敏感内容边界和出站授权，不得默认把整篇飞书文档发送给 Provider。

## 决策权

系统没有自动排期路径。`todayPlan` 只能通过用户显式动作写入。项目阶段总结的写入同样需要用户确认。AI 可以建议读取或追加飞书项目记录，但不能跳过 MCP 确认门。

## 持久化

这是单用户、单进程系统，使用原子 JSON 写入而不是数据库。写入通过进程内队列串行化；每天首次修改状态或配置前保存快照。

JSON、项目文件系统和飞书是不同事务资源。系统只提供各资源内的安全写入和读回确认，不宣称跨资源崩溃原子性。

## Readiness 边界

`GET /api/health` 是文件系统与配置 readiness 信号，不证明 AI Provider、飞书、浏览器或真实设备已完成端到端验证。项目飞书记录功能的真实可用性仍依赖本机 `lark-cli` 登录、目标文档权限和网络。
