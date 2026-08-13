# Personal AI Workbench v1.2.0 外部只读安全审阅报告

- Task ID：`personal-ai-workbench-v1-2-luna-feishu-ios-review-20260813-r3`
- 审阅角色：外部高级工程师
- Profile：`review_only`
- 审阅日期：2026-08-13
- 源码基线：附件中的 8 文件安全快照
- 源码修改：无
- 部署/生产操作：无
- 凭证请求或处理：无
- Live OpenAI / 飞书 / 浏览器 / 真实 iPhone 验证：无
- 配套规范提案：`PERSONAL_AI_WORKBENCH_V1_2_REVISED_SPEC_PROPOSAL.md`

## 0. 总裁决

### 0.1 结论

本轮可以完成**附件级、源码级、文档级的只读审阅**，但不能把当前基线裁决为“实现已完整验证”或“可声明生产就绪”。

建议门禁结论：

- **允许进入 Codex 文档修订、源码修复和补测阶段：YES。**
- **允许声明 Luna、飞书、`/api/capture` 或真实 iPhone 链路已完成集成验收：NO。**
- **允许声明安全外发包本身未包含凭证、PII、运行时数据和二进制：YES，仅限本附件包范围。**

主要原因：

1. Luna 的默认模型、`xhigh`、Responses API、strict JSON Schema、有界超时和错误回退在 `src/ai.mjs` 中有明确证据；但 `OPENAI_MODEL` 可任意覆盖，不能同时称为“固定模型”。项目进度回退的最终编排位于未附的 `src/projects.mjs`，无法端到端确认。
2. 三类 AI 工作流确实共用 `analysis.evidence/conflicts/gaps + decision` 信封，当前三条路径的 evidence ID 均由 enum 限定；但 ID 合法不等于 observation 真实，未来空证据目录会退化为任意字符串，早晨对焦的 conflicts/gaps 也不会触发置信度门禁。
3. 飞书同步链路可以完整追踪，但存在高优先级可靠性缺陷：写后读回按“文本相等”而不是“新增 block ID”确认；空白规范化可能造成外部已经写入但本地报失败；含嵌套标记的下一个一级标题可造成章节越界；导入时即写 ack 会使远端删除后恢复的同 block 被抑制。
4. iPhone Shortcut 和 `/api/capture` 的认证及状态边界只有文档证据。实际路由、token 比较、body 限制、Host/Origin、限流、幂等和日志实现位于未附的 `src/server.mjs` 或其他模块，必须标记为未验证。
5. tests 被任务书明确省略；`npm test` 所需的 `tests/*.test.mjs` 不在附件中。本轮没有运行 `npm test`，也不能引用未附测试的结论。

### 0.2 AC 总览

| AC | 裁决 | 摘要 |
|---|---|---|
| AC-01 | **PARTIAL** | 默认 Luna + 固定 `xhigh`、Responses API strict schema、有界错误处理已证实；“固定模型”被环境变量覆盖能力冲突，项目进度最终回退编排未附 |
| AC-02 | **PARTIAL** | 当前三条路径 evidence ID 受供应目录 enum 约束，AI 模块只返回 decision；语义真实性、future empty catalog、进度持久化全链仍有缺口 |
| AC-03 | **PASS-WITH-HIGH-RISK-FINDINGS** | 飞书解析、block ID 去重、写后读回、删除与缓存链路已完成追踪；发现多项高优先级缺陷 |
| AC-04 | **PARTIAL / DOCUMENT-ONLY** | Shortcut 和 API 文档可追踪；服务端认证和真实网络/设备前提未附、未验证 |
| AC-05 | **PASS** | 本报告给出可执行发现、矛盾、缺失测试和完整 Markdown 规范提案；未修改源码 |
| AC-06 | **PASS, PACKAGE SCOPE ONLY** | 清单与独立归档结构检查均支持安全外发包无实际凭证、PII、运行时文件或二进制；不外推到完整仓库 |

## 1. 可验证基线

### 1.1 三附件完整性

| 项目 | 实际核验结果 | 与任务/清单关系 |
|---|---|---|
| 上传 ZIP | `source-package(20260813-012722).zip`，30,078 bytes | 与 canonical `source-package.zip` 的任务基线一致 |
| ZIP SHA-256 | `7286be2a6a96b3f60672be8cccf17aef6c5803a72427dcad80f9c6d385b86ba9` | 与 `PUBLIC_MANIFEST.md`、`TASK_BRIEF.md` 一致 |
| PUBLIC_MANIFEST | 1,161 bytes；SHA-256 `1649d2b7275cb63b59ec022ea49c7822dc4a583b7a5199425f9b72365b3821e4` | 实际附件值 |
| TASK_BRIEF | 6,975 bytes；SHA-256 `33194e14555c29d09c13222468703d8f2361b3bb7415f30fa4b0efaf88219ebb` | 实际附件值 |
| Project/source binding | `a9254deaa42cebd64974a134a31c3a082b7e8c07edcbc9290158290e5cae72f8` | Manifest 与 Task Brief 一致 |
| Snapshot SHA-256 | `977eca63b866de92418443e15fc2b345582ff4616ae8a04ca3c04013dac28378` | Manifest 与 Task Brief 一致；packager 算法未附，属于元数据一致性而非独立重算 |
| PRD | `docs/PRODUCT_SPEC.md`，5,308 bytes | 实际 SHA-256 `39b81044bdbd65aa3363ae31ff3bc7343bb68201b543e76dc9c45aee9f7caa41`，与任务书一致 |
| Git 元数据 | branch `master`、HEAD `d70a6e...`、dirty | 只有清单/任务声明；ZIP 无 `.git`，不能独立验证 |
| 三件套集合哈希 | 未验证 | 任务书称记录于 `SESSION_LEDGER.json`，该文件未附 |

### 1.2 ZIP 内容

归档仅包含以下 8 个普通、未加密、无路径穿越、无 symlink 的文本文件，共 81,828 bytes：

| 文件 | 行数 | Bytes | SHA-256 |
|---|---:|---:|---|
| `docs/API.md` | 56 | 4,049 | `74d61704462e628981ce47fd73199e55614aa4c0457f2554fd1fa08dfd56a3ca` |
| `docs/ARCHITECTURE.md` | 72 | 7,146 | `873190e3e1556def44e3242d5301ff951bc46f66c39855abd833eb782f7358e3` |
| `docs/IPHONE_SHORTCUT.md` | 23 | 902 | `3397615a093906a2f18bdded50ab1121e467107fe8c6d80c107f093957d67c81` |
| `docs/PRODUCT_SPEC.md` | 109 | 5,308 | `39b81044bdbd65aa3363ae31ff3bc7343bb68201b543e76dc9c45aee9f7caa41` |
| `package.json` | 18 | 524 | `0afd414058259135161d4fdcf2440dd524c82c92a84d4387309da58df7388be6` |
| `src/ai.mjs` | 258 | 16,465 | `70375cb5be1aea8408fc6044b8b02cd2b07d9c3bdb781e7b1f568cdf831d54f0` |
| `src/domain.mjs` | 635 | 40,375 | `b87c96ab57b0e2a08e761bf6db1a07dc985e24c60910e81581eb8665726ed218` |
| `src/feishu.mjs` | 161 | 7,059 | `ec605b42bca64131da66b41d0d40bc55ca2802d8dc6fe743dc5bca96701d69bb` |

### 1.3 明确缺失的实现和测试

下列路径被附件中的脚本或 import 引用，但不在安全包：

- `tests/*.test.mjs`
- `src/server.mjs`
- `src/projects.mjs`
- `src/store.mjs`
- `src/utils.mjs`
- `src/validation.mjs`
- `scripts/doctor.mjs`
- `scripts/backup.mjs`
- `scripts/restore.mjs`

事实证据：

- `package.json:8-13` 引用了 server、tests 和 scripts。
- `src/ai.mjs:1` 引用了未附的 `utils.mjs`。
- `src/domain.mjs:3-8` 引用了未附的 store/projects/utils/validation。
- 任务书明确说明 tests 因 fixture credential/PII 模式被安全包省略。

由此形成的限制：

1. 无法验证真实 HTTP 路由、认证、Host/Origin、限流和 body 解析。
2. 无法验证 store 的原子写入、串行队列、迁移和 schema。
3. 无法验证 `analyzeProject` 如何消费 `analyzeProjectWithAI()` 返回的 `null` 并落实本地 fallback。
4. 无法验证 `writeProjectMd` 的持久化内容是否严格排除分析信封。
5. 无法执行附件声明的完整测试套件。

## 2. 本轮实际完成的只读检查

### 2.1 已执行

- 三附件 byte size 与 SHA-256 核验。
- ZIP 条目、总字节、文件列表核验。
- ZIP 路径穿越、symlink、加密标志检查：8 entries，0 issues。
- 8 文件类型检查：均为 UTF-8 文本/JSON/JavaScript source。
- `package.json` JSON 解析。
- `node --check`：附件中的 `src/ai.mjs`、`src/domain.mjs`、`src/feishu.mjs` 均通过语法检查。
- 当前审阅容器 Node 为 `v22.16.0`；这不是任务书声明的项目基线 `v22.22.0`，只证明语法可被当前解析器接受。
- 独立的本地 mock CLI 探针，仅针对 `src/feishu.mjs`，没有网络、凭证或真实飞书写入。
- 文档—源码需求追踪、矛盾检查和规范完整性检查。

### 2.2 未执行

- 未运行 `npm test`：tests 不在附件，且完整运行依赖的多个模块也未附。
- 未运行应用 server。
- 未调用 OpenAI。
- 未调用真实 `lark-cli`、飞书文档或用户身份。
- 未打开浏览器、未部署、未使用真实 iPhone。
- 未请求、读取或处理任何 credential。

## 3. AC-01：Luna Responses API、JSON Schema 与有界回退

### 3.1 已验证事实

#### A. 默认模型、推理档位和边界

- `src/ai.mjs:3`：默认模型为 `gpt-5.6-luna`。
- `src/ai.mjs:4`：推理档位常量为 `xhigh`。
- `src/ai.mjs:5-7`：请求超时 120,000ms，默认输出 32,000 tokens，硬上限 64,000。
- `src/ai.mjs:127-129`：实际模型为 `process.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL`，`xhigh` 不可通过环境变量改变。

#### B. Responses API 请求合同

`src/ai.mjs:131-150` 证明：

- endpoint：`https://api.openai.com/v1/responses`；
- method：POST；
- Bearer API key；
- `AbortSignal.timeout(120_000)`；
- `store:false`；
- `reasoning:{effort:'xhigh'}`；
- output token 被限制在 256–64,000；
- 固定规则通过 `instructions`；
- 不可信输入经 `redactSensitiveText()` 后作为 user input；
- `text.format.type='json_schema'`、`strict:true`。

#### C. 双层结构校验

- `src/ai.mjs:13-38` 构造统一信封。
- `src/ai.mjs:65-101` 实现本机 schema 验证，覆盖当前 schema 实际使用的 `type`、`enum`、`anyOf`、pattern、min/max、min/maxItems、required、additionalProperties。
- `src/ai.mjs:104-123` 拒绝 `incomplete`、非 completed、provider error、refusal，并抽取 output text。
- `src/ai.mjs:151-166` 对超时、网络、HTTP 非成功、非法 JSON、空输出、JSON parse 和 schema mismatch 全部 fail closed。

#### D. 三条工作流的回退入口

| 工作流 | AI 函数证据 | 调用方回退证据 | 裁决 |
|---|---|---|---|
| 项目创建 | `src/ai.mjs:169-191`：任一错误返回 `null` | `src/domain.mjs:153-160`：使用 `defaultProjectName`、本地 intro，业务板块可为 null | 已验证 |
| 项目进度 | `src/ai.mjs:194-224`：任一错误返回 `null`；未手工完成时上限 99 且修正状态 | 最终消费位于未附 `src/projects.mjs`；`src/domain.mjs:340-365` 只接收 `analyzeProject()` 的结果 | 部分验证 |
| 早晨对焦 | `src/ai.mjs:227-258`：错误返回 `null` | `src/domain.mjs:522-537`：明确使用本地 `fallbackReply`，只保存对话，不写 todayPlan | 已验证 |

### 3.2 冲突与缺口

#### AI-01：固定模型表述与源码冲突（中）

- 文档：`docs/ARCHITECTURE.md:30`、任务基线把 `gpt-5.6-luna + xhigh` 描述为固定模式。
- 源码：`src/ai.mjs:128` 允许任意 `OPENAI_MODEL` 覆盖。

结论：只能确认“默认 Luna、固定 xhigh”，不能确认“固定 Luna”。任意覆盖还可能选择不支持 `xhigh` 或 strict schema 的模型，导致稳定回退但产生配置漂移。

#### AI-02：项目进度回退未形成附件内闭环（中）

`analyzeProjectWithAI()` 的失败返回 `null` 已证实，但 `analyzeProject()` 位于未附模块。不能证明 `null` 一定转为当前文档声称的本地规则进度，也不能证明最终写入不包含分析信封。

#### AI-03：早晨 conflicts/gaps 不触发门禁（中）

- `applyAnalysisConfidence()` 只在 decision 有数值 confidence 时生效：`src/ai.mjs:40-45`。
- morning decision 没有 confidence：`src/ai.mjs:234-241`。
- `src/ai.mjs:253-256` 在 schema 和 candidate ID 合法时直接返回 decision。

因此 morning 可以在 `analysis.conflicts` 或 `analysis.gaps` 非空时仍接受模型回复。它不会产生排期副作用，所以安全边界仍在，但“冲突/缺口导致降级或回退”的架构表述并未完全落实。

#### AI-04：future empty evidence catalog 不是 fail closed（低—中）

`src/ai.mjs:14` 在 evidenceIds 为空时允许任意 1–80 字符 ID。当前三条工作流都至少供应一个 ID，因此当前路径没有越界；但共享 helper 不满足长期不变量，未来新增工作流可能绕过 supplied-evidence 约束。

#### AI-05：空业务板块的 provider schema 兼容性未验证（低）

项目创建在业务板块为空时构造 `enum: []`（`src/ai.mjs:170-178`）。本机 validator 会要求 `businessId=null`，但真实 Responses API 是否接受该 schema 未做 live 验证。即使 provider 拒绝，当前调用会安全回退；功能可用性仍未证实。

### 3.3 AC-01 裁决

**PARTIAL。** 请求结构、strict schema、本机校验和大部分 fallback 路径已充分支持；固定模型、项目进度编排和 live provider 兼容性不能确认。

## 4. AC-02：证据 ID、决策信封、持久化与人工排期权

### 4.1 已验证事实

#### A. 当前三条路径 evidence ID 受供应目录约束

- 通用 schema：`src/ai.mjs:13-37`；非空目录使用 `enum:evidenceIds`。
- 项目创建目录：`project_description` + `business_N`，`src/ai.mjs:169-187`。
- 项目进度目录：`project_meta`、`local_fallback`、`file_N`、`commit_N`，可选 `project_md`、`snippet_N`，`src/ai.mjs:194-212`。
- 早晨目录：`user_message`、`recent_N`、`project_N`、`todo_N`、`history_N`，`src/ai.mjs:227-250`。

当前三条路径的 evidenceIds 均不会为空，所以模型不能提交目录外 ID 而通过 schema。

#### B. decision 的业务候选也受约束

- 项目分类 `businessId` 只能来自输入业务 ID 或 null：`src/ai.mjs:172-179`。
- 项目进度 status 只能来自本机 `allowedStatuses`：`src/ai.mjs:194-208`。
- 早晨 `mentionedIds` 使用候选 enum，并在 schema 后再次执行 Set 校验：`src/ai.mjs:227-255`。

#### C. AI 模块只向调用方返回 decision

- 项目创建：`src/ai.mjs:190`。
- 项目进度：`src/ai.mjs:220-223`。
- 早晨对焦：`src/ai.mjs:253-256`。

附件范围内没有其他代码读取 `result.analysis`。因此分析信封在 AI 模块内用于校验和 confidence 调整，调用方只拿到业务 decision。

#### D. 人工排期权在附件内得到结构性保护

- 产品最高规则：`docs/PRODUCT_SPEC.md:9-19`。
- 早晨工作流 developer instructions 明确禁止加入今日和修改日期/优先级：`src/ai.mjs:247-250`。
- `morningChat()` 只保存消息和活动：`src/domain.mjs:522-537`。
- `todayPlan` 仅由 `setToday()` 显式修改：`src/domain.mjs:540-550`。
- 跨日会先清空旧计划并设置当天日期：`src/domain.mjs:545-547`。

### 4.2 冲突与缺口

#### AI-06：ID 范围合法不等于证据语义真实（中）

schema 只约束 `analysis.evidence.id` 在目录中，`observation` 只是 1–240 字符文本。模型仍可能对一个合法 ID 给出不被输入支持的描述，或重复同一 ID。当前 schema 没有 `uniqueItems`，本机也没有 evidence 语义核验。

#### AI-07：完整持久化链无法全部验证（中）

虽然 `ai.mjs` 只返回 decision，但 `src/projects.mjs`、`src/store.mjs`、`writeProjectMd` 实现未附。项目进度写入和 state 序列化的完整排除证明不足。

#### AI-08：审计性与隐私之间的文档表述需更精确（低）

“不持久化分析信封”保护隐私和避免保存思维草稿，但也意味着事后无法复原模型引用了哪些证据。规范应明确：可以记录非敏感的调用状态/版本/回退原因，不能记录 observation 草稿或原始 provider payload。

### 4.3 AC-02 裁决

**PARTIAL。** 当前源码足以确认 evidence ID 的范围约束、候选 ID 限制、decision-only 返回以及人工排期边界；但不能把“证据语义真实”和“完整持久化链”判定为已验证。

## 5. AC-03：飞书每日工作日记 → 收件箱完整链路

### 5.1 事实链路

#### 1. 数据源配置

- `src/domain.mjs:208-241` 保存 `provider/documentUrl/inboxHeading/inboxPrefix` 和同步元数据。
- `src/feishu.mjs:48-57` 仅接受无 userinfo 的 `http:`/`https:` URL。
- `src/feishu.mjs:157-159` 以 provider + 非空 URL 判断已配置。

#### 2. 读取文档

- `src/feishu.mjs:121-135` 调用：
  `lark-cli docs +fetch --api-version v2 --as user --doc <url> --detail with-ids --format json`。
- `src/feishu.mjs:74-80` 使用 `execFile`、30 秒默认超时、4 MiB stdout 上限，没有 shell 拼接。
- `src/feishu.mjs:30-45` 校验 JSON 和文档正文。

#### 3. 定位和解析收件箱

- `src/feishu.mjs:88-95` 找到第一个匹配的 `<h1>收件箱</h1>`，截取到下一个简单 h1。
- `src/feishu.mjs:97-108` 只扫描 `p/checkbox/li`，解码文本，要求前缀，要求 block ID。
- `src/feishu.mjs:109-112` 通过 Map 按 block ID 去重。

#### 4. 同步本地缓存

- `src/domain.mjs:258-270` 读取配置并 fetch；失败只更新同步错误元数据，不修改 inbox。
- `src/domain.mjs:271-292`：
  - 现有 block：更新文本；
  - 没有本地项但有同 block/同文本 ack：不重导入；
  - 新 block 或已消费后文本变化：导入新本地事项。
- `src/domain.mjs:293-299`：远端不存在的未处理飞书事项从本地 inbox 移除并写活动日志。
- `src/domain.mjs:301-311`：随后单独更新 revision、时间、状态和计数。

#### 5. 手工/iPhone 新增在已绑定飞书时的路径

- `src/domain.mjs:384-392`：source 不是 `feishu_doc` 且数据源已配置时，先调用 `appendAndFetch()`，再把 source 改成 `feishu_doc`。
- `src/feishu.mjs:137-153`：
  - 写前 fetch；
  - 以最后一个已解析 `[INBOX]` block 或 heading block 为 anchor；
  - `block_insert_after`；
  - 再 fetch；
  - 按 `item.text === text` 找到最后一个同文本项。
- `src/domain.mjs:393-404`：读回得到 block ID 后才提交本地 state。

#### 6. 用户处理后的抑制重导入

- `src/domain.mjs:473-500`：删除、备忘、待办或项目记录都会从活跃 inbox 移除。
- 导入时建立的 `inboxAcks` 保留，因此远端 unchanged block 不会在下次同步重新出现：`src/domain.mjs:284-289`。

### 5.2 本地 mock 探针结果

以下只使用附件代码和 mock `exec`，没有真实网络或飞书：

1. **block ID 去重**：同一 ID 的两个条目最终保留后一个文本，证实 Map last-value 行为。
2. **嵌套 h1 越界**：`<h1><span>日志</span></h1>` 未被 next-heading regex 识别，后续章节的 `[INBOX]` 条目被错误导入。
3. **重复文本误确认**：写前已有文本 `same` 的 block `old`；mock 写命令返回但读回没有新增 block。`appendAndFetch()` 仍返回 `old`，误认为新写入已确认。
4. **空白规范化读回失败**：输入 `a  b`，远端解析后被 `decodeXmlText()` 折叠为 `a b`；写命令已返回，但读回精确比较失败，抛出 `FEISHU_SOURCE_READBACK_FAILED`。

这些探针是本轮新建的只读/模拟检查，不是附件中的正式测试，也不证明真实飞书行为。

### 5.3 主要发现

#### FS-01：写后读回可绑定旧的同文本 block（高）

**事实：** `src/feishu.mjs:149-151` 在全章节中找所有 `item.text === text`，选择最后一个；没有比较写前 block ID 集合，也没有要求 revision 前进。

**推论：** 重复文本、并发同文本写入或最终一致性延迟时，系统可把旧 block 当成新写入，随后把本地事项绑定到错误 block。真正的新 block 后续可能被重复导入。

**建议：** 写前记录 block ID/revision，读回只接受“新 ID + 正确章节 + 规范化文本相等”的唯一匹配；零个或多个匹配分别返回 indeterminate/ambiguous，绝不选旧 block。

#### FS-02：空白/多行输入可形成外部成功、本地失败（高）

**事实：** `decodeXmlText()` 在 `src/feishu.mjs:26` 把所有空白折叠为单空格；读回在 `149` 与原输入精确比较。

**推论：** 双空格、多行、制表符等输入即使已经写入飞书，也可能无法读回确认。用户重试可制造重复远端条目。

**建议：** 定义单一 canonical normalization，写前、比较和本地存储使用同一结果；响应明确区分 write indeterminate，配合幂等键。

#### FS-03：下一个一级标题含嵌套标记时发生章节越界（高）

**事实：** `src/feishu.mjs:94` 的 next-heading regex 要求 h1 内容不含 `<`。

**推论：** 飞书返回富文本标题、span 或其他内嵌标记时，解析器可能继续扫描后续日期/日志章节，把不属于收件箱的 `[INBOX]` 文本导入。

**建议：** 使用结构化 block tree；至少让边界匹配支持任意 h1 内部内容，并对章节层级做 fixture 测试。

#### FS-04：导入即 ack 会抑制远端恢复（高）

**事实：** 新 remote 在 `src/domain.mjs:286-289` 导入时立即写 `inboxAcks`；远端删除在 `293-299` 移除本地项但不删 ack；以后同 block/同文本在 `284-285` 被跳过。

**推论：** 未处理事项被远端暂时删除后恢复，或一次错误解析把它视为消失后恢复，都可能永久不再显示。

**建议：** 区分 active/seen/consumed。只有用户真正处理或明确删除时创建 consumed receipt；未消费的远端恢复必须重新导入。

#### FS-05：同步没有 source fingerprint/CAS（高—中）

**事实：** `src/domain.mjs:259` 读取配置，`263` 执行外部 fetch，`273-300` 更新 state，`301-310` 再读取并更新当前 config；期间没有比较 document URL/heading/prefix 是否变化。

**推论：** 用户在 fetch 期间更换数据源时，旧文档事项可能被导入，新配置却被写上旧 revision/计数。

**建议：** 固定 source fingerprint；进入提交队列后再次比较，不一致时返回 `409 FEISHU_SOURCE_STALE`，整包丢弃。

#### FS-06：state 与 config 分两次提交（中）

**事实：** inbox 差异先 `updateState()`，同步元数据后 `updateConfig()`。

**推论：** state 成功而 config 失败时，API 可能报错但事项已导入；重试虽能依靠 block ID 去重，操作状态仍不一致。

**建议：** 同一可恢复事务边界、journal/outbox，或至少定义明确的 partial-success 响应和重启对账。

#### FS-07：并发去重命中时 API 可能返回未存储 ID（中）

**事实：** `src/domain.mjs:393` 先生成新 `item.id`；`395-396` 若已有同 block，则保留 existing.id；`404` 仍返回新建的 `item`。

**推论：** 并发 sync 在 capture 本地提交前已导入该 block 时，调用者收到的 ID 可能不存在于 state。

**建议：** state callback 返回实际 stored item；外层返回 callback 结果。

#### FS-08：实现并不保证写到章节末尾（中）

**事实：** `src/feishu.mjs:141` 选择最后一个已解析 `[INBOX]` 条目，或标题本身。`docs/ARCHITECTURE.md:18` 则称写入章节末尾。

**推论：** 章节内若有未标记说明、空段落或其他 block，新增项会插在它们之前。

**建议：** 从结构化章节 children 中取得真实末尾 block；修正文档或实现，二者只能保留一个真相。

#### FS-09：输入、条目和回执增长缺少显式业务上限（中）

**事实：** `addInbox()` 只检查非空；parser 导入全部匹配项；`inboxAcks` 未见 prune。CLI 只有 4 MiB stdout 上限。

**推论：** 有效 token、异常文档或长期运行可导致超长命令参数、state 膨胀和 UI/备份成本上升。

**建议：** body、单条文本、远端条目数、总文本量、ack 保留周期全部设硬上限。

#### FS-10：URL 校验过宽且 `validateToken()` 未使用（中—低）

**事实：** `src/feishu.mjs:48-57` 接受任意 http/https host；`59-63` 的 SAFE_TOKEN 校验函数没有调用点。

**推论：** 当前意图似乎是严格 Feishu 标识，但实现仅做通用 URL 校验。是否可形成 SSRF 取决于 lark-cli 内部行为，附件不能证明，故不作已存在漏洞结论。

**建议：** allowlist 支持的飞书域名/URL 形态，删除死代码或真正使用 token 解析。

#### FS-11：同步元数据语义不一致（低）

- `src/domain.mjs:307` 把 `lastImportedCount` 设为远端总条目数，而不是本次 imported。
- `updateWorkbenchConfig()` 在更换 dataSource 时保留旧 revision/status/count：`218-220`；`configureDataSource()` 则重置：`235-241`。

建议统一字段为 `lastRemoteCount`、`lastImportedDelta`，并在 source 变化时重置。

### 5.4 AC-03 裁决

**PASS-WITH-HIGH-RISK-FINDINGS。** 链路已经被完整追踪，但 FS-01 至 FS-05 应在任何“飞书写入可靠/同步不会误导入”声明前修复并测试。

## 6. AC-04：iPhone Shortcut → `/api/capture` → 收件箱

### 6.1 文档可验证事实

- `docs/IPHONE_SHORTCUT.md:3-8`：目标是听写/输入后进入收件箱；前提是 iPhone 可访问的工作台地址和 `CAPTURE_TOKEN`。
- `docs/IPHONE_SHORTCUT.md:11-20`：POST、JSON、`text`、`source=iphone-shortcut`、Bearer token。
- `docs/IPHONE_SHORTCUT.md:23`：capture 只采集，不自动变待办或今日任务。
- `docs/API.md:3-5`：普通 API 的 cookie、JSON Content-Type、Origin/Host 规则。
- `docs/API.md:19`：capture 必须 Bearer `CAPTURE_TOKEN`，或启用访问密码后的有效登录 cookie。
- `docs/API.md:50`：文档声称 capture 使用有界固定窗口限流。

### 6.2 源码可支持的状态边界

- `src/domain.mjs:384-404` 的 `addInbox()` 只新增 inbox；如果飞书已配置，先执行飞书写入/读回再本地提交。
- `src/domain.mjs:454-505` 说明从 inbox 变成待办、备忘或项目记录需要后续明确 command。
- `src/domain.mjs:540-550` 说明加入今日是独立显式动作。

### 6.3 必须标记为推论的部分

由于 `src/server.mjs` 未附，只能推论而不能证实：

1. `POST /api/capture` 是否真的调用 `addInbox()`。
2. server 是否强制 `source=iphone-shortcut`，还是信任客户端任意 source。
3. Bearer token 与 cookie 的优先级、常量时间比较、缺失 token 行为。
4. Content-Type、JSON object、额外字段和文本长度校验。
5. Host/Origin 校验是否覆盖 capture。
6. 限流 key、窗口、上限和 `Retry-After`。
7. 响应是否返回实际存储 ID，是否泄露 token、绝对路径或底层错误。
8. 访问日志是否记录 Authorization。

### 6.4 Live 前提均未验证

- 服务是否监听局域网/Tailscale 地址，而非仅 loopback。
- Tailscale/局域网 ACL。
- HTTPS 证书、DNS 和 iOS 信任。
- Host allowlist 是否接受实际主机名。
- Shortcut 是否自动设置 `Content-Type: application/json`。
- iPhone 听写、背部轻点、锁屏/后台网络行为。
- Shortcut 失败时是否向用户显示错误。
- `CAPTURE_TOKEN` 在 Shortcut/iCloud 同步中的保护和轮换。
- 真实 Feishu 用户身份、文档权限、网络和读写延迟。

### 6.5 AC-04 裁决

**PARTIAL / DOCUMENT-ONLY。** 文档链路和领域层边界明确；服务端安全实现和真实设备前提全部未验证。

## 7. 风险与矛盾总表

### 7.1 风险优先级

| ID | 严重度 | 风险 | 当前证据 |
|---|---|---|---|
| FS-01 | 高 | 重复文本读回可绑定旧 block，误报外部保存成功 | `src/feishu.mjs:149-151` + mock probe |
| FS-02 | 高 | 空白规范化造成外部已写、本地失败，重试可重复写 | `src/feishu.mjs:17-27,149-151` + mock probe |
| FS-03 | 高 | 富文本一级标题导致章节越界导入 | `src/feishu.mjs:94-108` + mock probe |
| FS-04 | 高 | 导入即 ack 导致未消费事项删除后恢复仍不再出现 | `src/domain.mjs:284-299` |
| FS-05 | 高—中 | 数据源同步期间变化，旧结果污染新配置 | `src/domain.mjs:258-310` |
| AI-01 | 中 | “固定 Luna”与任意 `OPENAI_MODEL` 覆盖冲突 | `src/ai.mjs:127-129` |
| AI-02 | 中 | 项目进度 fallback/持久化模块未附 | missing `src/projects.mjs` |
| AI-03 | 中 | morning gaps/conflicts 不触发降级门禁 | `src/ai.mjs:40-45,234-256` |
| FS-06 | 中 | state/config 分步提交，错误语义不原子 | `src/domain.mjs:273-311` |
| FS-07 | 中 | 并发去重时返回未存储本地 ID | `src/domain.mjs:393-404` |
| FS-08 | 中 | 写入 anchor 与“章节末尾”文档不一致 | `src/feishu.mjs:140-147`、`docs/ARCHITECTURE.md:18` |
| FS-09 | 中 | 文本、条目、ack 无业务硬上限 | `src/domain.mjs:384-404` 等 |
| IOS-01 | 中 | capture 实际认证、限流、Host/Origin 未附 | missing `src/server.mjs` |
| TEST-01 | 中 | 正式测试缺失，无法证明回归和 API 合同 | tests omitted |
| FS-10 | 中—低 | URL host 未限制、token validator 死代码 | `src/feishu.mjs:48-63` |
| AI-04 | 低—中 | future empty evidence catalog 放开 ID | `src/ai.mjs:13-15` |
| FS-11 | 低 | lastImportedCount 和 source metadata 语义不一致 | `src/domain.mjs:208-241,301-311` |

### 7.2 明确矛盾

| 文档/声明 | 源码事实 | 裁决 |
|---|---|---|
| 固定 `gpt-5.6-luna + xhigh` | model 可由 `OPENAI_MODEL` 覆盖，只有 xhigh 固定 | 文档应改为“默认模型”，或实现禁止生产覆盖 |
| 写入“收件箱章节末尾” | 写到最后一个已解析 `[INBOX]` 条目或标题之后 | 实现与文档不一致 |
| 冲突/缺口导致降置信或回退 | morning decision 无 confidence，仍可接受回复 | 只可解释为无副作用讨论输出，需写明 |
| `/api/capture` 有认证/限流/Host 规则 | server 实现未附 | 文档事实，不是实现验证 |
| `lastImportedCount` | 保存的是 fetched.items.length | 字段名/含义不一致 |
| source 更换后的同步状态 | 一个配置函数保留旧值，另一个重置 | 需要单一配置合同 |

### 7.3 非矛盾但必须保留的限制

- `store:false` 只证明请求参数，不证明服务商“零处理/零留存”。
- Key 已配置、doctor 通过或 UI 显示 configured，不证明 OpenAI 可达。
- lark-cli 已安装/登录不证明目标文档有权限或格式稳定。
- `/api/health` 200 不证明 OpenAI、飞书、浏览器或 iPhone E2E。
- mock probe 证明代码路径，不证明 live 集成。

## 8. 缺失测试与建议验收矩阵

### 8.1 测试文件未附的硬限制

任务书明确说明：tests 因安全扫描检测到 fixture credential/PII 模式而从安全包省略。附件 `package.json:10` 虽定义 `node --test tests/*.test.mjs`，实际没有 `tests/`。

因此：

- 本轮不能报告 `npm test` 结果；
- 不能根据 mock 或文档宣称正式测试通过；
- 不能确认测试是否覆盖 AC-01 至 AC-04；
- 不能确认 fixture 中被扫描命中的内容是占位符、真实敏感值还是误报；
- 建议内部 Codex 验收包提供脱敏后的测试清单、真实命令输出和覆盖映射，而不把敏感 fixture 外发。

### 8.2 最低必须补齐的 AI 测试

1. 默认 Luna、`xhigh`、`store:false`、timeout、token 上下界。
2. 生产模式下 `OPENAI_MODEL` 覆盖政策。
3. 无 key 不发请求。
4. timeout/network/HTTP 4xx/5xx/invalid JSON/empty output。
5. incomplete/refusal/non-completed/provider error。
6. extra field、类型、范围、长度、候选 ID 越界。
7. evidence ID 越界、重复、空目录。
8. conflicts/gaps confidence cap。
9. 项目未完成时 100%/已完成修正。
10. morning 无候选和非法 mentionedIds。
11. 三类 fallback 不改变 inbox/due date/todayPlan。
12. 项目快照变化时整包 stale 丢弃。

### 8.3 最低必须补齐的飞书测试

1. 标准一级收件箱与下一个标准 h1。
2. h1 内嵌 span/富文本，确保不越界。
3. heading 无 ID、block 无 ID、无 heading、空章节。
4. duplicate block ID 必须作为格式冲突处理。
5. 相同文本不同 block ID。
6. 写前已有相同文本，读回无新增 block，不得误确认。
7. 双空格、多行、tab、XML 特殊字符。
8. 真实章节末尾 anchor。
9. remote add/update/delete/restore。
10. 已消费 unchanged/changed block。
11. 数据源在 fetch 期间变化。
12. state/config 任一写入失败。
13. sync 与 capture 并发。
14. 大文档、超长文本、ack prune。
15. CLI ENOENT、timeout、permission、invalid JSON、missing content、maxBuffer。

### 8.4 最低必须补齐的 capture/API 测试

1. 正确/错误/缺失 Bearer token。
2. 有效/无效 cookie。
3. 常量时间比较与日志不泄露 Authorization。
4. Content-Type、非法 JSON、额外字段、空/超长文本、body 过大。
5. Origin 合法/非法/缺失；Host 合法/非法；不信任 X-Forwarded-*。
6. 固定窗口限流和 `Retry-After`。
7. 幂等键重放与参数冲突。
8. 飞书配置/未配置两条路径。
9. API 返回实际已存储 ID。
10. 成功/失败都不创建待办、不加入今日。
11. 真实 iPhone + 局域网/Tailscale + HTTPS + 听写 + 成功/失败通知。

## 9. AC-06：安全外发包审查

### 9.1 已验证事实

`PUBLIC_MANIFEST.md` 声明：

- include scan pass；8 files；81,828 bytes；
- secret scan pass，0 findings；
- PII scan pass，0 findings；
- binary/media none，0 findings；
- ZIP size/hash 与实际附件一致。

本轮独立检查补充：

- ZIP 仅 8 个常规文件；无绝对路径、`..`、symlink 或 encryption。
- 解压后均为文本/JSON/JavaScript source。
- 归档中没有 `.env`、data/state、backup、workspace、node_modules、tests 或真实媒体。
- 简单模式探针未发现实际 OpenAI/GitHub key、private key、email 或中国大陆手机号；`ai.mjs` 中的 token/private-key 正则是脱敏实现，不是 credential。

### 9.2 限制

1. 结论只适用于当前安全包，不适用于完整本地仓库、被排除的 28 entries 或真实运行目录。
2. Manifest 没有列出 28 个 excluded entries 的名字，也没有提供 scanner 规则和完整报告。
3. “Authoritative PRD lineage: not provided by packager” 表明 packager 本身没有记录 PRD lineage；本轮只能通过任务书提供的 path/hash 与实际 PRD 做一致性核验。
4. tests 被省略本身是已知限制，而不是“测试不存在于项目”的结论。

### 9.3 AC-06 裁决

**PASS, PACKAGE SCOPE ONLY。** 当前附件包符合外发安全清单；不得把此结论外推为完整仓库或生产数据已无敏感信息。

## 10. 事实、推论、假设、建议分离

### 10.1 事实

1. 三附件哈希/大小、ZIP 8 文件和 PRD hash 已核验。
2. 默认模型是 `gpt-5.6-luna`，reasoning effort 是常量 `xhigh`。
3. model 可由 `OPENAI_MODEL` 覆盖。
4. Responses API 请求使用 strict JSON Schema、`store:false`、有界 timeout 和 token。
5. 三类工作流共享分析信封，当前 evidence ID 使用供应 enum。
6. AI 模块返回 decision，不返回完整 analysis。
7. morning 域函数不写 todayPlan；setToday 是独立显式函数。
8. 飞书 parser 使用 h1/正则、block ID Map 去重。
9. append readback 使用文本相等选择最后匹配项。
10. sync import 时立即写 ack，远端删除只移除 active inbox。
11. `/api/capture` 的认证与限流只有文档，server 未附。
12. tests 未附，`npm test` 未运行。

### 10.2 推论

1. 重复文本或最终一致性延迟可导致旧 block 被误绑定。
2. 空白折叠可导致外部已写、本地失败和用户重试重复写。
3. 富文本 h1 可造成后续章节被导入。
4. 未消费事项远端删除再恢复可能因 ack 永久不再出现。
5. 数据源切换与同步并发可把旧文档结果写到新配置。
6. capture 与 sync 并发可使 API 返回未存储 ID。
7. 任意 model override 可能造成能力/成本/兼容性漂移，但会在请求或 schema 失败时回退。

### 10.3 假设

下列内容没有附件实现支持，不得当作事实：

1. server route 把 `/api/capture` 映射到 `addInbox()`。
2. store 的 updateState/updateConfig 使用真正的原子替换和单进程队列。
3. lark-cli 的文档内容始终是当前 parser 假定的 XML 形态。
4. 飞书 revision 在写后必然单调前进且立即可见。
5. `CAPTURE_TOKEN` 使用常量时间比较、可轮换且不进入日志。
6. Tailscale、TLS、Host allowlist 和 iPhone Shortcut 已正确配置。
7. `gpt-5.6-luna` 当前真实支持 `xhigh` 和该 strict schema。

### 10.4 建议

按优先顺序：

1. 先修 FS-01/02：以新增 block ID 确认写入，统一文本规范化，引入幂等/indeterminate 状态。
2. 修 FS-03：取消脆弱章节正则或至少加入结构化/富文本标题测试。
3. 修 FS-04：把“导入已见”与“用户已消费”分离。
4. 为同步增加 source fingerprint/CAS，并统一 state/config 恢复边界。
5. 修并发 existing-ID 返回问题。
6. 决定生产模型到底是固定还是可配置，并统一文档与代码。
7. 对 morning gaps/conflicts 写出明确的讨论性降级合同。
8. 提供 server/store/projects/tests 的受控内部验收证据；安全外发时提供脱敏测试摘要。
9. 实施配套规范提案中的 API schema、错误码、body 上限、URL allowlist、幂等和测试矩阵。
10. 完成真实 OpenAI、飞书和 iPhone E2E 后，再分别标记 live verified；不得合并为一个笼统“已配置”。

## 11. AC-05 交付确认

本轮已交付：

1. 本报告：完整基线、AC-01 至 AC-06 映射、精确路径/行号证据、风险、矛盾、缺失测试和限制。
2. `PERSONAL_AI_WORKBENCH_V1_2_REVISED_SPEC_PROPOSAL.md`：可供 Codex 保存的完整 Markdown 规范提案。
3. 没有源码 patch、dependency 修改、部署、凭证处理或生产操作。

## 12. 残余风险与外部阻塞

即使按本报告修订文档，以下仍需外部证据才能关闭：

- 真实 OpenAI model/effort/schema 兼容性、延迟、成本和 provider 行为。
- 真实 Feishu content 格式、revision、一致性、权限和 lark-cli 版本行为。
- server 认证、Host/Origin、限流、日志和 body 实现。
- store 的崩溃原子性、备份和并发队列。
- 项目进度 fallback 和 `PROJECT.md` 写入。
- 真实 iPhone/Tailscale/HTTPS/Shortcut E2E。
- 被安全包排除的 tests、fixtures 和 28 个 entries。

在这些证据补齐前，推荐的外部状态标签是：

```text
source_reviewed = true
safe_package_reviewed = true
implementation_fully_verified = false
live_openai_verified = false
live_feishu_verified = false
live_iphone_verified = false
production_ready = unverified
```
