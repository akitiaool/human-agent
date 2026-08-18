# human-agent

拟人化模块化 AI 智能体（Humanoid Agent）CLI 工具。以人体器官抽象系统模块——大脑思考、心脏驱动生命循环、眼睛观察、耳朵听取、嘴巴表达、双手执行、鼻子嗅探预警，通过本地大模型完成自主多步任务。

## 功能

- **器官化架构**：大脑（LLM 推理）→ 心脏（生命周期循环）→ 鼻子（风险嗅探）→ 手眼（执行）→ 反馈，循环往复
- **工具调用**：读文件、列目录、代码检索、写文件、行级 Patch、执行命令、抓取网页转 Markdown
- **风险拦截**：危险命令（`rm -rf`、`DROP TABLE`、`git push --force` 等）执行前向用户确认
- **中断优先**：`Ctrl+C` 毫秒级中断，级联停止子进程，会话状态不丢失
- **本地大脑**：默认接入本地 Ollama（qwen3），无需 API 费用，数据不出本机

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

## 架构

```text
src/
├── brain/    # 🧠 大脑：Ollama 推理接口、会话上下文与 Token 预算
├── heart/    # 🫀 心脏：AgentLoop 生命循环、AbortController 中断
├── eyes/     # 👁️ 眼睛：只读——文件读/目录/代码检索、网页抓取
├── ears/     # 👂 耳朵：终端输入（单 readline 接口 + 行队列）
├── mouth/    # 🗣️ 嘴巴：打字机输出、彩色日志、危险操作确认
├── hands/    # ✋ 双手：写文件/行级 Patch、Shell 执行（绑定中断）
├── nose/     # 👃 鼻子：危险特征嗅探、环境快照、端口占用探测
├── agent.ts  # HumanAgent 组装入口（构造注入全部器官）
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
