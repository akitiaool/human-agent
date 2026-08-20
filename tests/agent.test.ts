import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildBridgeService, HumanAgent } from "../src/agent.js";
import { ConversationContext } from "../src/brain/context.js";
import { GeminiBridgeThinking } from "../src/brain/gemini-bridge-thinking.js";
import { OllamaThinking } from "../src/brain/ollama-thinking.js";
import { TextOutput } from "../src/mouth/text-output.js";
import type { AgentOutput } from "../src/types/index.js";
import { FakeEars, FakeWritable, ScriptedBrain } from "./helpers.js";

const tempDir = mkdtempSync(join(tmpdir(), "agent-test-"));
const whitelistFile = join(tempDir, "whitelist.json");
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

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

  it("默认组装的大脑为 OllamaThinking", async () => {
    const savedBridgePort = process.env.GEMINI_BRIDGE_PORT;
    delete process.env.GEMINI_BRIDGE_PORT;
    const agent = new HumanAgent({
      ears: new FakeEars(["/exit"]),
      output: new FakeOutput(),
      whitelistFile,
    });
    try {
      expect(agent.brain).toBeInstanceOf(OllamaThinking);
      await agent.run();
    } finally {
      if (savedBridgePort !== undefined) process.env.GEMINI_BRIDGE_PORT = savedBridgePort;
      else delete process.env.GEMINI_BRIDGE_PORT;
    }
  });

});

it("buildBridgeService 返回可监听的桥服务", async () => {
  const service = buildBridgeService({ port: 0, whitelistFile });
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
    const service = buildBridgeService({ port: 0, whitelistFile }); // 显式 0 优先，避免真实绑定 8765
    expect(service).toBeInstanceOf(GeminiBridgeThinking);
    service.close();
  } finally {
    delete process.env.GEMINI_BRIDGE_PORT;
  }
});
