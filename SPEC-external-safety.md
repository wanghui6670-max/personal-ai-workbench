# Spec: external-safety

## Objective

`external-safety` 把所有出站能力做成可关闭、可审计、失败不丢本地主链的边界，并承担 `R1-FEISHU-01/02/03`、`R1-AI-01/02` 与 `R1-EGRESS-01`。

本地 Capture 必须先持久化，再进入 durable outbox。飞书、Provider、DSH、Joycrew 和 GetNote 均为可选；未启用时显示 disabled/unavailable，不得伪装成功。远端已成功但本地未知时，只能按稳定 `operationId` 唯一读回后再决定是否重试。

本模块不改变 `personal-core` 的待办来源，也不把配置写进 Git checkout。正式配置只来自 `<runtime-root>/config/revisions/<config-revision-id>/` 指向的不可变 revision。

## Tech Stack

- 现有 `src/feishu.mjs`、`src/feishu-capture.mjs`、`src/joycrew-client.mjs`、`src/joycrew-actions.mjs`
- 原子 Provider profile（模型、凭证、API style、base URL、network zone 不可跨族混配）
- 稳定 receipt：`provider_receipt_v1`、`feishu_outbox_receipt_v1`、`egress_receipt_v1`
- 字段级 egress 合同：允许/禁止字段、行/体积上限、redaction、purpose
- 普通 AI 与 Harness 共用 endpoint 安全规则

## Commands

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --test tests/feishu.test.mjs tests/joycrew-client.test.mjs
```

真实非生产 canary 属于 `R1-018`，必须另获确认；本模块的实现任务不得写真实远端。

## Feishu Local-First Contract

- Capture 先提交本地，再进入 durable outbox。
- 每条外部写使用稳定 `operationId`。
- `feishu_outbox_receipt_v1` 持久化四态：`pending` / `succeeded` / `uncertain` / `failed`；重启后仍可读。
- 正文、凭证、token 不得进入 argv、日志或原始 API 错误。
- 远端已成功、本地结果未知时，重试前必须按 `operationId` 做唯一远端读回；禁止盲目重放。
- 待办同步只拉明确待办；日记提取与 `mixed_diary` 猜任务不进入 R1 正式路径。

## Provider and Egress Contract

- Provider 按原子 profile 解析；混配、私有/保留地址、不安全 redirect/DNS/rebind 必须 fail closed。
- 每次真实模型运行写入 `provider_receipt_v1`：requested/actual provider 与 model、`requestId`、usage、latency、fallback、degraded、workflow；缺证据时显式 `unverified`。收据不含 prompt 或私有正文。
- DSH/Joycrew 每个工具定义允许/禁止字段、行/体积上限、redaction、purpose，并写 `egress_receipt_v1`。
- 敏感 canary 不得离开边界。
- Joycrew `uncertain` 必须跨重启可恢复；不能恢复则保持 disabled/experimental。

## Recovery and Identity Alignment

外部未知结果不是已确认本地写。已确认本地写仍是 `RPO=0`。磁盘灾难与空目录恢复仍是备份窗口 `RPO≤15 minutes`、空目录 `RTO≤30 minutes`。N/N-1 只覆盖当前与一个已验证回滚点；外部收据必须随 `dataSchemaVersion` `1` 一起备份。

配置路径固定为 `config/revisions/`。实现 WIP 若仍写其它目录，必须在 `R1-003C` 对齐到本树，不得冻结第三条路径。

## Error Schema

出站失败使用稳定错误对象：`code`、`stage`、`retryable`、`causeCode`。禁止包含 secret、凭证、正文或不必要的绝对路径。

## Testing Strategy

1. 离线主链：无网时 Capture 仍本地成功，outbox 为 `pending`。
2. unknown-outcome 注入：远端成功 + 本地超时 → 唯一读回后不重复写。
3. secret canary：进程列表、日志、错误对象扫描正文/token。
4. Provider 混配与 SSRF/DNS 负向测试。
5. egress 字段拒绝、体积上限、uncertain 重启或禁用读回。

## Boundaries

### Always

- 本地意图先落盘。
- 用 `operationId` 对账后再重试。
- 未启用的集成显示为不可用。
- 收据与错误不含私有正文。

### Ask First

- 任何真实外部写入。
- 启用 Joycrew、DSH、Provider 或 GetNote 作为现场路径。
- 改变 redaction 规则或把新字段加入默认 egress。

### Never

- 正文进 argv/日志/原始错误。
- 未知结果时盲目重试造成重复远端写。
- 静默 fallback 却显示成功。
- 把客户身份、财务明细或凭证写入 receipt。

## Success Criteria

1. Capture 离线可完成；outbox 四态可重启读回。
2. 未知结果经 `operationId` 对账，远端唯一。
3. `provider_receipt_v1` 记录 actual 模型与 fallback/degraded。
4. DSH/Joycrew 有字段级合同和 `egress_receipt_v1`；uncertain 可恢复或保持禁用。
5. 已确认本地写 `RPO=0` 不被外部失败打破；备份窗口仍是 `RPO≤15 minutes`，空目录仍是 `RTO≤30 minutes`。
