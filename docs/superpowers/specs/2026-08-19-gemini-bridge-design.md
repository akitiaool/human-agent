# Gemini 桥设计文档 v2（网页对话驱动 · 智能体仅执行）

日期：2026-08-19（v2 设计纠正）
状态：v1 已与用户逐节确认；v2 经用户拍板 4 项决策后定稿

## 背景与目标

qwen3:4b（当前 Ollama 大脑）工具调用能力不足（参数漏传频发）。Gemini 官方 API 国内不可直连，但网页版 AI Studio 可用。目标：让 human-agent 以**网页版 Gemini 作为对话大脑**，同时引入**大脑职责模型重构**（知识库 / 思考 / 反思分层）。

**方案形态**：浏览器插件（Chrome/Edge MV3）运行于 AI Studio 页面，作为 human-agent 与网页 Gemini 之间的桥。不依赖 Playwright / Python。

## 设计纠正（v2，2026-08-19 用户拍板）

v1 把桥做反了：CLI 驱动对话，插件把任务消息脚本化塞进网页——对话集中在 CLI、网页消息形态机械，连续数轮即被识别为机器人。用户纠正：

> 对话发生在网页。插件把网页模型（Gemini）生成的最新对话内容自动传递给智能体处理；智能体处理后的最新消息回填到网页输入框，提交给网页模型。

**v2 核心：桥模式（`GEMINI_BRIDGE_PORT` 设置时）对话全在网页，智能体不做模型推理、只执行工具。**

用户拍板的 4 项决策：

| 决策 | 定案 |
|---|---|
| 智能体如何处理网页内容 | **仅执行工具**：解析 Gemini 回复中的 ```tool_call``` 块 → 反思层裁决 → 双手/眼睛执行 → 结果回填；无 tool_call 不回填，循环自然终止（不引入 Ollama 推理） |
| CLI 在桥模式下的角色 | **仅宿主服务**：CLI 只运行 HTTP 服务 + 状态日志，对话全在网页，不再注入任务消息 |
| 防检测设置 | **随机延迟 + 模拟输入**：回填后逐字/逐段模拟人类打字，提交前随机延迟（区间可配置，默认 3–8s） |
| 危险命令确认 | **自动拒绝并反馈**：危险命令直接拒绝，拒绝说明作为处理结果回填给 Gemini（不再走 CLI 终端确认） |

## 桥模式数据流（v2）

```
[网页] 用户在 AI Studio 与 Gemini 直接对话（对话全在网页）
   ↓ Gemini 生成新回复（生成完成、文本稳定）
[插件] 抓取最新回复 → POST /result {reply}
   ↓
[智能体] 解析 ```tool_call``` 块（parseToolCalls）
   ├─ 无 → 不动作（循环自然终止，不回填）
   └─ 有 → 反思层逐条裁决（存在性 → zod 结构 → 危险嗅探）
        ├─ DANGEROUS → 自动拒绝（不发确认）
        ├─ UNKNOWN_TOOL / INVALID_ARGS → 拒绝
        └─ 放行 → 共享执行器路由到双手/眼睛执行（批级超时 + 全局中断）
       → 全部结果序列化为回填消息 → 队列
   ↓
[插件] GET /task（长轮询）取回填消息 → 模拟人类逐字输入到输入框
   ├─ 自动模式：按防检测设置（随机延迟）自动点击提交
   └─ 手动模式：只回填，用户点击页面发送按钮提交
   ↓
[网页] Gemini 收到结果继续生成 → 回到顶部（循环）
```

循环特性：**内容自终止**——Gemini 回复含 tool_call 才触发执行与回填；无 tool_call 的回复被忽略，循环停在对话的自然状态。

## 职责模型

```
大脑（brain/，唯一会"想"和"知道"的部位）
  ├─ knowledge.ts       知识库：7 个工具的 description + zod schema + 派生 JSON Schema
  │                     + serializeToolProtocol()（工具协议文本）
  ├─ reflection.ts      反思层（潜意识）：确定性可行性裁决，所有大脑共享
  │                     · 存在性 → UNKNOWN_TOOL · zod 结构 → INVALID_ARGS
  │                     · terminal 危险嗅探 → DANGEROUS → 经嘴巴确认 → USER_DENIED
  │                     （桥模式注入"永远拒绝"的嘴巴 → 危险命令自动拒绝）
  ├─ ollama-thinking.ts 思考层 Ollama 实现（BrainInference：infer + reflect），CLI 对话模式用
  ├─ gemini-bridge-thinking.ts  桥服务（执行型，非 BrainInference）：
  │                     内嵌 HTTP 服务，接收网页内容 → 解析 tool_call → 裁决 → 执行 → 回填队列
  ├─ context.ts         会话消息队列（仅 Ollama 模式用）
  └─ llm.ts             统一推理接口与类型契约
心脏（heart/，枢纽与身体，无知识）
  ├─ loop.ts            生命循环（Ollama 模式）：听→想→反思→做→反馈；承受力（超时/迭代/中断）
  ├─ executor.ts        （新）共享工具执行器：工具名 → 双手/眼睛方法 的映射路由（loop 与桥服务共用）
  └─ interrupt.ts       全局 AbortController
器官（eyes/hands/nose/mouth/ears）：执行被派到的活，反馈一律返回
```

职责边界：**大脑负责"是否可行"，心脏负责"能否承受"**。桥模式不运行心脏循环：接收内容 → 裁决 → 执行是桥服务内的单批流水线（带批级超时与全局中断），无多轮模型对话。

## 模块设计

### brain/ 目录（命名规范：内部文件不出现 brain 字样；思考实现直接放 brain/ 根目录，不建子目录）

| 文件 | 内容 |
|---|---|
| `brain/knowledge.ts`（保持） | 7 个工具的 zod schema 唯一来源；`TOOLS`（parameters 由 `z.toJSONSchema()` 派生）；`serializeToolProtocol()` 序列化工具协议文本 |
| `brain/reflection.ts`（保持） | Reflection 类（构造注入 nose/mouth）；`reflect(calls)` 逐条裁决 |
| `brain/ollama-thinking.ts`（迁移） | OllamaThinking：Ollama /api/chat 实现（原 ollama-brain.ts 改名，从 thinking/ 移到 brain/ 根目录）；实现 BrainInference（infer + reflect） |
| `brain/gemini-bridge-thinking.ts`（重写） | GeminiBridgeThinking 执行型桥服务（见下） |
| `brain/llm.ts`（保持） | BrainInference 接口（infer/reflect）、ReflectionVerdict/BlockedCall 契约 |

### GeminiBridgeThinking（桥服务，v2 重写）

```
构造：{ port?, host?, nose, hands, eyes, signal?, timeoutMs?, logger? }
  · nose/hands/eyes：反射裁决与工具执行所需器官（构造注入，无全局状态）
  · signal：全局中断 AbortSignal（Ctrl+C 级联）；timeoutMs：单批执行超时（默认 300s，0 禁用）
  · logger：可选回调，宿主（cli）打印状态
  · 内部：Reflection(nose, 永远拒绝的嘴巴) —— 危险命令自动拒绝
HTTP 服务（node:http，默认 127.0.0.1:8765）：
  GET  /task    长轮询：有回填消息立即返回 {message}；无则挂起约 25s 后 204
  POST /result  接收 {reply}（网页最新内容）→ 返回 {ok: true, processed: boolean}
                其他路径/方法 → 404
处理流水线（单批，串行队列）：
  1. 校验 reply（非空字符串，长度 ≤ 200_000 字符），非法 → 400
  2. 去重：与最近一次处理的内容完全相同 → processed: false，不处理
  3. parseToolCalls(reply)：无 tool_call → processed: false，不排队
  4. 有 → 入处理队列（串行，一次一批）→ processed: true
     批执行：reflection.reflect(calls) → 放行的经 executeTool 执行（共享执行器），
     拦截的收集拒绝原因；批 signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
     超时 → 队列一条"工具执行超时"说明；全局中断 → 丢弃批次
     结果序列化为回填消息 → 推入 outbox → 唤醒等待中的 GET /task
启动即把工具协议文本（serializeToolProtocol()）作为首条回填消息入队——
让网页 Gemini 知道 ```tool_call``` 格式（对话从协议开始）
close()：释放全部长轮询 waiter（204 结束）、清空 outbox、关闭服务与连接
导出：parseToolCalls(text): BrainInferenceResult（纯函数，容错解析，保持 v1 语义）
```

### 共享执行器（heart/executor.ts，从 loop #dispatch 抽出）

```
executeTool(organs: { eyes, hands }, name, args, signal?): Promise<ActionResult<unknown>>
  switch（read_file/read_dir/search_code/write_file/apply_patch/terminal/fetch_page）
  terminal 透传 signal 与 timeoutMs；未知工具返回 UNKNOWN_TOOL 失败
```

loop.ts 的 #dispatch 删除，改用 executeTool（行为不变，loop 测试回归验证）。桥服务与 loop 共用同一执行路由。

### 回填消息格式（处理结果序列化）

```
工具执行结果（human-agent）：
1. 工具 read_file 参数 {"path":"a.txt"} → 成功：
```json
{"success":true,"data":"..."}
```
2. 工具 terminal 参数 {"command":"rm -rf /"} → 已拒绝（USER_DENIED：危险命令自动拒绝，未执行）
3. 工具 read_file 参数 {} → 已拒绝（INVALID_ARGS：参数不合法...）
```

- 每调用一行：`N. 工具 {name} 参数 {args} → 成功/失败/已拒绝（原因）`
- 成功/失败附 ActionResult 的 JSON 代码块（供 Gemini 对照继续）
- 拒绝按错误码格式化：USER_DENIED → 危险命令自动拒绝；UNKNOWN_TOOL / INVALID_ARGS → 原文原因

### 插件侧（extensions/gemini-bridge/，v2 重写）

| 文件 | 内容 |
|---|---|
| `manifest.json` | MV3；content_scripts 注入 aistudio.google.com；background service worker；host_permissions `http://127.0.0.1:8765/*`；permissions: storage |
| `background.js` | HTTP 中转：长轮询 `GET /task`（fetch 30s 超时）、`POST /result {reply}`；全部 try/catch 答 {error} |
| `content.js` | 浮动面板（**自动模式开关 + 防检测设置**（延迟区间 min/max、模拟输入开关）+ 状态/日志）；内容监控循环（最新模型回复变化 → 稳定采样 → POST）；投递循环（长轮询取回填消息 → **模拟人类逐字输入** → 自动模式随机延迟后提交）；新对话检测（对话容器重置 → 重新注入协议文本）；**删除**「交给智能体」「回填」按钮与发送事件监控 |
| `README.md` | 加载方式与使用说明、排查节 |

面板状态：待命 / 已抓取回复（等待执行）/ 回填中（模拟输入）/ 自动提交（Xs 后）/ 等待 Gemini 回复 / 错误。

### 组装与配置（v2）

- `agent.ts`：`HumanAgent` **恒为 Ollama 模式**（GEMINI_BRIDGE_PORT 不再影响 HumanAgent）；新增导出 `buildBridgeService(options?): GeminiBridgeThinking`——组装真实器官（RiskChecker/EnvChecker 鼻子、FileReader/WebCrawler 眼睛、FileWriter/Terminal 双手），`port` 默认取 `GEMINI_BRIDGE_PORT`（非法值回退 8765），`signal`/`timeoutMs`/`logger` 可注入
- `bin/cli.ts`：`GEMINI_BRIDGE_PORT` 已设置 → 桥模式分支：建服务 → `getPort()`（失败友好报错 exit 1）→ 打印监听地址与使用说明 → 等待 SIGINT/SIGTERM（中断级联）→ `close()` → exit 130；未设置 → 原 HumanAgent 路径（不变）

## 协议细节（v2）

```
GET  /task      长轮询：{message} 或约 25s 后 204
POST /result    {reply: string} → {ok: true, processed: boolean}；非法 → 400 {error}
```

无 id 握手：内容驱动、单向流水线（插件推内容、拉回填），处理结果与请求不配对。插件侧去重 + 服务侧去重双保险。

### 工具协议文本（知识库序列化，作为首条回填消息注入）

```
【human-agent 工具协议】你是 human-agent 智能体的大脑，通过调用工具与本地环境交互。
可用工具（名称：用途 | 参数）：
1. read_file: 读取指定文件的内容 | {"path": 路径}
...（7 个，来自 TOOLS 序列化）
调用规则：
- 需要读取/修改/执行才能完成用户任务时，必须调用工具，不得假装完成
- 一次只调用一个工具，等待工具结果后再决定下一步
- 需要调用工具时，输出且只输出一个 JSON 代码块，不要附带其他文字：
```tool_call
{"name": "工具名", "arguments": {参数对象}}
```
- 工具结果将以「工具执行结果」的形式出现在下一条消息
- 任务完成或无需工具时，直接输出最终回答文本
```

注入时机：桥服务启动即入队（插件回填并提交，自动模式自动发、手动模式由用户发）；插件保存协议文本，检测到新对话（对话容器重置）时重新注入。

## 风控与人工干预（v2）

- **自动模式**（开关开启）：回填消息经**模拟人类逐字输入**填入输入框后，按防检测设置（随机延迟区间，默认 3–8s）自动点击页面发送按钮；延迟回调时开关已关闭则不点击（竞态守卫）
- **手动模式**（开关关闭）：仍自动回填（模拟输入），但不自动提交，由用户点击页面发送按钮；发送后插件照常监控下一轮回复
- **危险命令自动拒绝**：桥服务注入"永远拒绝"的嘴巴，反思层危险裁决直接 USER_DENIED，拒绝说明随结果消息回填——无人值守，安全优先
- 插件面板防检测设置：延迟区间（秒，min/max）+ 模拟输入开关；存入 chrome.storage.sync

## 测试策略（TDD）

- 重写 `tests/gemini-bridge-thinking.test.ts`：
  - parseToolCalls 4 例保持（纯文本 / 单块 / 坏 JSON / 多块）
  - 协议文本作为首条任务交付（GET /task 首条含协议）
  - POST 含 tool_call → processed: true → GET /task 取到「工具执行结果」消息（记录型 stub 器官断言执行）
  - POST 无 tool_call → processed: false（不回填）
  - 多个 tool_call 汇总为一条消息、全部执行
  - 危险命令自动拒绝：不回填执行结果、stub 器官未被调用、消息含拒绝说明（confirm 不被调用）
  - 未知工具 / 参数非法拒绝（INVALID_ARGS）
  - 相同内容重复 POST 只处理一次（第二次 processed: false）
  - 批超时（timeoutMs 短）：队列「执行超时」说明
  - 全局中断：批执行中止
  - close() 释放挂起的长轮询（204）
- 改 `tests/agent.test.ts`：新增 buildBridgeService 用例（port: 0 → 实例 + getPort 成功 + close）；删除旧「GEMINI_BRIDGE_PORT 在 HumanAgent 内切换大脑」用例（v2 已无此语义）
- `tests/loop.test.ts` 回归：executor 抽取后行为不变
- 插件 DOM 无法单测 → 手动 E2E（Task 15）

## 交付清单（v2 增量）

新增：
- `src/heart/executor.ts`
- `extensions/gemini-bridge/`（重写：manifest.json、background.js、content.js、README.md）

修改：
- `src/brain/gemini-bridge-thinking.ts`（重写为执行型桥服务）、`src/heart/loop.ts`（#dispatch → executeTool）
- `src/agent.ts`（HumanAgent 恒 Ollama；新增 buildBridgeService）、`bin/cli.ts`（桥模式分支）
- `tests/gemini-bridge-thinking.test.ts`（重写）、`tests/agent.test.ts`
- `CLAUDE.md`、`README.md`

迁移：
- `src/brain/thinking/ollama-thinking.ts` → `src/brain/ollama-thinking.ts`
- `src/brain/thinking/gemini-bridge-thinking.ts` → `src/brain/gemini-bridge-thinking.ts`
- （`src/brain/thinking/` 目录删除；所有 import 与文档路径同步）

保持：knowledge.ts、reflection.ts、ollama-thinking.ts 逻辑、llm.ts、context.ts、loop.ts（除 #dispatch 抽取）、interrupt.ts、Ollama 模式组装。

## 风险与已知限制

- 网页版无原生 function calling：工具调用为 ```tool_call``` 结构化输出模拟，存在降智风险；通过协议注入 + 一次一个工具约束缓解
- **AI Studio DOM 结构未知**：内容抓取（输入框/发送按钮/模型回复元素/对话容器）的选择器必须以真实 DOM 为准，由用户提供页面结构后落定（Task 13 阻塞项）
- 模拟输入对 React 受控输入框（rich-textarea）的兼容性需实测：逐字设置 + 合成 InputEvent，若页面不响应需调整注入方式
- 循环由内容自终止：长时间无 tool_call 时桥保持静默（长轮询 25s 心跳），无自动重启
- 需要浏览器保持 AI Studio 页面打开且已登录
