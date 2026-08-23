# Personal AI Workbench 3.1 产品基线

> 产品名：动觉 AI 工作台  
> 仓库：`wanghui6670-max/personal-ai-workbench`  
> 版本：3.1.0  
> 日期：2026-08-23  
> 权威顺序：本文件（统一产品）→ `JOYCREW_INTEGRATION.md`（跨服务合同）→ `PRODUCT_SPEC.md` / `ARCHITECTURE.md`（工作台子系统合同）

## 一句话定义

Personal AI Workbench 是小团队（5-10 人）的统一工作入口：用个人今日、收件箱和项目恢复管理注意力，用 Joycrew 管理客户、企业项目、AI 员工、Run、Evidence、审批和交付，用飞书项目文档保存长期项目叙事。部署在云服务器上，每个成员拥有独立的数据空间和认证身份。

业务场景：金融行业投标业务（银行、券商、保险、金租、消金等招标项目）全流程管理，以及常州地区政企项目与产业园区投标机会跟进。

## 用户界面

```text
左侧导航
├── 我的今日
├── 个人收件箱
├── 个人待办
├── 工作日志
├── 业务执行
├── 待确认 / 待归类 / 逾期 / 归档
└── 业务板块与个人项目

中间内容
├── 个人执行页面
├── 项目文件与飞书记录
└── Joycrew 项目 / 员工 / Run / Evidence / Approval / Deliverable

右侧 Copilot
├── 连续会话
├── Workbench 与 Joycrew 读取工具
├── 工具轨迹
└── Joycrew 外部操作预览
```

每个用户登录后看到自己的数据空间。管理员可切换到用户管理页查看全团队数据概要。

Joycrew 独立 Web 只作为管理、Pilot 调试和故障入口，不再作为第二套日常工作台。

## 核心用户流程

### 个人工作

```text
GetNote / iPhone Capture / 手工输入
→ 个人收件箱
→ 用户明确处理
→ 有截止日期的个人待办
→ 用户决定加入我的今日
→ 完成或继续
→ 飞书每日工作日记沉淀
```

### 企业 AI 员工执行

```text
打开业务执行
→ 选择 Joycrew 企业项目
→ 选择已授权 AI 员工
→ 明确本次任务与数据源
→ 生成操作预览
→ 用户确认
→ Joycrew 创建 Run
→ DataWeave 按需读取
→ Runtime 执行
→ Evidence Package
→ 用户生成交付或发起写回审批
```

### Copilot

```text
用户自然语言
→ Harness 选择固定工具
→ 读取 Workbench / Joycrew
→ 回答或生成 preview-only 操作
→ 页面显示影响范围
→ 用户确认后由 Workbench BFF 调 Joycrew
```

## 多用户架构

v3.1 引入多用户支持，部署到云服务器供 5-10 人小团队使用：

- **认证**：JWT Cookie 认证，用户名/密码登录。
- **存储**：SQLite 单库多表（`STORE_BACKEND=sqlite`），每条数据通过 `userId` 字段隔离。
- **兼容**：保留 JSON 文件存储作为 fallback（`STORE_BACKEND=json`），可一键回滚。
- **角色**：admin（管理用户 + 查看全员数据）/ user（仅操作自己的数据）。
- **DSH 隔离**：右侧 Copilot 通过 `harnessRunScope` 绑定当前登录用户，工具调用使用该用户的 `scopedStore`。

## 不变原则

1. AI 不替用户安排"我的今日"。
2. 个人收件箱和企业业务 Intake 不自动双向同步。
3. 本地项目文件夹是真实工作成果源，Git 是版本证据。
4. 项目分析、阶段总结、复盘和恢复叙事只以飞书项目文档为长期真源。
5. Joycrew 管 AI 员工、Run、Evidence、审批和交付；Workbench 不复制这些领域模型。
6. DataWeave 管按需数据读取；Workbench 不直连飞书业务 Token、Local Bridge 或服务器文件适配器。
7. Harness 不直接调用 Hermes，不拥有 Shell、终端、任意 Web 或文件写入。
8. 外部改变必须 Preview → Confirm → Execute → Readback。
9. Joycrew 离线不影响工作台启动和使用。
10. 测试通过不等同于真实外部系统已现场验收。
11. 每个用户的数据空间相互隔离，管理员可查看但不修改成员数据。

## v3.1 验收标准

- [x] Personal AI Workbench 仍可在 Joycrew 关闭时完整启动。
- [x] 单一导航中出现"业务执行"，不 iframe Joycrew。
- [x] 浏览器可读取 Joycrew 状态、项目、员工、Run、Evidence、审批和交付。
- [x] Joycrew Token 只存在于服务端环境变量。
- [x] Run、交付和审批必须先产生短时操作预览。
- [x] 未确认预览不会调用 Joycrew。
- [x] 重复确认已执行预览不会产生第二个副作用。
- [x] Harness 使用固定 21 工具目录；Joycrew 写能力只以 `*_prepare` 暴露。
- [x] Joycrew 读取和动作接口受 Workbench 登录与限流保护。
- [x] 公共健康检查不回显 Joycrew 内部 URL、Workspace 和用户身份。
- [x] `.env`、Docker、Doctor、README 和 CI 对 v3.0 对齐。
- [x] 多用户认证：JWT Cookie 登录，用户名/密码。
- [x] 数据隔离：每个用户独立的数据空间，通过 userId 字段隔离。
- [x] 管理员功能：用户管理（增删改查/改密码）+ 全团队成员数据概要查看。
- [x] DSH Copilot 隔离：工具调用绑定当前登录用户的 scopedStore。
- [x] 存储后端可切换：SQLite（多用户）/ JSON（单用户 fallback）。

## 后续门禁

v2.0 合并不自动证明下列现场事项完成：

- 真实 Joycrew PostgreSQL 数据迁移；
- 真实飞书 Base/Doc 授权；
- Mac Local Bridge 私有隧道；
- `/srv/AI-Work-OS` 最小权限；
- Hermes 请求、取消、超时和错误合同；
- 三轮脱敏真实项目 Pilot；
- 公网域名、反代、Cookie 与生产安全验收。

这些事项必须通过部署环境的真实证据另行裁决。


## 不确定结果保护

Joycrew 写操作在网络中断、响应丢失或返回不可验证结果时会标记为“结果不确定”。同一个预览不会自动重试，避免重复创建 Run、交付或写回；用户应先刷新业务状态核对，再决定是否生成新的预览。
