# Personal AI Workbench × Joycrew 集成合同

> 版本：2.0.0  
> 状态：统一产品运行合同  
> 原则：一个用户入口、两个清晰领域、服务端身份、外部改变必须确认

## 1. 产品关系

Personal AI Workbench 是用户每天打开的唯一产品界面。Joycrew 不被复制为第二套前端，而作为企业业务与 AI 员工执行服务接入。

```text
Browser
  │ Workbench Cookie Session
  ▼
Personal AI Workbench Server
  │ Trusted Proxy / Signed Session
  ▼
Joycrew API
  ├── PostgreSQL：Project / Employee / Run / Evidence / Approval / Deliverable
  ├── DataWeave：飞书、本机、服务器资料按需读取
  └── Runtime：Mock 或 Hermes
```

## 2. 对象所有权

### Workbench 拥有

- 个人收件箱；
- GetNote 外部待办映射；
- 个人待办和“我的今日”；
- 个人工作日志；
- 本地项目目录身份；
- Git 证据指针；
- Capture 幂等收据；
- 飞书项目记录指针和跨资源恢复凭据。

### Joycrew 拥有

- Workspace 内可见客户和业务任务；
- 企业项目执行视图；
- AI 员工、版本、Skill Version 和 Grant；
- Run 生命周期；
- Evidence Package；
- Approval；
- Deliverable 来源链；
- DataWeave 与 Runtime 调用审计。

### 外部真源

- 飞书项目文档：分析、阶段总结、复盘和恢复叙事；
- 飞书 Bitable 或指定业务系统：结构化业务记录；
- 本地目录：工作文件；
- 服务器目录：运行资料和正式交付；
- Git/GitHub：代码版本。

## 3. 身份合同

推荐 `trusted_proxy`：

```text
x-joycrew-proxy-token
x-user-id
x-workspace-id
x-role
x-correlation-id
x-request-id
```

Token 仅存在于 Workbench 与 Joycrew 服务端环境中。Workbench 的浏览器 API 不接受用户提供的 Joycrew Token、Base URL、Workspace 身份或角色覆盖。

支持的备选模式：

- `signed_session`：Workbench 服务端保存短期 Joycrew Session Token；
- `fixture`：只允许非生产隔离测试。

## 4. 网络合同

```text
local_loopback  → 只允许 http://127.0.0.0/8 或 localhost
private_http    → HTTP 仅允许私网、主机名或内部域名
public_https    → 强制 HTTPS
```

拒绝：

- URL 用户名或密码；
- 查询参数和 fragment；
- 非 HTTP(S) 协议；
- 公网明文 HTTP；
- 浏览器直连 Joycrew；
- 任意重定向；
- 超过大小限制的响应。

## 5. 读取能力

Workbench BFF 暴露经过认证和限流的只读聚合：

```text
/api/joycrew/status
/api/joycrew/overview
/api/joycrew/projects/:projectId
```

`overview` 聚合 Joycrew 的 health、meta、bootstrap、dashboard、customers 和 tasks。它不形成长期缓存，也不写入 Workbench 状态。

## 6. 外部改变：Preview → Confirm → Execute

支持三种动作：

```text
run.create
  projectId + task + employeeId + explicit sources

deliverable.create
  runId + title

approval.decide
  approvalId + approve|reject
```

### Prepare

`POST /api/joycrew/actions/prepare`

- 完整本地校验；
- 拒绝绝对路径、目录穿越、过深对象和过大参数；
- 生成高熵 action ID；
- 生成规范化 payload、SHA-256 摘要、影响范围和过期时间；
- 不调用 Joycrew；
- 默认 10 分钟过期；
- 仅保存在进程内存。

### Execute

`POST /api/joycrew/actions/:id/execute`

```json
{"confirmed":true}
```

- 没有 `confirmed=true` 返回冲突；
- 过期、取消或正在执行的预览不会再次调用 Joycrew；
- 同一已执行 action 重放返回原结果，不产生第二个 Run/交付；
- Joycrew 仍然执行 Workspace、角色、Employee Grant、Evidence、审批和源状态检查；
- 配置未启用等明确前置失败保持 pending；请求已发出但结果不可验证时标记为 uncertain，并禁止同一预览直接重试；
- 执行结果被安全裁剪后短时保留，便于 readback。

### Cancel

`POST /api/joycrew/actions/:id/cancel`

取消只删除执行授权，不改变 Joycrew。

## 7. Harness 合同

Harness 固定白名单包含：

```text
Workbench reads
panel_navigate
inbox_search
project_list
todo_list
journal_read
confirmation_list
business_list
project_records_read

Joycrew reads
joycrew_workspace_open
joycrew_status_read
joycrew_dashboard_read
joycrew_project_list
joycrew_project_read
joycrew_customer_list
joycrew_task_list
joycrew_approval_list
joycrew_deliverable_list
joycrew_pending_action_list

Joycrew previews
joycrew_run_prepare
joycrew_deliverable_prepare
joycrew_approval_prepare
```

Workbench 的直接写工具不向 Harness 暴露。Joycrew `*_prepare` 也不执行外部改变。新增普通 MCP 工具不会自动进入 Harness，必须同步审查父进程和 stdio 代理的固定名称集合。

## 8. 故障行为

| 故障 | 必须表现 | 禁止行为 |
|---|---|---|
| Joycrew 未启用 | 业务执行页显示配置边界；个人工作台正常 | 阻止 Workbench 启动 |
| Joycrew 不可达 | `JOYCREW_UNREACHABLE`，提示个人侧不受影响 | 使用旧结果冒充实时 |
| Joycrew 超时 | `JOYCREW_TIMEOUT`，可重试 | 静默伪造成功 |
| 身份失败 | 原样映射受控错误码 | 将 Token 返回浏览器 |
| Run 数据源缺失 | Prepare 阶段拒绝 | 自动扩大读取范围 |
| 文件路径穿越 | Prepare 阶段拒绝 | 把任意路径转给 DataWeave |
| 审批期间源改变 | Joycrew 返回 `SOURCE_CONFLICT` | 覆盖人工修改 |
| 重复确认 | 返回已执行结果 | 创建第二个 Run/交付 |

## 9. 数据不复制

以下内容不进入 `state.json`、Workbench backup 或浏览器持久化：

- Joycrew Token；
- 客户数据库副本；
- Run/Evidence/Approval/Deliverable 完整副本；
- Hermes 凭据；
- DataWeave 凭据；
- 操作预览；
- 项目叙事正文。

浏览器只保存当前页面内存状态。重新加载后重新按需读取 Joycrew。

## 10. 部署顺序

1. 启动 Joycrew PostgreSQL、DataWeave、Joycrew API；
2. 让 Joycrew 使用 `trusted_proxy`；
3. 配置相同 Proxy Token 到 Workbench 服务端；
4. `npm run doctor` 检查连接；
5. 打开“业务执行”，验证项目、员工、Run、Evidence、审批和交付读取；
6. 用 Mock Runtime 完成 Run 预览→确认→Evidence；
7. 在脱敏测试环境验证真实飞书和文件源；
8. 验证 Hermes 请求、超时、错误和取消合同后再切换 Runtime；
9. 至少执行正常、来源离线、审批冲突三类 Pilot。

## 11. 验证边界

仓库自动测试证明合同和隔离路径可运行，不声称真实飞书、Mac Local Bridge、服务器目录、Hermes 或生产权限已现场验收。任何 live 状态只能由部署环境的真实健康检查与 Pilot 证据确认。


## 不确定结果保护

Joycrew 写操作在网络中断、响应丢失或返回不可验证结果时会标记为“结果不确定”。同一个预览不会自动重试，避免重复创建 Run、交付或写回；用户应先刷新业务状态核对，再决定是否生成新的预览。
