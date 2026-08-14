# Personal AI Workbench 2.0｜P0 部署验收

> 目标：在不接触真实凭据、不启用 Joycrew、不写外部系统的隔离长期主机模型中，证明 Workbench 2.0 可以启动、备份、恢复和独立运行。

## 1. 为什么先做这一层

仓库 CI 已证明语法、合同测试、Harness E2E 和 Docker Smoke 通过，但这些不等于真实主机升级安全。P0 先锁定四件事：

1. Node 24 长期进程能够启动并通过 readiness；
2. Joycrew 关闭或不存在时，个人工作台继续可用；
3. backup v2 包含 state、config、Capture 收据和项目记录恢复凭据，但不包含运行凭据；
4. 停止服务后执行 restore，状态和 Capture 幂等收据可恢复，备份后的变更被正确回滚。

## 2. 可重复命令

```bash
npm run p0:acceptance -- --report ./artifacts/p0-deployment-acceptance.json
```

运行器会创建独立临时目录和随机本机端口，显式设置：

```text
JOYCREW_ENABLED=0
HARNESS_ENABLED=0
AI_PROVIDER_ENABLED=0
OPENAI_API_KEY=
```

它不读取仓库 `.env` 中的真实凭据，不调用 GetNote、飞书、Joycrew、DataWeave、Hermes 或公网 Provider。

## 3. 自动验收链

```text
隔离 DATA_DIR / WORKSPACE_ROOT
→ 部署前 doctor
→ 启动 Workbench 2.0
→ /api/health 与统一产品静态入口
→ Joycrew disabled fail-isolation
→ Capture 首次写入与同 ID 重放
→ 创建手工收件箱基线
→ 生成 backup v2
→ 制造备份后变更
→ 停止服务
→ restore backup v2
→ 恢复后 doctor
→ 重启服务
→ 读回基线且确认备份后变更消失
→ 再次重放 Capture，确认收据已恢复
```

## 4. 通过标准

- 报告 `status=passed`；
- 产品版本为 `2.0.0`；
- `/api/health` 返回 ready；
- `/api/joycrew/status` 明确 `enabled=false`，且未尝试连接外部 Joycrew；
- `joycrew-integration.js` 可由统一产品入口加载；
- Capture 首次 `201`、同 ID 重放 `200`；
- backup 为 `backupVersion=2`；
- backup 不包含 Capture Token；
- restore 后基线事项存在，备份后制造的事项不存在；
- restore 后同一 Capture ID 仍安全重放。

## 5. GitHub Actions

`.github/workflows/p0-deployment-acceptance.yml` 在以下场景运行：

- 本验收分支推送；
- 合入 `main` 后的主分支推送；
- 人工 `workflow_dispatch`。

每次运行上传 14 天保留的 JSON 验收报告。

## 6. 这一步没有证明什么

P0 隔离验收不等于目标服务器上线，也不证明：

- 现有生产 `/data` 和 `/workspace` 已完成备份；
- GetNote 会员、登录和 API 当前可用；
- `lark-cli` 当前有目标文档读写权限；
- 浏览器、iPhone Shortcut 和 ICS 客户端已现场验收；
- 反向代理、域名、TLS、Cookie 和公网暴露已验收；
- Joycrew PostgreSQL、DataWeave、Local Bridge 或 Hermes 已接通。

## 7. 进入真实主机 P0 的门槛

隔离报告通过后，真实主机仍需明确：

```text
目标主机
运行用户
部署目录
DATA_DIR
WORKSPACE_ROOT
测试端口或测试域名
现有版本回滚点
反向代理与 TLS 入口
```

不得把用于 VPN/Hermes 的既有服务器自动视为 Workbench 目标机；必须有明确部署绑定和最小权限方案。真实主机应先部署到测试端口，保持 `JOYCREW_ENABLED=0`，完成数据备份、浏览器和外部 CLI 现场读回后，才允许替换旧版本。
