import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiBridgeThinking, parseToolCalls } from "../src/brain/gemini-bridge-thinking.js";
import type { ActionResult, EyesContract, HandsContract, NoseContract, RiskLevel } from "../src/types/index.js";
import { buildStubNose } from "./helpers.js";

// 记录型 stub 器官：断言"执行了哪些工具"而不真跑命令
function makeRecordingOrgans() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const eyes: EyesContract = {
    readFile: async (path) => { calls.push({ name: "read_file", args: { path } }); return ok({ content: `内容:${path}` }); },
    readDir: async (path) => { calls.push({ name: "read_dir", args: { path } }); return ok(["a.txt"]); },
    searchCode: async (pattern, dir) => { calls.push({ name: "search_code", args: { pattern, dir } }); return ok([]); },
    fetchPageAsMarkdown: async (url) => { calls.push({ name: "fetch_page", args: { url } }); return ok("# 网页"); },
  };
  const hands: HandsContract = {
    writeFile: async (path, content) => { calls.push({ name: "write_file", args: { path, content } }); return ok(undefined); },
    applyPatch: async (path, patch) => { calls.push({ name: "apply_patch", args: { path, patch } }); return ok(undefined); },
    executeCommand: async (command, _signal, timeoutMs) => {
      calls.push({ name: "terminal", args: { command, timeoutMs } });
      if (command === "slow") await new Promise((r) => setTimeout(r, 10_000));
      return ok({ stdout: `输出:${command}`, exitCode: 0 });
    },
  };
  return { calls, eyes, hands };
}

function ok<T>(data: T): ActionResult<T> { return { success: true, data }; }

const openBridges: GeminiBridgeThinking[] = [];
afterEach(() => { for (const bridge of openBridges.splice(0)) bridge.close(); });

async function makeBridge(options: { nose?: NoseContract; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const organs = makeRecordingOrgans();
  const bridge = new GeminiBridgeThinking({
    port: 0,
    nose: options.nose ?? buildStubNose(),
    hands: organs.hands,
    eyes: organs.eyes,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  openBridges.push(bridge);
  const port = await bridge.getPort();
  return { bridge, port, organs };
}

/** 长轮询取一条回填消息；无消息时服务端 25s 后 204（测试不等待该路径）。 */
async function getMessage(port: number): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${port}/task`);
  if (res.status === 204) return null;
  const body = (await res.json()) as { message: string };
  return body.message;
}

async function postReply(port: number, reply: string): Promise<{ ok: boolean; processed: boolean }> {
  const res = await fetch(`http://127.0.0.1:${port}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  return (await res.json()) as { ok: boolean; processed: boolean };
}

const toolCall = (name: string, args: object) =>
  ["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n");

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

describe("GeminiBridgeThinking 执行型桥服务", () => {
  it("首条任务为工具协议", async () => {
    const { port } = await makeBridge();
    const message = await getMessage(port);
    expect(message).toContain("【human-agent 工具协议】");
  });

  it("含 tool_call 的内容执行后回填结果消息", async () => {
    const { port, organs } = await makeBridge();
    await getMessage(port); // 排空协议首条
    const res = await postReply(port, toolCall("read_file", { path: "a.txt" }));
    expect(res.processed).toBe(true);
    const message = await getMessage(port);
    expect(message).toContain("工具执行结果");
    expect(message).toContain("read_file");
    expect(message).toContain("内容:a.txt");
    expect(organs.calls).toEqual([{ name: "read_file", args: { path: "a.txt" } }]);
  });

  it("无 tool_call 的内容不回填", async () => {
    const { port, organs } = await makeBridge();
    const res = await postReply(port, "纯文本回复");
    expect(res.processed).toBe(false);
    expect(organs.calls).toEqual([]);
  });

  it("多个 tool_call 汇总为一条消息并全部执行", async () => {
    const { port, organs } = await makeBridge();
    await getMessage(port);
    const reply = [
      toolCall("read_file", { path: "a.txt" }),
      toolCall("terminal", { command: "echo hi" }),
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessage(port);
    expect(message).toContain("read_file");
    expect(message).toContain("terminal");
    expect(organs.calls).toHaveLength(2);
  });

  it("危险命令自动拒绝", async () => {
    const { port, organs } = await makeBridge({ nose: buildStubNose("DANGEROUS") });
    await getMessage(port);
    const res = await postReply(port, toolCall("terminal", { command: "rm -rf /" }));
    expect(res.processed).toBe(true);
    const message = await getMessage(port);
    expect(message).toContain("已拒绝");
    expect(message).toContain("危险命令自动拒绝");
    expect(organs.calls).toEqual([]); // 拒绝不执行
  });

  it("未知工具与参数非法拒绝", async () => {
    const { port } = await makeBridge();
    await getMessage(port);
    const reply = [toolCall("hack_planet", {}), toolCall("read_file", {})].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessage(port);
    expect(message).toContain("未知工具");
    expect(message).toContain("参数不合法");
  });

  it("相同内容重复提交只处理一次", async () => {
    const { port, organs } = await makeBridge();
    await getMessage(port);
    const reply = toolCall("read_file", { path: "a.txt" });
    const first = await postReply(port, reply);
    expect(first.processed).toBe(true);
    const second = await postReply(port, reply);
    expect(second.processed).toBe(false);
    await getMessage(port); // 取走结果消息，保证批执行完成
    expect(organs.calls).toHaveLength(1);
  });

  it("批超时队列执行超时说明", async () => {
    const { port, organs } = await makeBridge({ timeoutMs: 100 });
    await getMessage(port);
    const res = await postReply(port, toolCall("terminal", { command: "slow" }));
    expect(res.processed).toBe(true);
    const message = await getMessage(port);
    expect(message).toContain("超时");
    expect(organs.calls.some((c) => c.args.command === "slow")).toBe(true); // 已开始执行
  });

  it("全局中断丢弃批次", async () => {
    const controller = new AbortController();
    const { port, organs } = await makeBridge({ signal: controller.signal });
    controller.abort();
    const reply = [
      toolCall("read_file", { path: "a.txt" }),
      toolCall("read_file", { path: "b.txt" }),
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    // 批执行被中止：第二个工具未执行（calls 不完整）
    expect(organs.calls.some((c) => c.args.path === "b.txt")).toBe(false);
  });

  it("close 释放挂起长轮询", async () => {
    const { bridge, port } = await makeBridge();
    await getMessage(port); // 排空协议首条，使下一次 GET 挂起
    const poll = getMessage(port);
    bridge.close();
    await expect(poll).resolves.toBeNull(); // 204 结束
  });

  it("非法 reply 返回 400", async () => {
    const { port } = await makeBridge();
    const res = await fetch(`http://127.0.0.1:${port}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "" }),
    });
    expect(res.status).toBe(400);
    await res.json();
  });
});
