# GetNote Insight v1

## 目标

得到大脑在 Personal AI Workbench 中有两条互相独立的链路：

1. `meeting_todos` 是确定性任务来源，不允许模型从正文发明正式任务。
2. 会议正文可以由 AI 解析为结构化 Insight，用于理解、检索、决策证据和候选行动审核。

```text
GetNote
├─ meeting_todos ──> deterministic task sync ──> Todo / Inbox
└─ note content ───> AI parser ──> GetNoteInsightV1 ──> human review
```

AI Insight 不是任务真源，也不拥有 Today、优先级、项目状态或任务完成状态。

## `GetNoteInsightV1`

Schema version 固定为：

```text
getnote-insight-v1
```

核心字段：

- `note`: noteId、标题、源时间和 URL。
- `source.contentHash`: 原文 SHA-256；原始正文不默认持久化进 Workbench。
- `parser`: parser version、model profile、parsedAt。
- `summary`: 有证据引用的会议摘要。
- `topics`: 主题标签。
- `decisions`: `confirmed | tentative`，必须引用 evidence。
- `actionCandidates`: AI 发现的候选行动，必须引用 evidence。
- `risks`: 风险，必须引用 evidence。
- `openQuestions`: 未决问题，必须引用 evidence。
- `projectCandidates`: 项目关联候选，必须引用 evidence。
- `evidence`: 来源会议原文的小段证据，不保存整篇正文。
- `quality`: overall confidence 与 warnings。

## Evidence-first

Decision、Action Candidate、Risk、Question、Project Candidate 都必须引用有效 `evidenceIds`。

Evidence ID 由以下值确定性生成：

```text
noteId + normalized exact excerpt + speaker
```

AI 不得提供无法追溯到会议证据的结构化事实。

## Action Candidate 不是 Todo

`actionCandidates` 明确禁止出现这些自动化字段：

```text
todo
today
priority
projectId
done
```

候选只有：

- `text`
- `ownerHint`
- `dueHint`
- `explicitDueDate`
- `confidence`
- `evidenceIds`

只有源文出现明确日期时才可填写 `explicitDueDate=YYYY-MM-DD`。`下周`、`尽快` 等只能保留在 `dueHint`。

Candidate 稳定键由：

```text
noteId + kind + sorted evidenceIds
```

确定性生成，因此模型对候选文案做轻微改写时不会制造一个新候选。v1 要求不同候选拆分成不同 evidence，避免同一证据组对应多个候选产生身份歧义。

## 人工审核状态

候选状态：

```text
pending
accepted
rejected
merged
stale
```

规则：

- 新候选为 `pending`。
- `accepted / rejected / merged` 只能由人工审核产生。
- 当前解析中消失的 `pending` 候选变为 `stale`。
- 已经 `accepted / rejected / merged` 的候选即使源内容变化，也保留人的决定，只记录 `sourcePresent=false`，不得自动回滚任务或重新骚扰用户。
- `rejected -> pending` 只允许在候选仍存在于当前来源时由用户恢复。
- 人工状态修改使用 `expectedState` 做冲突检测，避免并发覆盖。

第一阶段只存审核状态，不创建 Todo；后续审核 UI 必须将“创建 Workbench Todo/Inbox”和“candidate accepted/merged”放进一个明确事务中。

## 缓存

缓存 tuple：

```text
noteId
+ contentHash
+ parserVersion
+ modelProfile
```

四项完全相同才能复用缓存。相同 tuple 如果出现不同 AI 结果，存储层返回冲突，拒绝静默覆盖。

目录：

```text
DATA_DIR/getnote/
├─ index.json
├─ candidates.json
└─ insights/
   └─ gni_<cache-key>.json
```

Insight 文件不可变；`index.json` 和 `candidates.json` 使用原子替换。目录和文件使用私有权限，并拒绝符号链接路径。

## 不做的事情

v1 core 不做：

- 不调用任何 AI provider。
- 不读取或持久化整篇 GetNote 原文。
- 不自动创建 Todo / Inbox。
- 不自动加入 Today。
- 不自动设置优先级。
- 不自动修改项目。
- 不写回 GetNote。
- 不做后台扫描或全量镜像。

下一阶段才接入：GetNote 正文按需读取 -> structured-output parser -> cache -> candidate review UI。
