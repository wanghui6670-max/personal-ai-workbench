# Personal AI Workbench R1 发布合同

> 状态：Normative / 已批准实施
> 生效日期：2026-08-20
> 产品来源合同仍以 `WORKBENCH_V3_SOURCE_CONTRACT.md` 为最高优先级；本文只定义首个正式运行版本的部署边界与发布门。

## 1. 最终目标

R1 要交付一个可每天真实使用、可重启恢复、可证明运行版本、外部依赖失败时仍保住本地主链的 Personal AI Workbench：

```text
单用户 + 单 Mac + 单进程 + 单 DATA_DIR
→ LaunchAgent 常驻
→ 默认只监听 loopback
→ 飞书明确待办 / 手工 Capture 进入 Inbox
→ AI 建议或人工处理
→ 用户确认后生成 Todo
→ 用户决定是否加入 Today
→ 重启、降级和恢复后状态不丢、不重、不串
```

R1 的“正常运行”不是页面能打开，也不是某次测试全绿，而是当前提交、安装清单、运行进程和静态资产属于同一构建，并且个人主链、外部集成、备份恢复和持续运行都有当前机器的可读回执。

## 2. 固定部署画像

R1 只支持 `local_single_user` 正式画像：

- 一台受信任的 macOS 主机；
- 一个 macOS 用户；
- 一个 Workbench Node 进程；
- 一个独占 `DATA_DIR`；
- LaunchAgent 常驻；
- HTTP 默认仅绑定 `127.0.0.1`；
- Joycrew、DSH、Provider、GetNote 和 Feishu 均按能力单独启用，离线不能阻塞核心 readiness；
- 未启用的外部能力必须明确显示为 disabled/unavailable，不能伪装为成功。

任何 LAN、Tailscale、公网、反向代理或多用户访问都不属于本画像，必须另立发布合同。

## 3. R1 范围

### 3.1 必须完成

| Requirement | 必须成立的结果 | 权威证据 |
|---|---|---|
| `R1-RUNTIME-01` | 根依赖可通过 lockfile 和 Node 24 使用 `npm ci` 重建 | lockfile、冷目录安装日志、全量测试 |
| `R1-RUNTIME-02` | Git HEAD、安装提交、运行提交和静态资产 manifest/hash 一致 | health、安装 manifest、service status、浏览器启动门 |
| `R1-RUNTIME-03` | 同一 `DATA_DIR` 只能有一个写入进程 | 进程锁测试、并发启动负向测试 |
| `R1-CORE-01` | 无 AI、Feishu 或 Joycrew 时，手工 Capture/Inbox 仍可人工处理成 Todo/Today | API + 浏览器 E2E、重启读回 |
| `R1-CORE-02` | 批量操作按逐项结果显示成功、失败和未执行，不能部分失败却提示全部成功 | 领域测试、浏览器 E2E |
| `R1-FEISHU-01` | 正文不进入 argv、日志或原始 API 错误；写入使用稳定 operationId | canary 扫描、注入测试 |
| `R1-FEISHU-02` | 远端已成功但本地结果未知时，重试不会重复写 | unknown-outcome 故障注入、远端唯一读回 |
| `R1-AI-01` | Provider 配置按原子 profile 解析，Harness 与普通 AI 共用 endpoint 安全规则 | 混配/SSRF 负向测试 |
| `R1-AI-02` | 每次真实模型运行记录 requested/actual provider、model、requestId、usage、latency、fallback/degraded | `provider_receipt_v1` 读回 |
| `R1-EGRESS-01` | DSH/Joycrew 工具按字段级合同最小化出站，敏感 canary 不离开边界 | 合同测试、egress receipt |
| `R1-OPS-01` | readiness 与外部依赖诊断分离，关键操作有 requestId、阶段、时延和安全错误码 | diagnostics/API/log 读回 |
| `R1-OPS-02` | 备份范围、RPO/RTO、保留和恢复边界明确；可从空目录恢复本地状态及收据 | 恢复演练报告 |
| `R1-FIELD-01` | 当前目标 Mac 完成 Feishu/GetNote/Provider/DSH（仅启用项）、浏览器/iPhone、重启恢复 canary | 当前时间戳的现场回执 |
| `R1-FIELD-02` | 连续至少 72 小时，建议 5–7 个工作日，未发生数据丢失、重复外部写、未解释 fallback 或不可恢复中断 | Pilot 日志与最终发布结论 |

### 3.2 不进入 R1

- 公网、多用户、RBAC、HA、多实例、Kubernetes；
- 为了未来扩展而重写为 SQLite 或其他数据库；
- Joycrew 全业务闭环、Evening Checkpoint、Decision Projection、AIHot、四象限；
- 未经单独确认的真实客户数据、生产外部写入、远端部署、Git push 或托管平台设置变更。

Joycrew 未完成真实 `Preview → Confirm → Execute → Readback` 时必须保持关闭或实验状态，不能阻塞 R1 的个人工作主链。

## 4. 运行与安全不变量

1. Workbench 只把飞书中的明确待办作为个人事项来源，不从普通日记猜任务。
2. AI 只能建议；Todo、Today、项目归属、日期和删除仍由用户确认。
3. 外部系统返回不确定结果时不得假设失败并盲目重试。
4. health=200 只证明本地 readiness；外部依赖必须独立诊断。
5. 配置成功、mock PASS、replay E2E 或回答内容都不能证明实际 Provider/model 或真实外部业务结果。
6. 凭证、token、Cookie、`.env`、客户资料和完整外部正文不得进入 Git、测试快照或普通日志。

## 5. 发布门

R1 只有在以下证据全部属于同一候选提交时才可发布：

1. `npm ci`、`npm test`、`npm run verify` 通过；
2. 当前 SHA、安装 SHA、运行 SHA、静态资产 hash 完全一致；
3. 个人主链在 AI/Feishu/Joycrew 不可用时仍可完成；
4. 启用的真实外部能力各有成功回执和故障恢复回执；
5. 重启后 Todo、Today、Capture 幂等和 Harness 持久对象连续；
6. 从空目录恢复演练达到记录的 RPO/RTO；
7. 72 小时以上 Pilot 通过；
8. 回滚演练通过，且没有未解释的高风险错误或待处理 unknown outcome。

## 6. 何时本合同会错

如果实际目标变成多人共享、跨设备远程访问、公开网络服务、并发多副本或强企业审计，本合同的单机 JSON、loopback 和单进程前提不再成立，必须停止沿用 R1 架构，重新设计身份、事务、网络和数据存储。
