# Spec: field-acceptance

## Objective

`field-acceptance` 规定 R1 何时才算在当前这台 Mac 上发布成功，并承担 `R1-FIELD-01/02/03`，以及对其它 23 条要求的现场证据。

单元测试全绿、health `200`、已配置集成或一份 artifact manifest 都不够。必须是同一候选：固定 commit、release、`config/revisions/` 中的配置 revision、deployment、LaunchAgent、实际 Node 进程和浏览器静态资产身份一致，并且个人主链、已启用的外部 canary、重启/恢复/回滚都有当前时间戳回执。

默认画像是 `local_single_user`。iPhone / 跨设备访问不是本现场门；未另立 `local_private_mobile` 前必须显示不可用。

## Tech Stack

- 当前目标 Mac 上的正式 LaunchAgent 与 `npm run service:macos -- status`
- 同一 `releaseId` / `configRevisionId` / `deploymentId` / `dataSchemaVersion` `1`
- 真实浏览器，而不是只跑 mocked page
- 脱敏的真实中断项目脚本与 Pilot 日志
- 现场回执目录留在运行 `runtime/receipts/`，不提交密钥

## Commands

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run service:macos -- status
npm run p0:host
```

`install` / `restart` / 真实外部写 / `git push` / 托管保护必须每次单独确认。

## Same-Candidate Field Contract

`R1-017` 在确认后证明：

- 仓库候选、不可变 release、`config/revisions/<id>`、deployment、plist、进程与浏览器/static 身份一致；
- 服务重启与 Mac 登录重启后主链可读；
- 空目录恢复满足 `RTO≤30 minutes`；
- 精确 N-1 回滚回到完整旧 deployment；
- 已确认本地写在这些场景中 `RPO=0`。

`R1-018` 在确认后，对每个已启用路径用非敏感测试数据各做一次成功和一次恢复。飞书还必须证明 unknown-outcome 对账与远端唯一结果。GetNote/Provider/DSH 仅在启用时验收。重放、mock、只配置不调用，不算现场证据。

## Value and Pilot Contract

- 至少 3 个真实但脱敏的中断项目：用户能恢复当前进度、最近活动、卡点，以及本地 / Git / 飞书证据入口。
- 连续至少 72 小时，建议 5–7 个工作日：零已确认本地写丢失、零重复外部写、零未解释 fallback、零遗留 unknown outcome、零不可恢复中断。
- 备份窗口现场演练仍是 `RPO≤15 minutes`。
- Pilot 结束时，26 条 `R1-*` 要求都有同一候选、当前 Mac 的证据行。

## Identity Alignment

现场不得使用开发 checkout 冒充正式运行，也不得把未跟踪 `CLAUDE.md`、`docs/HANDOFF_20260820.md`、`public/preview.html` 当作发布输入。配置身份只有 `config/revisions/`。

## Testing Strategy

现场任务本身就是验收，不是再发明一套测试框架：

1. 身份矩阵读回：status、health、plist、browser manifest。
2. 离线浏览器主链与重启读回。
3. 空目录 restore 与 N-1 回滚秒表。
4. 已启用集成的真实 canary 回执。
5. 三项目脚本 + Pilot 对账。

## Boundaries

### Always

- 同一候选、当前机器、当前时间戳。
- 未确认不碰真实 LaunchAgent 或真实外部写。
- iPhone 默认不可用。
- 回执脱敏。

### Ask First

- 每一次真实 cutover、重启、restore、外部写。
- 启用跨设备画像。
- 宣布 R1 完成或对外发布。

### Never

- 用另一台机器或旧候选的证据顶替。
- 把 mock 当 canary。
- 把父仓 `AI-Work-OS` 文件混进本产品仓提交。
- 现场改写 RPO/RTO 数字。

## Success Criteria

1. `R1-FIELD-01`：离线主链、已启用 canary、重启、空目录恢复、精确回滚均有同一候选回执。
2. `R1-FIELD-02`：Pilot 达到时长与五项零事件。
3. `R1-FIELD-03`：三个脱敏中断项目证明能找回进度与证据入口。
4. 恢复数字未被改写：已确认本地写 `RPO=0`，备份窗口 `RPO≤15 minutes`，空目录 `RTO≤30 minutes`。
5. 26 条要求的现场证据表闭合后，才可把 R1 标为可日常使用。
