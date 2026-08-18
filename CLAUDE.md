# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态

仓库权威设计来源为 `docs/human-agent 架构设计与开发规范文档.txt`（v1.0.0）。

已完成的骨架：Git 仓库（main 分支）、`package.json`、`tsconfig.json`（strict + NodeNext ESM，产物到 `dist/`）、`bin/cli.ts`（commander 最小入口）、依赖安装（`pnpm` 管理）。

阶段一类型契约已完成：`src/types/organ.ts`（`ActionResult` + `ok`/`fail`、`RiskLevel`、`EnvSnapshot`、`AgentStatus`/`AgentPhase`、各器官 `*Contract` 接口）、`src/types/index.ts` 与 `src/index.ts` 出口。

阶段二（双手/眼睛/鼻子）已完成（TDD，测试在 `tests/`，vitest 4）：
- `src/nose/risk-checker.ts`：危险特征规则库（rm -rf、DROP TABLE、git push --force 等）→ SAFE/DANGEROUS
- `src/nose/env-checker.ts`：环境快照（OS、CWD、git 分支），`getEnvSnapshot({ cwd })` 可指定目录
- `src/eyes/file-reader.ts`：readFile/readDir/searchCode（searchCode 支持目录参数、跳过 node_modules/.git/dist、相对搜索根返回路径）
- `src/hands/terminal.ts`：execa 10 执行命令，`{ shell: true, encoding: "utf8" }`，错误返回 `EXEC_ERROR` + shortMessage
- `src/hands/file-writer.ts`：writeFile（自动建父目录）+ applyPatch（行级 `- 删除`/`+ 插入` patch 格式，文档见文件头注释）

阶段三（嘴巴/耳朵）已完成（TDD）：
- `src/mouth/text-output.ts`：speak 打字机流式输出（首字符立即、可选 intervalMs）、info/success/warn/error 彩色日志、printDiff 的 +/- 行着色；构造可注入 stdout/chalk 实例（测试用 `new Chalk({ level: 3 })`）
- `src/mouth/ask-user.ts`：confirm(message) 阻塞式 [Y/n] 确认，默认 Y，无效输入循环追问；构造可注入 input/output 流
- `src/ears/text-input.ts`：prompt(question) 读入并 trim；**单实例只创建一个 readline 接口**，空闲期间到达的行进队列不丢失（多行管道输入 `printf "a\n/exit\n" | pnpm dev` 依赖此行为），输入流结束后队列仍可读取、清空后才报错结束会话；提供 `close()` 释放监听

阶段四（大脑/心脏 + 全链路）已完成（TDD，79 tests）：
- `src/brain/llm.ts`：`BrainInference` 统一推理接口（ToolCall/ToolInfo/BrainInferenceResult）
- `src/brain/context.ts`：会话消息队列（system 永不移除，超预算裁剪最旧非 system 消息）
- `src/brain/echo-brain.ts`：EchoBrain 回显最后一条 user 消息，真实 LLM 接入前作为默认大脑
- `src/heart/interrupt.ts`：AbortController 封装（getSignal/abort/isAborted/reset）
- `src/heart/loop.ts`：生命循环（LISTENING→THINKING→SNIFFING→ACTING→FEEDBACK）；6 个工具的 zod 参数校验（INVALID_ARGS）；terminal 危险命令经 mouth.confirm（USER_DENIED）；`#processTurn` 返回 boolean（true 表示中断/出错，规避 TS 对私有字段的收窄问题）；`onPhase` 回调；maxIterations 兜底
- `src/agent.ts`：HumanAgent 组装器，默认组装 EchoBrain + 全部器官（鼻子组合 RiskChecker+EnvChecker，显式组合而非对象展开——spread 不复制原型方法）
- `bin/cli.ts`：SIGINT/SIGTERM → `agent.interrupt.abort()`；结束后 `ears.close()` 防挂起；退出码 ERROR=1 / INTERRUPTED=130 / IDLE=0

**尚未开始**：接入具体大模型替换 EchoBrain（BrainInference 接口已就绪）、`src/eyes/web-crawler.ts`（fetchPageAsMarkdown，契约已定义未实现，loop 未注册工具）、voice/image/browser 等预留器官。

`human-agent` 是一个拟人化智能体（Humanoid Agent）CLI 工具，技术栈为 TypeScript / Node.js (>= 20.0.0, ESM)。

## 架构核心：器官模型

顶层模块以人类生物学器官抽象，每层只依赖相邻的神经信号，职责专一：

- 🧠 `src/brain/`（大脑）：思考与记忆。`llm.ts` 统一推理接口（输入上下文+工具列表，返回思考文本或 Tool Calls）；`context.ts` 会话消息队列与 Token 预算管理。
- 🫀 `src/heart/`（心脏）：生命循环。`loop.ts` 推进 `听取指令 → 大脑思考 → 鼻子嗅探 → 手眼执行 → 反馈结果 → 循环/结束`；`interrupt.ts` 持有全局 `AbortController`。
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
- runtime：`chalk` 6（ESM-only）、`commander` 15、`execa` 10、`zod` 4（错误 API 与 v3 不同）
- dev：`typescript` 7（原生编译器，`tsc --init` 生成的现代默认配置）、`tsx` 4、`@types/node` 26

CLI 入口为 `bin/cli.ts`（处理 argv）。

## 开发路线（4 阶段递进）

1. 骨架与类型（`package.json`/`tsconfig.json`、`src/types/` 与 `ActionResult` 契约）✅
2. 双手与眼睛（file-reader、terminal、file-writer、risk-checker）✅
3. 嘴巴与耳朵（text-output、ask-user、text-input）✅
4. 大脑与心脏（loop 状态机、interrupt、接入具体大模型）✅（LLM 接入待定：目前 EchoBrain 占位）
