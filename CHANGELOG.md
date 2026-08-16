# Changelog

## 3.0.0 - 2026-08-16

- 个人工作事项主入口改为飞书云文档：`[INBOX]` → Workbench Inbox → AI 分析 → 用户确认 → Workbench 执行
- “今日工作台 + 收件箱”合并成“今日与收件箱”，把 Today、飞书待处理、AI 建议、待确认、逾期和待归类放到同一决策面
- “最近工作现场 + 项目进度”合并成“项目现场与进度”
- 得到大脑退出个人待办主链路，仅保留“自媒体 / 得到大脑内容”本地 Markdown 内容采集；旧 GetNote Task Sync 工具退出交互式 AI/MCP registry
- 新增 `src/ai-review-scope.mjs`：飞书单条审阅只向模型提供目标 Inbox item + 最多 30 个未归档项目目录摘要，并且模型只可提议 `inbox_process`
- 飞书自动 AI 审阅改为最多 2 条并发、100 条有界队列；不再只处理前 12 条；未变化事项的短时预览可在浏览器 session 内复用
- LaunchAgent install 改为先生成并 lint replacement plist，再进入 cutover；端口释放、bootstrap、health 或 commit 失败都会尝试恢复旧服务
- LaunchAgent rollback 不再吞掉 bootstrap 失败；恢复旧版本时允许旧版本 health，只要求服务重新可用；restart 也增加已运行服务恢复路径
- 产品版本、package、Docker smoke 和合同测试统一升级到 `3.0.0`
- README / PRODUCT_SPEC / ARCHITECTURE / API 统一到 v3 来源与处理合同
- 新增当前工程收口审查，旧 GetNote v2 深审明确降级为历史审查证据

## 2.0.0 - 2026-08-14

- 将 Personal AI Workbench 明确升级为动觉 AI 工作台的唯一日常入口；个人工作连续性与 Joycrew 企业 AI 员工执行形成一个产品
- 新增原生“业务执行”页面，按需展示 Joycrew 客户、企业项目、业务任务、AI 员工、Run、Evidence、审批和正式交付
- 新增服务端 `JoycrewClient`，支持 `trusted_proxy`、`signed_session` 和非生产 Fixture；浏览器不接触 Joycrew URL、Token、Workspace 身份或角色覆盖
- 新增 `local_loopback`、`private_http`、`public_https` 网络分区，拒绝公网明文 HTTP、URL 认证信息、查询参数、片段和重定向
- 新增 Joycrew BFF：状态、总览、项目详情和短时操作预览 API；Joycrew 未启用或离线时个人工作台继续运行
- 新增 Run、交付和审批的 Preview → Confirm → Execute 合同；未确认不调用 Joycrew，已执行预览重放不产生第二次副作用
- 操作预览使用高熵 ID、规范化参数、SHA-256 摘要、影响范围和过期时间，仅保存在 Workbench 进程内存
- Run 数据源严格限定为显式选择的 DataWeave records/file 来源；拒绝绝对路径、目录穿越、空路径和过大参数
- Harness 固定白名单扩展为 Workbench 读取、Joycrew 读取和 Joycrew preview-only 工具；新增普通 MCP 工具不会自动进入 Copilot
- Harness 统一为“工作 Copilot”：可以跨个人工作和企业业务连续读取，但外部改变必须转到“业务执行”页面人工确认
- 修复 `.env` allowlist 未加载已文档化 Harness 配置的问题，并加入全部 Joycrew 服务端配置键
- 新增 Joycrew 专用限流、上游超时、响应体上限、受控错误映射和公开健康检查拓扑脱敏
- `doctor` 增加 Node 24、Joycrew 配置与连通性检查；只有显式启用 Joycrew 时才成为必需项
- Docker Compose 增加 `host.docker.internal` 主机网关，支持 Workbench 容器安全调用宿主机 Joycrew
- 产品版本升级为 2.0.0，PWA 名称更新为“动觉 AI 工作台”，新增统一产品 README 和 Joycrew 集成合同
- CI 增加 Joycrew 客户端、操作 Broker、MCP 工具、统一 Harness 21 工具目录和 Joycrew 关闭时的 Docker fail-isolation 验证

## 1.3.0 - 2026-08-14

- 个人待办来源纠正为得到大脑 / GetNote CLI，固定执行 `getnote notes`、`getnote note todos` 和 `getnote doctor`
- 无明确待办章节时接受空列表，不让模型从笔记正文自行发明任务；稳定身份由来源笔记 ID、文本和出现序号派生
- 明确日期事项进入正式待办，日期不确定事项进入收件箱；只有上游明确完成状态才同步完成
- 飞书《每日工作日记》作为任务快照和用户触发总结的沉淀目标，本机 ICS 只镜像确定日期并原子重建
- 项目分析、卡点、恢复摘要、阶段总结和复盘正文统一为飞书项目文档唯一真源
- `PROJECT.md` 降级为身份索引；本地状态只保存机器进度、飞书指针、幂等收据和恢复凭据
- 新增 Capture `captureId` 幂等、backup v2、跨资源恢复和项目记录读写合同
- DeepSeek Harness Navigator V1 接入右侧工作区，提供持续会话、固定只读工具、工具轨迹和 Docker E2E

## 1.2.0 - 2026-08-13

- 收件箱支持飞书云文档外部来源、稳定 block ID 去重、同步游标和删除读回
- 新增飞书文档读取、先写远端再提交本地缓存的失败关闭链路
- AI Provider 统一为结构化合同，支持 Responses-compatible 与 Chat-Completions-compatible 适配器
- Provider 请求增加工作流 allowlist、证据 ID 校验、响应体上限、稳定错误码和显式能力降级门

## 1.1.0 - 2026-08-12

- AI 判断默认使用 `gpt-5.6-luna` 和 `xhigh`
- 项目创建、项目进度和早晨对话采用“证据 → 冲突与缺口 → 最终结论”结构化分析
- 分析信封仅用于本次校验，不保存依据草稿或隐藏思维；Provider 失败回退本地规则
- 模型结论在项目或路径基准变化时以冲突作废，不覆盖用户最新决定

## 1.0.0 - 2026-08-12

- 从 PRD V0.2 升级为可部署完整项目
- 本地文件系统作为项目真实来源，Git 提供版本证据
- 收件箱强制入口、人在回路的早晨对焦与今日工作台
- 待确认、待归类、逾期、归档和业务板块目录管理
- 访问密码、Capture Token、安全 Headers、原子 JSON、自动备份、Docker、Doctor 和测试

## 不确定结果保护

Joycrew 写操作在网络中断、响应丢失或返回不可验证结果时会标记为“结果不确定”。同一个预览不会自动重试，避免重复创建 Run、交付或写回；用户应先刷新业务状态核对，再决定是否生成新的预览。
