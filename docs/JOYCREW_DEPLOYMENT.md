# Joycrew 部署指南

> 版本：1.0.0
> 适用场景：5-10 人小团队，与 Personal AI Workbench 联合部署
> 前置条件：Workbench 已完成阶段一~三（云部署就绪 + 安全加固 + 团队体验）并稳定运行

---

## 目录

1. [架构概览](#1-架构概览)
2. [前置条件](#2-前置条件)
3. [快速部署（Docker）](#3-快速部署docker)
4. [联合部署（Workbench + Joycrew）](#4-联合部署workbench--joycrew)
5. [配置说明](#5-配置说明)
6. [身份与认证](#6-身份与认证)
7. [网络分区策略](#7-网络分区策略)
8. [投标业务流程建模](#8-投标业务流程建模)
9. [验证与 Pilot](#9-验证与-pilot)
10. [备份与运维](#10-备份与运维)
11. [故障排查](#11-故障排查)
12. [安全清单](#12-安全清单)

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│ 浏览器（用户唯一入口）                                            │
│   └─ Workbench Cookie Session（JWT）                              │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│ Personal AI Workbench Server（BFF）                               │
│   ├─ 个人工作台：收件箱/待办/项目/日志/DSH Copilot                  │
│   └─ Joycrew BFF 代理层                                           │
│       ├─ 7 个 API 端点（认证 + 限流）                               │
│       ├─ Preview → Confirm → Execute 三阶段写操作                   │
│       └─ 安全裁剪（Token/凭据永不返回浏览器）                         │
└──────────┬──────────────────────────────────────────────────────┘
           │ trusted_proxy 认证（x-joycrew-proxy-token）
           │ 服务端到服务端，浏览器不接触
┌──────────▼──────────────────────────────────────────────────────┐
│ Joycrew API（独立服务）                                            │
│   ├─ 项目管理 / 客户 / 任务                                        │
│   ├─ AI 员工 / Skill / Grant                                       │
│   ├─ Run 生命周期 / Evidence Package                                │
│   ├─ 审批 / 交付物                                                  │
│   └─ DataWeave 集成（飞书/本机/服务器资料按需读取）                   │
└──────────┬──────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────────┐
│ PostgreSQL 16                                                     │
│   └─ Project / Employee / Run / Evidence / Approval / Deliverable │
└─────────────────────────────────────────────────────────────────┘
```

### 核心设计原则

| 原则 | 说明 |
|---|---|
| **Fail-isolated** | `JOYCREW_ENABLED=0` 时工作台完全正常，Joycrew 不影响 readiness |
| **浏览器零信任** | Token/Base URL/身份信息只存在于服务端，`status()` 不回显敏感字段 |
| **Preview → Confirm → Execute** | 所有写操作先生成预览（10 分钟过期），用户确认后才调用 Joycrew |
| **不确定结果保护** | 请求已发出但结果不可验证时标记 `uncertain`，禁止同一预览重试 |
| **数据不复制** | Joycrew 数据不进入 Workbench 的 `state.json` 或浏览器持久化 |

---

## 2. 前置条件

### 2.1 环境要求

| 组件 | 要求 |
|---|---|
| Docker | 24.0+（含 Docker Compose v2） |
| 服务器资源 | 额外 1C1G（PostgreSQL 256M + Joycrew API 512M） |
| Joycrew 源码 | Joycrew 仓库克隆到 `../joycrew`（或通过 `JOYCREW_SOURCE_PATH` 指定） |
| PostgreSQL 数据卷 | 至少 1GB 可用空间（持久卷） |

### 2.2 Workbench 侧准备

确保 Workbench 已完成：
- ✅ 阶段一：云部署就绪（SQLite 并发安全、Docker、安全响应头）
- ✅ 阶段二：安全加固（密码策略、Token 吊销、登录限流）
- ✅ 阶段三：团队体验（用户管理、DSH 多用户、活跃度追踪、Schema 版本管理）
- ✅ 团队在云部署环境下稳定运行至少 2 周

### 2.3 生成 Proxy Token

```bash
# 生成 24+ 字符的安全 Token（Workbench 和 Joycrew 必须使用相同值）
openssl rand -base64 32
# 输出示例：K7xN2mF8vQ3wR1yB6tZ0aE5cH9jL4sP7dG2uI8nM=
```

---

## 3. 快速部署（Docker）

### 3.1 独立部署 Joycrew

适用于 Joycrew 在单独机器上运行，Workbench 通过网络访问。

```bash
# 1. 克隆 Joycrew 仓库（或指定路径）
git clone <joycrew-repo-url> ../joycrew

# 2. 复制并编辑配置
cp .env.example .env
# 编辑 .env 中 Joycrew 部分：
#   JOYCREW_ENABLED=1
#   JOYCREW_BASE_URL=http://127.0.0.1:4000
#   JOYCREW_NETWORK_ZONE=local_loopback        # 本地部署
#   JOYCREW_AUTH_MODE=trusted_proxy
#   JOYCREW_TRUSTED_PROXY_TOKEN=<上一步生成的 Token>
#   JOYCREW_DB_PASSWORD=<PostgreSQL 密码>

# 3. 启动 Joycrew 服务
docker compose -f docker-compose.joycrew.yml up -d --build

# 4. 等待初始化完成（首次约 10-30 秒）
docker compose -f docker-compose.joycrew.yml logs -f joycrew-api
# 看到 "Server listening on 0.0.0.0:4000" 表示就绪

# 5. 验证健康状态
curl http://127.0.0.1:4000/health
# 期望返回：{"status":"ok","featureEnabled":true}
```

### 3.2 验证连通性

```bash
# 通过 Workbench BFF 验证（推荐）
# 确保 Workbench .env 中 JOYCREW_ENABLED=1 后重启 Workbench
curl -b "workbench_session=<your-jwt>" http://127.0.0.1:4173/api/joycrew/status
# 期望返回：
# {"enabled":true,"configured":true,"available":true,...}
```

---

## 4. 联合部署（Workbench + Joycrew）

### 4.1 Docker Compose 联合启动

```bash
# 同时启动 Workbench + Joycrew（共享网络）
docker compose -f docker-compose.yml -f docker-compose.joycrew.yml up -d --build

# 或生产环境（含 Nginx + TLS）
docker compose -f docker-compose.prod.yml -f docker-compose.joycrew.yml up -d --build
```

### 4.2 联合部署网络拓扑

```
外部访问
  │
  ▼
Nginx (443/TLS)  ──────────────►  Workbench (4173)
                                      │
                                      │ host.docker.internal:4000
                                      ▼
                                  Joycrew API (4000)  ──►  PostgreSQL (5432)
```

联合部署时，`.env` 中的网络配置：

```ini
# Workbench 调用 Joycrew（Docker 内部网络）
JOYCREW_ENABLED=1
JOYCREW_BASE_URL=http://host.docker.internal:4000
JOYCREW_NETWORK_ZONE=private_http        # Docker 环境
JOYCREW_AUTH_MODE=trusted_proxy
JOYCREW_TRUSTED_PROXY_TOKEN=<相同 Token>
```

### 4.3 Docker 外部部署（Joycrew 在宿主机）

如果 Joycrew 直接运行在宿主机（非 Docker），Workbench 在 Docker 中：

```ini
JOYCREW_ENABLED=1
JOYCREW_BASE_URL=http://host.docker.internal:4000
JOYCREW_NETWORK_ZONE=private_http
```

如果两者都在宿主机直接运行（无 Docker）：

```ini
JOYCREW_ENABLED=1
JOYCREW_BASE_URL=http://127.0.0.1:4000
JOYCREW_NETWORK_ZONE=local_loopback
```

---

## 5. 配置说明

### 5.1 Workbench 侧环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JOYCREW_ENABLED` | `0` | 总开关。`1` 启用，`0` 完全禁用（Fail-isolated） |
| `JOYCREW_BASE_URL` | `http://127.0.0.1:4000` | Joycrew API 地址 |
| `JOYCREW_NETWORK_ZONE` | `local_loopback` | 网络分区：`local_loopback`/`private_http`/`public_https` |
| `JOYCREW_AUTH_MODE` | `trusted_proxy` | 认证模式：`trusted_proxy`/`signed_session`/`fixture` |
| `JOYCREW_TRUSTED_PROXY_TOKEN` | （空） | 代理 Token，≥24 字符，Workbench 和 Joycrew 必须一致 |
| `JOYCREW_SESSION_TOKEN` | （空） | `signed_session` 模式下使用 |
| `JOYCREW_WORKSPACE_ID` | `ws-dongjue` | 工作空间 ID |
| `JOYCREW_USER_ID` | `user-chris` | 调用 Joycrew 时使用的用户 ID |
| `JOYCREW_ROLE` | `admin` | 调用 Joycrew 时的角色 |
| `JOYCREW_TIMEOUT_MS` | `20000` | 请求超时（毫秒） |
| `JOYCREW_MAX_RESPONSE_BYTES` | `2000000` | 响应大小上限（字节） |

### 5.2 Joycrew 侧环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | （必填） | PostgreSQL 连接串 |
| `JOYCREW_AUTH_MODE` | `trusted_proxy` | 认证模式（需与 Workbench 一致） |
| `JOYCREW_PROXY_TOKEN` | （必填） | 代理 Token（需与 Workbench 一致） |
| `JOYCREW_DEFAULT_WORKSPACE_ID` | `ws-dongjue` | 默认工作空间 |
| `JOYCREW_DB_NAME` | `joycrew` | PostgreSQL 数据库名 |
| `JOYCREW_DB_USER` | `joycrew` | PostgreSQL 用户名 |
| `JOYCREW_DB_PASSWORD` | （必填） | PostgreSQL 密码 |
| `JOYCREW_DATAWEAVE_URL` | （空） | DataWeave 服务地址（可选） |
| `JOYCREW_RUNTIME_MODE` | `mock` | 运行时模式：`mock`/`hermes` |

---

## 6. 身份与认证

### 6.1 推荐模式：trusted_proxy

```text
浏览器 ──Cookie Session──► Workbench BFF ──x-joycrew-proxy-token──► Joycrew API
                                           x-user-id
                                           x-workspace-id
                                           x-role
```

- Workbench 和 Joycrew 使用相同的 Proxy Token
- Token 仅存在于两个服务的环境变量中，浏览器永不接触
- Joycrew 通过 Token 信任 Workbench 的身份转发

### 6.2 备选模式

| 模式 | 适用场景 | 说明 |
|---|---|---|
| `signed_session` | Workbench 持有 Joycrew 短期 Session Token | `Authorization: Bearer <token>` |
| `fixture` | 非生产隔离测试 | 生产环境禁用（`NODE_ENV=production` 时拒绝） |

---

## 7. 网络分区策略

Workbench 客户端根据 `JOYCREW_NETWORK_ZONE` 强制校验 Joycrew API 地址：

| 分区 | 允许的地址 | 适用场景 |
|---|---|---|
| `local_loopback` | `http://127.0.0.0/8` 或 `localhost` | 本地开发、同机部署 |
| `private_http` | 私网 IP / `.local` / `.internal` / 内部域名 | Docker 联合部署、局域网 |
| `public_https` | 仅 HTTPS | 公网部署（Joycrew 暴露在公网时必须 HTTPS） |

**安全约束**：
- 禁止 URL 中携带用户名密码
- 禁止查询参数和 fragment
- 禁止非 HTTP(S) 协议
- 禁止公网明文 HTTP
- 禁止浏览器直连 Joycrew
- 禁止任意重定向

---

## 8. 投标业务流程建模

### 8.1 在 Joycrew 中创建业务结构

```text
Workspace（ws-dongjue）
  ├─ 客户：招商银行 / 中信证券 / 人保财险 / ...
  ├─ 企业项目：招商银行2026年AI风控系统招标
  ├─ AI 员工：投标分析师（配置 Skill: 商机调研/评分分析/竞品分析/方案起草）
  └─ Run 流程：商机调研 → 评分分析 → 竞品分析 → 方案起草
```

### 8.2 典型投标业务 Run 流程

```text
1. 商机调研（Skill: market_scan）
   ├─ 读取招标公告
   ├─ 提取关键信息（截止日期/资质要求/预算）
   └─ 产出：商机摘要

2. 评分分析（Skill: scoring_analysis）
   ├─ 分析我方优势/劣势
   ├─ 对比竞争对手
   └─ 产出：评分矩阵

3. 竞品分析（Skill: competitor_analysis）
   ├─ 收集竞争对手历史中标数据
   ├─ 分析竞品方案特点
   └─ 产出：竞品分析报告

4. 方案起草（Skill: proposal_drafting）
   ├─ 基于评分矩阵和竞品分析
   ├─ 起草技术方案大纲
   └─ 产出：方案草案 → 审批 → 交付物
```

### 8.3 在 Workbench 中操作

1. 访问 Workbench「业务执行」页面
2. 浏览 Joycrew 项目和客户列表
3. 选择项目 → 发起 Run（通过 Preview → Confirm → Execute）
4. 查看 Run 进度和 Evidence
5. 审批/拒绝交付物
6. 交付物确认后归档

---

## 9. 验证与 Pilot

### 9.1 部署验证清单

| 步骤 | 命令 | 期望结果 |
|---|---|---|
| PostgreSQL 健康 | `docker compose -f docker-compose.joycrew.yml ps postgres` | `healthy` |
| Joycrew API 健康 | `curl http://127.0.0.1:4000/health` | `{"status":"ok"}` |
| Workbench 连通 | `curl -b cookie http://127.0.0.1:4173/api/joycrew/status` | `"available":true` |
| 概览读取 | `curl -b cookie http://127.0.0.1:4173/api/joycrew/overview` | 返回 dashboard + customers |
| Doctor 诊断 | `npm run doctor` | Joycrew 检查项通过 |

### 9.2 Pilot 验证（按顺序执行）

| Pilot | 目的 | Runtime |
|---|---|---|
| 1. Mock Run | 验证 Preview → Confirm → Execute 全链路 | Mock |
| 2. 只读浏览 | 验证项目/客户/任务/审批/交付物列表渲染 | Mock |
| 3. 真实数据源 | 验证 DataWeave 飞书/文件源读取 | Mock + DataWeave |
| 4. Hermes Run | 验证真实 AI 员工执行能力 | Hermes |
| 5. 审批冲突 | 验证 SOURCE_CONFLICT 处理 | Mock |
| 6. 来源离线 | 验证故障降级行为 | Mock + 断开 DataWeave |

### 9.3 医生诊断

```bash
# 运行 Workbench Doctor 检查 Joycrew 连接
npm run doctor
# 关注 "Joycrew 业务执行" 检查项
```

---

## 10. 备份与运维

### 10.1 PostgreSQL 备份

```bash
# 在线备份（容器运行时）
docker compose -f docker-compose.joycrew.yml exec postgres \
  pg_dump -U joycrew joycrew | gzip > backups/joycrew-$(date +%Y%m%d).sql.gz

# 自动备份（cron）
# 每天凌晨 3 点
0 3 * * * docker compose -f /path/to/docker-compose.joycrew.yml exec -T postgres pg_dump -U joycrew joycrew | gzip > /path/to/backups/joycrew-$(date +\%Y\%m\%d).sql.gz
```

### 10.2 数据恢复

```bash
# 恢复 PostgreSQL
gunzip -c backups/joycrew-20260823.sql.gz | \
  docker compose -f docker-compose.joycrew.yml exec -T postgres psql -U joycrew joycrew
```

### 10.3 数据库运维

```bash
# 查看数据库状态
node scripts/db-info.mjs  # Workbench 数据库

# 查看表行数
docker compose -f docker-compose.joycrew.yml exec postgres \
  psql -U joycrew -c "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"

# VACUUM 分析
docker compose -f docker-compose.joycrew.yml exec postgres \
  psql -U joycrew -c "VACUUM ANALYZE;"
```

---

## 11. 故障排查

| 问题 | 原因 | 解决方案 |
|---|---|---|
| `JOYCREW_DISABLED` | `JOYCREW_ENABLED=0` 或未设置 | 设为 `1` 并重启 Workbench |
| `JOYCREW_UNREACHABLE` | Joycrew API 未启动或地址错误 | 检查 `docker compose ps`、`JOYCREW_BASE_URL` |
| `JOYCREW_TIMEOUT` | 请求超时（默认 20s） | 检查网络延迟，适当调大 `JOYCREW_TIMEOUT_MS` |
| `JOYCREW_CONFIGURATION_INVALID` | 配置缺失（如 Token 不足 24 字符） | 检查 `.env` 中 `JOYCREW_TRUSTED_PROXY_TOKEN` |
| `proxy_token_missing` | Token 为空或太短 | 生成 ≥24 字符 Token 并配置到两侧 |
| `base_url_unsafe` | URL 含用户名/密码/查询参数/fragment | 移除不安全部分 |
| `loopback_required` | `local_loopback` 模式但地址非 127.x | 改用 `private_http` 或修正地址 |
| `JOYCREW_RESPONSE_TOO_LARGE` | 响应超过 2MB 限制 | 检查 Joycrew 是否正常返回，调大 `JOYCREW_MAX_RESPONSE_BYTES` |
| `FEATURE_DISABLED` | Joycrew 功能开关关闭 | 在 Joycrew 侧启用功能开关 |
| `uncertain` | 请求已发出但结果不可验证 | 刷新业务状态核对，生成新预览（不要重试同一预览） |
| PostgreSQL 无法启动 | 数据卷权限问题 | `docker volume rm joycrew-pgdata` 后重新初始化（会丢数据） |
| PostgreSQL 连接拒绝 | 密码不匹配 | 确认 `JOYCREW_DB_PASSWORD` 两处一致 |

---

## 12. 安全清单

### 12.1 部署前检查

- [ ] `JOYCREW_TRUSTED_PROXY_TOKEN` ≥ 24 字符且 Workbench / Joycrew 两侧一致
- [ ] `JOYCREW_DB_PASSWORD` 已修改为强密码（非默认值）
- [ ] `JOYCREW_NETWORK_ZONE` 与实际网络环境匹配
- [ ] Joycrew API 不直接暴露到公网（仅通过 Workbench BFF 访问）
- [ ] PostgreSQL 端口不对外暴露（仅 Docker 内部网络）
- [ ] `JOYCREW_AUTH_MODE=fixture` 仅用于测试（生产环境会被拒绝）
- [ ] 浏览器无法获取 Joycrew Token / Base URL / 身份信息

### 12.2 运行时检查

- [ ] `/api/joycrew/status` 不回显 `baseUrl` / `proxyToken` / `userId`
- [ ] 所有写操作经过 Preview → Confirm → Execute 三阶段
- [ ] `safeJson` 递归脱敏 `token|secret|password|authorization|cookie|api.?key` 字段
- [ ] 响应大小限制生效（`JOYCREW_MAX_RESPONSE_BYTES`）
- [ ] 请求超时限制生效（`JOYCREW_TIMEOUT_MS`）
- [ ] 重定向被禁止（`redirect: 'error'`）

### 12.3 数据隔离确认

- [ ] Joycrew 数据不进入 Workbench 的 `state.json`
- [ ] Joycrew 数据不进入 Workbench backup
- [ ] Joycrew 数据不进入浏览器 localStorage
- [ ] 操作预览仅存在于进程内存（10 分钟过期后自动清理）

---

## 附录：部署顺序速查

```text
1. 生成 Proxy Token                    → openssl rand -base64 32
2. 克隆 Joycrew 仓库                    → git clone <joycrew-url> ../joycrew
3. 编辑 .env                           → JOYCREW_ENABLED=1 + Token + DB 密码
4. 启动 Joycrew 服务                    → docker compose -f docker-compose.joycrew.yml up -d --build
5. 等待 PostgreSQL 初始化               → docker compose logs -f postgres
6. 验证 Joycrew 健康                    → curl http://127.0.0.1:4000/health
7. 重启 Workbench                       → launchctl kickstart -k gui/$(id -u)/com.dongjue.personal-ai-workbench
8. 验证 Workbench 连通                  → curl -b cookie http://127.0.0.1:4173/api/joycrew/status
9. 运行 Doctor 诊断                     → npm run doctor
10. 浏览器验证业务执行页                 → 访问 Workbench → 业务执行
11. Mock Runtime Pilot                 → Preview → Confirm → Execute 全链路
12. 切换真实 Runtime（按需）              → JOYCREW_RUNTIME_MODE=hermes
```
