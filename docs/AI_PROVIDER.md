# AI Provider 配置与第三方 API 适配

## 1. 支持范围

程序当前注册三个 Profile：

| Profile | Adapter | 默认状态 | 用途 |
|---|---|---:|---|
| `openai_luna` | `openai_responses` | 兼容既有配置 | 默认 Luna Responses API |
| `third_party_responses` | `openai_responses_compatible` | 关闭 | 明确兼容 Responses 请求与响应语义的第三方 API |
| `third_party_chat_completions` | `openai_chat_completions_compatible` | 关闭 | 支持 Chat Completions 与结构化输出的第三方 API |

这不是任意 HTTP 转发器。程序不接受来自普通业务请求的任意 URL、method、path、header、请求模板或环境变量名。厂商原生 API 需要新增受审计的专用 Adapter，不能通过动态 JSON 模板代替代码实现。

## 2. 默认 Luna 与兼容变量

未设置 `AI_PROVIDER_PROFILE` 时默认使用 `openai_luna`：

```dotenv
OPENAI_API_KEY=<在部署环境中设置，不要提交>
OPENAI_MODEL=gpt-5.6-luna
```

默认行为保持：

- endpoint：OpenAI 官方 `/v1/responses`；
- reasoning：`xhigh`；
- structured output：strict JSON Schema；
- retention control：`store:false`；
- timeout：120 秒；
- Provider 失败后使用本地规则，不自动切换到另一家云服务。

`OPENAI_MODEL` 为既有兼容入口。生产环境若要求模型绝对固定，应不要覆盖它。

## 3. 同一网关配置两个模型

同一个第三方网关可以同时登记两套模型和密钥，但每次请求只使用一个明确的 active model。程序不会因为一次请求失败就自动把内容发送给另一家模型；Provider 失败仍按产品规则回退本地判断。

```dotenv
AI_PROVIDER_PROFILE=third_party_responses
AI_PROVIDER_ENABLED=1
AI_PROVIDER_BASE_URL=https://gateway.example.invalid/v1
AI_PROVIDER_ALLOWED_ORIGINS=https://gateway.example.invalid
AI_PROVIDER_NETWORK_ZONE=public_https
AI_PROVIDER_MODEL=gpt-5.6-luna
AI_PROVIDER_API_KEY=<OpenAI 组密钥>
AI_PROVIDER_GROK_MODEL=grok-4.6
AI_PROVIDER_GROK_API_KEY=<Grok 组密钥>
AI_PROVIDER_ACTIVE_MODEL=gpt-5.6-luna
```

字段含义：

- `AI_PROVIDER_MODEL` / `AI_PROVIDER_API_KEY`：主模型及其凭证；
- `AI_PROVIDER_GROK_MODEL` / `AI_PROVIDER_GROK_API_KEY`：第二模型及其凭证；
- `AI_PROVIDER_ACTIVE_MODEL`：必须精确匹配已登记的模型 ID，决定当前请求使用哪套凭证；留空时使用主模型。

健康接口和工作台设置只显示模型 ID、可用模型和当前 active model，不显示 endpoint 或密钥。切换 active model 后必须重启服务，再用非生产数据做 smoke test。

## 4. 第三方 Responses-compatible

管理员部署示例：

```dotenv
AI_PROVIDER_PROFILE=third_party_responses
AI_PROVIDER_ENABLED=1
AI_PROVIDER_BASE_URL=https://gateway.example.invalid/v1
AI_PROVIDER_ALLOWED_ORIGINS=https://gateway.example.invalid
AI_PROVIDER_NETWORK_ZONE=public_https
AI_PROVIDER_MODEL=approved-model-id
AI_PROVIDER_API_KEY=<在部署环境中设置，不要提交>
```

程序固定调用：

```text
${AI_PROVIDER_BASE_URL}/responses
```

第三方必须支持：

- `instructions` 与 user `input` 分离；
- `text.format.type=json_schema`；
- strict schema；
- 单一结构化输出；
- completed/incomplete/refusal 或等价可识别状态；
- `reasoning.effort=xhigh`，除非已走显式批准降级；
- `store:false`，除非已走显式批准降级。

只宣传“OpenAI compatible”不等于满足该合同。

## 5. 第三方 Chat-Completions-compatible

管理员部署示例：

```dotenv
AI_PROVIDER_PROFILE=third_party_chat_completions
AI_PROVIDER_ENABLED=1
AI_PROVIDER_BASE_URL=https://gateway.example.invalid/v1
AI_PROVIDER_ALLOWED_ORIGINS=https://gateway.example.invalid
AI_PROVIDER_NETWORK_ZONE=public_https
AI_PROVIDER_MODEL=approved-model-id
AI_PROVIDER_API_KEY=<在部署环境中设置，不要提交>
```

程序固定调用：

```text
${AI_PROVIDER_BASE_URL}/chat/completions
```

默认映射：

- 固定规则进入 `system` message；
- 不受信业务数据只进入 `user` message；
- `response_format.type=json_schema`；
- `reasoning_effort=xhigh`；
- `max_completion_tokens`；
- `store:false`；
- 只接受一个 assistant candidate，`finish_reason=stop`。

某些兼容服务只接受 `max_tokens`，可以由管理员设置：

```dotenv
AI_PROVIDER_CHAT_TOKEN_FIELD=max_tokens
```

允许值仅为 `max_completion_tokens` 或 `max_tokens`。

## 6. 本机兼容服务

只有明确的 loopback Profile 可以无凭证运行：

```dotenv
AI_PROVIDER_PROFILE=third_party_chat_completions
AI_PROVIDER_ENABLED=1
AI_PROVIDER_BASE_URL=http://127.0.0.1:11434/v1
AI_PROVIDER_ALLOWED_ORIGINS=http://127.0.0.1:11434
AI_PROVIDER_NETWORK_ZONE=local_loopback
AI_PROVIDER_MODEL=local-model-id
AI_PROVIDER_ALLOW_ANONYMOUS=1
```

`AI_PROVIDER_ALLOW_ANONYMOUS=1` 不允许与公网 zone 一起使用。`local_loopback` 只接受 `localhost`、`127.0.0.0/8` 或 `::1`。

## 7. 工作流 allowlist

默认允许四个工作流（包含右侧 AI 控制平面的工具规划）：

```text
project_creation,project_progress,morning_dialogue,ai_console
```

可以收窄：

```dotenv
AI_PROVIDER_WORKFLOWS=project_creation,morning_dialogue,ai_console
```

未知工作流或未获准工作流会 fail-closed。

## 8. 显式降级

默认不得静默降低 reasoning、structured output 或 no-store 能力。确有审查结论时，必须成对设置模式与批准开关。

### reasoning 降级

```dotenv
AI_PROVIDER_REASONING_MODE=approved_downgrade
AI_PROVIDER_ALLOW_REASONING_DOWNGRADE=1
```

此时不发送 Provider-specific reasoning 字段，并在 `aiConfig.degraded` 中标记。

### Chat JSON object + 本机 schema 校验

仅 Chat Adapter 支持：

```dotenv
AI_PROVIDER_STRUCTURED_OUTPUT_MODE=json_object_local_validate
AI_PROVIDER_ALLOW_SCHEMA_DOWNGRADE=1
```

程序仍会严格执行本机 JSON Schema；任何偏差都拒绝结果。

### Provider 不支持 no-store

```dotenv
AI_PROVIDER_NO_STORE_MODE=approved_unsupported
AI_PROVIDER_ALLOW_NO_STORE_DOWNGRADE=1
```

只有在数据保留、训练使用、区域和合规政策已单独批准后才应设置。该开关不会降低脱敏与输入最小化要求。

## 9. 其他运行限制

```dotenv
AI_PROVIDER_TIMEOUT_MS=120000
AI_PROVIDER_MAX_RESPONSE_BYTES=2000000
AI_SEND_FILE_CONTENT=0
```

安全边界：

- timeout 被限制在 1–300 秒；
- response body 被限制在约 16 KiB–8 MB 的管理员范围内，默认 2 MB；
- 默认禁止 redirect；
- 公网 endpoint 必须是 HTTPS，并在请求前拒绝 loopback、私网、link-local 和保留地址解析；
- base URL 不允许 username、password、query 或 fragment；
- endpoint 原点必须与 `AI_PROVIDER_ALLOWED_ORIGINS` 精确匹配；
- Provider 原始错误正文、Authorization、input、完整输出和 analysis 不写入业务 state；
- `AI_SEND_FILE_CONTENT=1` 才发送 `PROJECT.md`/文件片段；旧 `OPENAI_SEND_FILE_CONTENT=1` 仅在默认 `openai_luna` Profile 下作为兼容别名。

## 10. 验证状态

配置完成不等于真实 API 验证完成。上线前至少需要：

1. 通用 Provider 合同测试；
2. 目标 endpoint 的请求/响应 fixture 测试；
3. 使用非生产数据的真实 API smoke test；
4. timeout、429、5xx、refusal、incomplete、非法 JSON、schema 越界和超大响应测试；
5. 确认 Provider 数据保留与训练政策；
6. 确认 UI 显示实际 Profile、model 和 `degraded` 状态。

当前源码包没有提供真实第三方 endpoint 或凭证，因此本次只能验证本地 Adapter 合同，不能宣称任一第三方 API 已 live verified。
