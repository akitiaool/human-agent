# gemini-bridge 浏览器扩展

human-agent 与网页版 Gemini（AI Studio）之间的**双向通道**：
brain 的任务消息填入页面输入框（brain → 页面）；Gemini 回复完成后抓取并回传 brain
（页面 → brain），形成「任务消息 → 页面 → Gemini 回复 → 回传 → 下一轮任务」的双向循环。

## 前置条件

- Chrome / Edge（Chromium 内核）
- 已登录 https://aistudio.google.com（保持页面打开）
- human-agent 已启用 Gemini 桥大脑：`GEMINI_BRIDGE_PORT=8765 pnpm dev`（默认端口 8765）

## 安装

1. 浏览器打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录（`extensions/gemini-bridge`）

## 使用

- **自动发送**（开关开启）：任务消息填入输入框后，隔**随机时间**（约 3–8s，防止机器人检测）
  自动点击页面发送按钮；回复稳定后自动回传。
- **手动模式**（关闭自动发送）：任务消息填入输入框但**不自动发送**，由你点击 AI Studio
  页面自己的发送按钮提交；插件监控到发送后等待回复完成并自动回传。
- **交给智能体**：把输入框当前内容**不经页面发送**、直接作为当前任务的回复回传 brain
  （人工干预快速通道——如直接粘贴 tool_call 让智能体执行）。
- **回填**：把最近一次任务消息/回复粘贴到输入框，可编辑后再发送。

## 端口配置

扩展默认连接 `127.0.0.1:8765`。若 brain 侧修改端口，需同步修改：

- `manifest.json` 的 `host_permissions`（`http://127.0.0.1:<端口>/*`）
- `background.js` 顶部的 `BASE` 常量

## 排查：页面结构变化

AI Studio 的 DOM 结构可能更新导致插件失效（如找不到输入框/发送按钮/回复文本）。
此时打开 DevTools 检查页面元素，更新 `content.js` 顶部的选择器：

- `findInput`：输入框（`rich-textarea div[contenteditable="true"]` 或任意 `[contenteditable="true"]`）
- `findSendButton`：发送按钮（`button[data-test-id="send-button"]` 等）
- `findStopButton`：停止生成按钮（生成中才出现，用于判断回复是否完成）
- `findLastReply`：最后一条模型回复（`.markdown` 元素）
