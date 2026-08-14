# DeepSeek Harness Navigator V1

## 结论

Navigator 是工作台右侧可正式使用的只读工作导航员。它使用 DeepSeek Harness 提供持续会话、多步工具调用和执行轨迹，但不接管 Workbench 的业务状态、项目文件、Git 或飞书项目记忆。

```text
浏览器右侧 Navigator
        │ 已登录的 Workbench API
        ▼
Personal AI Workbench Server
        │ 本机连接 + 随机进程 Token
        ▼
DeepSeek Harness stdio Sidecar
        │ 固定只读工具桥
        ▼
Workbench MCP Registry / Domain
```

## 可用能力

- 查看今日待办、收件箱、项目、工作日志、待确认事项和业务板块；
- 读取项目绑定的飞书分析与阶段总结；
- 在同一个会话中连续追问；
- 展示实际工具调用和结果；
- 打开左侧对应页面；
- Sidecar 出错时不影响左侧工作台和原有确认式 AI 控制器。

## 固定安全边界

V1 是完整的**只读导航功能**，不是通用执行代理。它不能创建、修改、删除、归类、同步、完成、归档或写入飞书，也没有 Shell、终端、文件系统写入、任意 Web、Jobs、Cron、Workflow、Subagent 或持久化 Session。

允许的工具只有：

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

父进程按名称和 `readOnly` 属性过滤；子进程再次校验工具数量、名称、只读标记和确认要求。新增普通 MCP 工具不会自动进入 Navigator。

## 数据真源

| 数据 | 真源 |
|---|---|
| 项目成果 | 本地项目目录 |
| 代码变更 | Git |
| 今日、待办、项目机器状态 | Workbench State |
| 项目分析、总结、复盘、恢复叙事 | 绑定的飞书项目文档 |
| 本次对话与执行轨迹 | 浏览器模块内存 + Harness 子进程内存 |

Navigator 会话不进入 `state.json`、Backup、`PROJECT.md`、飞书、`localStorage`、`sessionStorage` 或 IndexedDB。页面或服务重启后开启新会话。

## 安装与启用

推荐 Node 24。本地源码运行：

```bash
npm run harness:install
npm run harness:check
npm run harness:e2e
```

然后在 `.env` 中启用：

```dotenv
HARNESS_ENABLED=1
OPENAI_API_KEY=<deployment secret>
OPENAI_MODEL=<approved model id>
```

也可以通过 `HARNESS_PROVIDER_*` 使用已批准的 OpenAI Responses / Chat Completions 兼容网关。公网 Provider 必须使用 HTTPS；本机 HTTP 仅在 `HARNESS_PROVIDER_NETWORK_ZONE=local_loopback` 时允许。

Docker 镜像使用 Node 24 并预装生产 Harness 依赖，不需要进入容器手工安装。只需通过 `.env` 提供启用标记和 Provider 配置。

## 可重复验证

```bash
npm run test:files
npm run harness:check
npm run harness:e2e
docker build -t personal-ai-workbench .
```

验证层包括：

1. Workbench 全量合同测试；
2. Harness 真实 Cordis Composition 初始化；
3. 无真实密钥的确定性端到端：Prompt → Agent Tool Call → 本机 Bridge → MCP Result → Assistant Reply；
4. 同一 Harness Session 的第二轮连续对话；
5. Docker 镜像内 Harness 初始化和 Workbench `/api/health`；
6. 固定工具白名单和无浏览器持久化合同。

真实 Provider 和真实飞书由部署凭证决定，代码不会保存或回显这些凭证；无法访问外部服务时会明确报错，不会伪装成功或静默切换 Provider。
