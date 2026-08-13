# Changelog

## Unreleased

- 项目分析、卡点说明、上下文恢复摘要、阶段总结和复盘正文迁移为“飞书项目文档唯一真源”；`state.json` 与 `PROJECT.md` 不再保存第二份正文
- `PROJECT.md` 降级为项目身份证；新建和归类项目从第一次落盘起就是 identity-only，不再经过旧叙事 writer
- 项目同步改为 remote-first：分析完成后先写飞书并读回确认，再提交本地机器进度和 revision/block/operation 指针
- 本地机器进度只保留 `percent/status/hasBlocker/lastActivity/syncedAt/confidence` 与飞书记录指针；持久化校验器拒绝 narrative 字段
- 新增稳定 operationId、飞书查重和幂等重试；相同操作不会重复追加远端记录
- 新增跨资源恢复凭据：区分远端结果未知与远端已保存但本地未提交，重试时先按 operationId 对账
- REST、右侧 AI 与 MCP 共用领域层项目同步锁，单项目同步与全量同步互斥
- 项目飞书链接限制为官方 Feishu/Lark HTTPS 云文档；换绑或解绑时原子清除旧指针
- 项目记录读取增加 latest-first 分页，默认 20、硬上限 100；阶段总结正文最大 6000 字符
- 项目页新增临时“飞书项目记忆”面板，可读取最近记录和打开云文档；正文不进入浏览器持久化存储
- 首次升级先生成不可覆盖的旧叙事原始快照；新增 dry-run / apply 迁移命令、`PROJECT.md` 原文件备份和可重入迁移报告
- MCP 新增 `project_records_read` 与 `project_summary_append`；阶段总结写入仍须用户确认，正文不进入本地审计日志
- 右侧 AI 控制平面新增 `ai_console` 结构化模型规划：模型只提出白名单 MCP 工具调用，不直接执行
- 本地 MCP 注册表增加工具参数 schema 校验、模型失败的显式安全回退，以及工具结果与左侧状态读回
- 双面板明确为左人右 AI；右侧展示当前模型/本地回退状态、工具参数和执行结果
- 新增 `panel_navigate` 导航桥：AI 可切换左侧面板、打开设置/新建项目，并在右侧显示证据、冲突和缺口摘要
- 飞书收件箱 ack 改为 block ID + SHA-256，不再保存历史正文；远端编辑会重新导入，远端删除会清理未处理缓存和关联确认
- iPhone `/api/capture` 新增 `captureId` 幂等合同：同 ID 同正文安全重放，同 ID 不同正文冲突，处理后重放不复活
- HTTP 请求 schema 正式允许 `captureId`，并增加真实服务进程级的 201/200/409 回归测试
- Capture 收据只保存正文哈希和标识符；飞书 Capture marker 支持远端查重，不把内部 marker 暴露为用户正文
- backup v2 同时保存持久化 state/config、Capture 幂等收据和项目记录恢复凭据；不保存 Capture 正文或项目分析正文
- 恢复支持成组替换和失败回滚两类凭据；旧备份缺少凭据字段时保留当前目录，避免静默清空
- CI 升级到 Node 24，固定第三方 Action commit，并检查迁移、收件箱、Capture、恢复与浏览器模块语法

## 1.2.0 - 2026-08-13

- 收件箱支持以飞书云文档《个人 AI 工作台｜每日工作日记》作为外部真实来源
- 新增飞书文档读取、`[INBOX]` 章节解析、稳定 block ID 去重、同步游标和删除读回
- 本地新增收件箱改为“先写飞书、再读回、最后提交本地缓存”，失败时不伪装成本地成功
- 设置页、API、README、部署说明和架构文档补齐飞书配置、安全边界及 Docker 限制
- 补充飞书链路合同测试与版本健康检查；测试不等同于 live 飞书验证
- AI 判断统一收敛为 Provider 合同；默认继续使用 `gpt-5.6-luna` / `xhigh` 的 Responses API，并新增受限的 Responses-compatible 与 Chat-Completions-compatible 适配器
- Provider 请求增加固定工作流 allowlist、证据 ID 校验、响应体上限、稳定错误码和显式能力降级门；未配置或失败时继续使用本地规则

## 1.1.0 - 2026-08-12

- AI 判断默认切换为 `gpt-5.6-luna`，固定使用极高推理档位 `xhigh`
- 项目创建、项目进度和早晨对话统一采用“证据 → 冲突与缺口 → 最终结论”结构化分析工作流
- 分析信封仅用于本次校验，持久化只保存业务结论，不保存依据草稿或隐藏思维；OpenAI 失败继续回退本地规则
- 设置页与 doctor 区分“已配置”与“联网调用已验证”；正文默认不出站的隐私边界保持不变
- Luna 分析期间若项目或路径基准被用户修改，过期结论会以冲突响应作废，不覆盖人的最新决定
- 批量同步会把这类过期项目单独标为跳过，不误报同步失败或生成失败待确认
- 显式指定不存在的业务板块会失败并保留收件箱来源，不再静默交由 AI 改判

## 1.0.0 - 2026-08-12

- 从 PRD V0.2 升级为可部署完整项目
- 本地文件系统作为项目真实来源
- 项目上下文恢复和手动批量进度同步
- OpenAI Structured Outputs 项目分析 + 无 Key fallback
- 收件箱强制入口和自然语言显式处理
- 人在回路的早晨对焦与今日工作台
- 待确认 / 待归类 / 逾期 / 归档
- 业务板块与本地目录一致管理
- 访问密码、外部 capture token、安全 headers
- 原子 JSON、自动备份、导出
- Docker、doctor、tests、部署文档
