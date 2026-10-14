// bridge 域：createBridge 全端点（统一信封）+ 管线不变量（options 预构造 / 回显校验 / 候选两钩子 / close 语义）。
// 风格铁律（T7 延续）：判别联合先收窄 `status` 再取 `data`/`error`，禁止 `.data?./.error?.`。
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createBridge } from "../src/bridge/index.js";
import { parseToolCalls } from "../src/bridge/pipeline.js";
import { normalizeMatchKey } from "../src/permission/index.js";
import type { TrustEntry } from "../src/tool/index.js";
import type { ActionResult, EyesContract, HandsContract } from "../src/types/index.js";
import { fail, ok } from "../src/types/index.js";

// ---------- 夹具 ----------
const tmpDir = mkdtempSync(join(tmpdir(), "bridge-wl-"));
const wsDir = mkdtempSync(join(tmpdir(), "bridge-ws-"));
const wsReal = realpathSync.native(wsDir);
const wsKey = normalizeMatchKey(wsReal);
const outDir = mkdtempSync(join(tmpdir(), "bridge-out-"));
const outReal = normalizeMatchKey(realpathSync.native(outDir));
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

/** 界内路径/键助手：与管道「最深已存在祖先归实」严格同键。 */
const keyOf = (rel: string): string => normalizeMatchKey(join(wsReal, rel));
/** 界外文件：输入路径（原始）/ 期望执行落点（realpath 后）/ 匹配键。 */
const outPath = (name: string): string => join(outDir, name);
const outExec = (name: string): string => join(realpathSync.native(outDir), name);
const outKey = (name: string): string => normalizeMatchKey(join(realpathSync.native(outDir), name));

let seq = 0;
function files(): { whitelistFile: string; candidatesFile: string } {
  const base = join(tmpDir, `case-${seq++}`);
  return { whitelistFile: `${base}-whitelist.json`, candidatesFile: `${base}-candidates.json` };
}

/** 预置白名单（v1 容器；createBridge 构造前写入——白名单在构造时加载）。 */
function seedWhitelist(file: string, entries: TrustEntry[]): void {
  writeFileSync(file, JSON.stringify({ version: 1, workspaces: { [wsKey]: entries } }), "utf8");
}

function whitelistEntries(file: string): TrustEntry[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    workspaces?: Record<string, TrustEntry[]>;
  };
  return parsed.workspaces?.[wsKey] ?? [];
}

function candidateList(file: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    workspaces?: Record<string, Array<Record<string, unknown>>>;
  };
  return parsed.workspaces?.[wsKey] ?? [];
}

// ---------- 记录型 stub 器官（新工具名） ----------
function makeRecordingOrgans() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const eyes: EyesContract = {
    readFile: async (path, options) => {
      calls.push({ name: "file_read", args: { path, ...options } });
      if (path.endsWith("bad.txt")) return fail("file-not-found", "文件不存在");
      return ok({ content: `内容:${path}`, versionId: "v-test1234", totalLines: 10 });
    },
    readDir: async (path) => {
      calls.push({ name: "dir_list", args: { path } });
      return ok(["a.txt"]);
    },
    searchCode: async (pattern, dir) => {
      calls.push({ name: "code_search", args: { pattern, dir } });
      return ok([]);
    },
    fetchPageAsMarkdown: async (url) => {
      calls.push({ name: "page_fetch", args: { url } });
      return ok("# 网页");
    },
  };
  const hands: HandsContract = {
    writeFile: async (path, content) => {
      calls.push({ name: "file_write", args: { path, content } });
      return ok(undefined);
    },
    applyPatch: async (path, patch) => {
      calls.push({ name: "file_patch", args: { path, patch } });
      return ok(undefined);
    },
    editFile: async (path, hunks, baseVersion) => {
      calls.push({ name: "file_edit", args: { path, hunks, baseVersion } });
      return ok({ path, newVersionId: "v-new1234", hunksApplied: hunks.length });
    },
    executeCommand: async (command, _signal, timeoutMs) => {
      calls.push({ name: "command_run", args: { command, timeoutMs } });
      if (command === "slow") await new Promise((resolve) => setTimeout(resolve, 10_000));
      if (command === "fail-cmd") return fail("command-failed", "命令失败");
      return ok({ stdout: `输出:${command}`, exitCode: 0 });
    },
  };
  return { calls, eyes, hands };
}

// ---------- 统一信封类型与断言助手 ----------
interface EnvelopeOk {
  status: "ok";
  data?: unknown;
}
interface EnvelopeError {
  status: "error";
  error: { code: string; message: string };
}
type EnvelopeBody = EnvelopeOk | EnvelopeError;
type ResponseBody = { status: number; envelope: EnvelopeBody };

function okData<T>(envelope: EnvelopeBody): T {
  if (envelope.status !== "ok") throw new Error(`期望 ok 信封：${JSON.stringify(envelope)}`);
  return envelope.data as T;
}

function errorCode(envelope: EnvelopeBody): string {
  if (envelope.status !== "error") throw new Error(`期望 error 信封：${JSON.stringify(envelope)}`);
  return envelope.error.code;
}

// ---------- 桥夹具与 HTTP 助手 ----------
type TaskItemBody =
  | { type: "message"; message: string }
  | {
      type: "approval";
      id: number;
      calls: Array<{ name: string; arguments: Record<string, unknown> }>;
      options: TrustEntry[][];
    };

const openBridges: Array<{ close(): void }> = [];
afterEach(() => {
  for (const bridge of openBridges.splice(0)) bridge.close();
});

interface MakeBridgeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  approvalTimeoutMs?: number;
  seed?: TrustEntry[];
}

async function makeBridge(options: MakeBridgeOptions = {}) {
  const organs = makeRecordingOrgans();
  const { whitelistFile, candidatesFile } = files();
  if (options.seed !== undefined) seedWhitelist(whitelistFile, options.seed);
  const bridge = createBridge({
    workspace: wsReal,
    port: 0,
    whitelistFile,
    candidatesFile,
    eyes: organs.eyes,
    hands: organs.hands,
    logger: () => {},
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
  });
  openBridges.push(bridge);
  const port = await bridge.getPort();
  return { bridge, port, organs, whitelistFile, candidatesFile };
}

async function getMessage(port: number): Promise<TaskItemBody | null> {
  const res = await fetch(`http://127.0.0.1:${port}/task`);
  if (res.status === 204) return null;
  const envelope = (await res.json()) as EnvelopeBody;
  if (envelope.status !== "ok") throw new Error(`期望 ok 信封：${JSON.stringify(envelope)}`);
  if (envelope.data === undefined) throw new Error("ok 信封缺少 data");
  return envelope.data as TaskItemBody;
}

async function tryGetMessage(port: number, ms: number): Promise<TaskItemBody | null> {
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

function processedOf(envelope: EnvelopeBody): boolean {
  return okData<{ processed: boolean }>(envelope).processed;
}

async function postReply(port: number, reply: string): Promise<ResponseBody> {
  const res = await fetch(`http://127.0.0.1:${port}/task/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  return { status: res.status, envelope: (await res.json()) as EnvelopeBody };
}

async function postApprovalRaw(
  port: number,
  id: number,
  allowed: boolean[],
  whitelist?: TrustEntry[],
): Promise<ResponseBody> {
  const body: Record<string, unknown> = { id, allowed };
  if (whitelist !== undefined && whitelist.length > 0) body.whitelist = whitelist;
  const res = await fetch(`http://127.0.0.1:${port}/task/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, envelope: (await res.json()) as EnvelopeBody };
}

async function postApproval(
  port: number,
  id: number,
  allowed: boolean[],
  whitelist?: TrustEntry[],
): Promise<number> {
  return (await postApprovalRaw(port, id, allowed, whitelist)).status;
}

async function getEnvelope(port: number, path: string): Promise<ResponseBody> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, envelope: (await res.json()) as EnvelopeBody };
}

async function postJson(port: number, path: string, body: unknown): Promise<ResponseBody> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, envelope: (await res.json()) as EnvelopeBody };
}

// ---------- 工具调用文本构造 ----------
function callLines(tool: string, args: Record<string, unknown>, id: string): string[] {
  const lines = [`<::: TOOL_CALL[${id}]`, `tool: ${tool}`];
  for (const [k, v] of Object.entries(args)) {
    if (k === "content") {
      lines.push("<::: CONTENT", String(v), ":::> CONTENT");
    } else if (k === "command") {
      lines.push("<::: COMMAND", String(v), ":::> COMMAND");
    } else {
      // 注意：ASTParser 的 CONTENT/COMMAND 块固定映射到 content/command 键，file_patch 的 patch 键只能走单行平铺参数。
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push(`:::> TOOL_CALL[${id}]`);
  return lines;
}

/** 单容器多块回复：`{ 块… }`。 */
function blocks(...calls: Array<{ tool: string; args: Record<string, unknown>; id: string }>): string {
  const lines: string[] = ["{"];
  for (const call of calls) lines.push(...callLines(call.tool, call.args, call.id));
  lines.push("}");
  return lines.join("\n");
}

/** 标准单调用回复（带外层容器）。 */
function toolCall(tool: string, args: Record<string, unknown>, id = "1"): string {
  return blocks({ tool, args, id });
}

describe("parseToolCalls AST 状态机解析器", () => {
  it("纯文本不产生 toolCalls", () => {
    const result = parseToolCalls("你好，我是 human-agent");
    expect(result.text).toBe("你好，我是 human-agent");
    expect(result.toolCalls).toBeUndefined();
  });

  it("零歧义铁律：包含说明文字的回复视为普通对话，不产生 toolCalls", () => {
    const reply = ["让我先看看文件：", toolCall("file_read", { path: "a.txt" })].join("\n");
    const result = parseToolCalls(reply);
    expect(result.text).toContain("让我先看看文件：");
    expect(result.toolCalls).toBeUndefined();
  });

  it("标准工具调用正确解析为 toolCalls", () => {
    const result = parseToolCalls(toolCall("file_read", { path: "a.txt" }));
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([{ name: "file_read", arguments: { path: "a.txt" } }]);
  });

  it("未闭合的块返回 null 并判定为普通文本", () => {
    const reply = ["{", "<::: TOOL_CALL[1]", "tool: file_read", "path: a.txt", "}"].join("\n");
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toBeUndefined();
  });

  it("多个纯块逐一解析", () => {
    const reply = blocks(
      { tool: "file_read", args: { path: "a.txt" }, id: "1" },
      { tool: "command_run", args: { command: "echo hi" }, id: "2" },
    );
    const result = parseToolCalls(reply);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![1]).toEqual({ name: "command_run", arguments: { command: "echo hi" } });
  });

  it("解析 PIPELINE 复合结构", () => {
    const reply = [
      "{",
      "<::: PIPELINE[p1]",
      "  <::: TOOL_CALL[1]",
      "  tool: file_write",
      "  path: a.ts",
      "  <::: CONTENT",
      "  x",
      "  :::> CONTENT",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: command_run",
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
      "  tool: file_read",
      "  path: a.txt",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: file_read",
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

describe("createBridge 端点与统一信封", () => {
  it("成员表冻结：Object.keys(bridge) === [close, getPort]", async () => {
    const { bridge } = await makeBridge();
    expect(Object.keys(bridge).sort()).toEqual(["close", "getPort"]);
  });

  it("GET /agent/protocol：ok 信封幂等返回协议，且不再入队协议消息", async () => {
    const { port } = await makeBridge();
    const first = await getEnvelope(port, "/agent/protocol");
    expect(first.status).toBe(200);
    const protocol = okData<{ protocol: string }>(first.envelope).protocol;
    expect(protocol).toContain(`你的工作区是 ${wsReal}`);
    expect(protocol).toContain("【human-agent 工具协议】");
    const again = await getEnvelope(port, "/agent/protocol");
    expect(okData<{ protocol: string }>(again.envelope).protocol).toBe(protocol);
    expect(await tryGetMessage(port, 300)).toBeNull();
  });

  it("GET /agent/info：ok 信封返回当前工作区", async () => {
    const { port } = await makeBridge();
    const res = await getEnvelope(port, "/agent/info");
    expect(res.status).toBe(200);
    expect(res.envelope).toEqual({ status: "ok", data: { workspace: wsReal } });
  });

  it("GET /permission/candidates：初始为空列表的信封", async () => {
    const { port } = await makeBridge();
    const res = await getEnvelope(port, "/permission/candidates");
    expect(res.status).toBe(200);
    expect(res.envelope).toEqual({ status: "ok", data: { candidates: [] } });
  });

  it("POST /task/reply：processed 字段信封（纯文本 false / 有调用 true）", async () => {
    const text = await postReply(await (await makeBridge()).port, "纯文本回复");
    expect(text.status).toBe(200);
    expect(text.envelope).toEqual({ status: "ok", data: { processed: false } });
    const { port } = await makeBridge({
      seed: [{ tool: "command_run", key: "echo hi", scope: "self" }],
    });
    const calls = await postReply(port, toolCall("command_run", { command: "echo hi" }));
    expect(calls.status).toBe(200);
    expect(processedOf(calls.envelope)).toBe(true);
    await getMessageText(port);
  });

  it("POST /task/reply 畸形 JSON → 400 invalid-body", async () => {
    const { port } = await makeBridge();
    const res = await postJson(port, "/task/reply", "{不是 JSON");
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
  });

  it("POST /task/approval 畸形 JSON → 400 invalid-body", async () => {
    const { port } = await makeBridge();
    const res = await postJson(port, "/task/approval", "{不是 JSON");
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
  });

  it("GET 打 POST 端点 → 405 method-not-allowed", async () => {
    const { port } = await makeBridge();
    const res = await getEnvelope(port, "/task/reply");
    expect(res.status).toBe(405);
    expect(errorCode(res.envelope)).toBe("method-not-allowed");
  });

  it("未知路径 → 404 unknown-endpoint", async () => {
    const { port } = await makeBridge();
    const res = await getEnvelope(port, "/nope");
    expect(res.status).toBe(404);
    expect(errorCode(res.envelope)).toBe("unknown-endpoint");
  });

  it("审批结构错误（id 非数字 / allowed 非布尔数组）→ 400 invalid-body", async () => {
    const { port } = await makeBridge();
    const badId = await postJson(port, "/task/approval", { id: "x", allowed: [true] });
    expect(badId.status).toBe(400);
    expect(errorCode(badId.envelope)).toBe("invalid-body");
    const badAllowed = await postJson(port, "/task/approval", { id: 1, allowed: ["y"] });
    expect(badAllowed.status).toBe(400);
    expect(errorCode(badAllowed.envelope)).toBe("invalid-body");
  });

  it("未知审批 id → 404 unknown-approval", async () => {
    const { port } = await makeBridge();
    const res = await postApprovalRaw(port, 999, [true]);
    expect(res.status).toBe(404);
    expect(errorCode(res.envelope)).toBe("unknown-approval");
  });

  it("空长轮询：裸 204（无信封；close 释放路径）", async () => {
    const { bridge, port } = await makeBridge();
    const poll = fetch(`http://127.0.0.1:${port}/task`);
    await new Promise((resolve) => setTimeout(resolve, 100)); // 确保请求已达服务端并注册 waiter
    bridge.close();
    const res = await poll;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("close 释放挂起长轮询", async () => {
    const { bridge, port } = await makeBridge();
    const poll = getMessage(port);
    bridge.close();
    await expect(poll).resolves.toBeNull();
  });

  it("close 后端点不可达（连接拒绝）或 204", async () => {
    const { bridge, port } = await makeBridge();
    const before = await getEnvelope(port, "/agent/info");
    expect(before.status).toBe(200);
    bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const info = await fetch(`http://127.0.0.1:${port}/agent/info`).catch(() => null);
    if (info !== null) expect(info.status).toBe(204);
    const candidates = await fetch(`http://127.0.0.1:${port}/permission/candidates`).catch(() => null);
    if (candidates !== null) expect(candidates.status).toBe(204);
  });

  it("close 中止在途批执行：级联 AbortSignal 到双手，且不再产生超时回填", async () => {
    const { whitelistFile, candidatesFile } = files();
    seedWhitelist(whitelistFile, [{ tool: "command_run", key: "hang", scope: "self" }]);
    let aborted = false;
    const hands: HandsContract = {
      writeFile: async () => ok(undefined),
      applyPatch: async () => ok(undefined),
      editFile: async () => ok(undefined),
      executeCommand: (_command, signal) =>
        new Promise<ActionResult<unknown>>((resolve) => {
          const done = (): void => {
            aborted = true;
            resolve(fail("exec-error", "已中止"));
          };
          if (signal?.aborted === true) { done(); return; }
          signal?.addEventListener("abort", done, { once: true });
        }),
    };
    const logs: string[] = [];
    const bridge = createBridge({
      workspace: wsReal,
      port: 0,
      whitelistFile,
      candidatesFile,
      hands,
      timeoutMs: 60_000,
      logger: (text) => logs.push(text),
    });
    openBridges.push(bridge);
    const port = await bridge.getPort();
    await postReply(port, toolCall("command_run", { command: "hang" }));
    await new Promise((resolve) => setTimeout(resolve, 100)); // 确保批执行已进入双手
    bridge.close();
    const seen = await new Promise<boolean>((resolve) => {
      const poll = setInterval(() => {
        if (aborted) { clearInterval(poll); clearTimeout(cap); resolve(true); }
      }, 10);
      const cap = setTimeout(() => { clearInterval(poll); resolve(false); }, 500);
    });
    expect(seen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50)); // 待管线收尾
    expect(logs.some((text) => text.includes("回填消息已入队"))).toBe(false);
  });

  it("请求体超 1MB 上限 → 400 invalid-body（message 说明上限）", async () => {
    const { port } = await makeBridge();
    const huge = JSON.stringify({
      items: [{ tool: "command_run", key: "a".repeat(1_200_000), scope: "self" }],
    });
    const res = await postJson(port, "/permission/whitelist/revoke", huge);
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
    if (res.envelope.status === "error") expect(res.envelope.error.message).toContain("1MB");
  });

  it("监听冲突在创建时被捕获：getPort 迟到仍拒绝（不产生未处理 error）", async () => {
    const a = await makeBridge();
    const { whitelistFile, candidatesFile } = files();
    const logs: string[] = [];
    const b = createBridge({
      workspace: wsReal,
      port: a.port,
      whitelistFile,
      candidatesFile,
      logger: (text) => logs.push(text),
    });
    openBridges.push(b);
    await new Promise((resolve) => setTimeout(resolve, 150)); // 让 EADDRINUSE 先行触发
    await expect(b.getPort()).rejects.toThrow();
    expect(logs.some((text) => text.includes("监听失败"))).toBe(true);
  });

  it("域失败不抬升信封：批执行超时回填为域消息，GET /task 仍 200 ok", async () => {
    const { port, organs } = await makeBridge({
      timeoutMs: 100,
      seed: [{ tool: "command_run", key: "slow", scope: "self" }],
    });
    const res = await postReply(port, toolCall("command_run", { command: "slow" }));
    expect(processedOf(res.envelope)).toBe(true);
    const raw = await fetch(`http://127.0.0.1:${port}/task`);
    expect(raw.status).toBe(200);
    const envelope = (await raw.json()) as EnvelopeBody;
    if (envelope.status !== "ok") throw new Error(`期望 ok 信封：${JSON.stringify(envelope)}`);
    const item = envelope.data as TaskItemBody;
    expect(item.type).toBe("message");
    if (item.type === "message") expect(item.message).toContain("工具执行超时");
    expect(organs.calls.some((call) => call.args.command === "slow")).toBe(true);
  });
});

describe("执行流与审批（旧桥用例逐条移植）", () => {
  it("含工具调用的内容执行后回填结果消息", async () => {
    const { port, organs } = await makeBridge({
      seed: [{ tool: "file_read", key: keyOf("a.txt"), scope: "self" }],
    });
    const res = await postReply(port, toolCall("file_read", { path: "a.txt" }));
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("工具执行结果");
    expect(message).toContain("file_read");
    expect(message).toContain("内容:");
    expect(message).toContain("a.txt");
    expect(organs.calls).toEqual([{ name: "file_read", args: { path: join(wsReal, "a.txt") } }]);
  });

  it("无工具调用的内容不回填", async () => {
    const { port, organs } = await makeBridge();
    const res = await postReply(port, "纯文本回复");
    expect(processedOf(res.envelope)).toBe(false);
    expect(organs.calls).toEqual([]);
    expect(await tryGetMessage(port, 300)).toBeNull();
  });

  it("多个工具调用汇总为一条消息并全部执行", async () => {
    const { port, organs } = await makeBridge({
      seed: [
        { tool: "file_read", key: keyOf("a.txt"), scope: "self" },
        { tool: "command_run", key: "echo hi", scope: "self" },
      ],
    });
    const reply = blocks(
      { tool: "file_read", args: { path: "a.txt" }, id: "1" },
      { tool: "command_run", args: { command: "echo hi" }, id: "2" },
    );
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("file_read");
    expect(message).toContain("command_run");
    expect(organs.calls).toHaveLength(2);
  });

  it("pipeline 模式：前序工具失败后阻断后续工具执行（dependency-blocked）", async () => {
    const { port, organs } = await makeBridge({
      seed: [
        { tool: "file_read", key: keyOf("bad.txt"), scope: "self" },
        { tool: "command_run", key: "echo next", scope: "self" },
      ],
    });
    const reply = [
      "{",
      "<::: PIPELINE[p1]",
      "  <::: TOOL_CALL[1]",
      "  tool: file_read",
      "  path: bad.txt",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: command_run",
      "  <::: COMMAND",
      "  echo next",
      "  :::> COMMAND",
      "  :::> TOOL_CALL[2]",
      ":::> PIPELINE[p1]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("1. 工具 file_read");
    expect(message).toContain("失败");
    expect(message).toContain("2. 工具 command_run");
    expect(message).toContain("已阻断（dependency-blocked");
    expect(organs.calls).toEqual([{ name: "file_read", args: { path: join(wsReal, "bad.txt") } }]);
  });

  it("batch 模式：前序工具失败不影响后续工具独立执行", async () => {
    const { port, organs } = await makeBridge({
      seed: [
        { tool: "file_read", key: keyOf("bad.txt"), scope: "self" },
        { tool: "command_run", key: "echo next", scope: "self" },
      ],
    });
    const reply = [
      "{",
      "<::: BATCH[b1]",
      "  <::: TOOL_CALL[1]",
      "  tool: file_read",
      "  path: bad.txt",
      "  :::> TOOL_CALL[1]",
      "  <::: TOOL_CALL[2]",
      "  tool: command_run",
      "  <::: COMMAND",
      "  echo next",
      "  :::> COMMAND",
      "  :::> TOOL_CALL[2]",
      ":::> BATCH[b1]",
      "}",
    ].join("\n");
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("1. 工具 file_read");
    expect(message).toContain("失败");
    expect(message).toContain("2. 工具 command_run");
    expect(message).toContain("成功");
    expect(organs.calls).toHaveLength(2);
  });

  it("未列入白名单的调用下发审批（含 options 预构造），未授权不执行", async () => {
    const { port, organs } = await makeBridge();
    const res = await postReply(port, toolCall("command_run", { command: "echo hi" }));
    expect(processedOf(res.envelope)).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    if (body?.type === "approval") {
      expect(typeof body.id).toBe("number");
      expect(body.calls).toEqual([{ name: "command_run", arguments: { command: "echo hi" } }]);
      expect(body.options).toEqual([[{ tool: "command_run", key: "echo hi", scope: "self" }]]);
    }
    expect(organs.calls).toEqual([]);
  });

  it("多个未列调用合并为一条审批请求（含命令键归一与 options 同序）", async () => {
    const { port } = await makeBridge();
    const reply = blocks(
      { tool: "command_run", args: { command: "git push --force origin main" }, id: "1" },
      { tool: "command_run", args: { command: "echo hi" }, id: "2" },
    );
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    if (body?.type === "approval") {
      expect(body.calls).toHaveLength(2);
      expect(body.calls[0]!.arguments).toEqual({ command: "git push --force origin main" });
      expect(body.calls[1]!.arguments).toEqual({ command: "echo hi" });
      expect(body.options).toEqual([
        [{ tool: "command_run", key: "git push --force origin main", scope: "self" }],
        [{ tool: "command_run", key: "echo hi", scope: "self" }],
      ]);
    }
  });

  it("审批载荷 options 正确：两粒度路径 / 单粒度命令 / 键缺失 []", async () => {
    const { port } = await makeBridge();
    const reply = blocks(
      { tool: "file_write", args: { path: outPath("opt-a.txt"), content: "x" }, id: "1" },
      { tool: "command_run", args: { command: "echo hi" }, id: "2" },
      { tool: "file_read", args: { path: "  " }, id: "3" },
    );
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    if (body?.type === "approval") {
      expect(body.calls.map((call) => call.name)).toEqual(["file_write", "command_run", "file_read"]);
      expect(body.options).toEqual([
        [
          { tool: "file_write", key: outKey("opt-a.txt"), scope: "self" },
          { tool: "file_write", key: `${outReal}/`, scope: "subtree" },
        ],
        [{ tool: "command_run", key: "echo hi", scope: "self" }],
        [],
      ]);
    }
  });

  it("审批允许后执行并回填结果（成功信封无 data）", async () => {
    const { port, organs } = await makeBridge();
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const res = await postApprovalRaw(port, id, [true]);
    expect(res.status).toBe(200);
    expect(res.envelope).toEqual({ status: "ok" });
    const message = await getMessageText(port);
    expect(message).toContain("工具执行结果");
    expect(message).toContain("command_run");
    expect(organs.calls.some((call) => call.args.command === "echo hi")).toBe(true);
  });

  it("审批逐条裁决：允许的执行、拒绝的生成拒绝行", async () => {
    const { port, organs } = await makeBridge();
    const reply = blocks(
      { tool: "command_run", args: { command: "ls -la" }, id: "1" },
      { tool: "command_run", args: { command: "echo ok" }, id: "2" },
    );
    await postReply(port, reply);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    expect(await postApproval(port, id, [false, true])).toBe(200);
    const message = await getMessageText(port);
    expect(message).toContain("已拒绝");
    expect(message).toContain("用户未授权");
    expect(message).toContain("echo ok");
    expect(organs.calls.some((call) => call.args.command === "ls -la")).toBe(false);
    expect(organs.calls.some((call) => call.args.command === "echo ok")).toBe(true);
  });

  it("allowed 与调用数不一致 → 400 invalid-body", async () => {
    const { port } = await makeBridge();
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    const body = await getMessage(port);
    const id = (body as { id: number }).id;
    const res = await postApprovalRaw(port, id, [true, false]);
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
  });

  it("审批兜底超时全部拒绝", async () => {
    const { port, organs } = await makeBridge({ approvalTimeoutMs: 50 });
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const message = await getMessageText(port);
    expect(message).toContain("审批超时");
    expect(message).toContain("已拒绝");
    expect(organs.calls).toEqual([]);
  });

  it("close 释放挂起审批（不执行）", async () => {
    const { bridge, port, organs } = await makeBridge({ approvalTimeoutMs: 1000 });
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(organs.calls).toEqual([]);
  });

  it("全局中断作废审批并丢弃批次", async () => {
    const controller = new AbortController();
    const { port, organs } = await makeBridge({ signal: controller.signal });
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(organs.calls).toEqual([]);
    expect(await postApproval(port, id, [true])).toBe(404);
  });

  it("全局中断丢弃批次（提交后即中止，不执行任何调用）", async () => {
    const controller = new AbortController();
    const { port, organs } = await makeBridge({ signal: controller.signal });
    controller.abort();
    const reply = blocks(
      { tool: "file_read", args: { path: "a.txt" }, id: "1" },
      { tool: "file_read", args: { path: "b.txt" }, id: "2" },
    );
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(organs.calls.some((call) => call.args.path === join(wsReal, "b.txt"))).toBe(false);
    expect(organs.calls).toEqual([]);
  });

  it("参数非法的危险命令不进审批，直接 invalid-args 拒绝", async () => {
    const { port } = await makeBridge();
    const reply = ["{", "<::: TOOL_CALL[1]", "tool: command_run", ":::> TOOL_CALL[1]", "}"].join("\n");
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("invalid-args");
    expect(message).toContain("参数校验失败");
    expect(await tryGetMessage(port, 300)).toBeNull();
  });

  it("黑名单命中直接回填拒绝，不下发审批", async () => {
    const { port, organs } = await makeBridge();
    await postReply(port, toolCall("command_run", { command: "rm -rf /" }));
    const message = await getMessageText(port);
    expect(message).toContain("blacklist");
    expect(message).toContain("黑名单命中");
    expect(await tryGetMessage(port, 300)).toBeNull();
    expect(organs.calls).toEqual([]);
  });

  it("白名单命中静默执行（不下发审批）", async () => {
    const { port, organs } = await makeBridge({
      seed: [{ tool: "command_run", key: "git status", scope: "self" }],
    });
    await postReply(port, toolCall("command_run", { command: "git status" }));
    const message = await getMessageText(port);
    expect(message).toContain("工具执行结果");
    expect(message).toContain("成功");
    expect(organs.calls.some((call) => call.args.command === "git status")).toBe(true);
  });

  it("构造工作区信任：界内读 / 写 / patch 静默执行（写蕴含读）", async () => {
    const { port, organs } = await makeBridge();
    const reply = blocks(
      { tool: "file_read", args: { path: "in.txt" }, id: "1" },
      { tool: "file_write", args: { path: join(wsReal, "a.txt"), content: "hi" }, id: "2" },
      { tool: "file_patch", args: { path: join(wsReal, "a.txt"), patch: "- a" }, id: "3" },
    );
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("file_read");
    expect(message).toContain("file_write");
    expect(message).toContain("file_patch");
    expect(message).not.toContain("已拒绝");
    expect(organs.calls).toHaveLength(3);
  });

  it("界外写入未入白名单 → 下发审批", async () => {
    const { port } = await makeBridge();
    await postReply(port, toolCall("file_write", { path: outPath("evil.txt"), content: "x" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
  });

  it("未知工具与参数非法拒绝", async () => {
    const { port } = await makeBridge();
    const reply = blocks(
      { tool: "hack_planet", args: {}, id: "1" },
      { tool: "file_read", args: {}, id: "2" },
    );
    const res = await postReply(port, reply);
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("未知工具");
    expect(message).toContain("参数校验失败");
  });

  it("相同内容再次提交仍会处理（服务端不做静默去重——重复控制属模型侧）", async () => {
    const { port, organs } = await makeBridge({
      seed: [{ tool: "file_read", key: keyOf("a.txt"), scope: "self" }],
    });
    const reply = toolCall("file_read", { path: "a.txt" });
    const first = await postReply(port, reply);
    expect(processedOf(first.envelope)).toBe(true);
    const second = await postReply(port, reply);
    expect(processedOf(second.envelope)).toBe(true);
    await getMessageText(port);
    await getMessageText(port);
    expect(organs.calls).toHaveLength(2);
  });

  it("批超时队列执行超时说明", async () => {
    const { port, organs } = await makeBridge({
      timeoutMs: 100,
      seed: [{ tool: "command_run", key: "slow", scope: "self" }],
    });
    const res = await postReply(port, toolCall("command_run", { command: "slow" }));
    expect(processedOf(res.envelope)).toBe(true);
    const message = await getMessageText(port);
    expect(message).toContain("超时");
    expect(organs.calls.some((call) => call.args.command === "slow")).toBe(true);
  });

  it("旧版 exact-JSON 读条目失效 → 重新按未信任处置（界外读下发审批，不自动迁移不崩溃）", async () => {
    // 旧版匹配键形态：read_file 走参数 JSON 序列化——新管道下必然不命中
    const legacyKey = JSON.stringify({ path: outPath("legacy-out.txt").replace(/\\/g, "/") });
    const { port } = await makeBridge({
      seed: [{ tool: "file_read", key: legacyKey, scope: "self" }],
    });
    const res = await postReply(port, toolCall("file_read", { path: outPath("legacy-out.txt") }));
    expect(processedOf(res.envelope)).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval"); // 旧条目不再静默放行；界外 → 审批
  });
});

describe("白名单与候选端点（审批回显 / 批量入库 / 查看 / 撤销 / 清除）", () => {
  it("审批带回 whitelist 条目 → 回显校验通过 → v1 落盘后生效", async () => {
    const { port, whitelistFile } = await makeBridge();
    await postReply(port, toolCall("command_run", { command: "ls -la" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const entry: TrustEntry = { tool: "command_run", key: "ls -la", scope: "self" };
    expect(await postApproval(port, id, [true], [entry])).toBe(200);
    await getMessageText(port);
    const raw = JSON.parse(readFileSync(whitelistFile, "utf8")) as { version: number };
    expect(raw.version).toBe(1);
    expect(whitelistEntries(whitelistFile)).toContainEqual(entry);
  });

  it("回显非 options 成员 → 400 拒绝（不落盘不执行）", async () => {
    const { port, organs, candidatesFile } = await makeBridge();
    await postReply(port, toolCall("command_run", { command: "ls -la" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const res = await postApprovalRaw(port, id, [true], [
      { tool: "file_write", key: "c:/whatever", scope: "self" },
    ]);
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
    expect(organs.calls).toEqual([]);
    expect(existsSync(candidatesFile)).toBe(false); // 拒绝先于记账：候选未入档
  });

  it("回显 allowed=false 调用之 option → 400 拒绝", async () => {
    const { port, organs } = await makeBridge();
    const reply = blocks(
      { tool: "command_run", args: { command: "ls -la" }, id: "1" },
      { tool: "command_run", args: { command: "echo ok" }, id: "2" },
    );
    await postReply(port, reply);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const res = await postApprovalRaw(port, id, [true, false], [
      { tool: "command_run", key: "echo ok", scope: "self" },
    ]);
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
    expect(organs.calls).toEqual([]);
  });

  it("合法回显（目录粒度）→ 200 + 落盘 + 候选核销 + 同子树静默", async () => {
    const { port, organs, whitelistFile, candidatesFile } = await makeBridge();
    await postReply(port, toolCall("file_write", { path: outPath("two-gran.txt"), content: "x" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const subtreeEntry: TrustEntry = { tool: "file_write", key: `${outReal}/`, scope: "subtree" };
    expect(await postApproval(port, id, [true], [subtreeEntry])).toBe(200);
    const message = await getMessageText(port);
    expect(message).toContain("成功");
    expect(whitelistEntries(whitelistFile)).toContainEqual(subtreeEntry);
    expect(candidateList(candidatesFile)).toEqual([]); // 入库即核销
    // 同子树另一文件：静默执行（子树覆盖）
    await postReply(port, toolCall("file_write", { path: outPath("two-gran-sibling.txt"), content: "x" }));
    const sibling = await getMessageText(port);
    expect(sibling).toContain("成功");
    expect(organs.calls.some((call) => call.args.path === outExec("two-gran-sibling.txt"))).toBe(true);
  });

  it("盘符根路径：子树选项退化为 self，整盘条目非成员 → 400", async () => {
    const { port, organs } = await makeBridge();
    await postReply(port, toolCall("file_write", { path: "c:/x.txt", content: "x" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const res = await postApprovalRaw(port, id, [true], [{ tool: "file_write", key: "c:/", scope: "subtree" }]);
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
    expect(organs.calls).toEqual([]);
  });

  it("桥自记：审批裁决入档（批内聚合计数；允许/拒绝同形）", async () => {
    const { port, candidatesFile } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    const body = await getMessage(port);
    const id = (body as { id: number }).id;
    expect(await postApproval(port, id, [false])).toBe(200);
    await getMessageText(port);
    expect(candidateList(candidatesFile)).toContainEqual(
      expect.objectContaining({ tool: "command_run", key: "echo hi", "deny-count": 1, "allow-count": 0 }),
    );
    // 再来一次允许：同条聚合
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    const body2 = await getMessage(port);
    expect(await postApproval(port, (body2 as { id: number }).id, [true])).toBe(200);
    await getMessageText(port);
    expect(candidateList(candidatesFile)).toContainEqual(
      expect.objectContaining({ tool: "command_run", key: "echo hi", "deny-count": 1, "allow-count": 1 }),
    );
  });

  it("桥自记：审批兜底超时 settle 全拒时入档 denied", async () => {
    const { port, candidatesFile } = await makeBridge({ approvalTimeoutMs: 50 });
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    await getMessage(port);
    await getMessageText(port); // 超时拒绝行
    expect(candidateList(candidatesFile)).toContainEqual(
      expect.objectContaining({ tool: "command_run", key: "echo hi", "deny-count": 1 }),
    );
  });

  it("close 释放的挂起审批不入档（非用户裁决，属关闭噪音）", async () => {
    const { bridge, port, candidatesFile } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("command_run", { command: "echo hi" }));
    await getMessage(port);
    bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(existsSync(candidatesFile)).toBe(false);
  });

  it("GET /permission/candidates：裁决入档后可见，入库核销后滤除已覆盖条目", async () => {
    const { port } = await makeBridge({ approvalTimeoutMs: 5000 });
    // 第一轮：拒绝 → 候选入档可见
    await postReply(port, toolCall("command_run", { command: "ls -la" }));
    const denied = await getMessage(port);
    expect(denied?.type).toBe("approval");
    await postApproval(port, (denied as { id: number }).id, [false]);
    await getMessageText(port);
    const listed = await getEnvelope(port, "/permission/candidates");
    expect(listed.status).toBe(200);
    const before = okData<{ candidates: unknown[] }>(listed.envelope).candidates;
    expect(before).toHaveLength(1);
    // 第二轮：允许并回显入库 → 核销 → 列表滤除
    await postReply(port, toolCall("command_run", { command: "ls -la" }));
    const allowedBody = await getMessage(port);
    await postApproval(port, (allowedBody as { id: number }).id, [true], [
      { tool: "command_run", key: "ls -la", scope: "self" },
    ]);
    await getMessageText(port);
    const after = await getEnvelope(port, "/permission/candidates");
    expect(okData<{ candidates: unknown[] }>(after.envelope).candidates).toEqual([]);
  });

  it("POST /permission/whitelist：候选批量入库（grants 形状 + retired 核销）+ 再跑同调用静默", async () => {
    const { port, organs, whitelistFile } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("file_write", { path: outPath("cand-out.txt"), content: "x" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [false]); // 生成候选（拒绝）
    await getMessageText(port);
    const candKey = outKey("cand-out.txt");
    const res = await postJson(port, "/permission/whitelist", {
      items: [{ tool: "file_write", key: candKey }],
      scope: "self",
    });
    expect(res.status).toBe(200);
    expect(res.envelope).toEqual({
      status: "ok",
      data: {
        grants: [{ entry: { tool: "file_write", key: candKey, scope: "self" }, add: { status: "added" }, retired: 1 }],
      },
    });
    expect(whitelistEntries(whitelistFile)).toContainEqual({ tool: "file_write", key: candKey, scope: "self" });
    // 核销：候选已滤除
    const after = await getEnvelope(port, "/permission/candidates");
    expect(okData<{ candidates: unknown[] }>(after.envelope).candidates).toEqual([]);
    // 再跑同调用：白名单静默执行
    await postReply(port, toolCall("file_write", { path: outPath("cand-out.txt"), content: "x" }));
    const message = await getMessageText(port);
    expect(message).toContain("成功");
    expect(organs.calls.some((call) => call.name === "file_write")).toBe(true);
  });

  it("POST /permission/whitelist 全量原子：任一不合法 → 400 全部不落盘（核销未发生）", async () => {
    const { port, whitelistFile, candidatesFile } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("file_write", { path: outPath("atomic-out.txt"), content: "x" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [false]);
    await getMessageText(port);
    const res = await postJson(port, "/permission/whitelist", {
      items: [
        { tool: "file_write", key: outKey("atomic-out.txt") },
        { tool: "ghost_tool", key: "x" },
      ],
      scope: "self",
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
    expect(whitelistEntries(whitelistFile)).not.toContainEqual({
      tool: "file_write",
      key: outKey("atomic-out.txt"),
      scope: "self",
    });
    expect(candidateList(candidatesFile)).toHaveLength(1); // 核销未发生
  });

  it("POST /permission/whitelist 空批 → 400 invalid-body", async () => {
    const { port } = await makeBridge();
    const res = await postJson(port, "/permission/whitelist", { items: [], scope: "self" });
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
  });

  it("POST /permission/candidates/dismiss：清除所选（不写白名单）", async () => {
    const { port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("file_write", { path: outPath("dismiss-out.txt"), content: "x" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [false]);
    await getMessageText(port);
    const res = await postJson(port, "/permission/candidates/dismiss", {
      items: [{ tool: "file_write", key: outKey("dismiss-out.txt") }],
    });
    expect(res.status).toBe(200);
    expect(res.envelope).toEqual({ status: "ok", data: { dropped: 1 } });
    const after = await getEnvelope(port, "/permission/candidates");
    expect(okData<{ candidates: unknown[] }>(after.envelope).candidates).toEqual([]);
  });

  it("审批回显接受读类条目（界外读文件 self 粒度）→ 200 落盘 + 复读静默", async () => {
    const { port, whitelistFile } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("file_read", { path: outPath("read-out.txt") }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const entry: TrustEntry = { tool: "file_read", key: outKey("read-out.txt"), scope: "self" };
    expect(await postApproval(port, id, [true], [entry])).toBe(200);
    const message = await getMessageText(port);
    expect(message).toContain("成功");
    expect(whitelistEntries(whitelistFile)).toContainEqual(entry);
    await postReply(port, toolCall("file_read", { path: outPath("read-out.txt") }));
    const again = await getMessageText(port);
    expect(again).toContain("内容:");
  });

  it("GET /permission/whitelist：startup 后含自动注册的工作区条目", async () => {
    const { port } = await makeBridge();
    const res = await getEnvelope(port, "/permission/whitelist");
    expect(res.status).toBe(200);
    expect(res.envelope).toEqual({
      status: "ok",
      data: { entries: [{ tool: "file_write", key: `${wsKey}/`, scope: "subtree" }] },
    });
  });

  it("GET /permission/whitelist：seed 条目与工作区条目同列", async () => {
    const { port } = await makeBridge({ seed: [{ tool: "command_run", key: "ls -la", scope: "self" }] });
    const res = await getEnvelope(port, "/permission/whitelist");
    const entries = okData<{ entries: TrustEntry[] }>(res.envelope).entries;
    expect(entries).toContainEqual({ tool: "command_run", key: "ls -la", scope: "self" });
    expect(entries).toContainEqual({ tool: "file_write", key: `${wsKey}/`, scope: "subtree" });
  });

  it("POST /permission/whitelist/revoke：命中移除 + 落盘 + 复跑回 pending（撤销立即生效）", async () => {
    const { port, whitelistFile } = await makeBridge({
      seed: [{ tool: "command_run", key: "ls -la", scope: "self" }],
      approvalTimeoutMs: 5000,
    });
    // 预验证：白名单内静默执行
    await postReply(port, toolCall("command_run", { command: "ls -la" }));
    expect(await getMessageText(port)).toContain("成功");
    const entry: TrustEntry = { tool: "command_run", key: "ls -la", scope: "self" };
    const res = await postJson(port, "/permission/whitelist/revoke", { items: [entry] });
    expect(res.status).toBe(200);
    expect(res.envelope).toEqual({ status: "ok", data: { revoked: [entry] } });
    expect(whitelistEntries(whitelistFile)).not.toContainEqual(entry);
    const list = await getEnvelope(port, "/permission/whitelist");
    expect(okData<{ entries: TrustEntry[] }>(list.envelope).entries).not.toContainEqual(entry);
    // 复跑：回 pending（审批下发而非执行）
    await postReply(port, toolCall("command_run", { command: "ls -la" }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
  });

  it("POST /permission/whitelist/revoke 全量原子：非法条目 → 400 且合法项未被单独撤销", async () => {
    const { port, whitelistFile } = await makeBridge({
      seed: [{ tool: "command_run", key: "ls -la", scope: "self" }],
    });
    const before = whitelistEntries(whitelistFile);
    const res = await postJson(port, "/permission/whitelist/revoke", {
      items: [
        { tool: "command_run", key: "ls -la", scope: "self" },
        { tool: "command_run", key: "x", scope: "weird" },
      ],
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.envelope)).toBe("invalid-body");
    expect(whitelistEntries(whitelistFile)).toEqual(before);
  });

  it("POST /permission/whitelist/revoke：非匹配条目跳过（revoked 仅实录命中项）；items 非数组 → 400", async () => {
    const { port } = await makeBridge({ seed: [{ tool: "command_run", key: "ls -la", scope: "self" }] });
    const res = await postJson(port, "/permission/whitelist/revoke", {
      items: [
        { tool: "command_run", key: "ls -la", scope: "self" },
        { tool: "command_run", key: "ghost", scope: "self" },
      ],
    });
    expect(res.status).toBe(200);
    expect(okData<{ revoked: TrustEntry[] }>(res.envelope).revoked).toEqual([
      { tool: "command_run", key: "ls -la", scope: "self" },
    ]);
    const bad = await postJson(port, "/permission/whitelist/revoke", { items: "x" });
    expect(bad.status).toBe(400);
    expect(errorCode(bad.envelope)).toBe("invalid-body");
  });

  it("工作区自动条目可撤销（立即生效；重启重建属启动语义）", async () => {
    const { port, whitelistFile } = await makeBridge();
    const entry: TrustEntry = { tool: "file_write", key: `${wsKey}/`, scope: "subtree" };
    const res = await postJson(port, "/permission/whitelist/revoke", { items: [entry] });
    expect(res.status).toBe(200);
    expect(okData<{ revoked: TrustEntry[] }>(res.envelope).revoked).toEqual([entry]);
    expect(whitelistEntries(whitelistFile)).toEqual([]);
  });

  it("GET /permission/whitelist/revoke → 405 method-not-allowed", async () => {
    const { port } = await makeBridge();
    const res = await getEnvelope(port, "/permission/whitelist/revoke");
    expect(res.status).toBe(405);
    expect(errorCode(res.envelope)).toBe("method-not-allowed");
  });
});
