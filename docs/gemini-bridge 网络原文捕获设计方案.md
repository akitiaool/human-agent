# gemini-bridge 网络原文捕获设计方案（路线 A：网络流拦截）

> 2026-10-10 · 状态：定稿待实施
> 关联：`docs/统一式无转义语法体系与基于栈状态的 AST 解析器设计方案`（解析侧，与本方案正交）；P-A 探针样本在 `probe-samples/`

## 1. 问题与目标

AI Studio 把模型回复渲染成 markdown 后才进 DOM，从 DOM 取文必然失真：代码围栏被渲染器消费成 `ms-code-block`（还原是启发式）、空白/缩进/段落边界不可靠。解析歧义已由无转义 AST 语法（栈式解析器）解决；「渲染失真」必须在提取层解决——两者正交。目标是让桥服务收到的回复是**未渲染的模型原文**。

## 2. 路线决策（已定）

- 路线 A：网络流拦截。主世界 hook fetch/XHR，零新权限。B（组件内存）并入 A；C（复制按钮）弃；D+（长围栏装箱）数学否决——终止符可出现在任意内容里，任何固定长度都有洞。
- **DOM 回复捕获通道全部删除，不保留降级**。理由：双源并存必须仲裁（防双投=工具双执行），且 DOM 通道本身有损——有损降级的最坏形态是「静默污染」（如 edit_file 源文本被改一个字而无人知晓），比它更健康的失败形态是「响亮停滞」（面板不再出现「已回传」日志，一眼可诊、可修复）。捕获层坏掉的唯一后果是没有消息，绝不产出错值。

## 3. P-A 探针校准（2026-10-10）

- 端点：`https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent`
- 请求 Type = **xhr**；content-type = `application/json+protobuf`（protobuf 的 JSON 映射形式，文本非二进制，无需 .proto）
- 响应 = 逐步追加的 **JSON chunk 数组**（非 SSE）。完整响应体是一个合法 JSON（顶层 array[1]）
- 文本 part 形如 `[null, "text", ...]`；**thinking 判据：数组长度 > 12 且 index 12 === 1**。signature blob、grounding、usage 尾块均为空文本或非字符串，被「非空文本」过滤自然剔除
- **delta 切分任意**：实测切在词中间（"围|栏"）、切在标记 token 中间（`TOOL_CALL` 与 `[1]` 之间）、跨 chunk 补齐（末尾 `[1]\n}`）→ 必须**全量累加后一次解析**，任何逐片解析必死
- 线上字节把 `<`/`>` 写作 `\u003c`/`\u003e`（JSON 转义）→ 必须**先 `JSON.parse` 再喂 AST**；正则抠原始字节会失配 AST 的 `lexLine` 标记正则
- fixtures（`probe-samples/`，随本方案入库）：
  - `generatecontent-plain-reply.txt` 普通回复：15 deltas / 515 字
  - `generatecontent-tool-call-reply.txt` 工具调用回复：24 deltas / 1215 字，含嵌套 \`\`\`js / \`\`\`bash 围栏（根因场景端到端基准）

## 4. 总体结构

```
[MAIN world]  inject.js（document_start，浏览器级注入，不受页面 CSP 影响）
   钩 XMLHttpRequest + fetch → URL 命中 GenerateContent 时捕获响应原文
   window.postMessage({ __ha, v, kind, ... })
        ↓
[ISOLATED world]  content.js（document_idle）
   校验 → done 时 haDecodeGenerateContent(raw)（decode.js 纯函数）
        ↓ 解码后的回复原文
   postResult(reply) → POST /result → 桥服务（协议零改动）
```

职责切分：

- `inject.js`：纯运输层。捕获 + 转发，不解码、不解析、零页面干扰
- `decode.js`：纯函数层。JSON 解码 + delta 提取 + thought 过滤，零 DOM/chrome 依赖（可单测）
- `content.js`：接入层。消息校验、投递、日志、状态；既有投递循环/新对话检测/审批弹窗不动

## 5. 分节设计

### 5.1 注入层（inject.js）

manifest 新增条目（与现有 content.js 条目并存）：

```json
{ "matches": ["https://aistudio.google.com/*"], "js": ["inject.js"],
  "run_at": "document_start", "world": "MAIN" }
```

- **document_start**：先于页面任何脚本运行，hook 装在最前（页面无法抢跑缓存原始引用）
- **XHR 主通道**：
  - 包装 `XMLHttpRequest.prototype.open`：实例级记录本次请求 URL
  - 包装 `send`：URL 命中 → 发 `start` → 挂 `loadend`
  - `loadend`：读 `responseText` 全量发 `done`。流式响应期间 responseText 自动累积，无需 progress 处理——终点取全量与「全量累加后一次解析」铁律天然一致
  - `responseType` 非 text/'' 读不到 responseText → 发 `error`（诊断用）
- **fetch 薄兜底**：包装 `window.fetch`；命中 URL 时**同步 clone 响应**，异步 `text()` 完成后发 `done`；不命中完全透明
- **URL 命中判据**：`url.includes("GenerateContent")`（配 `urlTail` 进日志辅助诊断）
- **零干扰纪律**：自身逻辑全部 try/catch，永不向页面抛异常、不改实参、不碰响应对象。捕获层坏了 = 没有消息（响亮停滞），绝不破坏页面
- **握手**：注入即发 `hello`；content.js（document_idle 才就位，会错过首包）初始化发 `ping`，inject 应答 `hello`；content 侧若在收到 `hello` 前先收到任何捕获消息，补记「已挂载」（诊断日志）

### 5.2 转发层（postMessage 协议）

消息结构：

| 字段 | 说明 |
|---|---|
| `__ha` | 固定标记 `"gemini-bridge-capture"` |
| `v` | 协议版本，当前 `1` |
| `kind` | `hello` / `start` / `done` / `error` |
| `reqId` | 自增序号，配对 start/done |
| `raw` | （done）响应原文全量 |
| `urlTail` | （start/error）URL 尾部片段，日志用 |
| `reason` | （error）原因文本 |

- content 侧校验：`event.source === window` && `data.__ha === "gemini-bridge-capture"` && `data.v === 1`
- **只转发 done 的响应原文**（实测量级 18–33KB，postMessage 一次性无压力），不在 MAIN 解码。理由：解码逻辑、日志、诊断同处隔离世界；解码失败可记原文长度辅助定位；MAIN 侧保持「只抄不改」
- 伪造风险：能往窗口注入消息的只有页面自身（= AI Studio），且文本最终过桥侧 `parseToolCalls` 严格门 + 权限模型，危害有界

### 5.3 解析层（decode.js，纯函数）

```js
// 经典脚本：content_scripts js 数组顺序加载（先 decode.js 后 content.js）
function haDecodeGenerateContent(rawText) { ... }
// CJS 尾巴：vitest 直接 import 单测（纯函数，零 DOM/chrome 依赖）
if (typeof module !== "undefined" && module.exports) module.exports = { haDecodeGenerateContent };
```

`haDecodeGenerateContent(rawText)` → `{ answer, deltaCount, thoughtCount } | null`

算法：

1. `JSON.parse(rawText)`——失败返回 null
2. 递归 walk：数组 `x` 满足 `x[0] === null && typeof x[1] === "string"` 收为 part；`x.length > 12 && x[12] === 1` 判 thought
3. 非空、非 thought 的 part 按遍历序拼接为 answer（遍历序即 delta 到达序）
4. answer 为空返回 null

- 两条铁律在此兑现：`\u003c` 转义被 parse 消化；任意切分被「全量 walk」消解
- thought 过滤是刚需：样本 2 的 thinking 里出现 `<::: TOOL_CALL[1]` 字面量，混入拼接会让 AST 的「以 `{` 起、以 `}` 止」校验失败（整条回复作废）
- 不设容错：解码失败 = 本轮不投递（面板记日志）。响亮停滞优先于静默错值

### 5.4 接入与删除（content.js）

接入：

- 新增 window message 监听（校验见 5.2）
- `hello` → 首次日志「网络捕获已挂载」
- `start` → 日志「网络捕获：检测到 GenerateContent 请求」
- `done` → `haDecodeGenerateContent(raw)`：
  - 成功 → `postResult(answer)`（沿用 lastPostedReply 去重与「已抓取回复（等待执行）」状态流），日志「网络捕获：已回传（1215 字符，24 deltas，滤 5 thought）」
  - 失败 → 日志「网络捕获解码失败（原文 N 字符），本轮不投递」
- `error` → 日志原因

删除（DOM 回复捕获全套）：

- `monitorLoop`、稳定采样（`STABLE_SAMPLES` / `SAMPLE_INTERVAL_MS`）、`extractReply`、`findLastModelTurn`、`announcerReady` 及残留状态（`announcerPrevReady` / `announcerReadySince`）、历史基线逻辑
- 历史基线本就为防 DOM 重放（页面渲染旧回复 + 桥重启后 lastContent 为空），网络层天然无此问题（加载历史不发 GenerateContent），随 DOM 通道一并删除

保留（与本设计正交，零改动）：

- 投递循环：长轮询 / 模拟输入 / 自动提交 / 协议注入与新对话重注入
- 新对话检测：观察会话容器重置 → 排队协议重注入（独立机制，不用网络捕获替代）
- 审批弹窗 / 白名单按钮 / 桥不可达重试 / 面板设置

失败模式（设计意图）：hook 失手（端点改名 / 传输迁移 / 注入失败）→ 任务照常回填提交、页面照常显示回复，但面板不再出现「已回传」= 响亮停滞，可诊断、可修复；无任何静默降级。

### 5.5 测试

单测（`tests/bridge-decode.test.ts`，vitest，直接吃真实 fixture）：

1. **普通回复**：解码成功；515 字符；以「你好！」开头；无 `{` 头
2. **工具调用回复**：解码成功；startsWith `{` / endsWith `}`；含 `<::: TOOL_CALL[1]` 与 `:::> TOOL_CALL[1]`；\`\`\`js 与 \`\`\`bash 两对围栏逐字节在；1215 字符
3. **贯通一测**：decode(样本 2) → `ASTParser.parseToInference` → toolTree = 1 个 `write_file`（path=`docs/example.md`，content 内嵌围栏原文、于 CONTENT 闭合符前终止）——「网络原文 → 解码 → 无转义 AST」全链焊死
4. **健壮性**：非 JSON / 空 part / 仅 thought → null

手动 E2E（浏览器，需真实 AI Studio）：

- 全链一轮：协议注入 → 任务回填提交 → 网络捕获（面板日志）→ 工具执行 → 结果回填 → 再捕获
- 制造解码失败（临时改坏 raw）→ 确认响亮停滞（无「已回传」日志、页面正常）
- 确认历史加载不触发任何捕获/投递（无基线逻辑后重放风险归零）

## 6. 改动清单

| 类型 | 路径 | 说明 |
|---|---|---|
| 新增 | `extensions/gemini-bridge/inject.js` | MAIN world 薄 hook |
| 新增 | `extensions/gemini-bridge/decode.js` | 纯函数解码器（CJS 尾巴双用） |
| 新增 | `tests/bridge-decode.test.ts` | fixture 驱动单测 |
| 新增 | `probe-samples/`（2 份） | P-A 探针 fixture（随本方案入库） |
| 修改 | `extensions/gemini-bridge/manifest.json` | v0.3.0；新增 MAIN world 条目 |
| 修改 | `extensions/gemini-bridge/content.js` | 消息接入 + DOM 捕获删除 |
| 修改 | `extensions/gemini-bridge/README.md` | 结构说明更新 |
| 不动 | `src/**` | 桥服务协议零改动；ASTParser 已就绪 |

## 7. 风险与已知边界

- **AI Studio 传输迁移**（XHR → fetch 之外的新通道，如 WebSocket/Service Worker）：hook 失手 = 响亮停滞，更新 hook 即可；fetch 已预挂
- **端点改名**：URL 命中失败 = 同上
- **Chrome 版本**：manifest `world: "MAIN"` 需 Chrome 111+
- **postMessage 伪造**：页面自身可信度 + 桥侧严格解析门 + 权限模型，危害有界
- **多标签页同开**：既有已知问题（GET /task 无租赁语义），本设计不涉及
- **扩展重载**：改扩展代码后需刷新 AI Studio 页面（content script 不热重载），README 说明
