import { ConversationContext } from "../brain/context.js";
import { TOOLS } from "../brain/knowledge.js";
import type { BrainInference, BrainInferenceResult, ToolCall } from "../brain/llm.js";
import { isPathTool, matchKeyFor } from "../nose/policy.js";
import type {
  ActionResult,
  AgentOutput,
  AgentPhase,
  AgentStatus,
  ApprovalPrompt,
  EarsContract,
  EyesContract,
  HandsContract,
  MouthContract,
} from "../types/index.js";
import { fail } from "../types/index.js";
import { executeTool } from "./executor.js";

export interface AgentLoopOptions {
  brain: BrainInference;
  ears: EarsContract;
  eyes: EyesContract;
  hands: HandsContract;
  mouth: MouthContract;
  output: AgentOutput;
  signal: AbortSignal;
  context?: ConversationContext;
  maxIterations?: number;
  /** 单轮任务超时（毫秒），0 表示禁用；超时后终止本轮并继续监听。 */
  timeoutMs?: number;
  onPhase?: (phase: AgentPhase, detail?: string) => void;
  /** 工作区（判定基准；缺省 process.cwd()）。 */
  workspace?: string;
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
  readonly #mouth: MouthContract;
  readonly #output: AgentOutput;
  readonly #signal: AbortSignal;
  readonly #context: ConversationContext;
  readonly #maxIterations: number;
  #timeoutMs: number;
  readonly #onPhase: ((phase: AgentPhase, detail?: string) => void) | undefined;
  readonly #workspace: string;

  #status: AgentStatus = "IDLE";
  #turnTimedOut = false;

  constructor(options: AgentLoopOptions) {
    this.#brain = options.brain;
    this.#ears = options.ears;
    this.#eyes = options.eyes;
    this.#hands = options.hands;
    this.#mouth = options.mouth;
    this.#output = options.output;
    this.#signal = options.signal;
    this.#context = options.context ?? new ConversationContext({ maxTokens: 8000 });
    this.#maxIterations = options.maxIterations ?? 10;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#onPhase = options.onPhase;
    this.#workspace = options.workspace ?? process.cwd();
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
        try {
          await this.#execute(calls, turnSignal);
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
          this.#output.error(`执行阶段失败: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        }
      }
      this.#output.warn("已达到最大迭代次数，停止本轮推演。");
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#turnTimedOut = false;
    }
  }

  /** 反思裁决：按原 calls 顺序依次执行/拦截，放行的调用路由到器官执行，拦截的调用直接反馈错误。 */
  async #execute(calls: readonly ToolCall[], turnSignal: AbortSignal): Promise<void> {
    const verdict = await this.#brain.reflect(calls);
    const allowedSet = new Set(verdict.allowed);
    const pendingSet = new Set(verdict.pending);
    const blockedMap = new Map(verdict.blocked.map((item) => [item.call, item.result] as const));

    for (const call of calls) {
      if (this.#signal.aborted) {
        this.#status = "INTERRUPTED";
        return;
      }
      if (this.#turnTimedOut) {
        this.#output.warn("任务超时，已终止本轮。");
        return;
      }

      if (blockedMap.has(call)) {
        const blockedResult = blockedMap.get(call)!;
        this.#finish(call.name, blockedResult);
        this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(blockedResult) });
        continue;
      }

      if (allowedSet.has(call)) {
        this.#emit("ACTING", call.name);
        const result = await executeTool(
          { eyes: this.#eyes, hands: this.#hands },
          call.name,
          call.arguments,
          turnSignal,
        );
        this.#finish(call.name, result);
        this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(result) });
        continue;
      }

      if (pendingSet.has(call)) {
        const kind = isPathTool(call.name) ? "path" : "exact";
        const prompt: ApprovalPrompt = {
          tool: call.name,
          key: matchKeyFor(call, this.#workspace) ?? "",
          kind,
        };
        const choice = await this.#mouth.askApproval(prompt);
        if (choice.action === "deny") {
          const denied = fail("USER_DENIED", `用户拒绝了工具调用: ${call.name}`);
          this.#finish(call.name, denied);
          this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(denied) });
          continue;
        }
        if (choice.action === "whitelist") {
          await this.#brain.addWhitelistEntry(choice.entry);
          this.#output.info(`已加入白名单：${choice.entry.tool} ${choice.entry.key}`);
        }
        this.#emit("ACTING", call.name);
        const result = await executeTool(
          { eyes: this.#eyes, hands: this.#hands },
          call.name,
          call.arguments,
          turnSignal,
        );
        this.#finish(call.name, result);
        this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(result) });
        continue;
      }
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
