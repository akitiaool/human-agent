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

async function makeBridge(options: { nose?: NoseContract; timeoutMs?: number; signal?: AbortSignal; approvalTimeoutMs?: number } = {}) {
  const organs = makeRecordingOrgans();
  const bridge = new GeminiBridgeThinking({
    port: 0,
    nose: options.nose ?? buildStubNose(),
    hands: organs.hands,
    eyes: organs.eyes,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
  });
  openBridges.push(bridge);
  const port = await bridge.getPort();
  return { bridge, port, organs };
}

type OutboxBody =
  | { type: "message"; message: string }
  | { type: "approval"; id: number; calls: Array<{ name: string; arguments: Record<string, unknown> }> };

/** 长轮询取一条出队消息；无消息时服务端 25s 后 204（测试不等待该路径）。 */
async function getMessage(port: number): Promise<OutboxBody | null> {
  const res = await fetch(`http://127.0.0.1:${port}/task`);
  if (res.status === 204) return null;
  return (await res.json()) as OutboxBody;
}

/** 取回填文本消息（非审批类型时抛错）。 */
async function getMessageText(port: number): Promise<string> {
  const body = await getMessage(port);
  if (body === null) throw new Error("expected message, got 204");
  if (body.type !== "message") throw new Error(`expected message, got ${body.type}`);
  return body.message;
}

/** 提交审批结果，返回 HTTP 状态码。 */
async function postApproval(port: number, id: number, allowed: boolean[]): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, allowed }),
  });
  await res.json().catch(() => undefined);
  return res.status;
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
    const message = await getMessageText(port);
    expect(message).toContain("【human-agent 工具协议】");
  });

  it("含 tool_call 的内容执行后回填结果消息", async () => {
    const { port, organs } = await makeBridge();
    await getMessageText(port); // 排空协议首条
    const res = await postReply(port, toolCall("read_file", { path: "a.txt" }));
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
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
    await getMessageText(port);
    const reply = [
      toolCall("read_file", { path: "a.txt" }),
      toolCall("terminal", { command: "echo hi" }),
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("read_file");
    expect(message).toContain("terminal");
    expect(organs.calls).toHaveLength(2);
  });

  it("危险命令需审批，未授权不执行", async () => {
    const { port, organs } = await makeBridge({ nose: buildStubNose("DANGEROUS") });
    await getMessage(port);
    const res = await postReply(port, toolCall("terminal", { command: "rm -rf /" }));
    expect(res.processed).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval"); // 审批请求而非自动拒绝
    expect(organs.calls).toEqual([]); // 未授权前不执行
  });

  it("多个危险命令合并为一条审批请求", async () => {
    const { port } = await makeBridge({ nose: buildStubNose("DANGEROUS") });
    await getMessage(port);
    const reply = [
      toolCall("terminal", { command: "rm -rf /" }),
      toolCall("terminal", { command: "git push --force" }),
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    if (body?.type === "approval") {
      expect(body.calls).toHaveLength(2);
      expect(body.calls[0]!.arguments).toEqual({ command: "rm -rf /" });
      expect(body.calls[1]!.arguments).toEqual({ command: "git push --force" });
    }
  });

  it("审批允许后执行并回填结果", async () => {
    const { port, organs } = await makeBridge({ nose: buildStubNose("DANGEROUS") });
    await getMessage(port);
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    expect(await postApproval(port, id, [true])).toBe(200);
    const message = await getMessageText(port);
    expect(message).toContain("工具执行结果");
    expect(message).toContain("terminal");
    expect(organs.calls.some((c) => c.args.command === "echo hi")).toBe(true);
  });

  it("审批逐条裁决：允许的执行、拒绝的生成拒绝行", async () => {
    const { port, organs } = await makeBridge({ nose: buildStubNose("DANGEROUS") });
    await getMessage(port);
    const reply = [
      toolCall("terminal", { command: "rm -rf /" }),
      toolCall("terminal", { command: "echo ok" }),
    ].join("\n");
    await postReply(port, reply);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    expect(await postApproval(port, id, [false, true])).toBe(200);
    const message = await getMessageText(port);
    expect(message).toContain("已拒绝");
    expect(message).toContain("用户未授权");
    expect(message).toContain("echo ok");
    expect(organs.calls.some((c) => c.args.command === "rm -rf /")).toBe(false);
    expect(organs.calls.some((c) => c.args.command === "echo ok")).toBe(true);
  });

  it("未知审批 id 返回 404", async () => {
    const { port } = await makeBridge();
    expect(await postApproval(port, 999, [true])).toBe(404);
  });

  it("审批兜底超时全部拒绝", async () => {
    const { port, organs } = await makeBridge({ nose: buildStubNose("DANGEROUS"), approvalTimeoutMs: 50 });
    await getMessage(port);
    await postReply(port, toolCall("terminal", { command: "rm -rf /" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const message = await getMessageText(port); // 50ms 兜底超时后回填拒绝行
    expect(message).toContain("审批超时");
    expect(message).toContain("已拒绝");
    expect(organs.calls).toEqual([]);
  });

  it("close 释放挂起审批", async () => {
    const { bridge, port, organs } = await makeBridge({ nose: buildStubNose("DANGEROUS"), approvalTimeoutMs: 1000 });
    await getMessage(port);
    await postReply(port, toolCall("terminal", { command: "rm -rf /" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    bridge.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(organs.calls).toEqual([]); // 未执行；若审批未释放则测试进程悬挂（afterEach close 兜底）
  });

  it("全局中断作废审批并丢弃批次", async () => {
    const controller = new AbortController();
    const { port, organs } = await makeBridge({ nose: buildStubNose("DANGEROUS"), signal: controller.signal });
    await getMessage(port);
    await postReply(port, toolCall("terminal", { command: "rm -rf /" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(organs.calls).toEqual([]);
    expect(await postApproval(port, id, [true])).toBe(404); // 审批条目已作废
  });

  it("参数非法的危险命令不进审批，直接 INVALID_ARGS 拒绝", async () => {
    const { port } = await makeBridge({ nose: buildStubNose("DANGEROUS") });
    await getMessage(port);
    const res = await postReply(port, toolCall("terminal", {}));
    expect(res.processed).toBe(true);
    const message = await getMessageText(port); // 直接 message 类型，无审批请求
    expect(message).toContain("参数不合法");
  });

  it("安全命令批不产生审批消息", async () => {
    const { port } = await makeBridge(); // SAFE nose
    await getMessage(port);
    await postReply(port, toolCall("read_file", { path: "a.txt" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("message");
  });

  it("未知工具与参数非法拒绝", async () => {
    const { port } = await makeBridge();
    await getMessageText(port);
    const reply = [toolCall("hack_planet", {}), toolCall("read_file", {})].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("未知工具");
    expect(message).toContain("参数不合法");
  });

  it("相同内容重复提交只处理一次", async () => {
    const { port, organs } = await makeBridge();
    await getMessageText(port);
    const reply = toolCall("read_file", { path: "a.txt" });
    const first = await postReply(port, reply);
    expect(first.processed).toBe(true);
    const second = await postReply(port, reply);
    expect(second.processed).toBe(false);
    await getMessageText(port); // 取走结果消息，保证批执行完成
    expect(organs.calls).toHaveLength(1);
  });

  it("批超时队列执行超时说明", async () => {
    const { port, organs } = await makeBridge({ timeoutMs: 100 });
    await getMessageText(port);
    const res = await postReply(port, toolCall("terminal", { command: "slow" }));
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
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
