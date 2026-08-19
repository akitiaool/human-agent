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

  it("已交付任务不会重复交付：新任务发布后 GET 返回新任务而非旧任务", async () => {
    const { bridge, port } = await makeBridge();
    const context = contextOf({ role: "user", content: "旧任务" });
    const firstInfer = bridge.infer(context, TOOLS);
    const first = (await (await fetch(`http://127.0.0.1:${port}/task`)).json()) as {
      id: string;
    };
    context.add({ role: "user", content: "新任务" });
    const secondInfer = bridge.infer(context, TOOLS);
    const second = (await (await fetch(`http://127.0.0.1:${port}/task`)).json()) as {
      id: string;
      message: string;
    };
    expect(second.id).not.toBe(first.id);
    expect(second.message).toContain("新任务");
    await postResult(port, first.id, "旧完成");
    await postResult(port, second.id, "新完成");
    await firstInfer;
    await secondInfer;
  });

  it("长轮询等待：先 GET /task 挂起，任务发布后唤醒交付", async () => {
    const { bridge, port } = await makeBridge();
    const poll = fetch(`http://127.0.0.1:${port}/task`);
    const inferPromise = bridge.infer(contextOf({ role: "user", content: "长轮询指令" }), TOOLS);
    const task = (await (await poll).json()) as { id: string; message: string };
    expect(task.message).toContain("长轮询指令");
    await postResult(port, task.id, "收到");
    expect((await inferPromise).text).toBe("收到");
  });
});
