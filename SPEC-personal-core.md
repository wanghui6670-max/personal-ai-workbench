# Spec: personal-core

## Objective

`personal-core` 交付 R1 每天可手工完成的个人主链，并承担 `R1-CORE-01`、`R1-CORE-02`、`R1-CORE-03` 与来源合同中的个人事项边界。

正式路径是：飞书云文档中的明确待办或本机手工 Capture 进入 Inbox → 用户确认后成为 Todo → 用户决定是否加入 Today → 完成。AI、Feishu 写入、Joycrew、GetNote 和 DSH 全关时，这条主链仍必须可走完，且不产生外部请求。

本模块不发明第二套待办来源，也不把得到大脑/GetNote 日记、观点、项目进展猜成任务。运行身份、配置 revision 和 `DATA_DIR` 锁由 `reproducible-runtime` 提供；本模块只在锁内写入个人状态。

## Tech Stack

- Node.js `24.19.0` 与现有 ECMAScript modules
- `src/store.mjs` 作为本地 `state.json` 真相源
- `src/capture-domain.mjs`、`src/inbox-domain.mjs`、`src/inbox-batch-domain.mjs`、`src/today-domain.mjs`
- Capture 收据 `src/capture-receipts.mjs` 与 `src/capture-contract.mjs`
- 浏览器 UI 使用唯一前端状态源；mutation 后立即读回
- Node built-in test runner 与真实 Chrome E2E

个人状态只写在 `DATA_DIR`。默认主机布局中它是 `runtime-root` 的兄弟目录，不是 Git checkout，也不是 `config/revisions/`。

## Commands

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --test tests/inbox-domain.test.mjs tests/today-domain.test.mjs tests/capture-domain.test.mjs
node --test tests/task-source-documentation.test.mjs
```

真实浏览器主链、网络隔离和重启读回属于 `R1-007` / `R1-007A` / `R1-008`，不在本 Spec 写成已经完成。

## Source and Flow Contract

- 个人待办同步只认飞书云文档中的明确待办：原生未完成待办 / 复选框类 block、`checkbox` / `task` / `todo`，以及明确收件箱中的 `[INBOX]` 条目。
- 普通段落、普通列表、工作日记、复盘、分析观点、项目进展不得进入待办同步。
- GetNote / 得到大脑只作为用户确认后的自媒体内容来源，不进入个人待办。
- 本地 `state.json` 是 Inbox / Todo / Today 的运行真相源；远端同步只能追加或更新明确来源条目，不能用模糊相似度删除两个不同待办。
- 不自动新建项目，不自动加入 Today。
- AI、Feishu、Joycrew、GetNote、DSH 全关时：手工 Capture 与 Inbox 人工处理必须可完成；测试须证明无外部请求。

## State, Batch and UI Contract

- 已向用户确认成功的本地写入，在进程崩溃、服务重启和升级场景中 `RPO=0`。
- 状态提交使用同目录临时文件、file fsync、atomic rename、parent-directory fsync；损坏 JSON fail closed。
- 批量操作必须按逐项给出成功、失败或未执行；部分失败不得显示为全部成功。
- 前端只有一条状态/渲染路径；每次 mutation 先读回权威状态再绘制一次。DOM、API 与刷新必须一致。
- Today 使用本机本地日期，边界行为必须可测。
- 浅色/深色主题达到 WCAG AA；键盘、焦点、加载和错误恢复必须完整。
- 旧页面向新后端写入返回 `409 WORKBENCH_BUILD_MISMATCH` 时，业务状态不变。

## Recovery and Identity Alignment

本模块不另定恢复数字。发布合同冻结为：

- 已确认本地写 `RPO=0`；
- 备份窗口 `RPO≤15 minutes`；
- 空目录恢复 `RTO≤30 minutes`；
- 只保留当前 deployment 和一个已验证 N-1 回滚点。

配置身份树固定为 `<runtime-root>/config/revisions/<config-revision-id>/`。个人状态不得写入该树，也不得把 Git checkout 当 `DATA_DIR`。

## Target Project Structure

实现完成后的责任边界，不表示所有文件当前已经满足 R1：

```text
src/store.mjs
src/capture-domain.mjs
src/capture-contract.mjs
src/capture-receipts.mjs
src/inbox-domain.mjs
src/inbox-ack.mjs
src/inbox-batch-domain.mjs
src/today-domain.mjs
public/                 Git tracked UI only
```

未跟踪 `public/preview.html` 不是个人主链入口，正式 HTTP 必须 404。

## Testing Strategy

1. 来源合同测试：明确待办进 Inbox，日记/段落/GetNote 不进待办。
2. 领域测试：Capture → Inbox → Todo → Today → Complete；重启后读回同一条目。
3. 批量测试：注入部分失败，断言逐项结果。
4. 真实浏览器：网络隔离下完成主链；320/768/1440 与 200% 缩放；键盘与对比度。
5. 负向：外部能力关闭时无出站；版本不一致时不写业务状态。

## Boundaries

### Always

- 服从 `docs/WORKBENCH_V3_SOURCE_CONTRACT.md`。
- 在取得 `DATA_DIR` 独占锁之后才初始化或写入个人状态。
- 已确认本地写保持 `RPO=0`。
- mutation 后读回权威状态再渲染。

### Ask First

- 真实飞书写入、客户触达或把演示数据当成现场验收。
- 改变 Today 日期规则或待办来源。

### Never

- 从整篇日记让模型猜任务。
- 把 GetNote 当作个人待办来源。
- 部分失败却提示全部成功。
- 把凭证、聊天原文或金额明细写入 UI 日志。

## Success Criteria

1. 外部能力全关时，手工主链可完成且无外部请求。
2. 批量结果逐项诚实。
3. 单一 UI 状态源，读回后绘制；Today 日期与无障碍门通过。
4. 已确认本地写在重启/升级后仍在，满足 `RPO=0`。
5. 备份与空目录恢复仍分别遵守 `RPO≤15 minutes` 与 `RTO≤30 minutes`，本模块不得改写这两个数字。
