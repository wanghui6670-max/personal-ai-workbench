# Spec: operations

## Objective

`operations` 让本机运行可诊断、可备份、可精确回滚，并承担 `R1-OPS-01/02/03`、`R1-CI-01` 的工程合同，以及耐久写入 `R1-DATA-01` 在运维面的证据。

liveness、readiness 和依赖诊断必须分开。doctor/preflight 只读。backup v3 覆盖全部 R1 本地状态与收据。CI 使用精确 Node `24.19.0`、npm `11.17.0`、双 lock 冷安装，不能靠临时 `npm install` 混过浏览器冒烟。

本模块不改发布画像，也不把 Git checkout 当成运行根。运行身份树为：

```text
$HOME/Library/Application Support/PersonalAIWorkbench/
├── runtime-root/
│   ├── releases/<release-id>/
│   ├── config/revisions/<config-revision-id>/
│   └── runtime/
└── data/          # DATA_DIR，与 runtime-root 兄弟
```

## Tech Stack

- `scripts/doctor.mjs`、`scripts/p0-host-preflight.mjs`
- 私有 `ops_event_v1` 轮转日志：目录 `0700`，文件 `0600`
- backup v3：逐文件 schema/bytes/SHA-256，在线一致性快照，维护锁 + 同盘 staging + 原子切换
- GitHub Actions 与 Docker 必须消费 `.node-version` 与双 lockfile
- 故障注入夹具覆盖 cutover、耐久写、未知外部结果与备份损坏

## Commands

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --test tests/doctor.test.mjs tests/host-p0.test.mjs
npm run p0:host
npm run service:macos -- status
```

真实 LaunchAgent cutover、真实 restore 到生产 `DATA_DIR` 需要单独确认。

## Diagnostics Contract

- `/live` 只表示进程活着。
- `/ready` 只表示本地核心可服务；可选外部依赖失败不得把核心打成未就绪。
- 受保护 diagnostics 逐项报告 enabled/configured/available、上次检查/成功、时延和安全错误码。
- `status` 展示完整不可变身份：release、config、deployment、toolchain、backup freshness、requestId/operationId、阶段、时延。
- doctor/preflight 不得调用 mutating `ensure()`、迁移或写探针。
- 候选 smoke 只用一致性隔离克隆，第二进程不得打开在线 `DATA_DIR`。

## Backup, Retention and Recovery

冻结数字，不得只改实现默认值：

- 已确认本地写 `RPO=0`；
- 备份窗口 `RPO≤15 minutes`，部署/恢复前强制一致性备份；
- 空目录恢复 `RTO≤30 minutes`。

保留策略：

- release / config / deployment：当前 + 一个已验证 N-1；旧对象在 N-1 回滚验收完成前不得删除。
- `ops_event_v1`：私有目录，按 20MB 或 14 天轮转，至少保留 2 个归档段。
- 备份：覆盖 15 分钟窗口所需快照，外加一个已知可恢复点。凭证、登录态、`WORKSPACE_ROOT` 原件另行恢复，不打进默认包。

`dataSchemaVersion` 从 `1` 开始。回滚只允许当前 schema 或一个已验证 N-1。

## Event and Error Schema

`ops_event_v1` 至少包含：timestamp、requestId/operationId、deploymentId、releaseId、configRevisionId、stage、durationMs、result、`code`、`retryable`、fallback/degraded、backup 与 unknown-outcome 事件。稳定错误对象使用 `code`、`stage`、`retryable`、`causeCode`。禁止 secret、凭证、正文和不必要绝对路径。

## CI Gate

同一候选必须经过：精确工具链、根/Harness `npm ci`、真实浏览器 E2E、macOS fixture、故障注入、secret/artifact scan、SBOM/漏洞/许可证。浏览器冒烟不得临时安装依赖。启用外部 branch protection 需另确认。

## Testing Strategy

1. doctor 零写入：前后字节/hash 对比。
2. 克隆一致性与 live-lock 负向。
3. 空目录 restore、损坏输入回滚、测得的 RPO/RTO。
4. 日志权限、轮转、并发写、secret canary。
5. workflow/Docker 合同：`.node-version`、禁止 `node-version: '24'` 与 `npm install --no-save`。

## Boundaries

### Always

- 诊断与核心就绪分离。
- 只读预检。
- 备份含 receipts 与 schema/hash。
- 错误与事件可安全展示。

### Ask First

- 真实 LaunchAgent 安装/切换/卸载。
- 对真实 `DATA_DIR` 做 restore。
- 打开 GitHub required checks 或其它托管保护。

### Never

- 用 health `200` 代替身份一致。
- 让 preflight 写在线数据。
- 把凭证打进备份包或日志。
- 静默缩短 RPO/RTO。

## Success Criteria

1. `/live`、`/ready`、diagnostics 分离且 status 含完整身份与 backup freshness。
2. doctor 前后字节不变；候选不碰在线 `DATA_DIR`。
3. backup v3 空目录恢复达到 `RTO≤30 minutes`，备份窗口 `RPO≤15 minutes`，已确认本地写仍是 `RPO=0`。
4. `ops_event_v1` 私有、有界、无 secret。
5. CI/Docker 使用精确 Node/npm 与双 lock，浏览器冒烟无临时安装。
