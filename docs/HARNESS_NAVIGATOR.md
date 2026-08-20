# DeepSeek Harness Navigator V1

## 结论

Navigator 是工作台右侧的正式 Agent 运行层。它使用 DeepSeek Harness 提供持续会话、多步工具调用和执行轨迹，但不接管 Workbench 的业务状态、项目文件、Git、飞书项目记忆或 Joycrew 的业务对象。

默认界面是 Workbench 自己的薄右侧面板：

```text
浏览器右侧 Workbench Harness UI
        │ 已登录的 Workbench API
        ▼
Personal AI Workbench Server
        │ 本机连接 + 随机进程 Token
        ▼
DeepSeek Harness SDK Sidecar
        │ 单一、版本化工具 Manifest
        ▼
Workbench MCP Registry / Joycrew BFF
```

这条路径是生产默认值。独立 DSH Web UI 只作为显式实验模式存在，不会因为配置了一个 URL 就自动接管右侧面板。

## 可用能力

- 查看今日待办、收件箱、项目、工作日志、待确认事项和业务板块；
- 盘点单个项目的本地资产、待办计数、Git 与飞书绑定指针；
- 在项目本地指针中检索知识章节，不读取飞书正文；
- 读取项目绑定的飞书分析与阶段总结；
- 读取 Joycrew 的客户、项目、业务任务、AI 员工、Run、Evidence、审批和交付；
- 在同一个会话中连续追问；
- 展示实际工具调用和结果；
- 打开左侧或中间的对应页面；
- 为 Joycrew Run、交付和审批生成 preview-only 操作；
- Sidecar 或外部 DSH Web 异常时不影响左侧工作台。

## 工作台只读可见面

- `#project/<id>` 的五章知识索引只组织现有项目页和指针级元数据，不读取飞书、备忘或项目文件正文。
- `#crew` / `#skills` 只盘点本机员工与 Skill 的结构化目录和 DSH localhost 状态；复制派单命令不等于执行，不会自动安装 Skill、创建员工或启动任务。
- 两个界面都受现有 Workbench 登录门保护，不新增外部写入能力。

## 固定安全边界

Navigator 不拥有 Shell、终端、文件系统写入、任意 Web、Jobs、Cron、Workflow、Subagent 或持久化 Session。

允许的工具清单只有一个权威来源：

```text
src/harness-policy.mjs
```

该文件同时定义：

- `HARNESS_COMPOSITION_ID`；
- `HARNESS_NAVIGATOR_TOOL_ALLOWLIST`；
- `HARNESS_NAVIGATOR_TOOL_CATALOG_SHA256`。

Workbench MCP Bridge 和 Harness stdio 代理都读取同一个 Manifest，不再手工维护两份工具名称。新增普通 MCP 工具不会自动进入 Harness，必须修改该 Manifest 并通过审查和测试。

Joycrew 的 `*_prepare` 工具只创建短时操作预览，不执行外部改变。没有中间页面的确认回执时，Harness 不得声称 Run、交付或审批已经完成。

## 默认 UI 模式

```dotenv
HARNESS_ENABLED=1
HARNESS_UI_MODE=workbench
```

`workbench` 模式使用仓库内的薄 UI：

- 消息列表；
- 当前页面上下文；
- 工具调用轨迹；
- Preview 链接和状态；
- Harness 状态与错误回执。

Agent 规划、Session、Tool Call 和 Provider 均在 Harness SDK Sidecar 中运行；前端不实现第二套 Agent Loop。

## 实验性 DSH Web 嵌入

只有明确需要评估 DSH 原生 Web UI 时才启用：

```dotenv
HARNESS_UI_MODE=embedded_experimental
HARNESS_WEB_URL=http://127.0.0.1:3080/
HARNESS_WEB_ATTESTATION_URL=http://127.0.0.1:3080/.well-known/workbench-harness.json
```

两条 URL 必须：

- 使用 HTTP(S)；
- 仅指向 `127.0.0.1`、`localhost` 或 `::1`；
- 不包含用户名、密码、查询参数或片段；
- 使用相同 Origin。

Workbench 在下发 iframe URL 前会读取 attestation。响应必须小于 64 KiB，并严格匹配：

```json
{
  "ok": true,
  "compositionId": "workbench-unified-copilot-v1",
  "toolCatalogHash": "<src/harness-policy.mjs 计算出的 SHA-256>",
  "harnessVersion": "0.1.0-rc.6"
}
```

任何超时、网络错误、非 JSON、版本不一致、Composition 不一致或工具目录不一致，都会：

```text
拒绝下发 webUrl
→ 不渲染 iframe
→ 自动回退到 Workbench 受控 Harness UI
```

嵌入 iframe 还使用 sandbox 和 no-referrer。实验模式不是生产默认能力，也不能绕过 Workbench 登录、Preview/Confirm/Execute 或 Joycrew 的 Grant。

## Workbench 不允许被任意嵌入

完整 Workbench 始终返回：

```text
frame-ancestors 'none'
X-Frame-Options: DENY
```

不存在通过 `/preview.html` 或其他特殊路径让任意站点 iframe 完整工作台的例外。`frame-src` 只控制 Workbench 能加载哪些经过配置的子 iframe，不等于允许其他站点加载 Workbench。

## 数据真源

| 数据 | 真源 |
|---|---|
| 项目成果 | 本地项目目录 |
| 代码变更 | Git |
| 今日、待办、项目机器状态 | Workbench State |
| 项目分析、总结、复盘、恢复叙事 | 绑定的飞书项目文档 |
| 客户、企业项目、Run、Evidence、Approval、Deliverable | Joycrew |
| 本次对话与执行轨迹 | 浏览器模块内存 + Harness Sidecar 内存 |

Harness 会话不进入 `state.json`、Backup、`PROJECT.md`、飞书、`localStorage`、`sessionStorage` 或 IndexedDB。页面或服务重启后开启新会话。

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
HARNESS_UI_MODE=workbench
OPENAI_API_KEY=<deployment secret>
OPENAI_MODEL=<approved model id>
```

也可以通过 `HARNESS_PROVIDER_*` 使用已批准的 OpenAI Responses / Chat Completions 兼容网关。公网 Provider 必须使用 HTTPS；本机 HTTP 仅在 `HARNESS_PROVIDER_NETWORK_ZONE=local_loopback` 时允许。

Docker 镜像使用 Node 24 并预装生产 Harness 依赖，不需要进入容器手工安装。

## 可重复验证

```bash
npm run test:files
npm run harness:check
npm run harness:e2e
docker build -t personal-ai-workbench .
```

验证层包括：

1. Workbench 全量合同测试；
2. Harness Cordis Composition 初始化；
3. Prompt → Agent Tool Call → 本机 Bridge → MCP Result → Assistant Reply；
4. 同一 Harness Session 的第二轮连续对话；
5. 单一工具 Manifest 和目录哈希；
6. 实验 iframe 的 URL、attestation、Composition、工具目录和版本门禁；
7. Workbench 自身不可被任意站点嵌入；
8. Docker 镜像内 Harness 初始化和 Workbench `/api/health`；
9. 固定工具白名单和无浏览器持久化合同。

真实 Provider、真实飞书、真实 Joycrew 和实验 DSH Web 服务由部署凭证决定。无法访问外部服务时必须明确报错，不伪装成功，也不影响个人工作台继续运行。
