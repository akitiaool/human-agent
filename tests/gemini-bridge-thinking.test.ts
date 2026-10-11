import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiBridgeThinking, parseToolCalls } from "../src/brain/gemini-bridge-thinking.js";
import type { ActionResult, EyesContract, HandsContract, WhitelistEntry } from "../src/types/index.js";
import { fail } from "../src/types/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "bridge-wl-"));
const tmpFile = join(tmpDir, "whitelist.json");
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => rmSync(tmpFile, { force: true }));

/** 预置白名单（构造前写入；桥构造时加载）。 */
function seedWhitelist(workspace: string, entries: WhitelistEntry[]): void {
  writeFileSync(tmpFile, JSON.stringify({ [workspace]: entries }), "utf8");
}

// 记录型 stub 器官
function makeRecordingOrgans() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const eyes: EyesContract = {
    readFile: async (path, options) => {
      calls.push({ name: "read_file", args: { path, ...options } });
      if (path === "bad.txt") return fail("FILE_NOT_FOUND", "文件不存在");
      return ok({ content: `内容:${path}`, versionId: "v-test1234", totalLines: 10 });
    },
    readDir: async (path) => { calls.push({ name: "read_dir", args: { path } }); return ok(["a.txt"]); },
    searchCode: async (pattern, dir) => { calls.push({ name: "search_code", args: { pattern, dir } }); return ok([]); },
    fetchPageAsMarkdown: async (url) => { calls.push({ name: "fetch_page", args: { url } }); return ok("# 网页"); },
  };
  const hands: HandsContract = {
    writeFile: async (path, content) => { calls.push({ name: "write_file", args: { path, content } }); return ok(undefined); },
    applyPatch: async (path, patch) => { calls.push({ name: "apply_patch", args: { path, patch } }); return ok(undefined); },
    editFile: async (path, hunks, baseVersion) => {
      calls.push({ name: "edit_file", args: { path, hunks, baseVersion } });
      return ok({ path, newVersionId: "v-new1234", hunksApplied: hunks.length });
    },
    executeCommand: async (command, _signal, timeoutMs) => {
      calls.push({ name: "terminal", args: { command, timeoutMs } });
      if (command === "slow") await new Promise((r) => setTimeout(r, 10_000));
      if (command === "fail-cmd") return fail("COMMAND_FAILED", "命令失败");
      return ok({ stdout: `输出:${command}`, exitCode: 0 });
    },
  };
  return { calls, eyes, hands };
}

function ok<T>(data: T): ActionResult<T> { return { success: true, data }; }

const openBridges: GeminiBridgeThinking[] = [];
afterEach(() => { for (const bridge of openBridges.splice(0)) bridge.close(); });

async function makeBridge(options: {
  workspace?: string;
  whitelistFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  approvalTimeoutMs?: number;
} = {}) {
  const organs = makeRecordingOrgans();
  const bridge = new GeminiBridgeThinking({
    port: 0,
    workspace: options.workspace ?? "/ws-test",
    whitelistFile: options.whitelistFile ?? tmpFile,
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

async function getMessage(port: number): Promise<OutboxBody | null> {
  const res = await fetch(`http://127.0.0.1:${port}/task`);
  if (res.status === 204) return null;
  return (await res.json()) as OutboxBody;
}

async function tryGetMessage(port: number, ms: number): Promise<OutboxBody | null> {
  return Promise.race([
    getMessage(port),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function getMessageText(port: number): Promise<string> {
  const body = await getMessage(port);
  if (body === null) throw new Error("expected message, got 204");
  if (body.type !== "message") throw new Error(`expected message, got ${body.type}`);
  return body.message;
}

async function postApproval(port: number, id: number, allowed: boolean[], whitelist?: WhitelistEntry[]): Promise<number> {
  const body: Record<string, unknown> = { id, allowed };
  if (whitelist !== undefined && whitelist.length > 0) body.whitelist = whitelist;
  const res = await fetch(`http://127.0.0.1:${port}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

/** 构造标准的全新语法指令 */
function toolCall(tool: string, args: Record<string, unknown>, id = "1"): string {
  const lines = ["{", `<::: TOOL_CALL[${id}]`, `tool: ${tool}`];
  for (const [k, v] of Object.entries(args)) {
    if (k === "content") {
      lines.push("<::: CONTENT", String(v), ":::> CONTENT");
    } else if (k === "command") {
      lines.push("<::: COMMAND", String(v), ":::> COMMAND");
    } else if (k === "patch") {
      lines.push("<::: CONTENT", String(v), ":::> CONTENT");
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push(`:::> TOOL_CALL[${id}]`, "}");
  return lines.join("\n");
}

describe("parseToolCalls AST 状态机解析器", () => {
  it("纯文本不产生 toolCalls", () => {
    const result = parseToolCalls("你好，我是 human-agent");
    expect(result.text).toBe("你好，我是 human-agent");
    expect(result.toolCalls).toBeUndefined();
  });

  it("零歧义铁律：包含说明文字的回复视为普通对话，不产生 toolCalls", () => {
    const reply = [
      "让我先看看文件：",
      "{",
      "<::: TOOL_CALL[1]",
      "tool: read_file",
      "path: a.txt",
      ":::> TOOL_CALL[1]",
      "}",
    ].join("\n");
    const result = parseToolCalls(reply);
    expect(result.text).toContain("让我先看看文件：");
    expect(result.toolCalls).toBeUndefined();
  });

  it("标准工具调用正确解析为 toolCalls", () => {
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: read_file",
      "path: a.txt",
      ":::> TOOL_CALL[1]",
      "}",
    ].join("\n");
    const result = parseToolCalls(reply);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([{ name: "read_file", arguments: { path: "a.txt" } }]);
  });

  it("未闭合的块返回 null 并判定为普通文本", () => {
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: read_file",
      "path: a.txt",
      "}",
    ].join("\n");
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toBeUndefined();
  });

  it("多个纯块逐一解析", () => {
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: read_file",
      "path: a.txt",
      ":::> TOOL_CALL[1]",
      "<::: TOOL_CALL[2]",
      "tool: terminal",
      "<::: COMMAND",
      "echo hi",
      ":::> COMMAND",
      ":::> TOOL_CALL[2]",
      "}",
    ].join("\n");
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![1]).toEqual({ name: "terminal", arguments: { command: "echo hi" } });
  });

  it("解析 PIPELINE 复合结构", () => {
    const reply = [
      "{",
      "<::: PIPELINE[p1]",
      "  <::: TOOL_CALL[1]",
      "  tool: write_file",
      "  path: a.ts",
      "  <::: CONTENT",
      "  x",
      "  :::> CONTENT",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: terminal",
      "  <::: COMMAND",
      "  pnpm test",
      "  :::> COMMAND",
      "  :::> TOOL_CALL[2]",
      ":::> PIPELINE[p1]",
      "}",
    ].join("\n");
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolTree).toHaveLength(1);
    expect(result.toolTree![0]).toMatchObject({ mode: "pipeline" });
  });

  it("解析 BATCH 复合结构", () => {
    const reply = [
      "{",
      "<::: BATCH[b1]",
      "  <::: TOOL_CALL[1]",
      "  tool: read_file",
      "  path: a.txt",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: read_file",
      "  path: b.txt",
      "  :::> TOOL_CALL[2]",
      ":::> BATCH[b1]",
      "}",
    ].join("\n");
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolTree).toHaveLength(1);
    expect(result.toolTree![0]).toMatchObject({ mode: "batch" });
  });
});

describe("GeminiBridgeThinking 执行型桥服务", () => {
  it("GET /protocol 幂等返回工具协议，且不再入队首条协议消息", async () => {
    const { port } = await makeBridge();
    const res = await fetch(`http://127.0.0.1:${port}/protocol`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; protocol: string };
    expect(body.ok).toBe(true);
    expect(body.protocol).toContain("你的工作区是 /ws-test");
    expect(body.protocol).toContain("【human-agent 工具协议】");
    const again = (await (await fetch(`http://127.0.0.1:${port}/protocol`)).json()) as { protocol: string };
    expect(again.protocol).toBe(body.protocol); // 无状态幂等：重复拉取内容一致
    expect(await tryGetMessage(port, 300)).toBeNull(); // 协议不再作为任务消息入队
  });

  it("含工具调用的内容执行后回填结果消息", async () => {
    seedWhitelist("/ws-test", [{ tool: "read_file", key: '{"path":"a.txt"}', kind: "exact" }]);
    const { port, organs } = await makeBridge();
    const res = await postReply(port, toolCall("read_file", { path: "a.txt" }));
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("工具执行结果");
    expect(message).toContain("read_file");
    expect(message).toContain("内容:a.txt");
    expect(organs.calls).toEqual([{ name: "read_file", args: { path: "a.txt" } }]);
  });

  it("无工具调用的内容不回填", async () => {
    const { port, organs } = await makeBridge();
    const res = await postReply(port, "纯文本回复");
    expect(res.processed).toBe(false);
    expect(organs.calls).toEqual([]);
  });

  it("多个工具调用汇总为一条消息并全部执行", async () => {
    seedWhitelist("/ws-test", [
      { tool: "read_file", key: '{"path":"a.txt"}', kind: "exact" },
      { tool: "terminal", key: "echo hi", kind: "exact" },
    ]);
    const { port, organs } = await makeBridge();
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: read_file",
      "path: a.txt",
      ":::> TOOL_CALL[1]",
      "<::: TOOL_CALL[2]",
      "tool: terminal",
      "<::: COMMAND",
      "echo hi",
      ":::> COMMAND",
      ":::> TOOL_CALL[2]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("read_file");
    expect(message).toContain("terminal");
    expect(organs.calls).toHaveLength(2);
  });

  it("pipeline 模式：前序工具失败后阻断后续工具执行（DEPENDENCY_BLOCKED）", async () => {
    seedWhitelist("/ws-test", [
      { tool: "read_file", key: '{"path":"bad.txt"}', kind: "exact" },
      { tool: "terminal", key: "echo next", kind: "exact" },
    ]);
    const { port, organs } = await makeBridge();
    const reply = [
      "{",
      "<::: PIPELINE[p1]",
      "  <::: TOOL_CALL[1]",
      "  tool: read_file",
      "  path: bad.txt",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: terminal",
      "  <::: COMMAND",
      "  echo next",
      "  :::> COMMAND",
      "  :::> TOOL_CALL[2]",
      ":::> PIPELINE[p1]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("1. 工具 read_file");
    expect(message).toContain("失败");
    expect(message).toContain("2. 工具 terminal");
    expect(message).toContain("已阻断（DEPENDENCY_BLOCKED");
    expect(organs.calls).toEqual([{ name: "read_file", args: { path: "bad.txt" } }]);
  });

  it("batch 模式：前序工具失败不影响后续工具独立执行", async () => {
    seedWhitelist("/ws-test", [
      { tool: "read_file", key: '{"path":"bad.txt"}', kind: "exact" },
      { tool: "terminal", key: "echo next", kind: "exact" },
    ]);
    const { port, organs } = await makeBridge();
    const reply = [
      "{",
      "<::: BATCH[b1]",
      "  <::: TOOL_CALL[1]",
      "  tool: read_file",
      "  path: bad.txt",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: terminal",
      "  <::: COMMAND",
      "  echo next",
      "  :::> COMMAND",
      "  :::> TOOL_CALL[2]",
      ":::> BATCH[b1]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("1. 工具 read_file");
    expect(message).toContain("失败");
    expect(message).toContain("2. 工具 terminal");
    expect(message).toContain("成功");
    expect(organs.calls).toHaveLength(2);
  });

  it("未列入白名单的调用下发审批，未授权不执行", async () => {
    const { port, organs } = await makeBridge({ workspace: "/ws-test" });
    const res = await postReply(port, toolCall("terminal", { command: "echo hi" }));
    expect(res.processed).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    expect(organs.calls).toEqual([]);
  });

  it("多个未列调用合并为一条审批请求", async () => {
    const { port } = await makeBridge({ workspace: "/ws-test" });
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: terminal",
      "<::: COMMAND",
      "git push --force origin main",
      ":::> COMMAND",
      ":::> TOOL_CALL[1]",
      "<::: TOOL_CALL[2]",
      "tool: terminal",
      "<::: COMMAND",
      "echo hi",
      ":::> COMMAND",
      ":::> TOOL_CALL[2]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    if (body?.type === "approval") {
      expect(body.calls).toHaveLength(2);
      expect(body.calls[0]!.arguments).toEqual({ command: "git push --force origin main" });
      expect(body.calls[1]!.arguments).toEqual({ command: "echo hi" });
    }
  });

  it("审批允许后执行并回填结果", async () => {
    const { port, organs } = await makeBridge({ workspace: "/ws-test" });
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
    const { port, organs } = await makeBridge({ workspace: "/ws-test" });
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: terminal",
      "<::: COMMAND",
      "ls -la",
      ":::> COMMAND",
      ":::> TOOL_CALL[1]",
      "<::: TOOL_CALL[2]",
      "tool: terminal",
      "<::: COMMAND",
      "echo ok",
      ":::> COMMAND",
      ":::> TOOL_CALL[2]",
      "}",
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
    expect(organs.calls.some((c) => c.args.command === "ls -la")).toBe(false);
    expect(organs.calls.some((c) => c.args.command === "echo ok")).toBe(true);
  });

  it("未知审批 id 返回 404", async () => {
    const { port } = await makeBridge();
    expect(await postApproval(port, 999, [true])).toBe(404);
  });

  it("审批兜底超时全部拒绝", async () => {
    const { port, organs } = await makeBridge({ workspace: "/ws-test", approvalTimeoutMs: 50 });
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const message = await getMessageText(port);
    expect(message).toContain("审批超时");
    expect(message).toContain("已拒绝");
    expect(organs.calls).toEqual([]);
  });

  it("close 释放挂起审批", async () => {
    const { bridge, port, organs } = await makeBridge({ workspace: "/ws-test", approvalTimeoutMs: 1000 });
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    bridge.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(organs.calls).toEqual([]);
  });

  it("全局中断作废审批并丢弃批次", async () => {
    const controller = new AbortController();
    const { port, organs } = await makeBridge({ workspace: "/ws-test", signal: controller.signal });
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(organs.calls).toEqual([]);
    expect(await postApproval(port, id, [true])).toBe(404);
  });

  it("参数非法的危险命令不进审批，直接 INVALID_ARGS 拒绝", async () => {
    const { port } = await makeBridge();
    const reply = ["{", "<::: TOOL_CALL[1]", "tool: terminal", ":::> TOOL_CALL[1]", "}"].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("参数不合法");
  });

  it("黑名单命中直接回填拒绝，不下发审批", async () => {
    const { port, organs } = await makeBridge();
    await postReply(port, toolCall("terminal", { command: "rm -rf /" }));
    const message = await getMessageText(port);
    expect(message).toContain("BLACKLIST");
    expect(message).toContain("系统破坏操作，禁止执行");
    expect(await tryGetMessage(port, 300)).toBeNull();
    expect(organs.calls).toEqual([]);
  });

  it("白名单命中静默执行（不下发审批）", async () => {
    seedWhitelist("/ws-test", [{ tool: "terminal", key: "git status", kind: "exact" }]);
    const { port, organs } = await makeBridge();
    await postReply(port, toolCall("terminal", { command: "git status" }));
    const message = await getMessageText(port);
    expect(message).toContain("工具执行结果");
    expect(message).toContain("成功");
    expect(organs.calls.some((c) => c.args.command === "git status")).toBe(true);
  });

  it("审批带回 whitelist 条目 → 落盘后生效", async () => {
    const { port } = await makeBridge({ workspace: "/ws-test" });
    await postReply(port, toolCall("terminal", { command: "ls -la" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    expect(await postApproval(port, id, [true], [{ tool: "terminal", key: "ls -la", kind: "exact" }])).toBe(200);
    await getMessageText(port);
    const raw = JSON.parse(readFileSync(tmpFile, "utf8")) as Record<string, WhitelistEntry[]>;
    expect(raw["/ws-test"]).toContainEqual({ tool: "terminal", key: "ls -la", kind: "exact" });
  });

  it("非法 whitelist 条目 → 400 拒绝（不落盘不执行）", async () => {
    const { port, organs } = await makeBridge({ workspace: "/ws-test" });
    await postReply(port, toolCall("terminal", { command: "ls -la" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const res = await postApproval(port, id, [true], [{ tool: "write_file", key: "/etc/passwd", kind: "path" }]);
    expect(res).toBe(400);
    expect(organs.calls).toEqual([]);
  });

  it("根级路径不接受 dir 条目：write_file /x.txt + key / → 400 且不执行", async () => {
    const { port, organs } = await makeBridge({ workspace: "/ws-test" });
    await postReply(port, toolCall("write_file", { path: "/x.txt", content: "x" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const res = await postApproval(port, id, [true], [{ tool: "write_file", key: "/", kind: "path" }]);
    expect(res).toBe(400);
    expect(organs.calls).toEqual([]);
  });

  it("盘符根 dir 条目 → 400（整盘放行拒绝）", async () => {
    const { port, organs } = await makeBridge({ workspace: "/ws" });
    await postReply(port, toolCall("write_file", { path: "c:/x.txt", content: "x" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const res = await postApproval(port, id, [true], [{ tool: "write_file", key: "c:/", kind: "path" }]);
    expect(res).toBe(400);
    expect(organs.calls).toEqual([]);
  });

  it("工作区启动即注册：界内写入静默执行（apply_patch 同样命中）", async () => {
    const { port, organs } = await makeBridge({ workspace: "/ws" });
    await postReply(port, toolCall("write_file", { path: "/ws/a.txt", content: "hi" }));
    const message = await getMessageText(port);
    expect(message).toContain("成功");
    expect(organs.calls.some((c) => c.name === "write_file")).toBe(true);
  });

  it("界外写入未入白名单 → 下发审批", async () => {
    const { port } = await makeBridge({ workspace: "/ws" });
    await postReply(port, toolCall("write_file", { path: "/tmp/evil.txt", content: "x" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
  });

  it("未知工具与参数非法拒绝", async () => {
    const { port } = await makeBridge();
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: hack_planet",
      ":::> TOOL_CALL[1]",
      "<::: TOOL_CALL[2]",
      "tool: read_file",
      ":::> TOOL_CALL[2]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("未知工具");
    expect(message).toContain("参数不合法");
  });

  it("相同内容再次提交仍会处理（服务端不做静默去重——重复控制属模型侧）", async () => {
    seedWhitelist("/ws-test", [{ tool: "read_file", key: '{"path":"a.txt"}', kind: "exact" }]);
    const { port, organs } = await makeBridge();
    const reply = toolCall("read_file", { path: "a.txt" });
    const first = await postReply(port, reply);
    expect(first.processed).toBe(true);
    const second = await postReply(port, reply);
    expect(second.processed).toBe(true);
    await getMessageText(port);
    await getMessageText(port);
    expect(organs.calls).toHaveLength(2);
  });

  it("批超时队列执行超时说明", async () => {
    seedWhitelist("/ws-test", [{ tool: "terminal", key: "slow", kind: "exact" }]);
    const { port, organs } = await makeBridge({ timeoutMs: 100 });
    const res = await postReply(port, toolCall("terminal", { command: "slow" }));
    expect(res.processed).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("超时");
    expect(organs.calls.some((c) => c.args.command === "slow")).toBe(true);
  });

  it("全局中断丢弃批次", async () => {
    const controller = new AbortController();
    const { port, organs } = await makeBridge({ signal: controller.signal });
    controller.abort();
    const reply = [
      "{",
      "<::: TOOL_CALL[1]",
      "tool: read_file",
      "path: a.txt",
      ":::> TOOL_CALL[1]",
      "<::: TOOL_CALL[2]",
      "tool: read_file",
      "path: b.txt",
      ":::> TOOL_CALL[2]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(res.processed).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(organs.calls.some((c) => c.args.path === "b.txt")).toBe(false);
  });

  it("close 释放挂起长轮询", async () => {
    const { bridge, port } = await makeBridge();
    const poll = getMessage(port);
    bridge.close();
    await expect(poll).resolves.toBeNull();
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