import { ConversationContext } from "../brain/context.js";
import type { BrainInference, BrainInferenceResult, ToolCall, ToolInfo } from "../brain/llm.js";
import {
  fail,
  type ActionResult,
  type AgentOutput,
  type AgentPhase,
  type AgentStatus,
  type EarsContract,
  type EyesContract,
  type HandsContract,
  type MouthContract,
  type NoseContract,
} from "../types/index.js";
import { z } from "zod";

const TOOL_SCHEMAS = {
  read_file: z.object({ path: z.string() }),
  read_dir: z.object({ path: z.string() }),
  search_code: z.object({ pattern: z.string(), dir: z.string().optional() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  apply_patch: z.object({ path: z.string(), patch: z.string() }),
  terminal: z.object({ command: z.string() }),
  fetch_page: z.object({ url: z.string() }),
} as const;

export interface AgentLoopOptions {
  brain: BrainInference;
  ears: EarsContract;
  nose: NoseContract;
  mouth: MouthContract;
  eyes: EyesContract;
  hands: HandsContract;
  output: AgentOutput;
  signal: AbortSignal;
  context?: ConversationContext;
  maxIterations?: number;
  onPhase?: (phase: AgentPhase, detail?: string) => void;
}

const TOOLS: readonly ToolInfo[] = [
  {
    name: "read_file",
    description: "读取指定文件的内容",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read_dir",
    description: "列出指定目录的条目",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "search_code",
    description: "在目录中检索匹配正则表达式的文件内容",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, dir: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description: "写入文件内容（自动创建父目录）",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "apply_patch",
    description: "对文件应用行级补丁",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, patch: { type: "string" } },
      required: ["path", "patch"],
    },
  },
  {
    name: "terminal",
    description: "执行 shell 命令",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "fetch_page",
    description: "抓取网页并转换为 Markdown",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

/** 生命泵：听取指令 → 大脑思考 → 鼻子嗅探 → 手眼执行 → 反馈结果 → 循环/结束（设计文档 §3.2）。 */
export class AgentLoop {
  readonly #brain: BrainInference;
  readonly #ears: EarsContract;
  readonly #nose: NoseContract;
  readonly #mouth: MouthContract;
  readonly #eyes: EyesContract;
  readonly #hands: HandsContract;
  readonly #output: AgentOutput;
  readonly #signal: AbortSignal;
  readonly #context: ConversationContext;
  readonly #maxIterations: number;
  readonly #onPhase: ((phase: AgentPhase, detail?: string) => void) | undefined;

  #status: AgentStatus = "IDLE";

  constructor(options: AgentLoopOptions) {
    this.#brain = options.brain;
    this.#ears = options.ears;
    this.#nose = options.nose;
    this.#mouth = options.mouth;
    this.#eyes = options.eyes;
    this.#hands = options.hands;
    this.#output = options.output;
    this.#signal = options.signal;
    this.#context = options.context ?? new ConversationContext({ maxTokens: 8000 });
    this.#maxIterations = options.maxIterations ?? 10;
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
        this.#context.add({ role: "user", content: input });
        const stopped = await this.#processTurn();
        if (stopped) break;
      }
    } finally {
      if (this.#status === "RUNNING") this.#status = "IDLE";
    }
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

  /** 处理一轮指令；返回 true 表示循环应终止（中断或出错）。 */
  async #processTurn(): Promise<boolean> {
    for (let iteration = 0; iteration < this.#maxIterations; iteration++) {
      if (this.#signal.aborted) {
        this.#status = "INTERRUPTED";
        return true;
      }
      this.#emit("THINKING");
      let result: BrainInferenceResult;
      try {
        result = await this.#brain.infer(this.#context, TOOLS);
      } catch (err) {
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
      for (const call of calls) {
        if (this.#signal.aborted) {
          this.#status = "INTERRUPTED";
          return true;
        }
        const actionResult = await this.#execute(call);
        this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(actionResult) });
      }
    }
    this.#output.warn("已达到最大迭代次数，停止本轮推演。");
    return false;
  }

  async #execute(call: ToolCall): Promise<ActionResult<unknown>> {
    this.#emit("SNIFFING", call.name);
    const schema = TOOL_SCHEMAS[call.name as keyof typeof TOOL_SCHEMAS];
    if (schema === undefined) {
      return this.#finish(call.name, fail("UNKNOWN_TOOL", `未知工具: ${call.name}`));
    }
    const parsed = schema.safeParse(call.arguments);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return this.#finish(call.name, fail("INVALID_ARGS", `工具 ${call.name} 参数不合法: ${issues}`));
    }
    if (call.name === "terminal") {
      const { command } = parsed.data as { command: string };
      const risk = this.#nose.checkRisk(command);
      if (risk === "DANGEROUS") {
        const approved = await this.#mouth.confirm(`命令存在风险，是否执行？\n  ${command}`);
        if (!approved) {
          return this.#finish(call.name, fail("USER_DENIED", `用户拒绝了命令: ${command}`));
        }
      }
    }
    this.#emit("ACTING", call.name);
    const result = await this.#dispatch(call.name, parsed.data);
    return this.#finish(call.name, result);
  }

  async #dispatch(name: string, args: Record<string, unknown>): Promise<ActionResult<unknown>> {
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
        return this.#hands.executeCommand(args.command as string, this.#signal);
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
