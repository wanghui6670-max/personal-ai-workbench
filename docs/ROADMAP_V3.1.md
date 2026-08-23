# 多用户工作台 + Joycrew 整体规划（v3.1→v3.2）

> 日期：2026-08-23
> 版本：v3.1（当前）→ v3.2（目标）
> 部署目标：云服务器，5-10 人小团队

## 当前状态

### 已完成

| 能力 | commit | 说明 |
|---|---|---|
| 多用户认证 | d638ddf | SQLite + JWT Cookie + per-user 数据隔离 |
| 管理员数据查看 | 5cd2ae1 | /api/admin/all-state + 用户管理页查看数据弹窗 |
| DSH 语音输入 | 411e588 | 麦克风按钮 + Web Speech API |
| 需求文档更新 | 7319141 | PRODUCT_SPEC / UNIFIED_PRODUCT / README / ARCHITECTURE |

### 架构现状

```
用户登录（用户名/密码）→ JWT Cookie → storeAdapter.scope(userId) → SQLite（按 userId 隔离）
管理员：用户管理 + 全员数据概要查看
DSH Copilot：harnessRunScope 绑定当前用户 → scopedStore
```

---

## 阶段一：云部署就绪（P0 阻塞项）

> 目标：让工作台能在云服务器上稳定运行，多人并发不崩溃。

### 1.1 SQLite 并发安全

- **问题**：未设置 `busy_timeout`，多用户并发写入会 `SQLITE_BUSY` 崩溃
- **方案**：`db.pragma('busy_timeout', 5000)` + WAL 模式确认
- **文件**：`src/db.mjs`
- **复杂度**：S（< 20 行）

### 1.2 Dockerfile 修复

- **问题**：Alpine 镜像缺少 `better-sqlite3` 编译依赖（python3/make/g++），构建可能失败
- **方案**：Dockerfile build 阶段添加 `apk add --no-cache python3 make g++`
- **文件**：`Dockerfile`
- **复杂度**：S

### 1.3 云部署环境变量补全

- **问题**：`TRUSTED_ORIGINS` 为空（公网访问被 421 拒绝）、`COOKIE_SECURE=0`（HTTPS 下 Cookie 不安全）
- **方案**：
  - `.env.example` 补充多用户/云部署配置说明
  - 新增 `JWT_MAX_AGE` 环境变量（会话超时可配置，当前硬编码 30 天）
  - 启动时校验必填项（`SESSION_SECRET`、`TRUSTED_ORIGINS`）
- **文件**：`.env.example`、`src/auth.mjs`、`src/env.mjs`
- **复杂度**：M

### 1.4 安全响应头补全

- **问题**：缺少 HSTS、`upgrade-insecure-requests`
- **方案**：HTTPS 模式下自动添加 `Strict-Transport-Security` 和 `upgrade-insecure-requests`
- **文件**：`src/http.mjs`
- **复杂度**：S

### 1.5 Docker Compose 多用户适配

- **问题**：compose 未显式传递多用户变量、无资源限制、无 Nginx 反代
- **方案**：
  - `docker-compose.yml` 添加多用户环境变量透传
  - 添加 `deploy.resources` 资源限制
  - 新增 `docker-compose.prod.yml`（含 Nginx 反代 + TLS）
- **文件**：`docker-compose.yml`、`docker-compose.prod.yml`（新建）、`nginx.conf`（新建）
- **复杂度**：M

### 1.6 部署文档

- **问题**：`docs/DEPLOYMENT.md` 完全缺少多用户 + 云服务器部署说明
- **方案**：新增云部署章节（systemd/Docker + Nginx + TLS + 初始管理员 + 备份策略）
- **文件**：`docs/DEPLOYMENT.md`
- **复杂度**：M

---

## 阶段二：安全加固（P1 上线前必须完成）

> 目标：达到生产级安全基线，可面向公网开放。

### 2.1 密码策略强化

- **问题**：密码最低 6 字符，无复杂度要求
- **方案**：提升到 8+ 字符，要求至少包含字母 + 数字
- **文件**：`src/user-manager.mjs`
- **复杂度**：S

### 2.2 JWT Token 吊销

- **问题**：用户删除/改密码后旧 token 仍有效（JWT 无状态，无黑名单）
- **方案**：在 SQLite 中维护 `token_blacklist` 表，记录已吊销的 `jti`；每次请求校验
- **文件**：`src/auth.mjs`、`src/db.mjs`、`src/store-sqlite.mjs`
- **复杂度**：L

### 2.3 登录限流优化

- **问题**：限流仅按 IP，反向代理后所有请求看起来都来自同一 IP
- **方案**：限流 key 改为 `IP + 用户名`，反代场景下解析 `X-Forwarded-For`
- **文件**：`src/auth.mjs`、`src/http.mjs`
- **复杂度**：M

### 2.4 凭据管理 per-user 隔离

- **问题**：凭据管理仍走全局 JsonStore，多用户下共享而非隔离
- **方案**：将凭据存储迁移到 SQLite，按 `userId` 隔离
- **文件**：`src/store-adapter.mjs`、`src/store-sqlite.mjs`
- **复杂度**：M

---

## 阶段三：团队使用体验（P2 迭代完善）

> 目标：让管理员和团队成员用得顺手。

### 3.1 用户管理页面增强

- 批量操作（批量删除/禁用/改角色）
- 搜索筛选（按用户名/角色）
- 编辑表单（改角色 + 显示名，替代 prompt()）
- 管理员重置用户密码（不要求旧密码）
- 用户启用/禁用（替代只有删除）
- **文件**：`public/users.js`、`public/users.html`、`src/user-manager.mjs`、`src/server.mjs`
- **复杂度**：L

### 3.2 DSH Copilot 多用户适配

- 更新 `navigator.cordis.yml` 系统提示词：服务当前登录用户、数据隔离说明、隐私边界
- 注入当前用户上下文（姓名/角色）
- **文件**：`harness/navigator.cordis.yml`、`src/harness-navigator.mjs`
- **复杂度**：M

### 3.3 用户活跃度追踪

- `users` 表新增 `lastLoginAt` 字段
- 登录时更新
- 用户管理页显示最后登录时间
- **文件**：`src/db.mjs`、`src/user-manager.mjs`、`src/auth.mjs`、`public/users.js`
- **复杂度**：M

### 3.4 SQLite 运维

- schema 版本管理（`schema_migrations` 表 + 迁移脚本框架）
- 活动日志 TTL 清理（保留最近 90 天）
- 定时 VACUUM
- **文件**：`src/db.mjs`、`src/store-sqlite.mjs`
- **复杂度**：M

---

## 阶段四：Joycrew 部署规划（P3 后续）

> 目标：在投标业务流程跑通后，引入企业级 AI 员工业务执行能力。
> 前置条件：阶段一~三完成，团队在云部署环境下稳定运行至少 2 周。

### 4.1 Joycrew 服务部署

- PostgreSQL 部署（Docker）
- DataWeave 部署
- Joycrew API 部署（Docker）
- `JOYCREW_ENABLED=1` + 认证配置
- **新建**：`docker-compose.joycrew.yml`、`docs/JOYCREW_DEPLOYMENT.md`
- **复杂度**：XL

### 4.2 投标业务流程建模

- 在 Joycrew 中创建客户（银行/券商/保险等）
- 建立企业项目（招标项目）
- 配置 AI 员工和 Skill
- 定义 Run 流程（商机调研 → 评分分析 → 竞品分析 → 方案起草）
- **复杂度**：XL（业务设计 + 技术实现）

### 4.3 Joycrew 与工作台联调

- `/api/joycrew/status` 实时探测
- 业务执行页联调
- Harness Copilot Joycrew 工具联调
- Pilot 验证（Mock Runtime → 真实 Run）
- **复杂度**：L

---

## 执行顺序与依赖关系

```
阶段一（云部署就绪）
  1.1 SQLite 并发安全 ──┐
  1.2 Dockerfile 修复 ──┤
  1.3 环境变量补全 ─────┤── 1.5 Docker Compose ── 1.6 部署文档
  1.4 安全响应头 ───────┘

阶段二（安全加固）── 依赖阶段一完成
  2.1 密码策略 ──┐
  2.2 Token 吊销 ┤── 2.3 登录限流 ── 2.4 凭据隔离
                 ┘

阶段三（团队体验）── 依赖阶段二完成
  3.1 用户管理增强 ──┐
  3.2 DSH 多用户适配 ┤── 3.3 活跃度追踪 ── 3.4 SQLite 运维
                     ┘

阶段四（Joycrew）── 依赖阶段三 + 业务流程跑通
  4.1 服务部署 ── 4.2 业务建模 ── 4.3 联调
```

## 工作量估算

| 阶段 | 任务数 | 估算工作量 | 阻塞条件 |
|---|---|---|---|
| 一 | 6 | 2-3 天 | 无 |
| 二 | 4 | 2-3 天 | 阶段一完成 |
| 三 | 4 | 3-4 天 | 阶段二完成 |
| 四 | 3 | 5-7 天 | 阶段三完成 + 业务流程跑通 |
| **合计** | **17** | **12-17 天** | |

---

## 风险与缓解

| 风险 | 缓解措施 |
|---|---|
| SQLite 并发瓶颈（>10 人） | 阶段一设置 busy_timeout + WAL；长期可迁移到 PostgreSQL |
| Docker 镜像构建失败 | 阶段一修复 Dockerfile，CI 验证 |
| 反向代理 IP 解析错误 | 阶段二限流改为 IP+用户名，不依赖 X-Forwarded-For 唯一性 |
| Joycrew 部署复杂度高 | 推迟到阶段四，先用 Mock Runtime 验证 |
| 数据备份遗漏 | 阶段一部署文档包含 SQLite 定时备份策略 |
