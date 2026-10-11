import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ConversationContext } from "../src/brain/context.js";
import { AgentLoop } from "../src/heart/loop.js";
import { TextOutput } from "../src/mouth/text-output.js";
import { fail, type AgentPhase, type EarsContract, type MouthContract } from "../src/types/index.js";
import type { ApprovalChoice, ApprovalPrompt, WhitelistEntry } from "../src/types/index.js";
import type { BrainInference, BrainInferenceResult, ReflectionVerdict, ToolCall, ToolInfo } from "../src/brain/llm.js";
import {
  FakeEars,
  FakeWritable,
  ScriptedBrain,
  buildEyes,
  buildHands,
} from "./helpers.js";

/** 共享嘴巴替身：confirm 一律放行、审批一律允许。 */
const autoAllowMouth: MouthContract = {
  confirm: async () => true,
  askApproval: async () => ({ action: "allow" }),
};

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

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    return { allowed: [...calls], blocked: [] };
  }

  async addWhitelistEntry(): Promise<void> {}

  workspaceConstraint(): string {
    return "test";
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

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    return { allowed: [...calls], blocked: [] };
  }

  async addWhitelistEntry(): Promise<void> {}

  workspaceConstraint(): string {
    return "test";
  }
}

function makeLoop(options: {
  brain: BrainInference;
  ears: EarsContract;
  signal: AbortSignal;
  mouth?: MouthContract;
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
    mouth: options.mouth ?? autoAllowMouth,
    maxIterations: options.maxIterations,
    timeoutMs: options.timeoutMs,
    onPhase: options.onPhase,
  });
}

/** 反思裁决：调用挂起（结构合法且未命中白名单），由嘴巴三选裁决。 */
function pendingBrain(call: ToolCall) {
  return new ScriptedBrain(
    [
      { result: { text: "", toolCalls: [call] } },
      { result: { text: "结束" } },
    ],
    { allowed: [], pending: [call], blocked: [] },
  );
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
      eyes: buildEyes({ fetchImpl }),
      hands: buildHands(),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
      signal,
      mouth: autoAllowMouth,
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

  it("被反思层拦截的调用作为失败结果反馈给大脑", async () => {
    const call = { name: "terminal", arguments: { command: "echo rm -rf /" } };
    const brain = new ScriptedBrain(
      [
        { result: { text: "", toolCalls: [call] } },
        { result: { text: "已跳过" } },
      ],
      {
        allowed: [],
        pending: [],
        blocked: [{ call, result: fail("USER_DENIED", "用户拒绝了命令") }],
      },
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

  it("多个工具调用按原数组顺序依次执行与写入上下文（保持时序不乱序）", async () => {
    const executionOrder: string[] = [];
    const call1 = { name: "terminal", arguments: { command: "echo step1-pending" } };
    const call2 = { name: "terminal", arguments: { command: "echo step2-allowed" } };
    const call3 = { name: "terminal", arguments: { command: "echo step3-blocked" } };

    const brain = new ScriptedBrain(
      [
        { result: { text: "", toolCalls: [call1, call2, call3] } },
        { result: { text: "全流程完成" } },
      ],
      {
        allowed: [call2],
        pending: [call1],
        blocked: [{ call: call3, result: fail("BLACKLIST", "黑名单禁止") }],
      },
    );

    const hands = buildHands();
    const origExec = hands.executeCommand;
    hands.executeCommand = async (cmd, sig, timeout) => {
      executionOrder.push(cmd);
      return origExec(cmd, sig, timeout);
    };

    const signal = new AbortController().signal;
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["按序执行三步", "/exit"]),
      eyes: buildEyes(),
      hands,
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
      signal,
      mouth: autoAllowMouth,
    });

    await loop.run();
    // 顺序必须严格保持为 step1 -> step2
    expect(executionOrder).toEqual(["echo step1-pending", "echo step2-allowed"]);

    const secondCall = brain.messagesOf(1);
    const toolMessages = secondCall.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]!.name).toBe("terminal");
    expect(toolMessages[1]!.name).toBe("terminal");
    expect(toolMessages[2]!.name).toBe("terminal");
    expect(JSON.parse(toolMessages[2]!.content)).toMatchObject({ success: false, error: { code: "BLACKLIST" } });
  });

  it("多个工具中部分被拒绝/失败不中断其他正常工具的独立执行", async () => {
    const call1 = { name: "terminal", arguments: { command: "echo deny-this" } };
    const call2 = { name: "terminal", arguments: { command: "echo allow-this" } };

    const brain = new ScriptedBrain(
      [
        { result: { text: "", toolCalls: [call1, call2] } },
        { result: { text: "完成" } },
      ],
      {
        allowed: [],
        pending: [call1, call2],
        blocked: [],
      },
    );

    const signal = new AbortController().signal;
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["执行", "/exit"]),
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
      signal,
      mouth: {
        confirm: async () => true,
        askApproval: async (prompt) => (prompt.key.includes("deny") ? { action: "deny" } : { action: "allow" }),
      },
    });

    await loop.run();
    const secondCall = brain.messagesOf(1);
    const toolMessages = secondCall.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(JSON.parse(toolMessages[0]!.content)).toMatchObject({ success: false, error: { code: "USER_DENIED" } });
    expect(JSON.parse(toolMessages[1]!.content)).toMatchObject({ success: true });
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
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: stream, intervalMs: 0 }),
      signal,
      mouth: autoAllowMouth,
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
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: stream, intervalMs: 0 }),
      signal,
      mouth: autoAllowMouth,
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
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: stream, intervalMs: 0 }),
      signal,
      mouth: autoAllowMouth,
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
      eyes: buildEyes(),
      hands: buildHands(),
      output,
      signal,
      mouth: autoAllowMouth,
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
      eyes: buildEyes(),
      hands: buildHands(),
      output,
      signal,
      mouth: autoAllowMouth,
      maxIterations: 2,
    });
    await loop.run();
    expect(brain.callCount()).toBe(2);
    expect(stream.output).toContain("已达到最大迭代次数");
    expect(loop.getStatus()).toBe("IDLE");
  });

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

  it("terminal 工具的 timeoutMs 参数透传给命令超时控制", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [
            {
              name: "terminal",
              arguments: { command: 'node -e "setTimeout(() => {}, 3000)"', timeoutMs: 500 },
            },
          ],
        },
      },
      { result: { text: "结束" } },
    ]);
    const signal = new AbortController().signal;
    const loop = makeLoop({ brain, ears: new FakeEars(["任务", "/exit"]), signal });
    await loop.run();
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as {
      success: boolean;
      error?: { code: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe("EXEC_TIMEOUT");
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
      eyes: buildEyes(),
      hands: buildHands(),
      output,
      signal,
      mouth: autoAllowMouth,
      context,
    });
    await loop.run();
    expect(brain.callCount()).toBe(2);
    expect(brain.messagesOf(1).filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "q1",
      "q2",
    ]);
  });

  it("反思层抛错时状态为 ERROR 且异常不逃逸（异常即反馈）", async () => {
    class ReflectBoomBrain implements BrainInference {
      async infer(): Promise<BrainInferenceResult> {
        return {
          text: "",
          toolCalls: [{ name: "terminal", arguments: { command: "echo boom" } }],
        };
      }
      async reflect(): Promise<ReflectionVerdict> {
        throw new Error("reflect boom");
      }
      async addWhitelistEntry(): Promise<void> {}

      workspaceConstraint(): string {
        return "test";
      }
    }
    const signal = new AbortController().signal;
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, intervalMs: 0 });
    const loop = new AgentLoop({
      brain: new ReflectBoomBrain(),
      ears: new FakeEars(["hi", "/exit"]),
      eyes: buildEyes(),
      hands: buildHands(),
      output,
      signal,
      mouth: autoAllowMouth,
    });
    await loop.run();
    expect(loop.getStatus()).toBe("ERROR");
    expect(stream.output).toContain("执行阶段失败");
    expect(stream.output).toContain("reflect boom");
  });

  it("pending 允许：嘴巴三选 allow → 执行并反馈 tool 消息", async () => {
    const call = { name: "terminal", arguments: { command: "ls -la" } };
    const brain = pendingBrain(call);
    const prompts: ApprovalPrompt[] = [];
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["任务", "/exit"]),
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
      signal: new AbortController().signal,
      mouth: {
        confirm: async () => true,
        askApproval: async (prompt) => {
          prompts.push(prompt);
          return { action: "allow" };
        },
      },
    });
    await loop.run();
    expect(prompts).toEqual([{ tool: "terminal", key: "ls -la", kind: "exact" }]);
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    expect(JSON.parse(toolMessage!.content) as { success: boolean }).toMatchObject({ success: true });
  });

  it("pending 拒绝：USER_DENIED 反馈，不执行", async () => {
    const call = { name: "terminal", arguments: { command: "ls -la" } };
    const brain = pendingBrain(call);
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["任务", "/exit"]),
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
      signal: new AbortController().signal,
      mouth: { confirm: async () => true, askApproval: async () => ({ action: "deny" }) },
    });
    await loop.run();
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content) as { success: boolean; error?: { code: string } };
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe("USER_DENIED");
  });

  it("pending 加入白名单：条目落盘后执行", async () => {
    const call = { name: "write_file", arguments: { path: "src/a.ts", content: "x" } };
    const brain = pendingBrain(call);
    const entry: WhitelistEntry = { tool: "write_file", key: "src/a.ts", kind: "path" };
    const loop = new AgentLoop({
      brain,
      ears: new FakeEars(["任务", "/exit"]),
      eyes: buildEyes(),
      hands: buildHands(),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
      signal: new AbortController().signal,
      mouth: {
        confirm: async () => true,
        askApproval: async (prompt: ApprovalPrompt) =>
          prompt.kind === "path" ? { action: "whitelist", entry } : { action: "allow" },
      },
    });
    await loop.run();
    try {
      expect(brain.addedWhitelist).toEqual([entry]);
      expect(brain.messagesOf(1).find((m) => m.role === "tool")).toBeDefined();
    } finally {
      // 清理真实写入（CWD 相对路径），防止测试产物污染 src/ 导致 tsc 失败
      rmSync("src/a.ts", { force: true });
    }
  });
});
