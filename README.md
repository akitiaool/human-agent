# human-agent

拟人化模块化 AI 智能体（Humanoid Agent）CLI 工具。以人体器官抽象系统模块——大脑思考、心脏驱动生命循环、眼睛观察、耳朵听取、嘴巴表达、双手执行、鼻子嗅探预警，通过本地大模型完成自主多步任务。

## 功能

- **器官化架构**：大脑（知识库 + 思考 + 反思）→ 心脏（路由 + 承受力）→ 鼻子（风险嗅探）→ 手眼（执行）→ 反馈，循环往复
- **工具调用**：读文件、列目录、代码检索、写文件、行级 Patch、执行命令、抓取网页转 Markdown
- **风险拦截**：危险命令（`rm -rf`、`DROP TABLE`、`git push --force` 等）执行前向用户确认
- **中断优先**：`Ctrl+C` 毫秒级中断，级联停止子进程，会话状态不丢失
- **双模式**：默认本地 Ollama（qwen3）对话 REPL；`GEMINI_BRIDGE_PORT=8765` 启用桥模式——对话全在网页（AI Studio），智能体不做推理、仅执行工具（经 gemini-bridge 浏览器扩展桥接）

## 快速开始

依赖：Node.js ≥ 20、pnpm ≥ 11、Ollama（含 qwen3 模型）。

```bash
pnpm install
pnpm dev        # 开发运行（tsx）
```

进入交互会话后直接输入指令即可，`/exit` 退出：

```
> 帮我读取 package.json，总结里面的脚本
```

## 常用命令

```bash
pnpm dev        # tsx 直接运行 bin/cli.ts
pnpm build      # tsc 编译到 dist/
pnpm start      # node dist/bin/cli.js
pnpm test       # vitest 全量测试（TDD 流程：先写测试并看其失败再实现）
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 服务地址 |
| `OLLAMA_MODEL` | `qwen3:4b` | 模型名，如 `qwen3:8b` |
| `GEMINI_BRIDGE_PORT` | 未设置（Ollama REPL 模式） | 设置即把 CLI 切换为**桥模式**（进程模式开关：对话在网页、智能体仅执行工具），端口默认 8765，非法值回退 8765 |

## Gemini 桥（桥模式：网页对话驱动 · 智能体仅执行工具）

Gemini 官方 API 国内不可直连，但网页版 AI Studio 可用。**桥模式下对话全在网页**：用户在
AI Studio 直接与 Gemini 对话，插件把最新回复推送给智能体；智能体**不做模型推理、只执行工具**——
解析回复中的 ```tool_call``` 块 → 反思层逐条裁决（危险命令经扩展弹窗人工授权（面板可开自动授权静默放行），拒绝/超时说明回填）→ 共享执行器
（hands/eyes）执行 → 结果序列化为「工具执行结果」消息回填到网页输入框，由 Gemini 继续
（网页版无原生 function calling，工具调用为 ```tool_call``` 结构化输出模拟）。无 tool_call 的
回复不回填，循环自然终止。

```bash
GEMINI_BRIDGE_PORT=8765 pnpm dev   # 启用桥模式（默认 8765）：CLI 仅宿主 HTTP 服务，对话在网页
```

前置：按 `extensions/gemini-bridge/README.md` 加载扩展，保持 AI Studio 页面打开并登录。
扩展面板为**自动模式开关 + 防检测设置**（回填内容模拟人类逐字输入、提交前随机延迟默认 3–8s）；
自动模式自动提交，手动模式只回填、由用户点击页面发送按钮。扩展 v2 重写待真实 AI Studio DOM
落定（阻塞项），当前 `extensions/gemini-bridge/` 仍为 v1 实现。

## 架构

```text
src/
├── brain/    # 🧠 大脑：knowledge 知识库、思考层（ollama-thinking 对话 / gemini-bridge-thinking 执行型桥服务）、reflection 反思层、会话上下文
├── heart/    # 🫀 心脏：AgentLoop 生命循环（承受力）、executor 共享工具执行路由、AbortController 中断
├── eyes/     # 👁️ 眼睛：只读——文件读/目录/代码检索、网页抓取
├── ears/     # 👂 耳朵：终端输入（单 readline 接口 + 行队列）
├── mouth/    # 🗣️ 嘴巴：打字机输出、彩色日志、危险操作确认
├── hands/    # ✋ 双手：写文件/行级 Patch、Shell 执行（绑定中断）
├── nose/     # 👃 鼻子：危险特征嗅探、环境快照、端口占用探测
├── agent.ts  # 组装入口：HumanAgent（Ollama REPL）与 buildBridgeService（执行型桥服务）
└── types/    # ActionResult 契约与器官接口
```

核心设计原则：

1. **动静绝对分离**：眼睛只读无副作用；双手破坏性操作必须受控，行动前由鼻子嗅探，检出危险则由嘴巴向用户确认。
2. **异常即反馈，永不崩溃**：双手/眼睛失败从不抛未捕获异常，一律包装为 `ActionResult` 返回给大脑自我修复。
3. **中断第一公民**：中断信号级联下发 `AbortSignal`，器官快速退出并保护会话历史。
4. **轻量起步**：仅基础设施依赖，重度能力（TTS/ASR/浏览器等）按阶段引入。

详细设计见 `docs/human-agent 架构设计与开发规范文档.txt`。

## 测试

```bash
pnpm test                       # 全量
pnpm exec vitest run tests/xxx.test.ts   # 单个文件
```
