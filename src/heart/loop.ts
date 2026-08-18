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
  terminal: z.object({
    command: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  }),
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
    description: "执行 shell 命令（可指定 timeoutMs 毫秒超时，超时自动终止）",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "number", description: "命令超时毫秒数（可选，默认由任务超时控制）" },
      },
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
  #timeoutMs: number;
  readonly #onPhase: ((phase: AgentPhase, detail?: string) => void) | undefined;

  #status: AgentStatus = "IDLE";
  #turnTimedOut = false;

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
        for (const call of calls) {
          if (this.#signal.aborted) {
            this.#status = "INTERRUPTED";
            return true;
          }
          if (this.#turnTimedOut) {
            this.#output.warn("任务超时，已终止本轮。");
            return false;
          }
          const actionResult = await this.#execute(call, turnSignal);
          this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(actionResult) });
        }
      }
      this.#output.warn("已达到最大迭代次数，停止本轮推演。");
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#turnTimedOut = false;
    }
  }

  async #execute(call: ToolCall, turnSignal: AbortSignal): Promise<ActionResult<unknown>> {
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
    const result = await this.#dispatch(call.name, parsed.data, turnSignal);
    return this.#finish(call.name, result);
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
