import { describe, expect, it, vi } from "vitest";
import { ConversationContext } from "../src/brain/context.js";
import { AgentLoop } from "../src/heart/loop.js";
import { TextOutput } from "../src/mouth/text-output.js";
import { AskUser } from "../src/mouth/ask-user.js";
import { RiskChecker } from "../src/nose/risk-checker.js";
import type { AgentPhase } from "../src/types/index.js";
import type { EarsContract } from "../src/types/index.js";
import {
  FakeEars,
  FakeWritable,
  ScriptedBrain,
  buildEyes,
  buildHands,
  inputFrom,
} from "./helpers.js";

class HangingEars implements EarsContract {
  public promptCalls = 0;
  async prompt(_question: string): Promise<string> {
    this.promptCalls++;
    return new Promise(() => {});
  }
}

/** infer 挂起直到 signal 中断；abort 时以 AbortError 拒绝。 */
class AbortableBrain implements BrainInference {
  async infer(
    _context: ConversationContext,
    _tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult> {
    await new Promise((_resolve, reject) => {
      if (signal !== undefined && signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
    return { text: "" };
  }
}

/** 第一轮 infer 挂起（等待超时取消），之后正常回答。 */
class TimeoutThenAnswerBrain implements BrainInference {
  private calls = 0;
  async infer(
    _context: ConversationContext,
    _tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult> {
    this.calls++;
    if (this.calls > 1) return { text: "超时后的回答" };
    await new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
    return { text: "" };
  }
}

function makeLoop(options: {
  brain: BrainInference;
  ears: EarsContract;
  signal: AbortSignal;
  mouth?: AskUser;
  maxIterations?: number;
  timeoutMs?: number;
  onPhase?: (phase: AgentPhase, detail?: string) => void;
}) {
  return new AgentLoop({
    brain: options.brain,
    ears: options.ears,
    nose: new RiskChecker(),
    mouth: options.mouth ?? new AskUser({ input: inputFrom("y\n") }),
    eyes: buildEyes(),
    hands: buildHands(),
    output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
    signal: options.signal,
    maxIterations: options.maxIterations,
    timeoutMs: options.timeoutMs,
    onPhase: options.onPhase,
  });
}

describe("AgentLoop", () => {
  it("无工具调用时直接说出最终回答，状态回到 IDLE", async () => {
    const brain = new ScriptedBrain([{ result: { text: "你好，我是 human-agent" } }]);
    const signal = new AbortController().signal;
    const loop = makeLoop({ brain, ears: new FakeEars(["hello", "/exit"]), signal });
    await loop.run();
    expect(brain.callCount()).toBe(1);
    expect(loop.getStatus()).toBe("IDLE");
  });

  it("工具执行结果作为 tool 消息反馈给大脑", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [{ name: "terminal", arguments: { command: "echo loop-hi" } }],
        },
      },
      { result: { text: "执行完成" } },
    ]);
    const signal = new AbortController().signal;
    const loop = makeLoop({ brain, ears: new FakeEars(["帮我执行命令", "/exit"]), signal });
    await loop.run();
    const secondCall = brain.messagesOf(1);
    const toolMessage = secondCall.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as { success: boolean; data?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.data).toContain("loop-hi");
  });

  it("fetch_page 工具调用经眼睛抓取网页并反馈 Markdown", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [{ name: "fetch_page", arguments: { url: "https://example.com" } }],
        },
      },
      { result: { text: "抓取完成" } },
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body><h1>抓到的标题</h1></body></html>", { status: 200 }),
    );
    const signal = new AbortController().signal;
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["抓网页", "/exit"]),
      nose: new RiskChecker(),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      eyes: buildEyes({ fetchImpl }),
      hands: buildHands(),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
      signal,
    });
    await loop.run();
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as { success: boolean; data?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.data).toContain("# 抓到的标题");
  });

  it("工具调用后，assistant 消息（含 toolCalls）与 tool 结果都写入上下文", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [{ name: "terminal", arguments: { command: "echo chain-test" } }],
        },
      },
      { result: { text: "完成" } },
    ]);
    const signal = new AbortController().signal;
    const loop = makeLoop({ brain, ears: new FakeEars(["执行", "/exit"]), signal });
    await loop.run();
    const secondCall = brain.messagesOf(1);
    const assistant = secondCall.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect((assistant as { toolCalls?: unknown }).toolCalls).toEqual([
      { name: "terminal", arguments: { command: "echo chain-test" } },
    ]);
    expect(secondCall.find((m) => m.role === "tool")).toBeDefined();
    const firstCall = brain.messagesOf(0);
    expect(firstCall.some((m) => m.role === "assistant")).toBe(true);
  });

  it("危险命令经用户拒绝后不执行，结果反馈为 USER_DENIED", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [{ name: "terminal", arguments: { command: "echo rm -rf /" } }],
        },
      },
      { result: { text: "已跳过" } },
    ]);
    const signal = new AbortController().signal;
    const loop = makeLoop({
      brain,
      ears: new FakeEars(["删除它", "/exit"]),
      signal,
      mouth: new AskUser({ input: inputFrom("n\n") }),
    });
    await loop.run();
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as { success: boolean; error?: { code: string } };
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe("USER_DENIED");
  });

  it("危险命令经用户确认后正常执行", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [{ name: "terminal", arguments: { command: "echo approved-run" } }],
        },
      },
      { result: { text: "已执行" } },
    ]);
    const signal = new AbortController().signal;
    const loop = makeLoop({
      brain,
      ears: new FakeEars(["执行", "/exit"]),
      signal,
      mouth: new AskUser({ input: inputFrom("y\n") }),
    });
    await loop.run();
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content) as { success: boolean; data?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.data).toContain("approved-run");
  });

  it("输入为空或 /exit 时退出且不调用大脑", async () => {
    const brain = new ScriptedBrain([]);
    const signal = new AbortController().signal;
    const loop = makeLoop({ brain, ears: new FakeEars([""]), signal });
    await loop.run();
    expect(brain.callCount()).toBe(0);
    expect(loop.getStatus()).toBe("IDLE");
  });

  it("信号预先中断时直接进入 INTERRUPTED 且不听取输入", async () => {
    const brain = new ScriptedBrain([]);
    const controller = new AbortController();
    controller.abort();
    const ears = new FakeEars(["hi"]);
    const loop = makeLoop({ brain, ears, signal: controller.signal });
    await loop.run();
    expect(ears.promptCalls).toBe(0);
    expect(loop.getStatus()).toBe("INTERRUPTED");
  });

  it("等待用户输入时中断 → INTERRUPTED", async () => {
    const brain = new ScriptedBrain([]);
    const controller = new AbortController();
    const loop = makeLoop({ brain, ears: new HangingEars(), signal: controller.signal });
    const runPromise = loop.run();
    setTimeout(() => controller.abort(), 30);
    await runPromise;
    expect(loop.getStatus()).toBe("INTERRUPTED");
  });

  it("/timeout 命令动态更新超时时长并即时生效", async () => {
    const signal = new AbortController().signal;
    const stream = new FakeWritable();
    const loop = new AgentLoop({
      brain: new TimeoutThenAnswerBrain(),
      ears: new FakeEars(["/timeout 20", "任务", "继续", "/exit"]),
      nose: new RiskChecker(),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: stream, intervalMs: 0 }),
      signal,
      timeoutMs: 300_000,
    });
    await loop.run();
    expect(loop.getStatus()).toBe("IDLE");
    expect(stream.output).toContain("任务超时已更新为 20ms");
    expect(stream.output).toContain("任务超时");
    expect(stream.output).toContain("超时后的回答");
  });

  it("/timeout 非法参数给出提示且会话继续", async () => {
    const signal = new AbortController().signal;
    const stream = new FakeWritable();
    const loop = new AgentLoop({
      brain: new ScriptedBrain([{ result: { text: "回答" } }]),
      ears: new FakeEars(["/timeout abc", "问题", "/exit"]),
      nose: new RiskChecker(),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: stream, intervalMs: 0 }),
      signal,
    });
    await loop.run();
    expect(stream.output).toContain("无法解析超时时长");
    expect(stream.output).toContain("回答");
  });

  it("推理超时后终止本轮并警告，会话继续监听下一条指令", async () => {
    const signal = new AbortController().signal;
    const stream = new FakeWritable();
    const loop = new AgentLoop({
      brain: new TimeoutThenAnswerBrain(),
      ears: new FakeEars(["任务", "再来一条", "/exit"]),
      nose: new RiskChecker(),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: stream, intervalMs: 0 }),
      signal,
      timeoutMs: 20,
    });
    await loop.run();
    expect(loop.getStatus()).toBe("IDLE");
    expect(stream.output).toContain("任务超时");
    expect(stream.output).toContain("超时后的回答");
  });

  it("执行中的工具被任务超时中止（命令被杀，结果反馈失败）", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [
            {
              name: "terminal",
              arguments: { command: 'node -e "setTimeout(() => {}, 10000)"' },
            },
          ],
        },
      },
      { result: { text: "结束" } },
    ]);
    const signal = new AbortController().signal;
    const loop = makeLoop({ brain, ears: new FakeEars(["任务", "继续", "/exit"]), signal, timeoutMs: 20 });
    await loop.run();
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content) as { success: boolean };
    expect(parsed.success).toBe(false);
  });

  it("推理期间被中断时状态为 INTERRUPTED 而非 ERROR", async () => {
    const controller = new AbortController();
    const loop = makeLoop({ brain: new AbortableBrain(), ears: new FakeEars(["hi"]), signal: controller.signal });
    const runPromise = loop.run();
    setTimeout(() => controller.abort(), 30);
    await runPromise;
    expect(loop.getStatus()).toBe("INTERRUPTED");
  });

  it("大脑抛错时状态为 ERROR 且输出错误信息", async () => {
    const brain = new ScriptedBrain([{ error: new Error("brain boom") }]);
    const signal = new AbortController().signal;
    const output = new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 });
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["hi", "/exit"]),
      nose: new RiskChecker(),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      eyes: buildEyes(),
      hands: buildHands(),
      output,
      signal,
    });
    await loop.run();
    expect(loop.getStatus()).toBe("ERROR");
  });

  it("大脑持续调用工具时达到最大迭代次数停止", async () => {
    const brain = new ScriptedBrain([
      { result: { text: "", toolCalls: [{ name: "terminal", arguments: { command: "echo x" } }] } },
      { result: { text: "", toolCalls: [{ name: "terminal", arguments: { command: "echo x" } }] } },
    ]);
    const signal = new AbortController().signal;
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, intervalMs: 0 });
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["hi", "/exit"]),
      nose: new RiskChecker(),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      eyes: buildEyes(),
      hands: buildHands(),
      output,
      signal,
      maxIterations: 2,
    });
    await loop.run();
    expect(brain.callCount()).toBe(2);
    expect(stream.output).toContain("已达到最大迭代次数");
    expect(loop.getStatus()).toBe("IDLE");
  });

  it("按 听→想→嗅→执行→反馈→想 顺序发出阶段事件", async () => {
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
    expect(phases.slice(0, 6)).toEqual([
      "LISTENING",
      "THINKING",
      "SNIFFING",
      "ACTING",
      "FEEDBACK",
      "THINKING",
    ]);
  });

  it("上下文在会话中持续累积", async () => {
    const brain = new ScriptedBrain([
      { result: { text: "第一轮回答" } },
      { result: { text: "第二轮回答" } },
    ]);
    const signal = new AbortController().signal;
    const context = new ConversationContext({ maxTokens: 8000 });
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, intervalMs: 0 });
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["q1", "q2", "/exit"]),
      nose: new RiskChecker(),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      eyes: buildEyes(),
      hands: buildHands(),
      output,
      signal,
      context,
    });
    await loop.run();
    expect(brain.callCount()).toBe(2);
    expect(brain.messagesOf(1).filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "q1",
      "q2",
    ]);
  });
});
