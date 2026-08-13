# 飞书项目分析与总结：唯一叙事真源

## 1. 数据边界

每个项目可以通过 `project.feishu` 绑定一个飞书/Lark 云文档。

四类数据的职责固定为：

| 位置 | 职责 |
|---|---|
| 本地项目文件夹 | 原始资料、工作过程、最终交付、代码和其他真实工作产物 |
| Git | 版本、提交、分支和代码变化证据 |
| Workbench `state.json` | 项目元数据、机器进度、任务、确认项、飞书记录指针 |
| 飞书项目云文档 | 项目分析、阶段总结、复盘、卡点说明和上下文恢复等人类可读叙事 |

Workbench 不在 `state.json`、`PROJECT.md` 或 activity 日志中保存第二份项目分析正文。

普通项目备忘仍属于 Workbench 的轻量本地记录；本规则专门约束项目分析、阶段总结、复盘和上下文恢复叙事。是否把普通项目备忘迁移到飞书，应作为单独产品变更处理。

## 2. 项目文档合同

项目文档必须是官方飞书/Lark HTTPS 云文档链接，当前允许：

- `*.feishu.cn`
- `*.larksuite.com`
- `*.larkoffice.com`

文档路径必须是 `/wiki/<token>`、`/docx/<token>` 或 `/docs/<token>`；链接不能包含账号密码、查询参数或 URL 片段。

工作台只操作固定一级章节：

```text
# 项目分析与总结
```

只识别两类记录：

```text
[WORKBENCH_ANALYSIS] [WORKBENCH_OP:<operationId>] ...
[WORKBENCH_SUMMARY] [WORKBENCH_OP:<operationId>] ...
```

其他飞书正文不会被解释成机器状态。

## 3. 项目同步事务

主动同步项目时：

```text
本地文件/Git 证据
→ 临时分析
→ 生成稳定 operationId
→ 写本地恢复凭据（不含分析正文）
→ 飞书按 operationId 查重
→ 必要时追加记录
→ 飞书读回唯一 block
→ 提交 Workbench 机器进度和指针
→ 删除恢复凭据
```

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

同步 API 不返回项目分析正文，只返回机器进度、扫描元数据和飞书记录指针。项目正文需要通过 `project_records_read` 从飞书读回。

## 4. 幂等与部分提交恢复

每次分析或总结都有稳定 `operationId`。同一操作重试时，飞书适配层先查找同一 operationId：

- 已存在：返回原 block，不再次追加；
- 不存在：创建新记录并读回；
- 出现多个相同 operationId：停止并要求人工核对。

恢复凭据保存在：

```text
data/recovery/project-record-<operationId>.json
```

恢复凭据不包含分析或总结正文，只保存：

- operationId；
- 项目 ID；
- 文档 URL；
- revision/block 指针；
- 机器进度；
- 项目快照哈希；
- 当前事务阶段。

事务阶段：

- `remote_pending`：飞书调用尚未得到可确认结果；
- `remote_outcome_unknown`：飞书请求报错，无法确定远端是否已经写入；
- `remote_saved_local_pending`：远端已读回确认，但本地机器状态尚未提交。

后两类会在“待确认”中持续显示。重新同步使用同一 operationId 对账，不盲目追加。

## 5. 同步互斥

单项目同步、全项目同步、REST、右侧 AI 和 `/api/mcp` 共用领域层同步协调器：

- 同一项目同时只能有一个同步；
- 全项目同步与任何单项目同步互斥；
- 冲突返回 `PROJECT_SYNC_BUSY`，调用方不得自动并发重试。

## 6. 项目页读取

项目页右侧提供“飞书项目记忆”面板：

- 读取最近分析与总结；
- 最新记录优先；
- 每页默认 10 条；
- 支持读取更早记录；
- 支持打开绑定的飞书云文档。

正文只保存在当前页面内存。工作台不使用 `localStorage`、`sessionStorage` 或 IndexedDB 缓存项目叙事。

## 7. `PROJECT.md`

`PROJECT.md` 只作为项目身份证：

- Project ID；
- 项目名称和介绍；
- 所属业务；
- 开始和结束日期；
- Git；
- 飞书项目文档链接；
- “分析与总结真源：飞书云文档”声明。

新建和归类项目从第一次写入开始就是 identity-only，不再先生成旧的进度叙事块。

## 8. 从旧版本升级

第一次启动新版本时，如果旧 `state.json` 中含有 `progress.summary/resume/blocker` 或旧同步日志，工作台会先创建不可覆盖的原始快照：

```text
data/migrations/pre-narrative-v1-startup.json
```

随后本地状态只保留机器字段，并为涉及的项目创建 `legacy_project_narrative_pending` 待确认。旧正文不会被假装成已经迁移到飞书。

先停止工作台并备份数据，然后执行 dry-run：

```bash
npm run migrate:project-records
```

确认报告后执行：

```bash
npm run migrate:project-records -- --apply
```

迁移行为：

1. 从不可覆盖快照读取旧叙事；
2. 已绑定有效飞书项目文档的项目，按稳定 operationId 追加迁移记录；
3. 未绑定飞书的项目保持待确认，不删除原始快照；
4. 旧 `PROJECT.md` 先备份为 `PROJECT.md.pre-feishu-v1.bak`；
5. 只替换工作台受管区块，保留用户自定义正文；
6. 生成 `data/migrations/migration-report-*.json`。

迁移是可重入的。同一 operationId 再次执行不会重复写飞书。

## 9. 更换或解绑项目文档

更新 `project.feishu` 时：

- 新 URL 必须通过官方 host 校验；
- 文档变化或清空时，旧 revision/block/operation 指针原子清除；
- 后续分析和总结只写新文档；
- 已存在的恢复凭据仍保留用于人工对账，不会被静默解释为属于新文档。

## 10. 运行前提和验证边界

飞书项目记录依赖运行工作台的同一台机器：

- 已安装 `lark-cli`；
- 当前系统用户已登录；
- 对目标文档有读写权限；
- 网络可达。

自动化测试使用本地 fake client，不处理真实凭证。源码和 CI 通过不等于已经完成 live 飞书、OpenAI、浏览器、iPhone 或部署验证。
