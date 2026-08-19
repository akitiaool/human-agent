# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态

仓库权威设计来源为 `docs/human-agent 架构设计与开发规范文档.txt`（v1.0.0）。

已完成的骨架：Git 仓库（main 分支）、`package.json`、`tsconfig.json`（strict + NodeNext ESM，产物到 `dist/`）、`bin/cli.ts`（commander 最小入口）、依赖安装（`pnpm` 管理）。

阶段一类型契约已完成：`src/types/organ.ts`（`ActionResult` + `ok`/`fail`、`RiskLevel`、`EnvSnapshot`、`AgentStatus`/`AgentPhase`、各器官 `*Contract` 接口）、`src/types/index.ts` 与 `src/index.ts` 出口。

阶段二（双手/眼睛/鼻子）已完成（TDD，测试在 `tests/`，vitest 4）：
- `src/nose/risk-checker.ts`：危险特征规则库（rm -rf、DROP TABLE、git push --force 等）→ SAFE/DANGEROUS
- `src/nose/env-checker.ts`：环境快照（OS、CWD、git 分支），`getEnvSnapshot({ cwd })` 可指定目录；`checkPorts(ports)` 探测端口占用（net.connect：可连=占用、ECONNREFUSED=空闲、其余保守视为占用）
- `src/eyes/file-reader.ts`：readFile/readDir/searchCode（searchCode 支持目录参数、跳过 node_modules/.git/dist、相对搜索根返回路径）
- `src/eyes/web-crawler.ts`：WebCrawler（turndown 转 Clean Markdown，atx 标题 + fenced 代码块；可注入 fetchImpl；非 200/网络异常包装为 FETCH_ERROR 不抛错）
- `src/hands/terminal.ts`：execa 10 执行命令，`{ shell: true, encoding: "utf8" }`，错误返回 `EXEC_ERROR` + shortMessage；**单命令超时**：`executeCommand(command, signal?, timeoutMs?)` 第三参透传 execa 原生 `timeout`（conditional spread，`exactOptionalPropertyTypes`），`err.timedOut` → `EXEC_TIMEOUT`（区分于中断的 EXEC_ERROR）；注意 Windows + shell:true 下被杀的是 shell 进程，命令自身子进程可能残留
- `src/hands/file-writer.ts`：writeFile（自动建父目录）+ applyPatch（行级 `- 删除`/`+ 插入` patch 格式，文档见文件头注释）

阶段三（嘴巴/耳朵）已完成（TDD）：
- `src/mouth/text-output.ts`：speak 打字机流式输出（首字符立即、可选 intervalMs）、info/success/warn/error 彩色日志、printDiff 的 +/- 行着色；构造可注入 stdout/chalk 实例（测试用 `new Chalk({ level: 3 })`）
- `src/mouth/ask-user.ts`：confirm(message) 阻塞式 [Y/n] 确认，默认 Y，无效输入循环追问；构造可注入 input/output 流
- `src/ears/text-input.ts`：prompt(question) 读入并 trim；**单实例只创建一个 readline 接口**，空闲期间到达的行进队列不丢失（多行管道输入 `printf "a\n/exit\n" | pnpm dev` 依赖此行为），输入流结束后队列仍可读取、清空后才报错结束会话；提供 `close()` 释放监听

阶段四（大脑/心脏 + 全链路）已完成（TDD，104 tests）：
- `src/brain/llm.ts`：`BrainInference` 统一推理接口（ToolCall/ToolInfo/BrainInferenceResult）
- `src/brain/context.ts`：会话消息队列（system 永不移除，超预算裁剪最旧非 system 消息）
- `src/brain/ollama-brain.ts`：OllamaBrain，走本机 `/api/chat` 协议（`{ baseUrl?: string, model?: string, fetchImpl?: typeof fetch }`），支持工具调用；默认 `http://localhost:11434` + `qwen3:4b`；非 200 抛错（loop 捕获转 ERROR）；assistant 的 toolCalls 序列化为 `tool_calls`（snake_case），工具列表为空时不发 `tools`；`infer(context, tools, signal?)` 第三参为 AbortSignal（fetch 绑定，中断可取消请求）
- `src/heart/interrupt.ts`：AbortController 封装（getSignal/abort/isAborted/reset）
- `src/heart/loop.ts`：生命循环（LISTENING→THINKING→SNIFFING→ACTING→FEEDBACK）；7 个工具的 zod 参数校验（INVALID_ARGS）且 `TOOLS` 携带 JSON Schema `parameters`（ToolInfo 契约）；terminal 危险命令经 mouth.confirm（USER_DENIED）；assistant 消息（含 toolCalls）与 tool 结果都写回上下文（Ollama 续接的前提）；`#processTurn` 返回 boolean（true 表示中断/出错，规避 TS 对私有字段的收窄问题）；`onPhase` 回调；maxIterations 兜底；**任务超时**：`timeoutMs`（默认 5 分钟，0 禁用）每轮 per-turn AbortController + `AbortSignal.any` 组合 signal（推理请求可取消、子进程可被杀），超时终止本轮并继续监听；斜杠命令 `/timeout`（`parseTimeout` 导出：纯数字毫秒 / s/m/h 单位 / 0|off 禁用）会话中动态更新；`terminal` 工具参数含可选 `timeoutMs`（正整数字节，zod 校验），经 `#dispatch` 透传给 `executeCommand` 第三参——大脑可对单条命令声明独立超时；`HandsContract.executeCommand` 签名同步加 `timeoutMs?`
- `src/agent.ts`：HumanAgent 组装器，默认组装 OllamaBrain + 全部器官（鼻子组合 RiskChecker+EnvChecker，显式组合而非对象展开——spread 不复制原型方法）；环境变量 `OLLAMA_BASE_URL`/`OLLAMA_MODEL` 覆盖默认大脑配置
- `bin/cli.ts`：SIGINT/SIGTERM → `agent.interrupt.abort()`；结束后 `ears.close()` 防挂起；退出码 ERROR=1 / INTERRUPTED=130 / IDLE=0

阶段五（Gemini 桥 + 大脑职责模型重构）已完成（TDD）：
- `src/brain/knowledge.ts`：大脑知识库——7 个工具的 zod schema 与 description 唯一来源；`TOOLS`（parameters 由 `z.toJSONSchema()` 派生，消除 TOOL_SCHEMAS 与 TOOLS.parameters 双写）、`schemas`、`serializeToolProtocol()`（思考层每轮完整注入的工具协议文本）
- `src/brain/reflection.ts`：反思层（潜意识）——确定性代码不经模型，逐条裁决：存在性（UNKNOWN_TOOL）→ zod 结构（INVALID_ARGS）→ terminal 危险嗅探（调鼻子，DANGEROUS 经嘴巴 confirm，拒绝为 USER_DENIED）
- `src/brain/thinking/`：思考层实现——`ollama-thinking.ts`（OllamaThinking，原 ollama-brain.ts 改名，逻辑不变）、`gemini-bridge-thinking.ts`（GeminiBridgeThinking：内嵌 HTTP 服务默认 127.0.0.1:8765，`GET /task` 长轮询（约 25s 后 204）+ `POST /result` 回传，任务按 id 匹配，`parseToolCalls` 容错解析 ```tool_call``` 代码块，`close()` 关服务）
- `src/brain/llm.ts`：`BrainInference` 增加 `reflect(calls)`（可行性裁决）；`ReflectionVerdict`/`BlockedCall` 契约
- `src/heart/loop.ts`：净化——TOOL_SCHEMAS/TOOLS/zod 校验/危险嗅探/嘴巴确认迁出；`#execute` = `brain.reflect(calls)` 裁决 → 放行 dispatch / 拦截结果直接反馈；loop 不再依赖 nose/mouth；`AgentPhase` 去掉 SNIFFING（嗅探属大脑反思，不再有心脏阶段）
- `src/agent.ts`：组装"带反思的大脑"（thinking 构造注入 nose/mouth 构建共享 Reflection）；`GEMINI_BRIDGE_PORT` 环境变量设置即启用 GeminiBridgeThinking（默认 OllamaThinking，非法值回退 8765）
- `bin/cli.ts`：结束后 `agent.brain.close()`（若为 GeminiBridgeThinking，与 ears.close() 同模式）
- `extensions/gemini-bridge/`：Chrome/Edge MV3 扩展——background 长轮询桥 + content 浮动面板（自动发送开关、「交给智能体」、「回填」按钮），AI Studio 页面收发，手动 E2E 验证

**尚未开始**：voice/image/browser 等预留器官（`eyes/image-viewer.ts`、`ears/voice-input.ts`、`mouth/voice-output.ts`、`hands/browser-action.ts`）。

`human-agent` 是一个拟人化智能体（Humanoid Agent）CLI 工具，技术栈为 TypeScript / Node.js (>= 20.0.0, ESM)。

## 架构核心：器官模型

顶层模块以人类生物学器官抽象，每层只依赖相邻的神经信号，职责专一：

- 🧠 `src/brain/`（大脑）：知识与思考。`knowledge.ts` 知识库（工具如何使用的知识，未来 RAG 在此聚合）、`thinking/` 思考层（模型推理实现：OllamaThinking / GeminiBridgeThinking）、`reflection.ts` 反思层（可行性裁决，确定性代码）、`context.ts` 会话消息队列；`llm.ts` 统一推理接口
- 🫀 `src/heart/`（心脏）：生命循环。`loop.ts` 推进 `听取指令 → 大脑思考 → 反思裁决 → 手眼执行 → 反馈结果 → 循环/结束`，并承担承受力（任务/单命令超时、maxIterations、中断）；`interrupt.ts` 持有全局 `AbortController`
- 👁️ `src/eyes/`（眼睛）：**只读**。文件读/目录遍历/代码检索、网页抓取转 Clean Markdown。
- 👂 `src/ears/`（耳朵）：输入。终端 REPL、语音（预留）。
- 🗣️ `src/mouth/`（嘴巴）：输出。流式 Markdown/彩色终端输出、`confirm(message): Promise<boolean>` 交互确认。
- ✋ `src/hands/`（双手）：**写/执行**。文件写入与 Patch、基于 `execa` 的 Shell 执行（绑定中断信号、超时强杀）。
- 👃 `src/nose/`（鼻子）：嗅探预警。危险特征规则库（`rm -rf`、`DROP TABLE`、`git push --force` 等）输出 `SAFE`/`DANGEROUS` 等级；环境快照（OS、CWD、Git 分支、端口占用）。

组装入口：`src/agent.ts` 的 `HumanAgent` 类，通过构造函数依赖注入全部器官（`brain, heart, eyes, hands, mouth, nose, ears`）。

## 不可违反的设计原则

1. **动静绝对分离**：眼睛只读、无副作用、无需安全审批；双手是破坏性操作必须受控；双手行动前由鼻子嗅探，检出危险则嘴巴向用户发起确认。
2. **异常即反馈，永不崩溃**：双手/眼睛执行失败（退出码非 0、文件不存在、超时等）**严禁抛出未捕获异常**，必须包装成 `ActionResult` 返回给大脑在下一循环中自我修复。
3. **中断第一公民**：`Ctrl+C` 由心脏毫秒级捕获，级联向所有器官下发 `AbortSignal`，停止子进程、取消网络流、保护现场；器官检测到 `signal.aborted` 后迅速退出并将生命体状态置为 `INTERRUPTED`，会话历史不丢失。
4. **轻量起步**：只装基础设施依赖（chalk、commander、execa、zod），大模型 SDK、TTS/ASR 等重度依赖在具体阶段按需引入。

## 关键契约

所有工具（双手/眼睛）操作统一返回 `ActionResult`，错误结构固定：

```typescript
export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
}
```

## 编码规范

- `tsconfig.json` 必须 `"strict": true`；**严禁 `any`**，未知结构用 `unknown` + `zod` 校验。
- 全面 ESM；相对路径导入需带扩展名。
- 器官类必须可实例化，**严禁单例/全局状态**，靠 `HumanAgent` 构造注入以便 mock 测试。
- 命名：目录小写名词、文件 kebab-case、类 PascalCase、变量/函数 camelCase。

## 命令与依赖

包管理用 **pnpm**（pnpm 11，配置在 `pnpm-workspace.yaml`，注意 pnpm 11 不再读取 package.json 的 `pnpm` 字段）：

```bash
pnpm dev      # tsx 直接运行 bin/cli.ts
pnpm build    # tsc 编译到 dist/（含 bin/ 与 src/）
pnpm start    # node dist/bin/cli.js
pnpm test     # vitest 全量运行（tests/ 目录，TDD 流程：先写测试并看其失败再实现）
```

已安装版本（均比设计文档 v1.0.0 中规划的版本新一个以上大版本，实现时注意 API 差异）：
- runtime：`chalk` 6（ESM-only）、`commander` 15、`execa` 10、`zod` 4（错误 API 与 v3 不同）、`turndown` 7（CJS，ESM 默认导入可用）
- dev：`typescript` 7（原生编译器，`tsc --init` 生成的现代默认配置）、`tsx` 4、`@types/node` 26

CLI 入口为 `bin/cli.ts`（处理 argv）。

## 开发路线（5 阶段递进）

1. 骨架与类型（`package.json`/`tsconfig.json`、`src/types/` 与 `ActionResult` 契约）✅
2. 双手与眼睛（file-reader、terminal、file-writer、risk-checker）✅
3. 嘴巴与耳朵（text-output、ask-user、text-input）✅
4. 大脑与心脏（loop 状态机、interrupt、接入具体大模型）✅（OllamaBrain + qwen3，`OLLAMA_MODEL` 可换模型）
5. Gemini 桥与职责模型重构（knowledge/thinking/reflection、浏览器扩展桥）✅
