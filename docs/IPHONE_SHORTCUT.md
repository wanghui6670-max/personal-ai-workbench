# iPhone 快捷指令采集

目标：双击手机背面或调用快捷指令，说/输入一句话，直接进入工作台收件箱。

## 前提

工作台需要有一个 iPhone 能访问的地址，例如局域网地址或 Tailscale 地址，并设置 `CAPTURE_TOKEN`。

## 快捷指令步骤

1. 新建快捷指令。
2. 添加“听写文本”或“询问输入”。
3. 添加“获取 URL 内容”。
4. URL：`https://你的工作台地址/api/capture`
5. 方法：POST。
6. 请求体：JSON。
7. 字段：
   - `text` = 听写文本
   - `source` = `iphone-shortcut`
8. Header：`Authorization` = `Bearer 你的 CAPTURE_TOKEN`
9. 在 iPhone 设置 → 辅助功能 → 触控 → 轻点背面，把“双击”绑定到这个快捷指令。

注意：快捷指令只负责采集。内容进入收件箱后仍需要你给 AI 指令，系统不会自动变成待办或自动加入今日。
