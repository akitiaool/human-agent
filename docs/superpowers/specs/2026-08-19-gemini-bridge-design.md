# Gemini 桥设计文档（GeminiBridge 大脑接入）

日期：2026-08-19
状态：已与用户逐节确认

## 背景与目标

qwen3:4b（当前 Ollama 大脑）工具调用能力不足（参数漏传频发）。Gemini 官方 API 国内不可直连，但网页版 AI Studio 可用。目标：让 human-agent 以**网页版 Gemini 作为大脑**，同时引入**大脑职责模型重构**（知识库 / 思考 / 反思分层）。

**方案形态**：浏览器插件（Chrome/Edge MV3）运行于 AI Studio 页面，作为 human-agent 与网页 Gemini 之间的桥——brain 发布任务消息，插件在页面输入框发送、抓取 Gemini 回复回传。不依赖 Playwright / Python。

**协作模式**：自动为主（brain 推理时自动经页面发消息、抓回复），插件提供手动干预能力（自动发送开关、交给智能体、回填按钮），以应对人工干预需求与风控。

## 职责模型（本次重构的核心）

```
大脑（brain/，唯一会"想"和"知道"的部位）
  ├─ knowledge.ts   知识库：大脑的认知层。"工具如何使用"的知识
  │                 （7 个工具的 description + zod schema + 派生 JSON Schema）
  │                 未来 RAG 系统作为新的知识来源在此聚合（当前不预建抽象）
  ├─ thinking/      思考层：模型推理实现（OllamaThinking / GeminiBridgeThinking）
  │                 读取知识 → 决策（要干什么、怎么干）→ 输出 toolCalls / 文本
  └─ reflection.ts  反思层（潜意识）：决策后再想"可行吗"。确定性代码，不经过模型，
                    "刻在基因中的意识"，所有大脑共享同一套实现
                    · 存在性校验（工具名）→ UNKNOWN_TOOL
                    · 结构校验（zod，规则来自知识库）→ INVALID_ARGS
                    · terminal 危险嗅探（调鼻子）→ DANGEROUS → 嘴巴向用户确认 → USER_DENIED
心脏（heart/loop.ts，枢纽与身体，无知识）
  ├─ 路由：大脑放行的决策按名分发到器官
  ├─ 维持循环：听→想→反思→做→反馈 的节拍
  └─ 承受力：判断"这个动作身体能否承受得住"
       · 任务级超时（/timeout 动态配置）
       · 单命令超时（timeoutMs 兜底）
       · maxIterations 防循环失控
       · 中断（Ctrl+C 级联 AbortSignal）
器官（eyes/hands/nose/mouth/ears）：执行被派到的活，反馈一律回到大脑
```

职责边界一句话：**大脑负责"是否可行"，心脏负责"能否承受"**；心脏不产生任何判断规则（规则要么来自知识库，要么来自器官感知）。

## 数据流

```
CLI 输入 → 心脏（循环节拍）→ 思考层 infer（读知识库）
  → 有 toolCalls → 反思层 reflect（可行性裁决）
       → 放行 → 心脏路由 → 器官执行 → 结果写回 context（tool 消息）→ 回到思考层
       → 拦截 → 错误结果（INVALID_ARGS / USER_DENIED / UNKNOWN_TOOL）写回 context → 回到思考层
  → 纯文本 → 心脏输出（speak）→ 回 LISTENING
```

Gemini 场景下思考层的 infer 流程：

```
infer(context, tools, signal)
  = 组装协议消息（知识库序列化的工具协议文本 + 本轮增量消息）
  → 发布任务（GET /task 长轮询可得）
  → 插件在 AI Studio 页面发送 → Gemini 回复 → 插件 POST /result 回传
  → parseToolCalls 解析 ```tool_call``` JSON → { text, toolCalls? }
```

## 模块设计

### brain/ 目录（命名规范：目录名即"大脑"，内部文件不出现 brain 字样）

| 文件 | 内容 |
|---|---|
| `brain/knowledge.ts`（新） | 大脑知识库。7 个工具的 zod schema 迁入（现定义于 loop.ts）；JSON Schema parameters 由 zod 派生（`z.toJSONSchema()`，消除现 TOOL_SCHEMAS 与 TOOLS.parameters 双写）；导出 `TOOLS: ToolInfo[]` 与 `schemas`。模块注释定位知识库（RAG 为未来扩展知识来源） |
| `brain/llm.ts`（改） | `BrainInference` 接口增加 `reflect()`；类型契约（ToolCall/ToolInfo/BrainInferenceResult）不变 |
| `brain/thinking/`（新目录） | 思考层实现 |
| `brain/thinking/ollama-thinking.ts`（原 ollama-brain.ts 改名） | OllamaThinking：Ollama /api/chat 实现，逻辑不变；实现 reflect（委托共享 Reflection） |
| `brain/thinking/gemini-bridge-thinking.ts`（新） | GeminiBridgeThinking：内嵌 HTTP 服务（node:http，默认 127.0.0.1:8765）；infer 组装协议消息 → 任务队列 → 等插件回传（signal abort 可取消）；`parseToolCalls` 纯函数（容错解析：坏 JSON 块丢弃、原文拼回 text）；`close()` 关服务 |
| `brain/reflection.ts`（新） | Reflection 类：构造注入 NoseContract + MouthContract（大脑统筹器官）；`reflect(calls)` 逐条裁决 → 放行 / 拦截+错误反馈；确定性代码 |

### 心脏侧（heart/loop.ts，净化）

- 删：TOOL_SCHEMAS / TOOLS 定义（迁 knowledge.ts）、zod 校验、危险嗅探、嘴巴确认（迁反思层）
- 留：路由（#dispatch）、承受力（任务超时 / 单命令超时 / maxIterations / 中断）、循环节拍、反馈写回
- `#execute` 变为：调 `brain.reflect(calls)` 得裁决 → 放行 dispatch / 拦截结果直接反馈
- loop 不再直接依赖 nose / mouth（组装处同步调整；NoseContract 中 checkPorts/getEnvSnapshot 仍由 agent 组装供外部使用）

### 插件侧（extensions/gemini-bridge/，全新）

| 文件 | 内容 |
|---|---|
| `manifest.json` | MV3；content_scripts 注入 aistudio.google.com；background service worker；host_permissions `http://127.0.0.1:8765/*`；permissions: storage（开关状态） |
| `background.js` | HTTP 桥：长轮询 `GET /task`、`POST /result`；content 与本地服务的中转（host_permissions 规避 CORS/CSP） |
| `content.js` | 浮动面板 UI（自动发送开关、「交给智能体」、「回填」按钮）；AI Studio DOM 操作：输入框填写+发送（rich-textarea）、等待回复完成（停止按钮消失 + 文本稳定）、提取最后回复 |
| `README.md` | 加载方式（chrome://extensions 开发者模式加载已解压扩展）与使用说明 |

### 组装与配置

- `agent.ts`：`GEMINI_BRIDGE_PORT` 环境变量设置即启用 GeminiBridgeThinking（默认 OllamaThinking）；组装"带反思的大脑"（OllamaThinking / GeminiBridgeThinking 构造注入 nose/mouth 构建共享 Reflection）
- `bin/cli.ts`：结束后调用大脑 close（若为 GeminiBridgeThinking，与 ears.close() 同模式，仅此处一处）

## 协议细节

### HTTP 任务协议（brain ↔ 插件）

```
GET  /task      长轮询：有待发消息立即返回 {id, message}；无任务挂起约 25s 后 204
POST /result    回传 {id, reply} → resolve 对应 infer
```

message 为纯文本（协议文本 + 本轮增量消息），插件不感知工具结构。

### 工具协议文本（思考层每轮注入，由 knowledge.ts 序列化）

```
【human-agent 工具协议】你是 human-agent 智能体的大脑，通过调用工具与本地环境交互。
可用工具（名称：用途 | 参数）：
1. read_file: 读取文件内容 | {"path": 路径}
...（7 个，来自 TOOLS 序列化）
调用规则：
- 需要读取/修改/执行才能完成用户任务时，必须调用工具，不得假装完成
- 一次只调用一个工具，等待工具结果后再决定下一步
- 需要调用工具时，输出且只输出一个 JSON 代码块，不要附带其他文字：
```tool_call
{"name": "工具名", "arguments": {参数对象}}
```
- 工具结果将以「工具返回：{结果 JSON}」的形式出现在下一条消息
- 任务完成或无需工具时，直接输出最终回答文本
```

每轮完整注入（不做首轮后精简）：7 工具全量协议约 700 字，Gemini 上下文无压力，格式遵循可靠性优先（qwen 教训）。

### 增量消息

页面会话天然保留历史，每轮只发增量（新指令 / 工具结果）。消息形态映射：
- user 消息 → 原文
- assistant 消息（含 toolCalls）→ 文本内容（toolCalls 信息由后续 tool 消息表达）
- tool 消息 → 「工具 {name} 返回：{result JSON}」

## 风控与人工干预

- 插件「自动发送」开关：关闭后待发消息改为按钮手动发送
- 「交给智能体」：输入框当前草稿作为指令发给 brain（等同 CLI 输入）
- 「回填」：brain 最近输出粘贴到输入框（可编辑再发）
- 默认连续自动发送间隔 ≥ 2s
- loop 的 maxIterations 兜底防高频循环

## 测试策略（TDD）

- 新：`tests/knowledge.test.ts`（zod 派生 JSON Schema 正确、7 工具齐全、schema 与 TOOLS 一致）、`tests/reflection.test.ts`（放行 / 未知工具 / 参数不合法 / 危险命令确认拒绝 / 危险命令确认放行）、`tests/gemini-bridge-thinking.test.ts`（真 HTTP 服务：node fetch 扮演插件长轮询取任务 + POST 回传 → infer resolve；abort 取消；parseToolCalls 容错）
- 改：`tests/loop.test.ts`（USER_DENIED 等用例改走 reflect 路径；loop 构造参数去掉 mouth/nose）、`tests/helpers.ts`（ScriptedBrain 增加可配置 reflect；makeLoop 同步）、`tests/agent.test.ts`（新组装 + GEMINI_BRIDGE_PORT 切换）
- 插件 DOM 无法单测 → 手动 E2E
- 真实联调：加载插件 → 登录 AI Studio → `pnpm dev` → 指令 → 页面自动对话 → 工具执行 → 回传 → CLI 输出

## 交付清单

新增：
- `src/brain/knowledge.ts`、`src/brain/reflection.ts`、`src/brain/thinking/ollama-thinking.ts`、`src/brain/thinking/gemini-bridge-thinking.ts`
- `extensions/gemini-bridge/manifest.json`、`background.js`、`content.js`、`README.md`
- `tests/knowledge.test.ts`、`tests/reflection.test.ts`、`tests/gemini-bridge-thinking.test.ts`

修改：
- `src/brain/llm.ts`（接口 + reflect + 类型导出调整）、`src/heart/loop.ts`（净化）、`src/agent.ts`（组装）、`bin/cli.ts`（close）
- `tests/loop.test.ts`、`tests/helpers.ts`、`tests/agent.test.ts`
- `CLAUDE.md`、`README.md`

重命名：
- `src/brain/ollama-brain.ts` → `src/brain/thinking/ollama-thinking.ts`（类名 OllamaThinking）

删除（迁出）：loop.ts 中的 TOOL_SCHEMAS / TOOLS 定义。

## 风险与已知限制

- 网页版无原生 function calling：工具调用为结构化输出模拟，存在降智风险（AIstudioProxyAPI 同类问题）；通过每轮完整协议 + 一次一个工具约束缓解
- AI Studio DOM 结构变化可能导致插件失效（内容脚本选择器需随页面更新）
- 页面会话与 agent 会话的同步假设：所有 agent 消息经插件发送，用户手动插话会引入页面侧额外上下文（可接受，甚至是有意的人工干预）
- 自动发送有风控风险：开关 + 发送间隔 + 迭代上限缓解
- 需要浏览器保持 AI Studio 页面打开且已登录
