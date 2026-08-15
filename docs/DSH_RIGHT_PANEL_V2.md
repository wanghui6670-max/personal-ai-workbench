# DSH Right Panel v2

目标：让 Personal AI Workbench 的右侧成为 IDE 风格的 DSH Agent 工作区，而不是产品介绍式聊天侧栏。

当前约束：

- DSH 永久拥有右侧，不回退旧 Workbench AI。
- Workbench 中间确定性页面不改。
- Harness Runtime、MCP allowlist、只读/预览权限边界不改。
- 默认桌面宽度 500px，可拖拽调整；刷新后回到默认值，不使用浏览器持久化。
- 顶部只保留“聊天”、健康状态、新对话、设置、收起。
- 助手回复采用无卡片内容流；用户输入保留轻量区分。
- 没有真实工具调用时不显示工具轨迹；有调用时以轻量折叠摘要呈现。
- composer 使用 Agent + 当前模型 + 发送，不伪造未接入的附件能力。
