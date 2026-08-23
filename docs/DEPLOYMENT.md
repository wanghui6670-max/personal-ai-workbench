# Personal AI Workbench 部署指南

## 1. 本地开发部署

### 1.1 前置要求

- Node.js >= 20.0.0
- npm

### 1.2 步骤

```bash
# 克隆仓库
git clone <repo-url> && cd personal-ai-workbench

# 安装依赖
npm ci

# 配置环境变量
cp .env.example .env
# 编辑 .env，至少设置 SESSION_SECRET（至少 24 字符）

# 启动服务
npm start
# 服务默认监听 http://127.0.0.1:4173
```

### 1.3 多用户模式

v3.1 默认启用多用户模式（`STORE_BACKEND=sqlite`）：

1. 在 `.env` 中设置 `WORKBENCH_ADMIN_USERNAME` 和 `WORKBENCH_ADMIN_PASSWORD`
2. 首次启动时自动创建管理员账户
3. 访问 `/login` 登录，之后通过 `/users` 页面管理其他用户

## 2. Docker 部署（局域网）

适用于团队内部网络，不需要 HTTPS。

### 2.1 配置

```bash
cp .env.example .env
# 编辑 .env：
#   WORKBENCH_ADMIN_USERNAME=admin
#   WORKBENCH_ADMIN_PASSWORD=<强密码>
#   SESSION_SECRET=<至少 24 字符随机字符串>
#   TRUSTED_ORIGINS=http://your-server-ip:4173
#   COOKIE_SECURE=0  （局域网 HTTP 时保持 0）
```

### 2.2 启动

```bash
docker compose up -d --build
```

服务监听 `http://your-server-ip:4173`。

### 2.3 资源限制

docker-compose.yml 已配置默认资源限制（512MB 内存 / 1 CPU）。5-10 人团队足够使用，如有 DSH Copilot 等重计算场景，可适当提高：

```yaml
deploy:
  resources:
    limits:
      memory: 1G
      cpus: '2.0'
```

## 3. 云服务器部署（HTTPS + Nginx 反代）

适用于公网部署，通过 Nginx 终结 TLS。

### 3.1 前置要求

- 一台云服务器（推荐 2C4G 以上）
- 域名已解析到服务器 IP
- TLS 证书（可用 Let's Encrypt / certbot 免费获取）

### 3.2 配置

```bash
cp .env.example .env
# 编辑 .env，确保以下配置：
#   STORE_BACKEND=sqlite
#   WORKBENCH_ADMIN_USERNAME=admin
#   WORKBENCH_ADMIN_PASSWORD=<强密码>
#   SESSION_SECRET=<至少 24 字符随机字符串>
#   TRUSTED_ORIGINS=https://your-domain.com
#   COOKIE_SECURE=1          ← HTTPS 时必须设为 1
#   JWT_MAX_AGE=2592000      ← 可选，默认 30 天
```

### 3.3 TLS 证书

```bash
mkdir -p certs

# 方式一：使用 certbot 获取 Let's Encrypt 证书
# （先临时启动 HTTP 服务以通过 ACME 验证）
certbot certonly --standalone -d your-domain.com
cp /etc/letsencrypt/live/your-domain.com/fullchain.pem ./certs/
cp /etc/letsencrypt/live/your-domain.com/privkey.pem  ./certs/

# 方式二：使用已有证书
cp /path/to/fullchain.pem ./certs/
cp /path/to/privkey.pem   ./certs/
```

### 3.4 启动

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

服务通过 Nginx 暴露在 `https://your-domain.com`。

### 3.5 Nginx 配置说明

`nginx.conf` 已包含：
- HTTP → HTTPS 自动重定向
- TLS 1.2/1.3 + 安全密码套件
- HSTS 头（max-age=31536000）
- WebSocket 支持（DSH 实时交互）
- 300 秒读取超时（DSH 长任务）
- 50MB 上传限制

如需修改域名或添加多个域名，编辑 `nginx.conf` 中的 `server_name`。

## 4. 数据备份

### 4.1 数据目录

SQLite 数据库和用户数据存储在 `DATA_DIR`（默认 `./data`）：
- `workbench.db` — SQLite 数据库
- `workbench.db-wal` — WAL 日志（运行时）
- `workbench.db-shm` — 共享内存（运行时）

### 4.2 备份策略

```bash
# 在线备份（WAL 模式下安全）
sqlite3 ./data/workbench.db ".backup './backups/workbench-$(date +%Y%m%d).db'"

# 或直接复制（需暂停服务）
docker compose stop workbench
cp ./data/workbench.db ./backups/
docker compose start workbench
```

建议配置 cron 定时备份：

```bash
# 每天凌晨 3 点自动备份
0 3 * * * sqlite3 /path/to/data/workbench.db ".backup '/path/to/backups/workbench-$(date +\%Y\%m\%d).db'"
```

## 5. 升级

```bash
# 拉取最新代码
git pull origin main

# 重新构建并启动
docker compose -f docker-compose.prod.yml up -d --build
```

数据库 schema 通过 `_schema_version` 版本管理自动迁移，启动时自动执行未完成的迁移，无需额外操作。可用 `node scripts/db-info.mjs` 查看数据库状态和版本。

## 7. Joycrew 部署（可选）

Joycrew 是企业级 AI 员工业务执行服务，与 Workbench 联合部署。详细部署指南见 [Joycrew 部署指南](./JOYCREW_DEPLOYMENT.md)。

快速启动：

```bash
# 确保 .env 中 JOYCREW_ENABLED=1 + Token 配置
docker compose -f docker-compose.yml -f docker-compose.joycrew.yml up -d --build
```

## 6. 故障排查

| 问题 | 原因 | 解决方案 |
|---|---|---|
| 启动报 421 | TRUSTED_ORIGINS 未配置或域名不匹配 | 设置 `TRUSTED_ORIGINS=https://your-domain.com` |
| 启动拒绝：未启用认证 | 公网绑定但无密码 | 设置 `WORKBENCH_ADMIN_PASSWORD` 或 `WORKBENCH_PASSWORD` |
| 启动拒绝：SESSION_SECRET | 密钥太短或使用了默认值 | 设置至少 24 字符的随机字符串 |
| SQLite SQLITE_BUSY | 并发写入冲突 | 已通过 busy_timeout=5000 缓解，如仍出现需检查是否有多个进程写入同一数据库 |
| better-sqlite3 编译失败 | Alpine 缺编译工具链 | Dockerfile 已添加 python3/make/g++，本机需 `apk add python3 make g++` |
| Cookie 不生效 | HTTPS 下未设 Secure | 确保 `COOKIE_SECURE=1` |
