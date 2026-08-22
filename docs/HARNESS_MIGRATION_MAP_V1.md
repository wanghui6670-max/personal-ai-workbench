# Workbench v3 → Harness-first 迁移地图

| 当前模块 | 新身份 | 迁移策略 |
|---|---|---|
| `harness/navigator.cordis.yml` | Agent profile | 降级；不能代表整个 Harness |
| `harness/employee.cordis.yml` | Agent template | 保留 persona/runtime 配置，接入 Agent Registry |
| `src/mcp/registry.mjs` | Tool/Capability Registry 原材料 | 提取通用注册、schema、approval 逻辑 |
| `src/harness-navigator.mjs` | DSH runtime adapter | 保留 provider/event 适配，移除 Workbench 主权 |
| `src/domain.mjs` | Personal Workbench domain | 迁为 workbench pack 内部实现 |
| Inbox/Todo/Today | Workbench capabilities/views | 从 Core 移出 |
| Project | Project capability | 保留真相源规则，注册成 capability |
| Feishu | Plugin | 读写分别声明 tool risk |
| Joycrew | Execution pack/plugin | Run/Evidence/Approval/Deliverable 注册为能力 |
| GetNote | Content source plugin | 保持 read-only 默认 |
| `src/server.mjs` | Bootstrap/transport | 最终只负责 boot/load/start |

## 不可破坏的现有安全基线

- 飞书普通日记/分析不得自动变成 Todo。
- 外部写操作维持 Preview/Confirm/Execute/Readback 语义。
- 浏览器不得提供任意上游 URL、Token、Shell、服务端路径。
- Joycrew 不得阻塞 Workbench readiness。
- Capture 保持稳定 `captureId` 幂等。
- 本地项目文件夹 + Git 继续作为工作产物/版本证据；飞书项目文档继续承担项目叙事真源，直到新的 Session contract 有明确迁移裁决。
