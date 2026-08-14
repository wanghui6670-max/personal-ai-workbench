# DeepSeek Harness Navigator P0

## 1. 目标与边界

Navigator 是右侧 AI Dock 中的持续只读工作导航员。它把 DeepSeek Harness 作为独立 Agent Runtime 使用，但不改变 Personal AI Workbench 的数据真源和业务规则。

```text
浏览器右侧 Navigator
        │ authenticated Joycrew API
        ▼
Personal AI Workbench Server
        │ random per-process token + local transport
        ▼
DeepSeek Harness stdio JSON-RPC child process
        │ fixed read-only tool bridge
        └──────────────► Workbench MCP domain tools
```

P0 只提供：

- 持续内存会话；
- 多步只读工具调用；
- 工具调用与结果轨迹；
- 左侧白名单页面导航；
- 明确的 Sidecar 状态与安全回退。

P0 不提供：

- Shell、终端或 Code Mode；
- 文件系统读取或写入；
- 任意 URL/Web 工具；
- 面向模型的 Jobs、Cron、Workflow 或 Subagent；
- Harness Session 持久化；
- 自动同步、创建、修改、归类、完成、归档或删除；
- 用 Harness 会话替代飞书项目长期记忆。

## 2. 数据真源

集成后仍维持以下边界：

| 数据 | 真源 |
|---|---|
| 真实项目成果 | 本地项目目录 |
| 代码与变更证据 | Git |
| 今日、待办、项目机器状态 | Workbench state |
| 项目分析、总结、复盘、上下文恢复叙事 | 绑定的飞书项目文档 |
| 本次 Navigator 对话与工具轨迹 | Harness 子进程内存 |
| Navigator 岗位和能力配置 | `harness/navigator.cordis.yml` |

Navigator 的 `sessionId` 只存在于当前浏览器模块内存和 Harness 子进程内存。它不写入 `state.json`、备份、`PROJECT.md`、飞书文档、`localStorage`、`sessionStorage` 或 IndexedDB。服务或页面重启后会话自然消失。

## 3. 固定只读能力

白名单由 `src/harness-policy.mjs` 显式维护。P0 工具是：

```text
panel_navigate
inbox_search
project_list
todo_list
journal_read
confirmation_list
business_list
project_records_read
```

这里使用“双重拒绝”而不是仅依赖模型提示：

1. 内部 Harness MCP 端点只列出固定白名单；
2. MCP Registry 执行时再次检查 `readOnly === true` 和白名单名称；
3. Harness 插件拒绝任何被标记为需要确认或非只读的工具；
4. 子进程没有加载 Shell、文件系统和其他执行插件。

新增一个普通 Workbench 只读工具不会自动暴露给 Navigator，必须单独评审并更新固定名单。

## 4. 进程与鉴权

Workbench 通过官方 `@deepseek-ai/dsh-sdk-client` 和 `@deepseek-ai/dsh-app-boot` 启动本仓库的最小 `runtime-bin.mjs` 子进程；运行服务仍由官方 SDK JSON-RPC Server 提供。Harness 使用 stdio JSON-RPC，不监听第二个 Web 端口。

父进程在每次启动时生成随机 256-bit bridge token，只通过“完全替换”的子进程环境传递。内部 `/api/harness/mcp` 同时要求：

- 本机 loopback，或同一主机对具体绑定地址的自连接；
- 正确的随机 Bearer token；
- 严格 JSON 请求体；
- 固定只读工具白名单。

该 token 不写入 `.env`、状态、日志、备份或浏览器。

传给 Harness 子进程的环境使用允许名单，只保留必要的系统路径、代理/CA 变量、一个 Provider 凭证和内部 bridge token。父进程的 `SESSION_SECRET`、`CAPTURE_TOKEN`、工作台密码和其他凭证不会继承。

## 5. 安装和启用

Harness 依赖被隔离在 `harness/package.json`，固定为已审阅的开发者预览版本 `0.1.0-rc.6`。安装入口使用官方 `@deepseek-ai/dsh` 发行包提供其内部核心依赖闭包，但 Cordis 配置只挂载第 3 节列出的最小只读运行树。普通 Workbench 继续保持根项目无运行时依赖；未安装 Sidecar 时左侧功能完全可用。

要求：

- 普通 Workbench：Node 20+；
- Harness Sidecar：Node 22.19+ 或 Node 24+；
- 推荐统一使用 Node 24。

安装：

```bash
npm run harness:install
```

最低配置：

```dotenv
HARNESS_ENABLED=1
OPENAI_API_KEY=<deployment secret>
OPENAI_MODEL=<approved model id>
```

默认复用现有 `OPENAI_*` 或 `AI_PROVIDER_*` 配置。也可以显式覆盖：

```dotenv
HARNESS_ENABLED=1
HARNESS_PROVIDER_MODEL=<approved model id>
HARNESS_PROVIDER_API_KEY=<deployment secret>
HARNESS_PROVIDER_API=openai-responses
HARNESS_PROVIDER_BASE_URL=https://api.openai.com/v1
HARNESS_PROVIDER_CONTEXT_WINDOW=131072
HARNESS_PROVIDER_MAX_TOKENS=4096
HARNESS_REQUEST_TIMEOUT_MS=180000
```

`HARNESS_PROVIDER_API` 仅允许：

```text
openai-responses
openai-completions
```

公网 Provider 必须使用 HTTPS。只有显式 `HARNESS_PROVIDER_NETWORK_ZONE=local_loopback` 时，才允许 `http://localhost`、`127.0.0.0/8` 或 `::1`。

## 6. 运行时失败语义

- `HARNESS_ENABLED` 未启用：右侧显示“未启用”，原 AI 控制器继续可用；
- Node 版本不足：不启动子进程；
- 依赖未安装：不启动子进程，并提示运行安装命令；
- Provider 缺模型或 Key：不启动子进程；
- Sidecar 启动失败：返回 `503 HARNESS_START_FAILED`；
- 本轮模型或传输失败：返回 `502 HARNESS_RUN_FAILED`；
- 同一 Session 并发执行：返回 `409 HARNESS_SESSION_BUSY`；
- 无论哪一种失败，都不修改左侧业务状态。

系统不会因为 Provider 失败而静默把请求转发到另一家 Provider。

## 7. 验证

根项目合同测试：

```bash
npm run test:files
```

Harness 独立安装与组合编译：

```bash
npm run harness:install
npm run harness:check
```

`harness:check` 会启动一个本地假的只读 bridge，加载真实的 Cordis composition，初始化官方 SDK runtime，然后关闭；它不发送真实模型请求。

CI 分成两个阻塞任务：

1. Node 24 语法和全部 Workbench 合同测试；
2. 安装固定 Harness 依赖并完成 composition initialize smoke test。

这些测试不等于 live Provider、live 飞书、真实浏览器设备矩阵或生产部署验证。首次启用后仍需使用非生产数据完成一次人工 smoke test。

## 8. 后续阶段

P1 才考虑一次性审批的写工具桥，例如 `inbox_add`、`todo_update`、`todo_today` 和 `project_sync`。P1 必须同时满足：

```text
Harness approval allowed-once
+ Workbench 工具参数可见
+ Workbench 领域层二次校验
+ 幂等/lease/stale/unknown-outcome 原语义
+ 执行后状态读回
```

在 P1 完成前，不得通过扩大 P0 白名单绕过确认机制。

## 9. 已知限制

- 标准 Docker 镜像继续保持轻量，当前不会在镜像构建中安装 `harness/node_modules`；容器内启用前需要单独设计并验证 Node 24/运行库镜像层。未安装时系统只显示 `packages_missing`，左侧工作台仍正常。
- P0 SDK wire 尚不承载人在回路审批，因此只开放无需审批的只读工具；写工具必须等待 P1 approval bridge。
- 当前没有提交 `harness/package-lock.json`；CI 每次安装固定的直接依赖版本并执行初始化 smoke test。进入生产发布前应在受控 Node 24 环境生成并审查 lockfile。
