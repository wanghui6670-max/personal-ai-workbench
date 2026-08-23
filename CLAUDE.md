# Personal AI Workbench

本地优先的个人项目管理台。人保留最终决策权：AI 可以分析、提醒、解释和执行明确指令，不能替用户安排今日、改截止日期或发明待办。

仓库：`wanghui6670-max/personal-ai-workbench`  
本地：`~/AI-Work-OS/code/personal-ai-workbench`  
当前 main：`4c83764`（PR #5 已合入，GitHub 签名有效）

产品细则以 `docs/PRODUCT_SPEC.md` 为准；架构以 `docs/ARCHITECTURE.md` 为准；待办管线以 `docs/TASK_SOURCE_PIPELINE.md` 为准。本文件只做进仓路由。

## 目录结构

```text
src/                 # Node ESM 服务与领域层（无第三方运行依赖）
  server.mjs         # HTTP 入口
  task-cli.mjs       # 只执行固定二进制 getnote
  task-sync-domain.mjs
  feishu-daily-journal.mjs
  local-calendar.mjs
  mcp/               # 受限 MCP 工具
public/              # 浏览器双面板
tests/               # node:test 合同测试
harness/             # DeepSeek Harness Navigator
docs/                # 产品/架构/API/部署
data/                # 运行状态（state.json / config.json 已被 gitignore）
workspace/           # 真实项目工作区挂载点（内容不入库）
```

## 常用命令

```bash
cp .env.example .env
npm run doctor
npm start                 # http://127.0.0.1:4173
npm run dev
npm test                  # 或 npm run test:files
npm run harness:check
npm run harness:e2e
npm run verify            # 测试 + harness check + e2e
```

不需要 `npm install`（无第三方运行依赖）。Harness 另走 `npm run harness:install`。

Node 20+。启用个人待办时需要已登录的 `getnote`；启用飞书沉淀时需要已登录的 `lark-cli`。

## 数据边界

```text
getnote 只读
  → 分页 notes + 逐篇 meeting_todos
  → 明确日期进正式待办；模糊/无日期进 Inbox
  → 飞书《每日工作日记》快照并读回
  → 原子重建私有 ICS
  → 提交 Workbench 机器状态
```

- 得到大脑是笔记/会议待办真源。不反向写 `getnote`。
- 飞书《每日工作日记》是快照和每日总结 sink，不是待办来源。
- 飞书项目文档是项目叙事真源。分析/复盘正文不得进 `state.json`、`PROJECT.md`、activity 日志或浏览器存储。
- 本机 ICS 是可重建镜像，不是真源。有时刻无开始时间 → 只写 `DTSTART` 瞬时事件，不猜时长。
- 只有上游 `completed=true` 才标完成。扫描缺失 ≠ 完成。
- 同步不自动加入今日。
- 历史误配置 `provider=dida_cli` / `cliFlavor` 视为无效，需用户明确保存 GetNote 设置后才清理该类机器导入项。

受控只读命令（设置里不得提供任意 shell / 二进制路径 / token）：

```text
getnote notes --limit <20-500> [--since-id <cursor>] -o json
待办从笔记标题与内容提取（不再调用 note todos）
getnote auth status
```

笔记 ID 始终当字符串，避免雪花 ID 被 JS 数字截断。

## 改代码时

- 新功能 / 改接口 / 跨 3 文件且改行为 → 按工作台开发工作流走全链（见 `~/AI-Work-OS/CLAUDE.md`）。产物写 `~/AI-Work-OS/projects/personal-ai-workbench/sdd/<topic>/`（档案未建则先建档或暂放 `projects/ai-work-os/sdd/`）。
- 已有流程上的单点改动 → 短设计获批后 TDD。测试用 `node:test`，放 `tests/*.test.mjs`。
- 合同测试覆盖：GetNote 命令与分页、稳定 ID、日期/完成语义、dida 迁移、飞书读回/冲突、ICS、MCP 确认门、doctor、既有 Capture/项目/备份。
- 不在 PR 里声称 live GetNote / 飞书 / 日历客户端 / 模型供应商 / iPhone 已验收，除非这次真的接了真实凭证并跑过。

### MCP 工具安全规则

- 工具参数如拼入 shell 命令（如 `codex exec --agent <id> <task>`），必须用 `shellEscape()` 单引号转义，禁止用双引号 `replace(/"/g,'\\"')`（双引号内 `$()`、反引号、`!` 仍可注入）。
- 工具的 `inputSchema` 中用户可控字符串字段应加 `pattern` 约束（如 `^[A-Za-z0-9][A-Za-z0-9_-]*$`），不要只限制长度。
- 修改 `HARNESS_NAVIGATOR_TOOL_ALLOWLIST` 后，必须同步更新所有引用白名单长度的测试断言（`harness-static-contract.test.mjs`、`harness-policy-v2.test.mjs` 等）。
- 浏览器端 `public/harness-navigator.js` 禁止使用 `localStorage`/`sessionStorage`/`indexedDB`——会话状态只保存在模块内存中。
- 新增工具需在 `crew-agent-tools.test.mjs` 补充测试：正常路径 + 安全边界（特殊字符、空值、注入尝试）。

## 红线

- 不自动分类 Inbox、不自动改截止日期、不自动加入今日。
- 不从笔记正文让模型发明待办；无 `meeting_todos` 就接受空列表。
- 不把凭证、`.env`、state/config 正文贴进对话或 commit。
- 不提供任意 shell、任意二进制、任意文件路径 API。
- 外部写入（飞书、同步、每日总结、阶段总结）必须用户确认；MCP 变更类工具走 confirmation + mutation lease。
- 不 commit `data/state.json`、`data/config.json`、`.env`。
