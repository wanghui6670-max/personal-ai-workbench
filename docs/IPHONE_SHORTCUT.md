# iPhone 快捷指令 → 飞书每日工作日记 → 工作台

这条链路不把飞书凭证放进 iPhone。快捷指令只携带专用 `CAPTURE_TOKEN`，请求工作台采集接口；工作台在已登录的本机 `lark-cli` 下执行：

```text
iPhone 听写/输入
  → 生成一次 captureId
  → POST /api/capture
  → 工作台调用 lark-cli 写入飞书“收件箱”章节
  → 工作台按 captureId 读回并确认飞书 block
  → 读回成功后提交本地收件箱与哈希收据
```

成功返回时，事项已经进入飞书文档和工作台收件箱，不需要再调用第二个同步接口。飞书里手动新增的 `[INBOX]` 条目，仍可在工作台点击“同步飞书收件箱”读回。

## 1. 先让 iPhone 能访问工作台

手机和运行工作台的 Mac 必须处于同一个可信局域网。先在 Mac 上查当前 Wi‑Fi IPv4 地址，再把下面的 `<Mac局域网IP>` 替换为当前地址，在 iPhone Safari 打开：

```text
http://<Mac局域网IP>:4173
```

如果 Safari 打不开，检查：

- Mac 工作台是否以 `HOST=0.0.0.0` 启动，而不是只监听 `127.0.0.1`；
- iPhone 与 Mac 是否连接同一个 Wi‑Fi，且不是启用了客户端隔离的访客网络；
- Mac 防火墙是否允许工作台进程接收入站连接；
- Mac 局域网地址是否变化；变化后需同时更新快捷指令 URL 与 `TRUSTED_ORIGINS`。

局域网 HTTP 只适合可信家庭或办公网络。不要把工作台端口直接暴露到公网；外网访问应使用受控的私网通道或 HTTPS 反向代理，并显式配置 `TRUSTED_ORIGINS`。

## 2. 新建快捷指令

在 iPhone“快捷指令”中新建一个快捷指令，按以下顺序添加动作：

1. 添加“听写文本”或“询问输入”。
2. 添加“生成 UUID”，并把结果保存为变量 `captureId`。
3. 添加“获取 URL 内容”。
4. URL 填：

   ```text
   http://<Mac局域网IP>:4173/api/capture
   ```

5. 展开“获取 URL 内容”的高级选项：
   - 方法：`POST`
   - 请求体：`JSON`
   - JSON 字段 `captureId`：选择第 2 步生成的 UUID
   - JSON 字段 `text`：选择第 1 步的文本变量
   - JSON 字段 `source`：可填写 `iphone-shortcut`，也可省略；服务端不会信任客户端标签决定持久化来源
   - 请求头 `Authorization`：`Bearer ` 加本机 `.env` 中的 `CAPTURE_TOKEN`
   - 请求头 `Content-Type`：`application/json`；如果界面已自动生成，可不重复添加
6. 测试时先保留“显示结果”；确认返回 JSON 后，再改成“显示通知”。

示例请求体：

```json
{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "text": "联系设计师确认门店海报终稿",
  "source": "iphone-shortcut"
}
```

不要把飞书 access token、app secret、cookie 或 `lark-cli` 登录文件放进快捷指令。快捷指令可能进入 iCloud 或设备备份；如需分享快捷指令，先删除或轮换 `CAPTURE_TOKEN`。

## 3. captureId 与重试规则

`captureId` 是一次采集的幂等身份，不是正文的一部分。

- 每条新采集生成一个新 UUID。
- 同一条采集的所有网络重试必须复用同一个 `captureId`。
- 不要把“生成 UUID”放进重试循环里。
- 如果快捷指令包含“等待后重试”，应把 UUID 保存在循环外的变量中。
- 收到超时或连接中断、无法确定服务端是否已处理时，不要重新生成 UUID；用原 UUID 和原正文重试。
- 同一 `captureId` 与同一正文再次提交：服务端返回第一次结果，不重复写飞书或收件箱。
- 同一 `captureId` 与不同正文再次提交：服务端返回 `409`，拒绝覆盖。
- 原事项已经处理后再重试：返回 `processed: true`，不会把事项重新放回收件箱。

为兼容旧客户端，服务端可以在缺少 `captureId` 时生成一个 ID；但这种请求无法为客户端侧的不确定重试提供可靠去重，因此快捷指令应始终显式发送 UUID。

## 4. 绑定语音入口

可以把快捷指令绑定到“轻点背面”双击、Siri 或主屏幕快捷方式。例如：

```text
设置 → 辅助功能 → 触控 → 轻点背面 → 双击 → 选择快捷指令
```

## 5. 成功与失败怎么判断

首次成功通常返回 HTTP `201`：

```json
{
  "captureId": "8f25a25e-2b0c-4fd1-b4df-a779848fd552",
  "replayed": false,
  "processed": false,
  "item": {
    "id": "in_...",
    "source": "feishu_doc"
  }
}
```

同一请求安全重放通常返回 HTTP `200` 且 `replayed: true`。

其他结果：

- `400`：请求体、`captureId` 或正文格式无效。
- `401`：token 错误、缺少 `Bearer ` 前缀，或服务改动后尚未重启。
- `409`：同一 `captureId` 被用于不同正文。
- `429`：请求过于频繁；按 `Retry-After` 等待，并使用原 `captureId` 重试。
- `502` 或其他飞书错误：工作台不会伪装成已同步；检查运行工作台的 Mac 上 `lark-cli` 的登录状态、网络和文档编辑权限。

只有返回的 `item.source` 为 `feishu_doc`，才能证明本次请求完成了飞书写入、block-ID 读回和本地缓存提交。如果尚未配置飞书收件箱数据源，采集可以只进入本地收件箱，此时 `item.source` 为 `iphone-shortcut`。

## 6. 工作台中的后续动作

采集事项只进入“收件箱”，不会自动分类、不会自动变成待办、不会补截止日期，也不会自动加入“今日工作台”。你需要在收件箱中明确选择“项目 / 待办 / 备忘 / 删除”；只有你明确加入的待办才会进入今日计划。

## 7. 验证边界

仓库测试覆盖了 HTTP 请求 schema、Bearer 授权、同 ID 重放、正文冲突、并发去重、飞书 marker 查重、哈希收据和恢复后重放。它们不等同于真实 iPhone、真实局域网、真实飞书账号或当前 iOS 界面的现场验收；首次使用仍应以一条无敏感内容的测试采集进行端到端核对。
