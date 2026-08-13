# 架构说明

## 设计目标

工作台负责“状态和上下文”，文件系统负责“真实资料”，其他 AI 工具负责“具体生产工作”。

## 数据边界

- 工作台：项目元数据、待办、今日安排、收件箱、待确认、日志、路径。
- 本地文件夹：原始资料、工作过程、最终交付、归档。
- Git：代码/版本变化证据和仓库入口。
- 飞书每日工作日记：收件箱的外部真实来源；只读取“收件箱”一级章节下 `[INBOX]` 条目，本地 state 只保存缓存和同步游标，不把整篇日记复制进工作台。

## 飞书收件箱同步

工作台通过本机已登录的 `lark-cli` 使用飞书用户身份访问文档。同步流程是：读取文档全文（`docs +fetch --api-version v2 --detail with-ids`）→定位一级标题“收件箱”→只解析该章节下以 `[INBOX]` 开头的块→按稳定 block ID 去重→更新本地缓存。文档其他日期日记、明确决定和待确认内容不会进入收件箱。

新增收件箱时先用 `block_insert_after` 写入“收件箱”章节末尾，再立即读回全文并寻找新 block；只有读回成功才提交本地状态。飞书权限、lark-cli、网络或读回失败时，服务返回可见错误，不把本地写入误报为外部已保存。

同步是用户主动点击动作，不会创建待办、不改变截止日期、不加入 `todayPlan`。从飞书删除的未处理条目会从本地缓存移除并记录日志。

## 项目进度

项目进度不是持续后台监控，而是按需同步：

1. 用户点击同步。
2. 服务在本机读取项目目录文件列表、mtime 和可读文本片段；扫描受文件数、目录数、深度和总时长预算约束。
3. 若为 Git 仓库，读取最近 commit、remote、working tree 是否有变化。
4. 本地规则生成一个 fallback 判断。
5. 若启用 AI Provider，三类工作流只调用统一的供应商无关合同。默认 Profile `openai_luna` 仍以 `gpt-5.6-luna` 和固定极高推理档位 `xhigh` 调用 OpenAI Responses API；经部署管理员显式配置后，也可以使用受限的 Responses-compatible 或 Chat-Completions-compatible Profile。默认只发送项目、文件、Git 和本地规则元数据，不发送 `PROJECT.md` 或可读文件正文。
6. 任一 Provider 都必须按“证据 → 冲突与缺口 → 最终结论”返回同一结构化信封；Adapter 只负责协议映射，本机再次校验完整性后只把业务结论交给调用方。
7. AI 置信度过低、证据冲突/不足或目录扫描达到任一安全预算 → 降为低置信度并进入待确认。
8. 写入项目进度缓存并更新 `PROJECT.md`。

## AI 判断工作流

项目创建、项目进度和早晨对话共用同一条受控判断链：

1. **证据**：引用本次输入中可核对的项目、文件、Git、待办或活动证据，不把模型常识当成业务事实。
2. **冲突与缺口**：显式标注相互矛盾或不足以支撑判断的信息；证据不足时降低置信度或回退。
3. **最终结论**：只输出业务需要的结构化字段，并继续接受本机 schema、范围、长度和候选 ID 校验。

分析信封只提供简短、可审计的依据，不请求模型披露内部思维链；该信封仅用于本次本机校验，持久化时只保存业务结论，依据草稿、Provider 原始响应和隐藏推理都不会写入 `state.json`、活动日志或 `PROJECT.md`。固定 `xhigh` 会增加响应时间和调用成本。任一 Provider 请求超时、拒绝、不可达、返回不完整或不通过本机校验时，调用方使用现有本地规则继续工作；默认不把同一数据静默转发给另一个云 Provider。

AI Provider 分析可能持续较长时间。提交结果前，服务会比较分析开始时的项目完整快照和项目路径；如果期间用户修改了完成状态、归档、结束日期、简介、链接或路径基准，本次旧分析会返回 `409` 并整包丢弃，不写进度、待确认、活动或 `PROJECT.md`，也不会自动重试。用户可按最新状态再次手动同步。

## AI Provider 与出站隐私边界

- 未配置可用 Profile 时，AI 路径使用本地回退规则，不发起外部请求。为兼容既有部署，设置 `OPENAI_API_KEY` 且未选择其他 Profile 时会启用默认 `openai_luna`。
- AI Provider 注册表当前只允许 `openai_luna`、`third_party_responses` 和 `third_party_chat_completions`。普通业务请求不能传入任意 URL、method、path、header 或凭证引用。
- 第三方 Profile 必须由部署管理员显式设置 `AI_PROVIDER_ENABLED=1`，配置固定的 base URL、exact origin allowlist、model、network zone 和固定凭证变量；公网 endpoint 必须使用 HTTPS，loopback 匿名调用只允许显式的 `local_loopback`。
- OpenAI-specific 请求映射只存在于 Adapter 内。Responses-compatible 与 Chat-Completions-compatible 分别使用固定 `/responses`、`/chat/completions` 路径；重定向被禁止，响应体有硬上限，服务商错误正文不进入业务日志。
- 默认 Provider 是 `openai_luna`，保持 `gpt-5.6-luna`、`xhigh`、strict JSON Schema、`store:false` 和 120 秒有界超时。第三方若不能满足 reasoning、schema 或 no-store 要求，必须 fail-closed；只有显式批准的 downgrade 开关才允许降级，并在 `aiConfig.degraded` 中可见。
- 设置 Provider 后，项目创建会发送项目描述和业务板块；进度分析会发送项目元数据、相对文件名/mtime、Git 提交元数据和本地规则摘要；早晨对话会发送候选项目/待办、近期活动、对话历史和当前消息。配置存在只表示具备发起请求的条件，不表示真实 API 已验证。
- `PROJECT.md` 和文件片段默认不出站。供应商无关开关 `AI_SEND_FILE_CONTENT=1` 会显式开启正文；旧的 `OPENAI_SEND_FILE_CONTENT=1` 仅在默认 `openai_luna` Profile 下作为兼容别名。
- 所有发送的 input 都会先脱敏 Bearer 凭证、常见 OpenAI/GitHub token、URL userinfo、key/token/password/secret 赋值和私钥块。这是防误传护栏，不是全部敏感数据识别保证。
- 固定业务规则与不受信数据保持角色分离；所有 Provider 结果仍须通过本机 JSON、schema、证据 ID 唯一性、候选范围和业务不变量校验。
- 云到云自动 fallback 默认关闭。Provider 失败只触发现有本地规则，不会改变收件箱、截止日期、项目完成标记或 `todayPlan`。
- 详细部署配置和能力边界见 `docs/AI_PROVIDER.md`。

## 决策权

系统没有“自动排期”路径。`todayPlan` 只能通过显式 `/api/todos/today` 用户动作写入，并与 `todayPlanDate` 一起保存。派生 API 只在该日期等于服务本机当天时暴露计划；跨自然日后视为空，用户当天首次操作会清空旧日选择并切换日期。旧版没有日期标记的非空计划无法证明属于哪一天，启动迁移时会保守清空。

新项目、新待办和新备忘均以收件箱事项为来源。项目创建会在同一次状态写入中消费 `sourceInboxId`；直接写备忘被拒绝。自然语言指令若匹配到多个项目，只返回候选并进入待确认，必须由用户按项目 ID 明确选择后才会移动事项。

## 持久化

这是单用户、单进程系统，使用原子 JSON 写入而不是数据库。写入通过进程内队列串行化；每天首次修改状态或配置前，会把两者一起保存为同一份快照，快照失败则中止本次写入。不要让多个工作台进程共享同一个 `DATA_DIR`；若未来扩展多人或多实例协作，再迁移 PostgreSQL/SQLite。

JSON 状态文件与外部项目目录不是同一种事务资源。正常错误会在状态提交前尽量回滚本次创建的空目录，但主机在极窄的写入窗口崩溃时仍可能留下孤立目录，需要人工核对；这里不宣称跨文件系统的崩溃原子事务。

## Readiness 边界

`GET /api/health` 是 Docker 和运维使用的只读 readiness 信号。它读取并校验 state/config，检查 data/state/config/backups、解析后的工作区及所有业务目录的存在性、类型、权限、symlink 和 realpath 越界边界。该路径不创建探针文件或修复目录；任一检查失败时对外只暴露固定的 `not_ready` 状态，不暴露绝对路径、JSON 内容或底层错误。

这是文件系统依赖就绪检查，不是端到端业务验收：`200` 不证明任一 AI Provider 可达、第三方 API 已通过真实验证、外部备份可恢复或视觉浏览器流程正常。
