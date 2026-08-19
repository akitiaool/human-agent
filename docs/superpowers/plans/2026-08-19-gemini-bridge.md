# Gemini 桥实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入网页版 Gemini 作为大脑（浏览器扩展桥），并完成大脑职责模型重构（知识库 / 思考 / 反思分层）。

**Architecture:** 大脑分为知识库（`brain/knowledge.ts`，工具 schema 唯一来源）、思考层（`brain/thinking/`，模型推理实现）、反思层（`brain/reflection.ts`，确定性可行性裁决）。Gemini 走浏览器扩展桥：brain 内嵌 HTTP 服务发布任务，插件在 AI Studio 页面发送/抓取回复回传。心脏净化：只保留路由、承受力与循环节拍，可行性裁决全部移交大脑。

**Tech Stack:** TypeScript 7（strict + NodeNext ESM）、node:http、zod 4（`z.toJSONSchema`）、vitest 4、Chrome/Edge MV3 扩展（无框架）。

**Spec:** `docs/superpowers/specs/2026-08-19-gemini-bridge-design.md`

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

### Task 1: 大脑知识库（brain/knowledge.ts）

**Files:**
- Create: `src/brain/knowledge.ts`
- Test: `tests/knowledge.test.ts`

**Interfaces:**
- Consumes: `ToolInfo`（`src/brain/llm.ts` 现有导出）、zod 4。
- Produces: `schemas`（7 个 zod schema 的 `as const` 对象）、`TOOLS: readonly ToolInfo[]`（parameters 由 `z.toJSONSchema` 派生）、`serializeToolProtocol(): string`（思考层每轮注入的工具协议文本）。后续 Task 2/4/5 依赖这三者。

- [ ] **Step 1: 写失败测试**

创建 `tests/knowledge.test.ts`：

````ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemas, serializeToolProtocol, TOOLS } from "../src/brain/knowledge.js";

describe("brain/knowledge", () => {
  it("知识库包含 7 个工具且名称齐全", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "read_file",
      "read_dir",
      "search_code",
      "write_file",
      "apply_patch",
      "terminal",
      "fetch_page",
    ]);
  });

  it("每个工具的 JSON Schema parameters 均为 object 形态", () => {
    for (const tool of TOOLS) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.properties).toBeTypeOf("object");
    }
  });

  it("TOOLS 的 parameters 与 zod 派生的 JSON Schema 一致", () => {
    for (const tool of TOOLS) {
      const name = tool.name as keyof typeof schemas;
      expect(tool.parameters).toEqual(z.toJSONSchema(schemas[name]));
    }
  });

  it("read_file 的 schema 要求 path 为字符串", () => {
    const jsonSchema = z.toJSONSchema(schemas.read_file) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(jsonSchema.properties.path).toEqual({ type: "string" });
    expect(jsonSchema.required).toEqual(["path"]);
  });

  it("terminal 的 timeoutMs 可选（required 仅含 command）", () => {
    const jsonSchema = z.toJSONSchema(schemas.terminal) as { required?: string[] };
    expect(jsonSchema.required).toEqual(["command"]);
  });

  it("serializeToolProtocol 输出协议头、全部工具与调用规则", () => {
    const protocol = serializeToolProtocol();
    expect(protocol).toContain("【human-agent 工具协议】");
    expect(protocol).toContain("read_file");
    expect(protocol).toContain("fetch_page");
    expect(protocol).toContain("一次只调用一个工具");
    expect(protocol).toContain("```tool_call");
  });
});
````

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/knowledge.test.ts`
Expected: FAIL（模块 `../src/brain/knowledge.js` 不存在）。

- [ ] **Step 3: 实现 knowledge.ts**

创建 `src/brain/knowledge.ts`：

````ts
// 大脑知识库（认知层）："工具如何使用"的知识——7 个工具的 schema + description。
// 当前是唯一知识来源；未来 RAG 系统将作为新的知识来源在此聚合。
import { z } from "zod";
import type { ToolInfo } from "./llm.js";

export const schemas = {
  read_file: z.object({ path: z.string() }),
  read_dir: z.object({ path: z.string() }),
  search_code: z.object({ pattern: z.string(), dir: z.string().optional() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  apply_patch: z.object({ path: z.string(), patch: z.string() }),
  terminal: z.object({
    command: z.string(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("命令超时毫秒数（可选，默认由任务超时控制）")
      .optional(),
  }),
  fetch_page: z.object({ url: z.string() }),
} as const;

const descriptions = {
  read_file: "读取指定文件的内容",
  read_dir: "列出指定目录的条目",
  search_code: "在目录中检索匹配正则表达式的文件内容",
  write_file: "写入文件内容（自动创建父目录）",
  apply_patch: "对文件应用行级补丁",
  terminal: "执行 shell 命令（可指定 timeoutMs 毫秒超时，超时自动终止）",
  fetch_page: "抓取网页并转换为 Markdown",
} as const;

export const TOOLS: readonly ToolInfo[] = (
  Object.keys(schemas) as (keyof typeof schemas)[]
).map((name) => ({
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(schemas[name]) as Record<string, unknown>,
}));

const PROTOCOL_HEADER =
  "【human-agent 工具协议】你是 human-agent 智能体的大脑，通过调用工具与本地环境交互。";

const PROTOCOL_RULES = [
  "调用规则：",
  "- 需要读取/修改/执行才能完成用户任务时，必须调用工具，不得假装完成",
  "- 一次只调用一个工具，等待工具结果后再决定下一步",
  "- 需要调用工具时，输出且只输出一个 JSON 代码块，不要附带其他文字：",
  "```tool_call",
  '{"name": "工具名", "arguments": {参数对象}}',
  "```",
  "- 工具结果将以「工具返回：{结果 JSON}」的形式出现在下一条消息",
  "- 任务完成或无需工具时，直接输出最终回答文本",
].join("\n");

/** 序列化工具协议文本：每轮思考完整注入（可靠性优先，不做首轮后精简）。 */
export function serializeToolProtocol(): string {
  const toolLines = TOOLS.map(
    (tool, index) =>
      `${index + 1}. ${tool.name}: ${tool.description} | ${JSON.stringify(tool.parameters)}`,
  );
  return `${PROTOCOL_HEADER}\n可用工具（名称：用途 | 参数）：\n${toolLines.join("\n")}\n${PROTOCOL_RULES}`;
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/knowledge.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/brain/knowledge.ts tests/knowledge.test.ts
git commit -m "feat: 大脑知识库——工具 schema 与协议序列化迁入 brain/knowledge.ts"
```

---

### Task 2: 反思层（brain/reflection.ts）+ 裁决类型

**Files:**
- Create: `src/brain/reflection.ts`
- Modify: `src/brain/llm.ts`（新增 `BlockedCall` / `ReflectionVerdict` 类型导出）
- Test: `tests/reflection.test.ts`

**Interfaces:**
- Consumes: `schemas`（Task 1）、`ToolCall`（llm.ts 现有）、`fail`/`NoseContract`/`MouthContract`（types/index.js 现有）。
- Produces: `BlockedCall` / `ReflectionVerdict`（llm.ts）、`Reflection` 类（`constructor(nose, mouth)`、`reflect(calls): Promise<ReflectionVerdict>`）。Task 3/4 的思考层实现与 Task 5 的 loop 依赖这些。

- [ ] **Step 1: 写失败测试**

创建 `tests/reflection.test.ts`：

````ts
import { describe, expect, it, vi } from "vitest";
import { Reflection } from "../src/brain/reflection.js";
import type { MouthContract, NoseContract, RiskLevel } from "../src/types/index.js";

function makeNose(risk: RiskLevel): NoseContract {
  return {
    checkRisk: () => risk,
    getEnvSnapshot: () => ({ os: "test", cwd: "/tmp" }),
    checkPorts: async () => [],
  };
}

function makeMouth(approve: boolean): MouthContract {
  return { confirm: async () => approve };
}

describe("Reflection", () => {
  it("安全命令放行", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const call = { name: "terminal", arguments: { command: "echo hi" } };
    const verdict = await reflection.reflect([call]);
    expect(verdict.allowed).toEqual([call]);
    expect(verdict.blocked).toEqual([]);
  });

  it("未知工具拦截为 UNKNOWN_TOOL", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const call = { name: "hack_the_planet", arguments: {} };
    const verdict = await reflection.reflect([call]);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("UNKNOWN_TOOL");
  });

  it("参数不合法拦截为 INVALID_ARGS", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const call = { name: "read_file", arguments: {} };
    const verdict = await reflection.reflect([call]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("INVALID_ARGS");
  });

  it("危险命令经用户拒绝后拦截为 USER_DENIED", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const reflection = new Reflection(makeNose("DANGEROUS"), { confirm });
    const call = { name: "terminal", arguments: { command: "rm -rf /" } };
    const verdict = await reflection.reflect([call]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("USER_DENIED");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("rm -rf /"));
  });

  it("危险命令经用户确认后放行", async () => {
    const reflection = new Reflection(makeNose("DANGEROUS"), makeMouth(true));
    const call = { name: "terminal", arguments: { command: "rm -rf /tmp/test" } };
    const verdict = await reflection.reflect([call]);
    expect(verdict.allowed).toEqual([call]);
  });

  it("混合调用逐条裁决", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const good = { name: "read_file", arguments: { path: "a.txt" } };
    const bad = { name: "read_file", arguments: {} };
    const verdict = await reflection.reflect([good, bad]);
    expect(verdict.allowed).toEqual([good]);
    expect(verdict.blocked).toHaveLength(1);
  });
});
````

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/reflection.test.ts`
Expected: FAIL（模块 `../src/brain/reflection.js` 不存在）。

- [ ] **Step 3: llm.ts 新增裁决类型**

在 `src/brain/llm.ts` 中：顶部加 `import type { ActionResult } from "../types/index.js";`，并在 `BrainInferenceResult` 之后新增：

```ts
/** 反思裁决：逐条调用给出 放行 或 拦截+错误反馈（大脑反思层的输出契约）。 */
export interface BlockedCall {
  call: ToolCall;
  result: ActionResult<unknown>;
}

export interface ReflectionVerdict {
  allowed: ToolCall[];
  blocked: BlockedCall[];
}
```

- [ ] **Step 4: 实现 reflection.ts**

创建 `src/brain/reflection.ts`：

````ts
// 反思层（潜意识）：决策后再想"可行吗"。确定性代码，不经过模型，
// 所有大脑共享同一套实现：存在性 → 结构 → 危险嗅探，逐条裁决。
import { schemas } from "./knowledge.js";
import type { ReflectionVerdict, ToolCall } from "./llm.js";
import { fail, type MouthContract, type NoseContract } from "../types/index.js";

export class Reflection {
  readonly #nose: NoseContract;
  readonly #mouth: MouthContract;

  constructor(nose: NoseContract, mouth: MouthContract) {
    this.#nose = nose;
    this.#mouth = mouth;
  }

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    const allowed: ToolCall[] = [];
    const blocked: ReflectionVerdict["blocked"] = [];
    for (const call of calls) {
      const schema = schemas[call.name as keyof typeof schemas];
      if (schema === undefined) {
        blocked.push({ call, result: fail("UNKNOWN_TOOL", `未知工具: ${call.name}`) });
        continue;
      }
      const parsed = schema.safeParse(call.arguments);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        blocked.push({
          call,
          result: fail("INVALID_ARGS", `工具 ${call.name} 参数不合法: ${issues}`),
        });
        continue;
      }
      if (call.name === "terminal") {
        const { command } = parsed.data as { command: string };
        if (this.#nose.checkRisk(command) === "DANGEROUS") {
          const approved = await this.#mouth.confirm(`命令存在风险，是否执行？\n  ${command}`);
          if (!approved) {
            blocked.push({ call, result: fail("USER_DENIED", `用户拒绝了命令: ${command}`) });
            continue;
          }
        }
      }
      allowed.push(call);
    }
    return { allowed, blocked };
  }
}
````

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run tests/reflection.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 6: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（llm.ts 只加类型导出，不破坏现有实现者）。

- [ ] **Step 7: Commit**

```bash
git add src/brain/reflection.ts src/brain/llm.ts tests/reflection.test.ts
git commit -m "feat: 大脑反思层——存在性/结构/危险嗅探的可行性裁决"
```

---

### Task 3: OllamaBrain 改名 OllamaThinking + reflect 接口接入

将 `BrainInference` 接口扩展 `reflect()`，并把 `src/brain/ollama-brain.ts` 迁为 `src/brain/thinking/ollama-thinking.ts`（类名 `OllamaThinking`，构造必填 `nose`/`mouth`，reflect 委托共享 Reflection）。同步所有实现者（ScriptedBrain、loop.test.ts 的两个测试脑）与 agent.ts 组装（大脑最后构建，注入鼻子/嘴巴）。

**Files:**
- Rename: `src/brain/ollama-brain.ts` → `src/brain/thinking/ollama-thinking.ts`（git mv 保留历史）
- Rename: `tests/ollama-brain.test.ts` → `tests/ollama-thinking.test.ts`
- Modify: `src/brain/llm.ts`（接口加 `reflect`）
- Modify: `tests/helpers.ts`（ScriptedBrain 可配置 reflect；新增 buildStubNose/buildStubMouth）
- Modify: `tests/loop.test.ts`（AbortableBrain / TimeoutThenAnswerBrain 加 reflect）
- Modify: `src/agent.ts`（构造顺序调整：brain 最后构建，注入 nose/mouth）
- Test: `tests/ollama-thinking.test.ts`（改名 + stub 注入 + 新增 reflect 委托用例）

**Interfaces:**
- Consumes: `Reflection` + `ReflectionVerdict`（Task 2）、`ToolCall`（llm.ts）。
- Produces: `OllamaThinking` 类（`{ baseUrl?, model?, fetchImpl?, nose: NoseContract, mouth: MouthContract }`）、`BrainInference.reflect(calls): Promise<ReflectionVerdict>`（所有实现者必须提供）、`buildStubNose(risk?: RiskLevel)` / `buildStubMouth(approve?: boolean)`（helpers，供 Task 4 使用）。

- [ ] **Step 1: 改名并写失败测试**

```bash
git mv src/brain/ollama-brain.ts src/brain/thinking/ollama-thinking.ts
git mv tests/ollama-brain.test.ts tests/ollama-thinking.test.ts
```

编辑 `tests/ollama-thinking.test.ts`：
1. 顶部 import 改为：
   ```ts
   import { describe, expect, it, vi } from "vitest";
   import { OllamaThinking } from "../src/brain/thinking/ollama-thinking.js";
   import { ConversationContext } from "../src/brain/context.js";
   import type { Message, ToolInfo } from "../src/brain/llm.js";
   import { buildStubMouth, buildStubNose } from "./helpers.js";
   ```
2. `makeBrain` 改为：
   ```ts
   function makeBrain(fetchImpl: typeof fetch) {
     return new OllamaThinking({ fetchImpl, nose: buildStubNose(), mouth: buildStubMouth() });
   }
   ```
3. 末尾"可自定义 baseUrl 与 model"用例的构造改为：
   ```ts
   const brain = new OllamaThinking({
     baseUrl: "http://10.0.0.2:8080",
     model: "qwen3:8b",
     fetchImpl,
     nose: buildStubNose(),
     mouth: buildStubMouth(),
   });
   ```
4. 文件末尾追加 reflect 委托用例：
   ```ts
   it("reflect 委托共享反思层：危险命令被拒时拦截为 USER_DENIED", async () => {
     const brain = new OllamaThinking({
       fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "ok" } })),
       nose: buildStubNose("DANGEROUS"),
       mouth: buildStubMouth(false),
     });
     const verdict = await brain.reflect([{ name: "terminal", arguments: { command: "rm -rf /" } }]);
     expect(verdict.blocked[0]?.result.error?.code).toBe("USER_DENIED");
   });
   ```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/ollama-thinking.test.ts`
Expected: FAIL（类名 `OllamaThinking` 不存在 / 模块未导出）。

- [ ] **Step 3: llm.ts 接口加 reflect**

`src/brain/llm.ts` 的 `BrainInference` 改为：

```ts
/** 大脑统一推理接口：输入上下文与可用工具，返回思考文本或工具调用意图（设计文档 §3.1）。 */
export interface BrainInference {
  infer(
    context: ConversationContext,
    tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult>;
  /** 反思：对候选工具调用做可行性裁决（存在性/结构/危险嗅探），放行或拦截+错误反馈。 */
  reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict>;
}
```

- [ ] **Step 4: 实现 ollama-thinking.ts**

编辑 `src/brain/thinking/ollama-thinking.ts`（git mv 后的文件）：
1. import 改为：
   ```ts
   import type { ConversationContext, Message } from "../context.js";
   import type {
     BrainInference,
     BrainInferenceResult,
     ReflectionVerdict,
     ToolCall,
     ToolInfo,
   } from "../llm.js";
   import { Reflection } from "../reflection.js";
   import type { MouthContract, NoseContract } from "../../types/index.js";
   ```
2. `OllamaBrainOptions` 改名为 `OllamaThinkingOptions` 并加两个必填字段：
   ```ts
   export interface OllamaThinkingOptions {
     baseUrl?: string;
     model?: string;
     fetchImpl?: typeof fetch;
     nose: NoseContract;
     mouth: MouthContract;
   }
   ```
3. 类名 `OllamaBrain` → `OllamaThinking`；新增 `readonly #reflection: Reflection;` 字段；构造签名改为 `constructor(options: OllamaThinkingOptions)`，并在末尾加：
   ```ts
   this.#reflection = new Reflection(options.nose, options.mouth);
   ```
4. 类内新增：
   ```ts
   async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
     return this.#reflection.reflect(calls);
   }
   ```
5. 类文档注释更新为："思考层的 Ollama 实现：走本机 /api/chat 协议，支持工具调用，反思委托共享 Reflection（设计文档 §4.2）。"
6. 文件底部 `toOllamaMessage` / `toOllamaTool` / `toToolCall` 保持不变。

- [ ] **Step 5: helpers.ts 更新**

`tests/helpers.ts`：
1. import 中 `BrainInference, BrainInferenceResult, ToolInfo` 改为 `BrainInference, BrainInferenceResult, ReflectionVerdict, ToolCall, ToolInfo`；`EarsContract, EyesContract, HandsContract` 改为 `EarsContract, EyesContract, HandsContract, MouthContract, NoseContract, RiskLevel`。
2. 文件末尾追加：
   ```ts
   /** 反思测试替身：可指定风险等级与确认结果。 */
   export function buildStubNose(risk: RiskLevel = "SAFE"): NoseContract {
     return {
       checkRisk: () => risk,
       getEnvSnapshot: () => ({ os: "test", cwd: "" }),
       checkPorts: async () => [],
     };
   }

   export function buildStubMouth(approve = true): MouthContract {
     return { confirm: async () => approve };
   }
   ```
3. `ScriptedBrain` 构造加可配置裁决（默认全放行，保持现有用例行为）：
   ```ts
   constructor(
     private readonly steps: ScriptedBrainStep[],
     private readonly reflectVerdict?: ReflectionVerdict,
   ) {}
   ```
   并在类内新增：
   ```ts
   async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
     return this.reflectVerdict ?? { allowed: [...calls], blocked: [] };
   }
   ```

- [ ] **Step 6: loop.test.ts 的测试脑补 reflect**

`tests/loop.test.ts` 中 `AbortableBrain` 与 `TimeoutThenAnswerBrain` 两个类（`implements BrainInference`）各加：
```ts
async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
  return { allowed: [...calls], blocked: [] };
}
```
并在 import 中给 `BrainInference` 加 `ReflectionVerdict`、`ToolCall` 类型：
```ts
import type { BrainInference, BrainInferenceResult, ReflectionVerdict, ToolCall, ToolInfo } from "../src/brain/llm.js";
```

- [ ] **Step 7: agent.ts 组装调整**

`src/agent.ts`：
1. `import { OllamaBrain } from "./brain/ollama-brain.js";` 改为：
   ```ts
   import { OllamaThinking } from "./brain/thinking/ollama-thinking.js";
   ```
2. `buildDefaultBrain` 改为：
   ```ts
   function buildDefaultBrain(nose: NoseContract, mouth: MouthContract): BrainInference {
     return new OllamaThinking({
       nose,
       mouth,
       ...(process.env.OLLAMA_BASE_URL !== undefined ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
       ...(process.env.OLLAMA_MODEL !== undefined ? { model: process.env.OLLAMA_MODEL } : {}),
     });
   }
   ```
3. `constructor` 字段初始化顺序调整（brain 依赖鼻子/嘴巴，最后构建）——把 `this.brain = options.brain ?? buildDefaultBrain();` 一行移到所有其他字段之后，改为：
   ```ts
   this.brain = options.brain ?? buildDefaultBrain(this.nose, this.mouth);
   ```

- [ ] **Step 8: 跑全量测试确认通过**

Run: `pnpm test`
Expected: PASS（ollama-thinking 全部用例 + 其余全部）。若 TS 报缺 `reflect` 的实现者，按 Step 5/6 补齐。

- [ ] **Step 9: Commit**

```bash
git add -A src/brain/llm.ts src/brain/thinking/ollama-thinking.ts src/agent.ts tests/helpers.ts tests/loop.test.ts tests/ollama-thinking.test.ts
git commit -m "refactor: OllamaBrain 更名 OllamaThinking，BrainInference 增加反思接口"
```

---

### Task 4: GeminiBridgeThinking（网页 Gemini 桥思考层）

**Files:**
- Create: `src/brain/thinking/gemini-bridge-thinking.ts`
- Test: `tests/gemini-bridge-thinking.test.ts`

**Interfaces:**
- Consumes: `serializeToolProtocol`（Task 1）、`Reflection` + `ReflectionVerdict`（Task 2）、`ConversationContext`/`Message`（context.ts）、`ToolCall`/`BrainInferenceResult`/`BrainInference`（llm.ts）、`buildStubNose`/`buildStubMouth`（helpers，Task 3）、`MouthContract`/`NoseContract`。
- Produces: `GeminiBridgeThinking` 类（`{ port?, host?, nose, mouth }`、`getPort(): Promise<number>`、`close()`）、`parseToolCalls(text): BrainInferenceResult` 纯函数（导出）。Task 6 的 agent 组装与 cli 依赖。

- [ ] **Step 1: 写失败测试**

创建 `tests/gemini-bridge-thinking.test.ts`：

````ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiBridgeThinking,
  parseToolCalls,
} from "../src/brain/thinking/gemini-bridge-thinking.js";
import { ConversationContext } from "../src/brain/context.js";
import { TOOLS } from "../src/brain/knowledge.js";
import type { Message } from "../src/brain/llm.js";
import { buildStubMouth, buildStubNose } from "./helpers.js";

function contextOf(...messages: Message[]): ConversationContext {
  const context = new ConversationContext({ maxTokens: 8000 });
  for (const message of messages) context.add(message);
  return context;
}

const openBridges: GeminiBridgeThinking[] = [];

afterEach(() => {
  for (const bridge of openBridges.splice(0)) bridge.close();
});

async function makeBridge() {
  const bridge = new GeminiBridgeThinking({ port: 0, nose: buildStubNose(), mouth: buildStubMouth() });
  openBridges.push(bridge);
  const port = await bridge.getPort();
  return { bridge, port };
}

async function postResult(port: number, id: string, reply: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, reply }),
  });
}

describe("parseToolCalls", () => {
  it("纯文本不产生 toolCalls", () => {
    const result = parseToolCalls("你好，我是 human-agent");
    expect(result.text).toBe("你好，我是 human-agent");
    expect(result.toolCalls).toBeUndefined();
  });

  it("解析 tool_call 代码块，说明文字保留为 text", () => {
    const reply = ["让我先看看文件。", "```tool_call", '{"name": "read_file", "arguments": {"path": "a.txt"}}', "```"].join("\n");
    const result = parseToolCalls(reply);
    expect(result.text).toBe("让我先看看文件。");
    expect(result.toolCalls).toEqual([{ name: "read_file", arguments: { path: "a.txt" } }]);
  });

  it("坏 JSON 块丢弃且原文拼回 text", () => {
    const reply = ["```tool_call", '{"name": "read_file", "arguments": {"path": }}', "```", "后面还有说明"].join("\n");
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toBeUndefined();
    expect(result.text).toBe("后面还有说明");
  });

  it("多个块逐一解析，坏块不影响好块", () => {
    const reply = [
      "```tool_call",
      '{"name": "read_file", "arguments": {"path": "a.txt"}}',
      "```",
      "```tool_call",
      "not json",
      "```",
      "```tool_call",
      '{"name": "terminal", "arguments": {"command": "echo hi"}}',
      "```",
    ].join("\n");
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![1]).toEqual({ name: "terminal", arguments: { command: "echo hi" } });
  });
});

describe("GeminiBridgeThinking", () => {
  it("发布任务 → 插件长轮询取走 → 回传回复 → infer 返回解析结果", async () => {
    const { bridge, port } = await makeBridge();
    const inferPromise = bridge.infer(contextOf({ role: "user", content: "读取 a.txt" }), TOOLS);
    const response = await fetch(`http://127.0.0.1:${port}/task`);
    const task = (await response.json()) as { id: string; message: string };
    expect(task.message).toContain("【human-agent 工具协议】");
    expect(task.message).toContain("读取 a.txt");
    const reply = ["```tool_call", '{"name": "read_file", "arguments": {"path": "a.txt"}}', "```"].join("\n");
    await postResult(port, task.id, reply);
    const result = await inferPromise;
    expect(result.toolCalls).toEqual([{ name: "read_file", arguments: { path: "a.txt" } }]);
  });

  it("每轮只发送增量消息：第二轮不含首轮内容，包含工具结果映射", async () => {
    const { bridge, port } = await makeBridge();
    const context = contextOf({ role: "user", content: "第一轮指令" });
    const first = bridge.infer(context, TOOLS);
    const task1 = (await (await fetch(`http://127.0.0.1:${port}/task`)).json()) as { id: string };
    await postResult(port, task1.id, "好的");
    const firstResult = await first;
    expect(firstResult.text).toBe("好的");

    context.add({
      role: "assistant",
      content: "",
      toolCalls: [{ name: "terminal", arguments: { command: "echo x" } }],
    });
    context.add({ role: "tool", name: "terminal", content: '{"success":true}' });
    const second = bridge.infer(context, TOOLS);
    const task2 = (await (await fetch(`http://127.0.0.1:${port}/task`)).json()) as {
      id: string;
      message: string;
    };
    expect(task2.message).not.toContain("第一轮指令");
    expect(task2.message).toContain("工具 terminal 返回");
    await postResult(port, task2.id, "完成");
    await second;
  });

  it("signal 中断取消等待中的 infer", async () => {
    const { bridge } = await makeBridge();
    const controller = new AbortController();
    const inferPromise = bridge.infer(
      contextOf({ role: "user", content: "hi" }),
      TOOLS,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    await expect(inferPromise).rejects.toThrow("aborted");
  });

  it("reflect 委托共享反思层：危险命令被拒时拦截", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const bridge = new GeminiBridgeThinking({ port: 0, nose: buildStubNose("DANGEROUS"), mouth: { confirm } });
    openBridges.push(bridge);
    await bridge.getPort();
    const verdict = await bridge.reflect([{ name: "terminal", arguments: { command: "rm -rf /" } }]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("USER_DENIED");
  });
});
````

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/gemini-bridge-thinking.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 gemini-bridge-thinking.ts**

创建 `src/brain/thinking/gemini-bridge-thinking.ts`：

````ts
// 思考层的网页 Gemini 桥实现：内嵌 HTTP 服务与浏览器扩展通信。
// infer 组装协议消息 → 任务队列 → 插件在 AI Studio 页面发送并回传回复 → 解析工具调用。
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ConversationContext, Message } from "../context.js";
import { serializeToolProtocol } from "../knowledge.js";
import type {
  BrainInference,
  BrainInferenceResult,
  ReflectionVerdict,
  ToolCall,
  ToolInfo,
} from "../llm.js";
import { Reflection } from "../reflection.js";
import type { MouthContract, NoseContract } from "../../types/index.js";

export interface GeminiBridgeThinkingOptions {
  port?: number;
  host?: string;
  nose: NoseContract;
  mouth: MouthContract;
}

interface PendingTask {
  id: string;
  message: string;
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 容错解析 ```tool_call``` JSON 代码块：坏 JSON 块丢弃、其余原文拼回 text。 */
export function parseToolCalls(text: string): BrainInferenceResult {
  const pattern = /```tool_call\s*\n([\s\S]*?)(?:\n)?```/g;
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      if (isToolCall(parsed)) calls.push(parsed);
    } catch {
      // 坏 JSON 块丢弃
    }
  }
  const stripped = text.replace(pattern, "").trim();
  return { text: stripped, ...(calls.length > 0 ? { toolCalls: calls } : {}) };
}

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.arguments === "object" &&
    candidate.arguments !== null
  );
}

export class GeminiBridgeThinking implements BrainInference {
  readonly #server: http.Server;
  readonly #portPromise: Promise<number>;
  readonly #reflection: Reflection;
  readonly #pending = new Map<string, PendingTask>();
  readonly #waiters: Array<(task: PendingTask | null) => void> = [];
  #sentCount = 0;

  constructor(options: GeminiBridgeThinkingOptions) {
    this.#reflection = new Reflection(options.nose, options.mouth);
    this.#portPromise = new Promise<number>((resolve, reject) => {
      this.#server = http.createServer((req, res) => this.#handleRequest(req, res));
      this.#server.on("error", reject);
      this.#server.listen(options.port ?? 8765, options.host ?? "127.0.0.1", () => {
        const address = this.#server.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  async getPort(): Promise<number> {
    return this.#portPromise;
  }

  /** 关闭 HTTP 服务并释放所有等待中的任务与长轮询。 */
  close(): void {
    for (const waiter of this.#waiters) waiter(null);
    this.#waiters.length = 0;
    for (const task of this.#pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Gemini 桥服务已关闭"));
    }
    this.#pending.clear();
    this.#server.close();
    this.#server.closeAllConnections();
  }

  async infer(
    context: ConversationContext,
    _tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult> {
    const increment = this.#collectIncrement(context);
    const message =
      increment === "" ? serializeToolProtocol() : `${serializeToolProtocol()}\n\n${increment}`;
    const reply = await this.#publish(message, signal);
    return parseToolCalls(reply);
  }

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    return this.#reflection.reflect(calls);
  }

  /** 页面会话保留历史，每轮只发上次发送之后的新消息（新指令 / 工具结果）。 */
  #collectIncrement(context: ConversationContext): string {
    const all = context.getAll();
    const start = Math.min(this.#sentCount, all.length);
    this.#sentCount = all.length;
    return all
      .slice(start)
      .map(toIncrementText)
      .filter((part) => part !== "")
      .join("\n\n");
  }

  #publish(message: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const task: PendingTask = { id, message, resolve, reject, timer: undefined! };
      this.#armTimeout(task);
      this.#pending.set(task.id, task);
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(task);
      if (signal !== undefined) {
        signal.addEventListener(
          "abort",
          () => {
            this.#pending.delete(id);
            clearTimeout(task.timer);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }
    });
  }

  #armTimeout(task: PendingTask): void {
    task.timer = setTimeout(() => {
      this.#pending.delete(task.id);
      task.reject(new Error("等待插件回传超时"));
    }, 60_000);
  }

  #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/task") {
      this.#handleTaskRequest(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/result") {
      this.#handleResultRequest(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  /** 长轮询：有待发任务立即返回；无任务挂起约 25s 后 204。 */
  #handleTaskRequest(res: http.ServerResponse): void {
    const next = this.#pending.values().next();
    if (!next.done) {
      this.#serveTask(next.value, res);
      return;
    }
    const waiter = (task: PendingTask | null): void => {
      clearTimeout(timer);
      if (task === null) {
        res.writeHead(204).end();
        return;
      }
      this.#serveTask(task, res);
    };
    const timer = setTimeout(() => {
      const index = this.#waiters.indexOf(waiter);
      if (index !== -1) this.#waiters.splice(index, 1);
      res.writeHead(204).end();
    }, 25_000);
    this.#waiters.push(waiter);
  }

  /** 任务交给插件后仍保留在 #pending（结果按 id 匹配回传），只重置回传超时。 */
  #serveTask(task: PendingTask, res: http.ServerResponse): void {
    clearTimeout(task.timer);
    this.#armTimeout(task);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: task.id, message: task.message }));
  }

  #handleResultRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readJsonBody(req).then(
      (body) => {
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const reply = typeof record.reply === "string" ? record.reply : "";
        const task = this.#pending.get(id);
        if (task !== undefined) {
          clearTimeout(task.timer);
          this.#pending.delete(task.id);
          task.resolve(reply);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      () => {
        res.writeHead(400).end();
      },
    );
  }
}

function toIncrementText(message: Message): string {
  switch (message.role) {
    case "system":
      return "";
    case "user":
      return message.content;
    case "assistant":
      return message.content;
    case "tool":
      return `工具 ${message.name} 返回：${message.content}`;
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/gemini-bridge-thinking.test.ts`
Expected: PASS（8 个用例）。若超时/挂起，检查 `close()` 是否释放了长轮询 waiter（`close()` 中 `waiter(null)` 会结束挂起的 GET）。

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/brain/thinking/gemini-bridge-thinking.ts tests/gemini-bridge-thinking.test.ts
git commit -m "feat: GeminiBridgeThinking——网页 Gemini 桥 HTTP 任务协议与容错解析"
```

---

### Task 5: 心脏净化（loop.ts 移交可行性裁决）

**Files:**
- Modify: `src/heart/loop.ts`（删 TOOL_SCHEMAS/TOOLS/zod 校验/嗅探/确认；`#execute` 改为走 `brain.reflect`）
- Modify: `src/types/organ.ts`（AgentPhase 删除 `"SNIFFING"`）
- Modify: `src/agent.ts`（`run()` 中 AgentLoop 构造删除 `nose`/`mouth` 两行——净化后构造参数不再含它们，不改会编译失败）
- Modify: `tests/loop.test.ts`（makeLoop 去 nose/mouth、两个危险命令用例改造、phase 断言更新、7 处直接构造删两行）

**Interfaces:**
- Consumes: `BrainInference.reflect`（Task 3）、`ReflectionVerdict`（Task 2）。
- Produces: 净化后的 `AgentLoop`（构造参数不再含 `nose`/`mouth`；`#execute(calls, turnSignal)` 内部裁决后路由）。Task 6 的 agent.ts 组装依赖。

- [ ] **Step 1: 改测试（RED）**

`tests/loop.test.ts`：
1. 顶部 import：删除 `AskUser`、`RiskChecker`、`inputFrom`；`fail` 从 `../src/types/index.js` 导入；llm 类型导入改为 `BrainInference, BrainInferenceResult, ReflectionVerdict, ToolCall, ToolInfo`。
2. `makeLoop` 删除 `nose`/`mouth` 两行并去掉 `mouth?: AskUser` 参数，变为：

```ts
function makeLoop(options: {
  brain: BrainInference;
  ears: EarsContract;
  signal: AbortSignal;
  maxIterations?: number;
  timeoutMs?: number;
  onPhase?: (phase: AgentPhase, detail?: string) => void;
}) {
  return new AgentLoop({
    brain: options.brain,
    ears: options.ears,
    eyes: buildEyes(),
    hands: buildHands(),
    output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
    signal: options.signal,
    maxIterations: options.maxIterations,
    timeoutMs: options.timeoutMs,
    onPhase: options.onPhase,
  });
}
```

3. "危险命令经用户拒绝后不执行，结果反馈为 USER_DENIED" 用例整体替换为（反思拦截路径）：

```ts
it("被反思层拦截的调用作为失败结果反馈给大脑", async () => {
  const call = { name: "terminal", arguments: { command: "echo rm -rf /" } };
  const brain = new ScriptedBrain(
    [
      { result: { text: "", toolCalls: [call] } },
      { result: { text: "已跳过" } },
    ],
    { allowed: [], blocked: [{ call, result: fail("USER_DENIED", "用户拒绝了命令") }] },
  );
  const signal = new AbortController().signal;
  const loop = makeLoop({ brain, ears: new FakeEars(["删除它", "/exit"]), signal });
  await loop.run();
  const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
  expect(toolMessage).toBeDefined();
  const parsed = JSON.parse(toolMessage!.content) as { success: boolean; error?: { code: string } };
  expect(parsed.success).toBe(false);
  expect(parsed.error?.code).toBe("USER_DENIED");
});
```

4. 删除整个"危险命令经用户确认后正常执行"用例（确认逻辑已迁至反思层，由 reflection.test.ts 覆盖；放行路径由"工具执行结果作为 tool 消息反馈给大脑"覆盖）。
5. "按 听→想→嗅→执行→反馈→想 顺序发出阶段事件" 用例改为：

```ts
it("按 听→想→执行→反馈→想 顺序发出阶段事件", async () => {
  const phases: AgentPhase[] = [];
  const brain = new ScriptedBrain([
    {
      result: {
        text: "",
        toolCalls: [{ name: "terminal", arguments: { command: "echo phase-test" } }],
      },
    },
    { result: { text: "结束" } },
  ]);
  const signal = new AbortController().signal;
  const loop = makeLoop({
    brain,
    ears: new FakeEars(["hi", "/exit"]),
    signal,
    onPhase: (phase) => phases.push(phase),
  });
  await loop.run();
  expect(phases.slice(0, 5)).toEqual([
    "LISTENING",
    "THINKING",
    "ACTING",
    "FEEDBACK",
    "THINKING",
  ]);
});
```

6. 以下用例中直接构造 `new AgentLoop({...})` 的，各删除这两行：
   ```ts
   nose: new RiskChecker(),
   mouth: new AskUser({ input: inputFrom("y\n") }),
   ```
   涉及用例：`fetch_page 工具调用经眼睛抓取网页并反馈 Markdown`、`/timeout 命令动态更新超时时长并即时生效`、`/timeout 非法参数给出提示且会话继续`、`推理超时后终止本轮并警告，会话继续监听下一条指令`、`大脑抛错时状态为 ERROR 且输出错误信息`、`大脑持续调用工具时达到最大迭代次数停止`、`上下文在会话中持续累积`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/loop.test.ts`
Expected: FAIL（`AgentLoopOptions` 不存在的属性 `nose` / `mouth` 等编译错误）。

- [ ] **Step 3: 净化 loop.ts 与 agent.ts**

`src/heart/loop.ts` 整体替换为：

```ts
import { ConversationContext } from "../brain/context.js";
import { TOOLS } from "../brain/knowledge.js";
import type { BrainInference, BrainInferenceResult, ToolCall } from "../brain/llm.js";
import {
  fail,
  type ActionResult,
  type AgentOutput,
  type AgentPhase,
  type AgentStatus,
  type EarsContract,
  type EyesContract,
  type HandsContract,
} from "../types/index.js";

export interface AgentLoopOptions {
  brain: BrainInference;
  ears: EarsContract;
  eyes: EyesContract;
  hands: HandsContract;
  output: AgentOutput;
  signal: AbortSignal;
  context?: ConversationContext;
  maxIterations?: number;
  /** 单轮任务超时（毫秒），0 表示禁用；超时后终止本轮并继续监听。 */
  timeoutMs?: number;
  onPhase?: (phase: AgentPhase, detail?: string) => void;
}

/** 解析超时时长：纯数字按毫秒；s/m/h 后缀按秒/分/时；0 或 off 表示禁用；非法返回 null。 */
export function parseTimeout(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "0" || trimmed === "off") return 0;
  const match = /^(\d+)(h|m|s)?$/.exec(trimmed);
  if (match === null) return null;
  const value = Number(match[1]);
  const factor =
    match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  return value * factor;
}

/** 生命泵：听取指令 → 大脑思考 → 反思裁决 → 放行路由到器官执行 → 反馈 → 循环/结束。
 *  心脏只承担路由、承受力（任务/单命令超时、maxIterations、中断）与循环节拍；
 *  可行性裁决（是否可行）属于大脑反思层，本类不再持有任何判断规则。 */
export class AgentLoop {
  readonly #brain: BrainInference;
  readonly #ears: EarsContract;
  readonly #eyes: EyesContract;
  readonly #hands: HandsContract;
  readonly #output: AgentOutput;
  readonly #signal: AbortSignal;
  readonly #context: ConversationContext;
  readonly #maxIterations: number;
  #timeoutMs: number;
  readonly #onPhase: ((phase: AgentPhase, detail?: string) => void) | undefined;

  #status: AgentStatus = "IDLE";
  #turnTimedOut = false;

  constructor(options: AgentLoopOptions) {
    this.#brain = options.brain;
    this.#ears = options.ears;
    this.#eyes = options.eyes;
    this.#hands = options.hands;
    this.#output = options.output;
    this.#signal = options.signal;
    this.#context = options.context ?? new ConversationContext({ maxTokens: 8000 });
    this.#maxIterations = options.maxIterations ?? 10;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#onPhase = options.onPhase;
  }

  getStatus(): AgentStatus {
    return this.#status;
  }

  async run(): Promise<void> {
    this.#status = "RUNNING";
    try {
      for (;;) {
        this.#emit("LISTENING");
        if (this.#signal.aborted) {
          this.#status = "INTERRUPTED";
          break;
        }
        const input = await this.#listen();
        if (input === null) {
          if (this.#signal.aborted) this.#status = "INTERRUPTED";
          break;
        }
        if (input.trim() === "" || input.trim() === "/exit") break;
        if (this.#handleSlashCommand(input)) continue;
        this.#context.add({ role: "user", content: input });
        const stopped = await this.#processTurn();
        if (stopped) break;
      }
    } finally {
      if (this.#status === "RUNNING") this.#status = "IDLE";
    }
  }

  /** 处理斜杠命令；返回 true 表示已消费该输入。 */
  #handleSlashCommand(input: string): boolean {
    const match = /^\/timeout(?:\s+(.+))?$/.exec(input.trim());
    if (match === null) return false;
    const spec = match[1];
    if (spec === undefined) {
      this.#output.info(
        `当前任务超时：${this.#timeoutMs === 0 ? "无限" : `${this.#timeoutMs}ms`}（/timeout 0 禁用）`,
      );
      return true;
    }
    const ms = parseTimeout(spec);
    if (ms === null) {
      this.#output.warn(
        "无法解析超时时长，格式：/timeout 30s、/timeout 5m、/timeout 1h、/timeout 900（毫秒）或 /timeout 0 禁用",
      );
      return true;
    }
    this.#timeoutMs = ms;
    this.#output.info(`任务超时已更新为 ${ms === 0 ? "无限" : `${ms}ms`}`);
    return true;
  }

  async #listen(): Promise<string | null> {
    try {
      return await Promise.race([this.#ears.prompt("> "), this.#abortPromise()]);
    } catch {
      return null;
    }
  }

  #abortPromise(): Promise<never> {
    return new Promise((_, reject) => {
      this.#signal.addEventListener(
        "abort",
        () => reject(new Error("interrupted")),
        { once: true },
      );
    });
  }

  /** 处理一轮指令；返回 true 表示循环应终止（中断或出错），false 表示继续监听。 */
  async #processTurn(): Promise<boolean> {
    const turnController = new AbortController();
    const turnSignal =
      this.#timeoutMs > 0
        ? AbortSignal.any([this.#signal, turnController.signal])
        : this.#signal;
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => {
            this.#turnTimedOut = true;
            turnController.abort();
          }, this.#timeoutMs)
        : undefined;
    try {
      for (let iteration = 0; iteration < this.#maxIterations; iteration++) {
        if (this.#signal.aborted) {
          this.#status = "INTERRUPTED";
          return true;
        }
        if (this.#turnTimedOut) {
          this.#output.warn("任务超时，已终止本轮。");
          return false;
        }
        this.#emit("THINKING");
        let result: BrainInferenceResult;
        try {
          result = await this.#brain.infer(this.#context, TOOLS, turnSignal);
        } catch (err) {
          if (this.#signal.aborted) {
            this.#status = "INTERRUPTED";
            return true;
          }
          if (this.#turnTimedOut) {
            this.#output.warn("任务超时，已终止本轮。");
            return false;
          }
          this.#status = "ERROR";
          this.#output.error(`大脑推理失败: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        }
        const calls = result.toolCalls ?? [];
        if (calls.length === 0) {
          this.#context.add({ role: "assistant", content: result.text });
          await this.#output.speak(result.text);
          return false;
        }
        this.#context.add({ role: "assistant", content: result.text, toolCalls: calls });
        await this.#execute(calls, turnSignal);
      }
      this.#output.warn("已达到最大迭代次数，停止本轮推演。");
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#turnTimedOut = false;
    }
  }

  /** 反思裁决：放行的调用路由到器官执行，拦截的调用直接反馈错误（裁决规则在大脑，不在心脏）。 */
  async #execute(calls: readonly ToolCall[], turnSignal: AbortSignal): Promise<void> {
    const verdict = await this.#brain.reflect(calls);
    for (const call of verdict.allowed) {
      if (this.#signal.aborted) {
        this.#status = "INTERRUPTED";
        return;
      }
      if (this.#turnTimedOut) {
        this.#output.warn("任务超时，已终止本轮。");
        return;
      }
      this.#emit("ACTING", call.name);
      const result = await this.#dispatch(call.name, call.arguments, turnSignal);
      this.#finish(call.name, result);
      this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(result) });
    }
    for (const item of verdict.blocked) {
      this.#finish(item.call.name, item.result);
      this.#context.add({ role: "tool", name: item.call.name, content: JSON.stringify(item.result) });
    }
  }

  async #dispatch(
    name: string,
    args: Record<string, unknown>,
    turnSignal: AbortSignal,
  ): Promise<ActionResult<unknown>> {
    switch (name) {
      case "read_file":
        return this.#eyes.readFile(args.path as string);
      case "read_dir":
        return this.#eyes.readDir(args.path as string);
      case "search_code":
        return this.#eyes.searchCode(args.pattern as string, args.dir as string | undefined);
      case "write_file":
        return this.#hands.writeFile(args.path as string, args.content as string);
      case "apply_patch":
        return this.#hands.applyPatch(args.path as string, args.patch as string);
      case "terminal":
        return this.#hands.executeCommand(
          args.command as string,
          turnSignal,
          args.timeoutMs as number | undefined,
        );
      case "fetch_page":
        return this.#eyes.fetchPageAsMarkdown(args.url as string);
      default:
        return fail("UNKNOWN_TOOL", `未知工具: ${name}`);
    }
  }

  #finish(name: string, result: ActionResult<unknown>): ActionResult<unknown> {
    this.#emit("FEEDBACK", name);
    return result;
  }

  #emit(phase: AgentPhase, detail?: string): void {
    this.#onPhase?.(phase, detail);
  }
}
```

`src/agent.ts` 的 `run()` 中 AgentLoop 构造删除两行（净化后不再接受）：

```ts
    const loop = new AgentLoop({
      brain: this.brain,
      ears: this.ears,
      nose: this.nose,
      mouth: this.mouth,
      eyes: this.eyes,
      hands: this.hands,
      output: this.output,
      signal: this.interrupt.getSignal(),
      context: this.context,
      maxIterations: this.maxIterations,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
```

改为：

```ts
    const loop = new AgentLoop({
      brain: this.brain,
      ears: this.ears,
      eyes: this.eyes,
      hands: this.hands,
      output: this.output,
      signal: this.interrupt.getSignal(),
      context: this.context,
      maxIterations: this.maxIterations,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/loop.test.ts`
Expected: PASS。

- [ ] **Step 5: organ.ts 删除 SNIFFING**

`src/types/organ.ts` 的 `AgentPhase` 改为：

```ts
export type AgentPhase =
  | "LISTENING" // 听取指令
  | "THINKING" // 大脑思考
  | "ACTING" // 手眼执行
  | "FEEDBACK"; // 反馈结果
```

（嗅探已随可行性裁决移入大脑反思层，心脏循环不再有该阶段。）

- [ ] **Step 6: 跑全量测试确认通过**

Run: `pnpm test`
Expected: PASS（organ.ts 类型删除 SNIFFING 后 loop.test.ts 已同步，无残留引用）。

- [ ] **Step 7: Commit**

```bash
git add src/heart/loop.ts src/types/organ.ts tests/loop.test.ts
git commit -m "refactor: 心脏净化——可行性裁决移交大脑反思层，循环只留路由与承受力"
```

---

### Task 6: agent.ts 组装（GEMINI_BRIDGE_PORT 切换）+ cli.ts close

**Files:**
- Modify: `src/agent.ts`（`GEMINI_BRIDGE_PORT` 环境变量启用 GeminiBridgeThinking）
- Modify: `bin/cli.ts`（结束后关闭桥服务）
- Modify: `tests/agent.test.ts`（新增默认大脑与端口切换用例）

**Interfaces:**
- Consumes: `GeminiBridgeThinking`（Task 4）、`OllamaThinking`（Task 3）、`NoseContract`/`MouthContract`。
- Produces: 环境变量 `GEMINI_BRIDGE_PORT`（设置即启用 GeminiBridgeThinking，非法值回退 8765）；cli 退出前关闭大脑 HTTP 服务。

- [ ] **Step 1: 写失败测试**

`tests/agent.test.ts`：
1. import 增加：
   ```ts
   import { OllamaThinking } from "../src/brain/thinking/ollama-thinking.js";
   import { GeminiBridgeThinking } from "../src/brain/thinking/gemini-bridge-thinking.js";
   ```
2. "terminal 工具的 timeoutMs 经默认组装透传到命令超时" 用例删除 `mouth: new AskUser(...)` 注入（loop 不再用嘴巴；ScriptedBrain 默认全放行）。
3. 文件末尾追加两个用例：

```ts
it("默认组装的大脑为 OllamaThinking", async () => {
  const agent = new HumanAgent({ ears: new FakeEars(["/exit"]), output: new FakeOutput() });
  expect(agent.brain).toBeInstanceOf(OllamaThinking);
  await agent.run();
});

it("GEMINI_BRIDGE_PORT 环境变量启用 GeminiBridgeThinking", async () => {
  process.env.GEMINI_BRIDGE_PORT = "0";
  const agent = new HumanAgent({ ears: new FakeEars(["/exit"]), output: new FakeOutput() });
  try {
    expect(agent.brain).toBeInstanceOf(GeminiBridgeThinking);
    const status = await agent.run();
    expect(status).toBe("IDLE");
  } finally {
    if (agent.brain instanceof GeminiBridgeThinking) agent.brain.close();
    delete process.env.GEMINI_BRIDGE_PORT;
  }
});
```

4. `AskUser` / `inputFrom` 的 import 若不再使用则删除（检查：仅 timeoutMs 用例曾用）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/agent.test.ts`
Expected: FAIL（第二个新用例：`agent.brain` 不是 `GeminiBridgeThinking` 实例）。

- [ ] **Step 3: agent.ts 加端口切换**

`src/agent.ts`：
1. import 增加：
   ```ts
   import { GeminiBridgeThinking } from "./brain/thinking/gemini-bridge-thinking.js";
   ```
2. `buildDefaultBrain` 改为：

```ts
function buildDefaultBrain(nose: NoseContract, mouth: MouthContract): BrainInference {
  const bridgePort = process.env.GEMINI_BRIDGE_PORT;
  if (bridgePort !== undefined) {
    const port = Number(bridgePort);
    return new GeminiBridgeThinking({
      port: Number.isInteger(port) && port > 0 ? port : 8765,
      nose,
      mouth,
    });
  }
  return new OllamaThinking({
    nose,
    mouth,
    ...(process.env.OLLAMA_BASE_URL !== undefined ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
    ...(process.env.OLLAMA_MODEL !== undefined ? { model: process.env.OLLAMA_MODEL } : {}),
  });
}
```

3. 类文档注释中补充大脑说明（可选项，不改也可）。

- [ ] **Step 4: cli.ts 关闭桥服务**

`bin/cli.ts` 改为：

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { HumanAgent } from "../src/agent.js";
import { GeminiBridgeThinking } from "../src/brain/thinking/gemini-bridge-thinking.js";
import { TextInput } from "../src/ears/text-input.js";

const program = new Command();

program
  .name("human-agent")
  .description("A humanoid modular AI Agent CLI tool")
  .version("0.1.0");

program.parse(process.argv);

const agent = new HumanAgent();
process.on("SIGINT", () => agent.interrupt.abort());
process.on("SIGTERM", () => agent.interrupt.abort());
const status = await agent.run();
if (agent.ears instanceof TextInput) agent.ears.close();
if (agent.brain instanceof GeminiBridgeThinking) agent.brain.close();
process.exitCode = status === "ERROR" ? 1 : status === "INTERRUPTED" ? 130 : 0;
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run tests/agent.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 6: 跑全量测试确认通过**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts bin/cli.ts tests/agent.test.ts
git commit -m "feat: GEMINI_BRIDGE_PORT 环境变量切换 Gemini 桥大脑，退出时关闭桥服务"
```

---

### Task 7: gemini-bridge 浏览器扩展（手动验证）

**Files:**
- Create: `extensions/gemini-bridge/manifest.json`
- Create: `extensions/gemini-bridge/background.js`
- Create: `extensions/gemini-bridge/content.js`
- Create: `extensions/gemini-bridge/README.md`

**Interfaces:**
- Consumes: brain 侧 HTTP 协议 `GET /task`（长轮询，约 25s 后 204）、`POST /result {id, reply}`（Task 4）。
- Produces: 浏览器桥（无自动化测试，按 Task 9 手动 E2E 验证）。端口固定 `127.0.0.1:8765`，与 `manifest.json` 的 host_permissions 一致。

- [ ] **Step 1: manifest.json**

创建 `extensions/gemini-bridge/manifest.json`：

```json
{
  "manifest_version": 3,
  "name": "gemini-bridge",
  "version": "0.1.0",
  "description": "human-agent 与网页版 Gemini（AI Studio）之间的桥",
  "permissions": ["storage"],
  "host_permissions": ["http://127.0.0.1:8765/*"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://aistudio.google.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: background.js**

创建 `extensions/gemini-bridge/background.js`：

```js
// HTTP 桥：长轮询取任务、回传结果。host_permissions 规避页面 CSP/CORS 限制。
const BASE = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "get-task") {
      const res = await fetch(`${BASE}/task`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 204) {
        sendResponse({ task: null });
        return;
      }
      sendResponse({ task: await res.json() });
      return;
    }
    if (message.type === "submit-result") {
      const res = await fetch(`${BASE}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: message.id, reply: message.reply }),
      });
      sendResponse({ ok: res.ok });
      return;
    }
    sendResponse({ error: "unknown message type" });
  })();
  return true; // 异步 sendResponse
});
```

- [ ] **Step 3: content.js**

创建 `extensions/gemini-bridge/content.js`：

```js
// 浮动面板 + AI Studio 页面收发。选择器随页面结构可能失效，见 README 排查节。
const POLL_INTERVAL = 5_000;
const MIN_SEND_INTERVAL = 2_000;
const REPLY_STABLE_SAMPLES = 3;

let autoSend = true;
let pendingTask = null; // 已取到、尚未回传的任务
let taskInProgress = false;
let lastReply = ""; // 最近一次回传的回复（「回填」使用）
let lastSendAt = 0;

// ---------- 面板 ----------
const panel = document.createElement("div");
panel.id = "gemini-bridge-panel";
panel.innerHTML = `
<style>
#gemini-bridge-panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 260px; padding: 10px 12px; border-radius: 10px;
  background: #1f1f1f; color: #e8e8e8; font: 12px/1.6 system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.35); user-select: none;
}
#gemini-bridge-panel .gb-title { font-weight: 700; margin-bottom: 6px; }
#gemini-bridge-panel .gb-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
#gemini-bridge-panel button {
  background: #3b82f6; color: #fff; border: 0; border-radius: 6px;
  padding: 4px 10px; cursor: pointer; font-size: 12px;
}
#gemini-bridge-panel button:active { opacity: .7; }
#gemini-bridge-panel .gb-status { color: #9ca3af; }
#gemini-bridge-panel .gb-log {
  margin-top: 6px; max-height: 120px; overflow-y: auto;
  border-top: 1px solid #333; padding-top: 6px; color: #b0b0b0;
  white-space: pre-wrap; word-break: break-all;
}
</style>
<div class="gb-title">gemini-bridge</div>
<label class="gb-row">
  <input type="checkbox" id="gb-autosend" checked> 自动发送
</label>
<div class="gb-row gb-status" id="gb-status">待命中</div>
<div class="gb-row">
  <button id="gb-instruct">交给智能体</button>
  <button id="gb-refill">回填</button>
</div>
<div class="gb-log" id="gb-log"></div>
`;
document.documentElement.appendChild(panel);

const checkbox = panel.querySelector("#gb-autosend");
const statusEl = panel.querySelector("#gb-status");
const logEl = panel.querySelector("#gb-log");
const instructBtn = panel.querySelector("#gb-instruct");
const refillBtn = panel.querySelector("#gb-refill");

chrome.storage.sync.get("geminiBridgeAutoSend", ({ geminiBridgeAutoSend }) => {
  if (typeof geminiBridgeAutoSend === "boolean") {
    autoSend = geminiBridgeAutoSend;
    checkbox.checked = autoSend;
  }
});
checkbox.addEventListener("change", () => {
  autoSend = checkbox.checked;
  chrome.storage.sync.set({ geminiBridgeAutoSend: autoSend });
  setStatus(autoSend ? "自动发送" : "手动模式");
});

function setStatus(text) {
  statusEl.textContent = text;
}

function log(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.textContent = `${line}\n${logEl.textContent}`;
}

// ---------- AI Studio DOM 操作 ----------
function findInput() {
  return (
    document.querySelector('rich-textarea div[contenteditable="true"]') ??
    document.querySelector('[contenteditable="true"]')
  );
}

function findSendButton() {
  return (
    document.querySelector('button[data-test-id="send-button"]') ??
    document.querySelector('button[aria-label*="发送"]') ??
    document.querySelector('button[aria-label*="Send"]')
  );
}

function findStopButton() {
  return (
    document.querySelector('[data-test-id="stop-generation-button"]') ??
    document.querySelector('button[aria-label*="停止"]') ??
    document.querySelector('button[aria-label*="Stop"]')
  );
}

function findLastReply() {
  const marks = document.querySelectorAll(".markdown");
  return marks.length > 0 ? marks[marks.length - 1].innerText : "";
}

function setInput(text) {
  const el = findInput();
  if (!el) return false;
  el.textContent = text;
  el.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
  );
  return true;
}

function clickSend() {
  const btn = findSendButton();
  if (!btn) return false;
  btn.click();
  return true;
}

async function waitReplyReady(timeoutMs = 120_000) {
  const start = Date.now();
  let stable = 0;
  let lastText = "";
  while (Date.now() - start < timeoutMs) {
    const stop = findStopButton();
    const text = findLastReply();
    if (!stop && text !== "" && text === lastText) {
      stable += 1;
      if (stable >= REPLY_STABLE_SAMPLES) return text;
    } else {
      stable = 0;
      lastText = text;
    }
    await sleep(500);
  }
  return findLastReply();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 任务处理 ----------
async function poll() {
  if (taskInProgress) return;
  taskInProgress = true;
  try {
    if (pendingTask === null) {
      const resp = await chrome.runtime.sendMessage({ type: "get-task" });
      if (!resp?.task) return;
      pendingTask = resp.task;
      log(`任务到达：${pendingTask.message.slice(0, 100)}${pendingTask.message.length > 100 ? "…" : ""}`);
    }
    const task = pendingTask;
    const inputOk = setInput(task.message);
    if (!inputOk) {
      log("未找到输入框，稍后重试");
      return;
    }
    if (!autoSend) {
      setStatus("待发送（手动）");
      log("自动发送已关闭，可编辑输入框后点「交给智能体」");
      return;
    }
    const wait = MIN_SEND_INTERVAL - (Date.now() - lastSendAt);
    if (wait > 0) await sleep(wait);
    if (!clickSend()) {
      log("未找到发送按钮，稍后重试");
      return;
    }
    lastSendAt = Date.now();
    setStatus("等待 Gemini 回复…");
    const reply = await waitReplyReady();
    await submit(task, reply);
  } finally {
    taskInProgress = false;
  }
}

async function submit(task, reply) {
  await chrome.runtime.sendMessage({ type: "submit-result", id: task.id, reply });
  lastReply = reply;
  pendingTask = null;
  setStatus("已回传");
  log("已回传回复给 brain");
}

instructBtn.addEventListener("click", async () => {
  if (pendingTask === null) {
    log("当前没有待发送的任务");
    return;
  }
  const el = findInput();
  const draft = el ? el.innerText.trim() : "";
  if (draft === "") {
    log("输入框为空");
    return;
  }
  await submit(pendingTask, draft);
});

refillBtn.addEventListener("click", () => {
  const source = lastReply !== "" ? lastReply : pendingTask?.message;
  if (!source) {
    log("暂无可回填的内容");
    return;
  }
  if (setInput(source)) log("已回填到输入框，可编辑后发送");
});

setInterval(poll, POLL_INTERVAL);
poll();
```

- [ ] **Step 4: 插件 README**

创建 `extensions/gemini-bridge/README.md`：

```markdown
# gemini-bridge 浏览器扩展

human-agent 与网页版 Gemini（AI Studio）之间的桥：brain 发布任务消息，插件在 AI Studio 页面
自动发送、抓取 Gemini 回复回传。

## 前置条件

- Chrome / Edge（Chromium 内核）
- 已登录 https://aistudio.google.com（保持页面打开）
- human-agent 已启用 Gemini 桥大脑：`GEMINI_BRIDGE_PORT=8765 pnpm dev`（默认端口 8765）

## 安装

1. 浏览器打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录（`extensions/gemini-bridge`）

## 使用

- **自动发送**：开关开启时，brain 的任务消息自动填入输入框并发送，回复稳定后自动回传。
- **手动模式**（关闭自动发送）：任务消息填入输入框但不发送，可编辑后点「交给智能体」提交。
- **交给智能体**：把输入框当前内容作为当前任务的回复提交给 brain（等同用户人工干预回复）。
- **回填**：把最近一次任务消息/回复粘贴到输入框，可编辑后再发送。
- 相邻两次自动发送间隔 ≥ 2s，降低风控风险。

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
```

- [ ] **Step 5: 手动验证加载**

在浏览器加载扩展，打开 AI Studio 页面，确认浮动面板出现、开关可用。此步无自动化测试，完整链路在 Task 9 联调。

- [ ] **Step 6: Commit**

```bash
git add extensions/gemini-bridge/
git commit -m "feat: gemini-bridge 浏览器扩展——AI Studio 页面收发与人工干预面板"
```

---

### Task 8: 文档更新（CLAUDE.md / README.md）

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: CLAUDE.md**

1. 在"阶段四（大脑/心脏 + 全链路）已完成（TDD，104 tests）"段落之后、"**尚未开始**"之前，插入阶段五段落：

````markdown
阶段五（Gemini 桥 + 大脑职责模型重构）已完成（TDD）：
- `src/brain/knowledge.ts`：大脑知识库——7 个工具的 zod schema 与 description 唯一来源；`TOOLS`（parameters 由 `z.toJSONSchema()` 派生，消除 TOOL_SCHEMAS 与 TOOLS.parameters 双写）、`schemas`、`serializeToolProtocol()`（思考层每轮完整注入的工具协议文本）
- `src/brain/reflection.ts`：反思层（潜意识）——确定性代码不经模型，逐条裁决：存在性（UNKNOWN_TOOL）→ zod 结构（INVALID_ARGS）→ terminal 危险嗅探（调鼻子，DANGEROUS 经嘴巴 confirm，拒绝为 USER_DENIED）
- `src/brain/thinking/`：思考层实现——`ollama-thinking.ts`（OllamaThinking，原 ollama-brain.ts 改名，逻辑不变）、`gemini-bridge-thinking.ts`（GeminiBridgeThinking：内嵌 HTTP 服务默认 127.0.0.1:8765，`GET /task` 长轮询（约 25s 后 204）+ `POST /result` 回传，任务按 id 匹配，`parseToolCalls` 容错解析 ```tool_call``` 代码块，`close()` 关服务）
- `src/brain/llm.ts`：`BrainInference` 增加 `reflect(calls)`（可行性裁决）；`ReflectionVerdict`/`BlockedCall` 契约
- `src/heart/loop.ts`：净化——TOOL_SCHEMAS/TOOLS/zod 校验/危险嗅探/嘴巴确认迁出；`#execute` = `brain.reflect(calls)` 裁决 → 放行 dispatch / 拦截结果直接反馈；loop 不再依赖 nose/mouth；`AgentPhase` 去掉 SNIFFING（嗅探属大脑反思，不再有心脏阶段）
- `src/agent.ts`：组装"带反思的大脑"（thinking 构造注入 nose/mouth 构建共享 Reflection）；`GEMINI_BRIDGE_PORT` 环境变量设置即启用 GeminiBridgeThinking（默认 OllamaThinking，非法值回退 8765）
- `bin/cli.ts`：结束后 `agent.brain.close()`（若为 GeminiBridgeThinking，与 ears.close() 同模式）
- `extensions/gemini-bridge/`：Chrome/Edge MV3 扩展——background 长轮询桥 + content 浮动面板（自动发送开关、「交给智能体」、「回填」按钮），AI Studio 页面收发，手动 E2E 验证
````

2. 架构核心的 🧠 行替换为：

````markdown
- 🧠 `src/brain/`（大脑）：知识与思考。`knowledge.ts` 知识库（工具如何使用的知识，未来 RAG 在此聚合）、`thinking/` 思考层（模型推理实现：OllamaThinking / GeminiBridgeThinking）、`reflection.ts` 反思层（可行性裁决，确定性代码）、`context.ts` 会话消息队列；`llm.ts` 统一推理接口
````

3. 🫀 行替换为：

````markdown
- 🫀 `src/heart/`（心脏）：生命循环。`loop.ts` 推进 `听取指令 → 大脑思考 → 反思裁决 → 手眼执行 → 反馈结果 → 循环/结束`，并承担承受力（任务/单命令超时、maxIterations、中断）；`interrupt.ts` 持有全局 `AbortController`
````

4. 开发路线追加：

````markdown
5. Gemini 桥与职责模型重构（knowledge/thinking/reflection、浏览器扩展桥）✅
````

- [ ] **Step 2: README.md**

1. "功能"列表更新两行：

````markdown
- **器官化架构**：大脑（知识库 + 思考 + 反思）→ 心脏（路由 + 承受力）→ 鼻子（风险嗅探）→ 手眼（执行）→ 反馈，循环往复
- **双大脑**：默认本地 Ollama（qwen3）；`GEMINI_BRIDGE_PORT=8765` 切换网页版 Gemini（AI Studio + gemini-bridge 浏览器扩展）
````

2. "配置"表格增加一行：

````markdown
| `GEMINI_BRIDGE_PORT` | 未设置（用 Ollama） | 设置即启用 Gemini 桥大脑，端口默认 8765，非法值回退 8765 |
````

3. "架构"树中 `brain/` 与 `heart/` 两行替换为：

````markdown
├── brain/    # 🧠 大脑：knowledge 知识库、thinking/ 思考层、reflection 反思层、会话上下文
├── heart/    # 🫀 心脏：AgentLoop 生命循环（路由 + 承受力）、AbortController 中断
````

4. 新增"Gemini 桥（网页版 Gemini 大脑）"小节（放在"配置"之后、"架构"之前）：

````markdown
## Gemini 桥（网页版 Gemini 大脑）

Gemini 官方 API 国内不可直连，但网页版 AI Studio 可用。human-agent 通过浏览器扩展
`extensions/gemini-bridge/` 作为桥，在 AI Studio 页面收发消息，以网页版 Gemini 作为大脑
（网页版无原生 function calling，工具调用为 ```tool_call``` 结构化输出模拟）。

```bash
GEMINI_BRIDGE_PORT=8765 pnpm dev   # 启用 Gemini 桥大脑（默认 8765）
```

前置：按 `extensions/gemini-bridge/README.md` 加载扩展，保持 AI Studio 页面打开并登录。
插件提供自动发送开关、「交给智能体」、「回填」按钮，支持人工干预与风控降频（间隔 ≥ 2s）。
````

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: 职责模型重构与 Gemini 桥接入说明"
```

---

### Task 9: 真实联调（手动 E2E，非 TDD）

**Files:** 无代码改动；按清单人工验证。

- [ ] **Step 1: 基线回归**

Run: `pnpm test` → 全绿；`pnpm build` → 编译通过。

- [ ] **Step 2: Ollama 基线**

Run: `pnpm dev`，输入"读取 package.json"，确认工具调用链路正常（qwen 场景）。

- [ ] **Step 3: 加载扩展**

浏览器加载 `extensions/gemini-bridge`，打开 https://aistudio.google.com 并登录，确认浮动面板出现。

- [ ] **Step 4: Gemini 桥全链路**

```bash
GEMINI_BRIDGE_PORT=8765 pnpm dev
```

1. CLI 输入"读取 package.json" → 观察页面自动填入协议文本并发送 → Gemini 回复 ```tool_call``` → 插件回传 → CLI 显示工具执行结果 → 继续下一轮直至 CLI 输出最终回答。
2. 若页面未自动发送：检查面板"自动发送"开关、DevTools 排查选择器（README 排查节）。

- [ ] **Step 5: 人工干预路径**

关闭"自动发送"开关 → CLI 输入新指令 → 任务消息填入输入框但不发送 → 点击「回填」/编辑输入框 → 点「交给智能体」→ 确认回复回传、CLI 继续。

- [ ] **Step 6: 风控与中断**

1. 连续多轮指令，确认发送间隔 ≥ 2s。
2. CLI 输入危险命令场景（如删除命令），确认确认交互正常（Gemini 桥下确认仍走 CLI 终端）。
3. `Ctrl+C` 中断 → 进程干净退出（exit code 130），无残留 node 进程（`GET /task` 长轮询已随服务关闭释放）。

- [ ] **Step 7: 收尾提交（如有联调中发现的小修复）**

按 TDD 规则补测试后提交。

---

## Self-Review

**Spec 覆盖检查：**
- 知识库（schema 迁移、zod 派生 parameters、协议序列化）→ Task 1
- 反思层（存在性/结构/危险嗅探，构造注入 nose/mouth）→ Task 2
- llm.ts 接口 reflect + 类型契约 → Task 2/3
- ollama-brain → thinking/ollama-thinking 改名 → Task 3
- GeminiBridgeThinking（HTTP 服务、任务队列、signal abort、parseToolCalls、close）→ Task 4
- loop 净化（删 TOOL_SCHEMAS/TOOLS/校验/嗅探/确认，reflect 裁决路径）→ Task 5
- agent.ts GEMINI_BRIDGE_PORT 切换 + cli.ts close → Task 6
- 插件（manifest/background/content/README，开关/交给智能体/回填，≥2s 间隔）→ Task 7
- CLAUDE.md / README.md → Task 8
- 测试策略（knowledge/reflection/gemini-bridge-thinking 新测；loop/helpers/agent 改造）→ Task 1/2/3/4/5/6
- 真实联调 → Task 9

**设计决策说明（spec 未完全定死的落点）：**
1. 「交给智能体」落实为"把输入框当前内容作为当前任务的回复提交（POST /result）"——在不新增协议端点、不改 loop 的前提下实现人工干预；自动发送关闭时任务消息填入输入框，编辑后提交。与 spec"作为指令发给 brain（等同 CLI 输入）"的目标一致（用户干预文本进入推理流）。
2. `AgentPhase` 删除 `SNIFFING`：嗅探已移入大脑反思层，心脏循环不再有该阶段，类型与注释同步更新。
3. `OllamaThinking` 构造 `nose`/`mouth` 必填（无默认 no-op），TS 强制组装者注入真实器官。
4. Gemini 桥任务在交予插件后仍保留在 pending map（按 id 匹配回传），回传超时 60s；`close()` 释放全部 waiter 与 pending，防止进程挂起。
