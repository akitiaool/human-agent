import { describe, expect, it } from "vitest";
import { HumanAgent } from "../src/agent.js";
import { ConversationContext } from "../src/brain/context.js";
import { AskUser } from "../src/mouth/ask-user.js";
import type { AgentOutput } from "../src/types/index.js";
import { FakeEars, FakeWritable, ScriptedBrain, inputFrom } from "./helpers.js";
import { TextOutput } from "../src/mouth/text-output.js";

class FakeOutput implements AgentOutput {
  public spoken: string[] = [];
  async speak(text: string): Promise<void> {
    this.spoken.push(text);
  }
  info(_message: string): void {}
  warn(_message: string): void {}
  error(_message: string): void {}
  printDiff(_diff: string): void {}
}

describe("HumanAgent", () => {
  it("默认组装可完成一轮会话，返回 IDLE", async () => {
    const brain = new ScriptedBrain([{ result: { text: "回答完毕" } }]);
    const output = new FakeOutput();
    const agent = new HumanAgent({
      brain,
      ears: new FakeEars(["你好", "/exit"]),
      output,
    });
    const status = await agent.run();
    expect(status).toBe("IDLE");
    expect(brain.callCount()).toBe(1);
    expect(output.spoken).toEqual(["回答完毕"]);
  });

  it("中断后返回 INTERRUPTED", async () => {
    const brain = new ScriptedBrain([]);
    const agent = new HumanAgent({
      brain,
      ears: new FakeEars(["你好", "/exit"]),
      output: new FakeOutput(),
    });
    agent.interrupt.abort();
    const status = await agent.run();
    expect(status).toBe("INTERRUPTED");
    expect(brain.callCount()).toBe(0);
  });

  it("terminal 工具的 timeoutMs 经默认组装透传到命令超时", async () => {
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
    const agent = new HumanAgent({
      brain,
      ears: new FakeEars(["任务", "/exit"]),
      mouth: new AskUser({ input: inputFrom("y\n") }),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
    });
    const status = await agent.run();
    expect(status).toBe("IDLE");
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as {
      success: boolean;
      error?: { code: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe("EXEC_TIMEOUT");
  });

  it("可注入自定义器官覆盖默认实现", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [{ name: "terminal", arguments: { command: "echo override-ok" } }],
        },
      },
      { result: { text: "覆盖成功" } },
    ]);
    const agent = new HumanAgent({
      brain,
      ears: new FakeEars(["hi", "/exit"]),
      output: new FakeOutput(),
      context: new ConversationContext({ maxTokens: 100 }),
      maxIterations: 3,
    });
    const status = await agent.run();
    expect(status).toBe("IDLE");
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content) as { success: boolean };
    expect(parsed.success).toBe(true);
  });
});
