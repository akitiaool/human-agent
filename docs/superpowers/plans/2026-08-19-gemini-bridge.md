# Gemini 桥实现计划（v2：网页对话驱动 · 智能体仅执行）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网页版 Gemini 作为对话大脑（浏览器扩展桥），智能体侧仅执行工具；完成大脑职责模型重构（知识库 / 思考 / 反思分层）。

**Architecture（v2，用户拍板）：** 桥模式（`GEMINI_BRIDGE_PORT` 设置时）对话全在网页。插件抓取 Gemini 最新回复 → `POST /result` → 智能体解析 ```tool_call```（无则不回填，循环自然终止）→ 反思层裁决（危险命令**自动拒绝**）→ 共享执行器执行 → 结果序列化 → `GET /task` 长轮询交付 → 插件**模拟人类逐字输入**回填 → 自动模式按防检测随机延迟提交 / 手动模式等用户提交。CLI 仅宿主服务。`GEMINI_BRIDGE_PORT` 不再切换 HumanAgent 内的大脑，而是切换 cli 进程模式。

**Tech Stack:** TypeScript 7（strict + NodeNext ESM）、node:http、zod 4（`z.toJSONSchema`）、vitest 4、Chrome/Edge MV3 扩展（无框架）。

**Spec:** `docs/superpowers/specs/2026-08-19-gemini-bridge-design.md`（v2）

## Global Constraints

- 包管理用 pnpm；测试命令：`pnpm test`（全量）、`pnpm exec vitest run tests/<file>.test.ts`（单文件）。
- **TDD 强制**：每任务先写测试并运行看到失败（RED），再实现到通过（GREEN）。
- TS strict；严禁 `any`，未知结构用 `unknown` + zod；ESM 相对导入必须带 `.js` 扩展名。
- 器官类可实例化，严禁单例/全局状态，靠构造注入。
- `exactOptionalPropertyTypes`：可选参数用 conditional spread（`...(x !== undefined ? { y: x } : {})`）。
- git commit 消息**不得包含** Co-Authored-By / Generated with 等署名，只写变更内容。
- zod 4：`z.toJSONSchema(schema)` 顶层 API；`safeParse` 失败走 `parsed.error.issues`。
- Node ≥ 20，`fetch` 全局可用；不需要新依赖（node:http / node:crypto 为标准库）。
- 默认不写注释；仅当解释 WHY 且删掉会误导读者时才写。

---

## 已完成任务（v1，保持有效）

| 任务 | 产出 | 状态 |
|---|---|---|
| Task 1 | `src/brain/knowledge.ts`（schemas/TOOLS/serializeToolProtocol）+ `tests/knowledge.test.ts` | ✅ 保持 |
| Task 2 | `src/brain/reflection.ts`（存在性/zod/危险嗅探裁决）+ llm.ts 契约 + 测试 | ✅ 保持 |
| Task 3 | `src/brain/thinking/ollama-thinking.ts`（改名 + reflect）+ helpers stub + agent 组装调整 | ✅ 保持（**目录迁移见 Task 10**） |
| Task 5 | 心脏净化：loop 只留路由/承受力，`#execute` = reflect 裁决路径；AgentPhase 去 SNIFFING | ✅ 保持（**#dispatch 抽取见 Task 11**） |
| Task 8 | CLAUDE.md / README.md 阶段五段落 | ⚠️ v2 语义下需重写（Task 14） |

**v1 已交付但按 v2 重做：** Task 4（GeminiBridgeThinking，重写为执行型桥服务 → Task 11）、Task 6（agent/cli 组装 → Task 12）、Task 7（浏览器扩展 → Task 13，**阻塞：需用户提供 AI Studio 真实 DOM 结构**）。

---

### Task 10: 布局迁移——thinking 实现移至 src/brain/ 根目录

**Files:**
- Rename: `src/brain/thinking/ollama-thinking.ts` → `src/brain/ollama-thinking.ts`（git mv 保留历史）
- Rename: `src/brain/thinking/gemini-bridge-thinking.ts` → `src/brain/gemini-bridge-thinking.ts`
- Modify: 所有引用 `thinking/` 路径的 import 与文档（grep `thinking/` 全仓库）

**Interfaces:**
- Produces: `src/brain/` 下直接放置两个 thinking 实现，`src/brain/thinking/` 目录删除。Task 11/12/13/14 全部基于新路径。

- [ ] **Step 1: 迁移文件**

```bash
git mv src/brain/thinking/ollama-thinking.ts src/brain/ollama-thinking.ts
git mv src/brain/thinking/gemini-bridge-thinking.ts src/brain/gemini-bridge-thinking.ts
rmdir src/brain/thinking
```

- [ ] **Step 2: 修正所有引用**

Grep `thinking/` 覆盖：`src/`、`bin/`、`tests/`、`CLAUDE.md`、`README.md`。逐一修正：

1. 两个迁移文件内部的相对导入（深度变化）：
   - `ollama-thinking.ts`：`../context.js`→`./context.js`、`../llm.js`→`./llm.js`、`../reflection.js`→`./reflection.js`、`../../types/index.js`→`../types/index.js`
   - `gemini-bridge-thinking.ts`：同上（含 `../knowledge.js`→`./knowledge.js`）
2. 引用方：
   - `src/agent.ts`、`bin/cli.ts`：`./brain/thinking/ollama-thinking.js` → `./brain/ollama-thinking.js`（gemini-bridge-thinking 同）
   - `tests/ollama-thinking.test.ts`、`tests/gemini-bridge-thinking.test.ts`、`tests/agent.test.ts`：`../src/brain/thinking/*.js` → `../src/brain/*.js`
3. `CLAUDE.md` / `README.md` 中的 `src/brain/thinking/` 路径改为 `src/brain/`（描述文本的完整重写在 Task 14，此处只改路径事实）

- [ ] **Step 3: 验证**

Run: `pnpm test` → 全绿；`pnpm build` → 编译通过。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 思考层实现移至 src/brain/ 根目录（不建 thinking/ 子目录）"
```

---

### Task 11: GeminiBridgeThinking 重写为执行型桥服务 + 共享执行器抽取

**Files:**
- Rewrite: `src/brain/gemini-bridge-thinking.ts`（v2 执行型桥服务）
- Create: `src/heart/executor.ts`（共享工具执行器，从 loop #dispatch 抽出）
- Modify: `src/heart/loop.ts`（#dispatch 删除，改用 executeTool）
- Rewrite: `tests/gemini-bridge-thinking.test.ts`
- Test: `tests/loop.test.ts`（回归验证 executor 抽取行为不变）

**Interfaces:**
- Consumes: `schemas`/`serializeToolProtocol`（knowledge.ts）、`Reflection`（reflection.ts）、`ToolCall`/`BrainInferenceResult`（llm.ts）、`EyesContract`/`HandsContract`/`NoseContract`/`ActionResult`（types）。
- Produces: `GeminiBridgeThinking`（`{ port?, host?, nose, hands, eyes, signal?, timeoutMs?, logger? }`、`getPort()`、`close()`）、`parseToolCalls`（保持）、`executeTool(organs, name, args, signal?)`（executor.ts）。Task 12 的组装与 cli 依赖。

**设计要点（spec v2「GeminiBridgeThinking（桥服务）」节，必须逐条落实）：**

- 构造注入 nose/hands/eyes；内部 `new Reflection(nose, { confirm: async () => false })`——危险命令自动拒绝（不再调用真实嘴巴）
- 启动即把 `serializeToolProtocol()` 作为首条回填消息入队
- HTTP：`GET /task` 长轮询（约 25s 后 204）返回 `{message}`；`POST /result` 收 `{reply}`（非空字符串、≤ 200_000 字符，非法 400）→ `{ok: true, processed: boolean}`；其余 404
- 处理流水线（单批串行队列）：去重（与最近一次处理内容完全相同 → processed:false）→ parseToolCalls（无 tool_call → processed:false）→ 有则入队（processed:true）→ 批执行：reflect 裁决 → 放行经 executeTool（共享执行器，signal = `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`，timeoutMs>0 时）→ 拦截收集拒绝原因 → 序列化回填消息 → 唤醒长轮询
- 超时（AbortSignal.timeout 触发）→ 队列一条「工具执行超时」说明；全局中断（signal.aborted）→ 丢弃批次不排队
- `close()`：waiter 全部以 204 释放、清空 outbox、关服务与全部连接
- 回填消息格式（spec「回填消息格式」节）：`N. 工具 {name} 参数 {args} → 成功/失败/已拒绝（原因）`，成功/失败附 ActionResult JSON 代码块；拒绝按错误码格式化（USER_DENIED → 危险命令自动拒绝）

- [ ] **Step 1: 抽共享执行器（先 GREEN 后重写，保证 loop 无回归）**

`tests/loop.test.ts` 现有工具执行用例是 executor 抽取的行为基准。新建 `src/heart/executor.ts`：

```ts
import { fail, type ActionResult, type EyesContract, type HandsContract } from "../types/index.js";

export interface ToolOrgans {
  eyes: EyesContract;
  hands: HandsContract;
}

/** 工具执行路由：工具名 → 双手/眼睛方法（loop 与桥服务共用，保持单一映射）。 */
export async function executeTool(
  organs: ToolOrgans,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ActionResult<unknown>> {
  switch (name) {
    case "read_file":
      return organs.eyes.readFile(args.path as string);
    case "read_dir":
      return organs.eyes.readDir(args.path as string);
    case "search_code":
      return organs.eyes.searchCode(args.pattern as string, args.dir as string | undefined);
    case "write_file":
      return organs.hands.writeFile(args.path as string, args.content as string);
    case "apply_patch":
      return organs.hands.applyPatch(args.path as string, args.patch as string);
    case "terminal":
      return organs.hands.executeCommand(
        args.command as string,
        signal,
        args.timeoutMs as number | undefined,
      );
    case "fetch_page":
      return organs.eyes.fetchPageAsMarkdown(args.url as string);
    default:
      return fail("UNKNOWN_TOOL", `未知工具: ${name}`);
  }
}
```

`src/heart/loop.ts`：删除 `#dispatch` 方法，`#execute` 中 `await this.#dispatch(call.name, call.arguments, turnSignal)` 改为 `await executeTool({ eyes: this.#eyes, hands: this.#hands }, call.name, call.arguments, turnSignal)`（import 同步）。跑 `pnpm exec vitest run tests/loop.test.ts` → 全绿（行为不变，这步不是 TDD 的 RED，是抽取回归）。

- [ ] **Step 2: 重写 gemini-bridge-thinking 测试（RED）**

`tests/gemini-bridge-thinking.test.ts` 整体重写。测试骨架与用例：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiBridgeThinking, parseToolCalls } from "../src/brain/gemini-bridge-thinking.js";
import type { ActionResult, EyesContract, HandsContract, NoseContract, RiskLevel } from "../src/types/index.js";
import { buildStubNose } from "./helpers.js";

// 记录型 stub 器官：断言"执行了哪些工具"而不真跑命令
function makeRecordingOrgans() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const eyes: EyesContract = {
    readFile: async (path) => { calls.push({ name: "read_file", args: { path } }); return ok({ content: `内容:${path}` }); },
    readDir: async (path) => { calls.push({ name: "read_dir", args: { path } }); return ok(["a.txt"]); },
    searchCode: async (pattern, dir) => { calls.push({ name: "search_code", args: { pattern, dir } }); return ok([]); },
    fetchPageAsMarkdown: async (url) => { calls.push({ name: "fetch_page", args: { url } }); return ok("# 网页"); },
  };
  const hands: HandsContract = {
    writeFile: async (path, content) => { calls.push({ name: "write_file", args: { path, content } }); return ok(undefined); },
    applyPatch: async (path, patch) => { calls.push({ name: "apply_patch", args: { path, patch } }); return ok(undefined); },
    executeCommand: async (command, _signal, timeoutMs) => {
      calls.push({ name: "terminal", args: { command, timeoutMs } });
      if (command === "slow") await new Promise((r) => setTimeout(r, 10_000));
      return ok({ stdout: `输出:${command}`, exitCode: 0 });
    },
  };
  return { calls, eyes, hands };
}

function ok<T>(data: T): ActionResult<T> { return { success: true, data }; }

const openBridges: GeminiBridgeThinking[] = [];
afterEach(() => { for (const bridge of openBridges.splice(0)) bridge.close(); });

async function makeBridge(options: { nose?: NoseContract; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const organs = makeRecordingOrgans();
  const bridge = new GeminiBridgeThinking({
    port: 0,
    nose: options.nose ?? buildStubNose(),
    hands: organs.hands,
    eyes: organs.eyes,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  openBridges.push(bridge);
  const port = await bridge.getPort();
  return { bridge, port, organs };
}

/** 长轮询取一条回填消息；无消息时服务端 25s 后 204（测试不等待该路径）。 */
async function getMessage(port: number): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${port}/task`);
  if (res.status === 204) return null;
  const body = (await res.json()) as { message: string };
  return body.message;
}

async function postReply(port: number, reply: string): Promise<{ ok: boolean; processed: boolean }> {
  const res = await fetch(`http://127.0.0.1:${port}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  return (await res.json()) as { ok: boolean; processed: boolean };
}

const toolCall = (name: string, args: object) =>
  ["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");
```

用例清单（全部必须）：见 Self-Review 对应行，具体断言：
1. parseToolCalls 四例（沿用 v1：纯文本 / 单块 / 坏 JSON / 多块）
2. 「首条任务为工具协议」：`getMessage` → 含 `【human-agent 工具协议】`
3. 「含 tool_call 的内容执行后回填结果消息」：`postReply(toolCall("read_file", { path: "a.txt" }))` → `processed: true`；`getMessage` → 含 `工具执行结果`、`read_file`、`内容:a.txt`；`organs.calls` 含 `read_file`
4. 「无 tool_call 的内容不回填」：`postReply("纯文本回复")` → `processed: false`；`organs.calls` 为空
5. 「多个 tool_call 汇总为一条消息并全部执行」：post 两个（read_file + terminal echo）→ processed:true → getMessage 含两个工具名；calls 长度 2
6. 「危险命令自动拒绝」：`makeBridge({ nose: buildStubNose("DANGEROUS") })`；post `toolCall("terminal", { command: "rm -rf /" })` → getMessage 含 `已拒绝` 且含 `危险命令自动拒绝`；`organs.calls` 不含该 terminal（拒绝不执行）
7. 「未知工具与参数非法拒绝」：post 两个（`hack_planet` + `read_file` 空参）→ getMessage 含 `未知工具` 与 `参数不合法`
8. 「相同内容重复提交只处理一次」：连续两次相同 post → 第一次 processed:true、第二次 processed:false；`organs.calls` 只执行一次
9. 「批超时队列执行超时说明」：`makeBridge({ timeoutMs: 100 })`；post `toolCall("terminal", { command: "slow" })` → processed:true → getMessage 含 `超时`；calls 含 slow（已开始执行）
10. 「全局中断丢弃批次」：`makeBridge({ signal })`，先 `controller.abort()`；post tool_call → processed:true 但批执行被中止 → calls 中 second 工具未执行（post 后小等 50ms 断言 calls 状态）——注意：中断后批不排队，无消息可取（不做 25s 等待断言）
11. 「close 释放挂起长轮询」：先 `getMessage`（无消息挂起）→ 主流程 `bridge.close()` → fetch 以 204 结束（`Promise.race` 或直接断言 fetch resolve 且 status 204）
12. 「非法 reply 返回 400」：`postReply("")` → res.status 400

注：用例 10 的「不排队」不做 25s 长轮询等待，仅断言批中止（calls 不完整）；waitFor 用 `await new Promise((r) => setTimeout(r, 50))` 后断言。

- [ ] **Step 3: 运行确认 RED**

Run: `pnpm exec vitest run tests/gemini-bridge-thinking.test.ts`
Expected: FAIL（模块导出/行为与测试不符——类名保持 GeminiBridgeThinking 但构造签名与 HTTP 行为全变）。

- [ ] **Step 4: 重写 gemini-bridge-thinking.ts**

按 spec「GeminiBridgeThinking（桥服务）」节实现。结构要点：
- 构造：`readonly #server`/`#portPromise`（沿用 v1 模式：构造内 createServer + listen，`getPort()` 返回 portPromise）；`#reflection = new Reflection(options.nose, { confirm: async () => false })`；`#outbox: string[]`；`#waiters`；`#busy: Promise<void>`（串行链）；`#lastContent: string | undefined`；`#logger`；构造末尾 `this.#outbox.push(serializeToolProtocol())`
- `#handleRequest`：GET /task → 出队或挂起；POST /result → `#handleResultRequest`；其余 404
- `#handleResultRequest`：readJsonBody → zod 或手写校验 `typeof reply === "string" && reply.length > 0 && reply.length <= 200_000`（非法 400 `{error}`）→ 去重（`reply === this.#lastContent` → processed:false）→ `parseToolCalls(reply)` → 无 toolCalls → processed:false → 有 → `this.#lastContent = reply; this.#busy = this.#busy.then(() => this.#process(calls, reply))` → processed:true；响应 `{ok:true, processed}` 立即返回（不等待批完成）
- `#process(calls)`：批 signal = `timeoutMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal`（signal 为构造注入的 AbortSignal，缺省 `new AbortController().signal`）；`reflection.reflect(calls)` → allowed 逐个 `executeTool({eyes, hands}, name, args, batchSignal)`（每次执行前检查 `batchSignal.aborted` 则停止）→ blocked 收集 → 序列化回填消息（格式见 spec）→ 若超时（非全局中断）则消息为「⚠️ 工具执行超时...」→ `this.#outbox.push(message)` + 唤醒第一个 waiter；全局中断（`signal.aborted`）→ 不排队；catch 异常 → logger 记录、不排队（或排一条错误说明——选择一种并在测试中固定：**选排一条「执行失败」说明**更利于 Gemini 继续，测试 9 之外补一个用例或并入批超时用例的断言——实现时若选择排队，注意用例 10 仅针对全局中断）
  - 简化裁决：`reflection.reflect(calls)` 一次裁决整批（与 loop 一致）
- 序列化函数（模块级，便于测试）：`formatExecutionResults(entries: Array<{ name, args, result? | blocked? }>): string`——逐条 `N. 工具 {name} 参数 {JSON} → 成功/失败/已拒绝（原因）`，成功/失败附 `\`\`\`json\n{JSON.stringify(result)}\n\`\`\``；拒绝按 `result.error.code` 映射文案（USER_DENIED → `危险命令自动拒绝，未执行`；其余 → 原文 error.message）
- `close()`：`waiter(null)` 释放全部（204）、outbox 清空、`#server.close()` + `#server.closeAllConnections()`
- `parseToolCalls` / `isToolCall`：从 v1 原样保留

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run tests/gemini-bridge-thinking.test.ts`
Expected: PASS（约 13 个用例）。

- [ ] **Step 6: 全量回归**

Run: `pnpm test`
Expected: PASS（loop.test.ts 验证 executor 抽取无回归）。

- [ ] **Step 7: Commit**

```bash
git add src/brain/gemini-bridge-thinking.ts src/heart/executor.ts src/heart/loop.ts tests/gemini-bridge-thinking.test.ts
git commit -m "feat: GeminiBridgeThinking 重写为执行型桥服务——网页内容→tool_call 解析→裁决→执行→回填"
```

---

### Task 12: agent.ts buildBridgeService + cli.ts 桥模式宿主分支

**Files:**
- Modify: `src/agent.ts`（buildDefaultBrain 去掉桥分支；新增 buildBridgeService）
- Modify: `bin/cli.ts`（GEMINI_BRIDGE_PORT → 桥模式分支）
- Modify: `tests/agent.test.ts`（buildBridgeService 用例；删旧 env 用例）

**Interfaces:**
- Consumes: `GeminiBridgeThinking`（Task 11，新构造签名）、`InterruptController`（heart/interrupt.ts，isAborted 存在）。
- Produces: `buildBridgeService(options?)`（agent.ts 导出）、cli 桥模式分支（宿主服务，SIGINT/SIGTERM 干净退出）。

- [ ] **Step 1: 改测试（RED）**

`tests/agent.test.ts`：
1. import：`GeminiBridgeThinking` 改从 `../src/brain/gemini-bridge-thinking.js` 导入；新增 `buildBridgeService` 从 `../src/agent.js` 导入
2. **删除**用例「GEMINI_BRIDGE_PORT 环境变量启用 GeminiBridgeThinking」（v2 语义：env 不再切换 HumanAgent 大脑）
3. 文件末尾追加：

```ts
it("buildBridgeService 返回可监听的桥服务", async () => {
  const service = buildBridgeService({ port: 0 });
  try {
    expect(service).toBeInstanceOf(GeminiBridgeThinking);
    const port = await service.getPort();
    expect(Number.isInteger(port)).toBe(true);
  } finally {
    service.close();
  }
});

it("buildBridgeService 未指定端口时读 GEMINI_BRIDGE_PORT，非法值回退 8765", async () => {
  process.env.GEMINI_BRIDGE_PORT = "not-a-port";
  try {
    const service = buildBridgeService({ port: 0 }); // 显式 0 优先，避免真实绑定 8765
    expect(service).toBeInstanceOf(GeminiBridgeThinking);
    service.close();
  } finally {
    delete process.env.GEMINI_BRIDGE_PORT;
  }
});
```

（第二个用例以「显式 port 优先于 env」验证 env 解析路径存在；若实现为「port 选项缺省才读 env」，则该用例断言 port 0 生效且 env 不影响——具体断言以实现的语义为准，但必须覆盖 env 解析分支的代码路径。）

- [ ] **Step 2: 运行确认 RED**

Run: `pnpm exec vitest run tests/agent.test.ts`
Expected: FAIL（`buildBridgeService` 未导出）。

- [ ] **Step 3: agent.ts 修改**

1. `buildDefaultBrain` 删除 `GEMINI_BRIDGE_PORT` 分支，恒返回 OllamaThinking（`GeminiBridgeThinking` import 移除）
2. 新增导出：

```ts
export interface BridgeServiceOptions {
  port?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: (text: string) => void;
}

/** 桥模式组装：网页对话 + 智能体仅执行工具。port 缺省读 GEMINI_BRIDGE_PORT（非法回退 8765）。 */
export function buildBridgeService(options: BridgeServiceOptions = {}): GeminiBridgeThinking {
  const nose = buildDefaultNose();
  const hands = buildDefaultHands();
  const eyes = buildDefaultEyes();
  const port = options.port ?? (() => {
    const raw = process.env.GEMINI_BRIDGE_PORT;
    if (raw === undefined) return 8765;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 8765;
  })();
  return new GeminiBridgeThinking({
    port,
    nose,
    hands,
    eyes,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
```

（HumanAgent 类与 Ollama 组装保持不变。）

- [ ] **Step 4: cli.ts 桥模式分支**

`bin/cli.ts` 整体替换为：

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { buildBridgeService, HumanAgent } from "../src/agent.js";
import { InterruptController } from "../src/heart/interrupt.js";
import { TextInput } from "../src/ears/text-input.js";

const program = new Command();

program
  .name("human-agent")
  .description("A humanoid modular AI Agent CLI tool")
  .version("0.1.0");

program.parse(process.argv);

if (process.env.GEMINI_BRIDGE_PORT !== undefined) {
  // 桥模式：对话在网页（AI Studio），CLI 仅宿主 HTTP 服务
  const interrupt = new InterruptController();
  const service = buildBridgeService({
    signal: interrupt.getSignal(),
    logger: (text) => console.log(`[gemini-bridge] ${text}`),
  });
  process.on("SIGINT", () => interrupt.abort());
  process.on("SIGTERM", () => interrupt.abort());
  try {
    const port = await service.getPort();
    console.log(`Gemini 桥已监听 http://127.0.0.1:${port}`);
    console.log("请在 AI Studio 页面与 Gemini 对话；插件会把 Gemini 的回复传给智能体执行工具，并把结果回填提交。");
  } catch (err) {
    console.error(`Gemini 桥无法监听端口：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  await new Promise<void>((resolve) => {
    if (interrupt.isAborted()) resolve();
    else interrupt.getSignal().addEventListener("abort", () => resolve(), { once: true });
  });
  service.close();
  process.exitCode = interrupt.isAborted() ? 130 : 0;
} else {
  const agent = new HumanAgent();
  process.on("SIGINT", () => agent.interrupt.abort());
  process.on("SIGTERM", () => agent.interrupt.abort());
  const status = await agent.run();
  if (agent.ears instanceof TextInput) agent.ears.close();
  process.exitCode = status === "ERROR" ? 1 : status === "INTERRUPTED" ? 130 : 0;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run tests/agent.test.ts` → PASS；`pnpm test` → PASS；`pnpm build` → 通过。

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts bin/cli.ts tests/agent.test.ts
git commit -m "feat: 桥模式——GEMINI_BRIDGE_PORT 切换 CLI 为宿主服务，buildBridgeService 组装执行型桥"
```

---

### Task 13: gemini-bridge 浏览器扩展重写（阻塞：需真实 DOM）

**状态：BLOCKED** —— content.js 的内容抓取（输入框/发送按钮/模型回复元素/对话容器）必须基于用户提供的 AI Studio 真实 DOM 结构，当前选择器为猜测，不可用。拿到 DOM 后按 spec「插件侧（v2 重写）」节与下列要点执行：

- 面板：自动模式开关 + 防检测设置（延迟区间 min/max 输入、模拟输入开关）+ 状态/日志；**删除**「交给智能体」「回填」按钮与发送事件监控
- 内容监控循环：最新模型回复文本变化（稳定采样 2–3 次）→ `POST /result {reply}`；去重由服务侧兜底
- 投递循环：长轮询 `GET /task` → 模拟人类逐字输入（每字符随机短延时，输入完成后合成 InputEvent）→ 自动模式：随机延迟（面板区间）后点击发送（延迟回调时开关已关则跳过）；手动模式：只回填
- 协议注入：首条任务消息即协议文本，直接回填提交；插件保存该文本，检测到新对话（对话容器清空/重置）时重新注入
- background.js：get-task（fetch 30s 超时）、submit-result（POST {reply}）、全部 try/catch 答 {error}
- 手动验证加载 + Commit

---

### Task 14: 文档更新（CLAUDE.md / README.md，v2 语义）

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

按 v2 设计重写阶段五段落、架构行与 Gemini 桥小节（Task 10 已改路径事实，此处写语义）。要点：
- 阶段五：`src/brain/ollama-thinking.ts` / `gemini-bridge-thinking.ts`（**brain/ 根目录**）；桥服务为**执行型**（接收网页内容 → 解析 ```tool_call``` → 反思裁决（危险自动拒绝）→ 执行 → 回填队列），**非 BrainInference 实现**；`heart/executor.ts` 共享执行器；`GEMINI_BRIDGE_PORT` 切换 **cli 进程模式**（桥模式对话全在网页，CLI 仅宿主）；扩展面板 = 自动模式 + 防检测设置（随机延迟 + 模拟输入）
- README：功能行、配置表（GEMINI_BRIDGE_PORT 语义）、架构树（brain/ 无 thinking/）、Gemini 桥小节重写

- [ ] **Step 1: CLAUDE.md**
- [ ] **Step 2: README.md**
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: 桥模式 v2——网页对话驱动、智能体仅执行工具、执行型桥服务说明"
```

---

### Task 15: 真实联调（手动 E2E，非 TDD）

**Files:** 无代码改动；按清单人工验证（需要用户操作浏览器）。

- [ ] **Step 1: 基线回归**：`pnpm test` 全绿；`pnpm build` 通过
- [ ] **Step 2: Ollama 基线**：`pnpm dev` 输入"读取 package.json"，工具链路正常
- [ ] **Step 3: 加载扩展**：chrome://extensions 开发者模式加载 `extensions/gemini-bridge`；打开并登录 aistudio.google.com；浮动面板出现（自动模式开关 + 防检测设置）
- [ ] **Step 4: 桥全链路**：`GEMINI_BRIDGE_PORT=8765 pnpm dev` → 插件自动回填协议并提交 → 页面输入"读取 package.json" → Gemini 回复 ```tool_call``` → 插件抓取回传 → 智能体执行 → 结果模拟输入回填 → 自动模式随机延迟后提交 → Gemini 总结（无 tool_call）→ 循环自然终止
- [ ] **Step 5: 手动模式**：关自动模式 → 结果只回填不提交 → 手动点发送 → 循环继续
- [ ] **Step 6: 防检测与安全**：连续多轮，提交为随机延迟 + 逐字模拟输入；页面生成危险命令（如 rm -rf）→ 智能体自动拒绝 → 拒绝说明回填
- [ ] **Step 7: 中断**：`Ctrl+C` → 干净退出（exit 130），无残留 node 进程
- [ ] **Step 8: 收尾提交**（如有联调中发现的小修复，按 TDD 补测试后提交）

---

## Self-Review

**Spec v2 覆盖检查：**
- 布局迁移（thinking/ → brain/ 根目录，import 与文档路径）→ Task 10
- 执行型桥服务（协议注入、POST /result 校验/去重、parseToolCalls、裁决自动拒绝、executeTool 批执行、回填序列化、批超时、全局中断、close 释放）→ Task 11
- 共享执行器抽取（loop #dispatch → executor.ts，loop 回归）→ Task 11
- 组装（buildBridgeService、HumanAgent 恒 Ollama）与 cli 桥模式宿主分支 → Task 12
- 扩展重写（自动模式 + 防检测设置、内容监控、模拟输入、新对话协议重注入、删旧按钮）→ Task 13（阻塞：DOM）
- 文档 v2 语义 → Task 14
- 手动 E2E（新清单）→ Task 15

**设计决策说明（spec 未完全定死的落点）：**
1. **无 id 握手**：v2 是单向流水线（插件推内容、拉回填），处理结果与请求不配对；去重靠插件（内容变化才 POST）+ 服务（#lastContent）双保险。
2. **协议注入时机**：桥服务启动即把协议文本作为首条回填消息入队；插件保存协议文本，新对话（容器重置）时重新注入——让 Gemini 在任何新对话里都知道 ```tool_call``` 格式。
3. **超时与中断的差异**：批超时（AbortSignal.timeout）→ 队列「执行超时」说明让 Gemini 继续；全局中断（Ctrl+C）→ 丢弃批次（进程即将退出）。
4. **危险自动拒绝**：桥服务内部注入 `{ confirm: async () => false }` 嘴巴——复用 Reflection 的 DANGEROUS→USER_DENIED 路径，不新增策略参数。
5. **拒绝消息按错误码格式化**：USER_DENIED →「危险命令自动拒绝，未执行」；UNKNOWN_TOOL/INVALID_ARGS → 原文原因。
6. **v2 中 GEMINI_BRIDGE_PORT 是进程模式开关**：设置 → cli 桥模式宿主分支（无 HumanAgent/loop）；未设置 → 原 Ollama 对话模式。HumanAgent 不再感知该环境变量。
