// HumanAgent 组装器：新面（workspace/whitelistFile 注入、permission 内部实例、system 消息 = workspace.constraint()）。
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HumanAgent } from "../src/agent.js";
import { ConversationContext } from "../src/brain/context.js";
import { OllamaThinking } from "../src/brain/ollama-thinking.js";
import { TextOutput } from "../src/mouth/text-output.js";
import { createPermission } from "../src/permission/index.js";
import type { ActionResult, AgentOutput } from "../src/types/index.js";
import { FakeEars, FakeWritable, ScriptedBrain } from "./helpers.js";

const wsDir = mkdtempSync(join(tmpdir(), "agent-ws-"));
const wsReal = realpathSync.native(wsDir);
const fixtureDir = mkdtempSync(join(tmpdir(), "agent-fixture-"));
let seq = 0;
afterAll(() => {
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

function whitelistPath(): string {
  return join(fixtureDir, `whitelist-${seq++}.json`);
}

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
      workspace: wsReal,
      whitelistFile: whitelistPath(),
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
      workspace: wsReal,
      whitelistFile: whitelistPath(),
      brain,
      ears: new FakeEars(["你好", "/exit"]),
      output: new FakeOutput(),
    });
    agent.interrupt.abort();
    const status = await agent.run();
    expect(status).toBe("INTERRUPTED");
    expect(brain.callCount()).toBe(0);
  });

  it("command_run 工具的 timeoutMs 经默认组装透传到命令超时", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [
            {
              name: "command_run",
              arguments: { command: 'node -e "setTimeout(() => {}, 3000)"', timeoutMs: 500 },
            },
          ],
        },
      },
      { result: { text: "结束" } },
    ]);
    const agent = new HumanAgent({
      workspace: wsReal,
      whitelistFile: whitelistPath(),
      brain,
      ears: new FakeEars(["任务", "/exit"]),
      output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
    });
    const status = await agent.run();
    expect(status).toBe("IDLE");
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as ActionResult<unknown>;
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") expect(parsed.error.code).toBe("exec-timeout");
  });

  it("可注入自定义器官覆盖默认实现", async () => {
    const brain = new ScriptedBrain([
      {
        result: {
          text: "",
          toolCalls: [{ name: "command_run", arguments: { command: "echo override-ok" } }],
        },
      },
      { result: { text: "覆盖成功" } },
    ]);
    const agent = new HumanAgent({
      workspace: wsReal,
      whitelistFile: whitelistPath(),
      brain,
      ears: new FakeEars(["hi", "/exit"]),
      output: new FakeOutput(),
      context: new ConversationContext({ maxTokens: 100 }),
      maxIterations: 3,
    });
    const status = await agent.run();
    expect(status).toBe("IDLE");
    const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content) as ActionResult<unknown>;
    expect(parsed.status).toBe("ok");
  });

  it("默认组装的大脑为 OllamaThinking", async () => {
    const agent = new HumanAgent({
      workspace: wsReal,
      whitelistFile: whitelistPath(),
      ears: new FakeEars(["/exit"]),
      output: new FakeOutput(),
    });
    expect(agent.brain).toBeInstanceOf(OllamaThinking);
    const status = await agent.run();
    expect(status).toBe("IDLE");
  });

  it("运行前向上下文注入工作区 system 消息（= permission.workspace.constraint() 文案）", async () => {
    const brain = new ScriptedBrain([{ result: { text: "回答" } }]);
    const agent = new HumanAgent({
      workspace: wsReal,
      whitelistFile: whitelistPath(),
      brain,
      ears: new FakeEars(["hi", "/exit"]),
      output: new FakeOutput(),
    });
    await agent.run();
    const expected = createPermission({ workspace: wsReal, whitelistFile: whitelistPath() });
    const system = brain.messagesOf(0).find((m) => m.role === "system");
    expect(system?.content).toBe(expected.workspace.constraint());
  });

  it("上下文已有 system 消息时不重复注入", async () => {
    const brain = new ScriptedBrain([{ result: { text: "回答" } }]);
    const agent = new HumanAgent({
      workspace: wsReal,
      whitelistFile: whitelistPath(),
      brain,
      ears: new FakeEars(["hi", "/exit"]),
      output: new FakeOutput(),
      context: new ConversationContext({ maxTokens: 8000 }),
    });
    agent.context.add({ role: "system", content: "自定义系统提示" });
    await agent.run();
    const systems = brain.messagesOf(0).filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]!.content).toBe("自定义系统提示");
  });
});
