# GetNote 来源决策与截止日期所有权合同

状态：v2.0 收口合同  
适用范围：`getnote_cli` → Workbench Inbox/Todo 同步

## 1. 用户处理过的来源事项不能“死而复生”

GetNote 当前稳定待办身份使用 `text_fingerprint`。当一个无截止日期的 GetNote 事项进入 Workbench 收件箱后，用户明确执行以下终结动作时，Workbench 必须在**同一次状态事务**中记录来源决策：

- 删除：`dismissed`
- 保存为备忘：`memo`
- 归入已有项目作为项目记录：`project_note`

来源决策只保存最小必要字段：Workbench 决策 ID、`externalId`、可选 `sourceNoteId`、disposition、决策时间；不复制原待办正文。

后续同步遇到**完全相同的 externalId** 时必须抑制重新导入。若 GetNote 显式返回该来源事项已完成，Workbench 清理对应来源决策。若源文本被修改而产生新的 `text_fingerprint`，它被视为新的上游事实，可以重新进入工作台，避免把真正的新内容永久吞掉。

## 2. Inbox → Todo 必须保持来源身份

用户把 GetNote Inbox 事项手工转为 Todo 时：

- 保持原 Workbench entity ID；
- 保留 `source=getnote_cli`、`externalId`、`sourceNoteId` 和来源元数据；
- 不创建来源 tombstone，因为 Todo 本身就是继续跟踪该来源的实体；
- 下一次同步只能更新这一实体，不能再创建第二条 Inbox/Todo。

## 3. 截止日期所有权必须显式

GetNote 来源 Todo 使用：

- `dueDateOwner=source`：当前截止日期由 GetNote 来源控制；
- `dueDateOwner=user`：当前截止日期由用户在 Workbench 明确设定。

以下动作将所有权切换为 `user`：

1. 无日期 GetNote Inbox 被用户转成带截止日期的 Todo；
2. 用户在 Workbench 修改 GetNote Todo 的 `dueDate`。

当 `dueDateOwner=user` 时，后续 GetNote 同步可以更新 `sourceDueDate` 作为来源证据，但**不得覆盖用户的 `dueDate`**，也不得因为来源日期消失把 Todo 移回 Inbox。

当 `dueDateOwner=source` 时，来源日期变化继续正常覆盖本地日期。旧版本没有 `dueDateOwner` 的实体仍使用既有保守推断逻辑，并在识别出本地覆盖后升级为 `user`。

## 4. 原子性与 fail-safe

来源决策、Inbox 移除、Todo/Note 创建必须位于同一个 `JsonStore.updateState(...)` 提交中。不得采用“先删/先转，再追加 tombstone”的事后补丁。

飞书工作日志与 ICS 日历仍然是 Workbench 核心提交之后的派生 sink；sink 失败不得回滚核心状态。

## 5. 回归测试

`tests/external-task-user-decisions.test.mjs` 覆盖：

1. 删除后同 externalId 不再导入，源端显式完成后清理决策；
2. Inbox → Todo 保持同一 Workbench ID 与 externalId；
3. 用户截止日期在无日期/改期的后续来源同步中不被覆盖；
4. Workbench 修改 GetNote Todo 截止日期时显式切换 `dueDateOwner=user`。
