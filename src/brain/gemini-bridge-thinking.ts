// 执行型桥服务（v3）：网页驱动对话，智能体只执行。
// 接收网页内容（POST /result）→ ASTParser 状态机解析 → 统一 reflect 裁决
// （黑名单绝对拒绝 / 未知与参数非法拦截 / 白名单放行 / 其余 pending）
// → pending 经审批协议批量下发（GET /task 下发 approval + POST /approval 回裁决，
//   可携带 whitelist 条目落盘）→ 共享执行器执行（支持 pipeline 链式依赖与 batch 独立执行，以及 edit_file 原生无转义 Diff）
// → 序列化回填消息入队；插件经长轮询（GET /task）取回填。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { executeTool, type ToolOrgans } from "../heart/executor.js";
import { normalizePath, toolMatches } from "../nose/policy.js";
import { ASTParser, flattenToolCalls } from "./ast-parser.js";
import type { ActionResult, EyesContract, HandsContract, WhitelistEntry } from "../types/index.js";
import { fail } from "../types/index.js";
import type { BrainInferenceResult, ToolCall, ToolCallNode } from "./llm.js";
import { BaseThinking, type BaseThinkingOptions } from "./thinking.js";

export interface GeminiBridgeThinkingOptions extends BaseThinkingOptions {
  port?: number;
  host?: string;
  hands: HandsContract;
  eyes: EyesContract;
  /** 全局中断 AbortSignal（Ctrl+C 级联）；缺省为永不中断的控制器。 */
  signal?: AbortSignal;
  /** 单批执行超时（毫秒），0 表示禁用；默认 300s。 */
  timeoutMs?: number;
  /** 审批兜底超时（毫秒）：扩展未在面板超时前应答时全部按拒绝；默认 600s。 */
  approvalTimeoutMs?: number;
  /** 可选状态日志回调（宿主 cli 打印）。 */
  logger?: (message: string) => void;
}

/** 出队消息联合类型：回填文本或审批请求（含全部危险命令）。 */
type OutboxItem =
  | { type: "message"; message: string }
  | { type: "approval"; id: number; calls: ToolCall[] };

/** 审批裁决：allowed 逐条对应危险命令顺序；timedOut 标记兜底超时（拒绝文案区分）。 */
type ApprovalDecision = { allowed: boolean[]; timedOut: boolean };

/**
 * 解析工具调用代码块（由 ASTParser 状态机执行确定性解析）。
 * 零歧义铁律：如果回复包含任何非工具代码块的文本（解释、说明、闲聊），
 * 100% 判定为普通文本对话，不执行任何工具。
 */
export function parseToolCalls(text: string): BrainInferenceResult {
  const parser = new ASTParser();
  const res = parser.parseToInference(text);
  if (res !== null) {
    return res;
  }
  return { text: text.trim() };
}

/** 回填消息队列（outbox）+ 长轮询 waiter 的唤醒协议。 */
export class GeminiBridgeThinking extends BaseThinking {
  readonly #server: http.Server;
  readonly #portPromise: Promise<number>;
  readonly #organs: ToolOrgans;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #logger: ((message: string) => void) | undefined;
  readonly #outbox: OutboxItem[] = [];
  readonly #waiters: Array<() => void> = [];
  readonly #approvals = new Map<number, { settle: (decision: ApprovalDecision) => void; count: number; calls: ToolCall[] }>();
  #nextApprovalId = 1;
  readonly #approvalTimeoutMs: number;
  /** 单批串行队列：一次只处理一批，避免并发批交错。 */
  #busy: Promise<void> = Promise.resolve();
  /** close() 后置位：此后到达的长轮询请求立即 204（close 时请求可能尚未到达服务端）。 */
  #closed = false;

  constructor(options: GeminiBridgeThinkingOptions) {
    super(options); // 内部建 policy + ensureWorkspace + Reflection
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 600_000;
    this.#organs = { eyes: options.eyes, hands: options.hands };
    this.#signal = options.signal ?? new AbortController().signal;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#logger = options.logger;
    this.#server = http.createServer((req, res) => this.#handleRequest(req, res));
    this.#portPromise = new Promise<number>((resolve, reject) => {
      this.#server.on("error", reject);
      this.#server.listen(options.port ?? 8765, options.host ?? "127.0.0.1", () => {
        const address = this.#server.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  async getPort(): Promise<number> {
    return this.#portPromise;
  }

  /** 关闭桥服务：挂起审批全部按拒绝释放、长轮询以 204 释放、清空回填队列、关服务与连接。 */
  close(): void {
    this.#closed = true;
    for (const entry of this.#approvals.values()) {
      entry.settle({ allowed: new Array<boolean>(entry.count).fill(false), timedOut: true });
    }
    this.#approvals.clear();
    this.#outbox.length = 0;
    for (const waiter of this.#waiters) waiter();
    this.#waiters.length = 0;
    setTimeout(() => {
      this.#server.close();
      this.#server.closeIdleConnections();
      this.#server.closeAllConnections();
    }, 50);
  }

  #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/task") {
      this.#handleTaskRequest(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/protocol") {
      this.#handleProtocolRequest(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/result") {
      this.#handleResultRequest(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/approval") {
      this.#handleApprovalRequest(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  /** 长轮询：有出队消息立即返回；无则挂起约 25s 后 204。 */
  #handleTaskRequest(res: http.ServerResponse): void {
    if (this.#closed) {
      res.writeHead(204).end();
      return;
    }
    const next = this.#outbox.shift();
    if (next !== undefined) {
      this.#serveItem(next, res);
      return;
    }
    const waiter = (): void => {
      clearTimeout(timer);
      const item = this.#outbox.shift();
      if (item !== undefined) this.#serveItem(item, res);
      else res.writeHead(204).end();
    };
    const timer = setTimeout(() => {
      const index = this.#waiters.indexOf(waiter);
      if (index !== -1) this.#waiters.splice(index, 1);
      res.writeHead(204).end();
    }, 25_000);
    this.#waiters.push(waiter);
  }

  #serveItem(item: OutboxItem, res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(item));
  }

  /** 拉取协议文本（工作区声明 + 工具协议）：无状态幂等，每次返回当前值；服务已关闭时 204。 */
  #handleProtocolRequest(res: http.ServerResponse): void {
    if (this.#closed) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, protocol: this.toolProtocol() }));
  }

  /** 收网页内容：校验 → 解析 tool_call → 有则入串行队列；响应立即返回。 */
  #handleResultRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readJsonBody(req).then(
      (body) => {
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        const reply = typeof record.reply === "string" ? record.reply : "";
        if (reply.length === 0 || reply.length > 200_000) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "reply 必须为非空字符串且不超过 200000 字符" }));
          return;
        }
        const processed = this.#enqueue(reply);
        this.#logger?.(`收到网页内容（${reply.length} 字符，${processed ? "已入队" : "未处理"}）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, processed }));
      },
      () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体必须为合法 JSON" }));
      },
    );
  }

  /** 解析 tool_call → 有则入串行队列。重复控制属模型侧（失败重试等场景需要重复执行），服务端不做静默去重。 */
  #enqueue(reply: string): boolean {
    const parsed = parseToolCalls(reply);
    const nodes = parsed.toolTree ?? (parsed.toolCalls ? parsed.toolCalls : []);
    if (nodes.length === 0) return false;
    this.#busy = this.#busy.then(() => this.#process(nodes));
    return true;
  }

  /** 单批流水线：统一裁决 → 需授权的批量审批 → 执行流控（支持 pipeline 短路与 batch 独立执行）→ 回填。 */
  async #process(nodes: readonly ToolCallNode[]): Promise<void> {
    if (this.#signal.aborted) return; // 全局中断：丢弃批次
    const batchSignal =
      this.#timeoutMs > 0
        ? AbortSignal.any([this.#signal, AbortSignal.timeout(this.#timeoutMs)])
        : this.#signal;

    const flatCalls = flattenToolCalls(nodes);
    const verdict = await this.reflect(flatCalls);
    const pending = verdict.pending;

    // 批量审批：一条请求含全部待授权调用；批中止时作废审批条目并清除兜底定时器
    let decision: ApprovalDecision | undefined;
    if (pending.length > 0) {
      const { id, promise, cancel } = this.#requestApproval(pending);
      try {
        decision = await Promise.race([promise, abortSignalPromise(batchSignal)]);
      } catch {
        cancel();
        if (this.#signal.aborted) return; // 全局中断：丢弃批次
        this.#pushMessage(`⚠️ 工具执行超时（超过 ${this.#timeoutMs}ms），已终止`);
        return;
      }
    }

    const allowedSet = new Set(verdict.allowed);
    const pendingSet = new Set(pending);
    const blockedMap = new Map(verdict.blocked.map((item) => [item.call, item.result] as const));
    const decisions = decision?.allowed ?? [];
    const lines: string[] = [];
    let lineIndex = 0;
    let pendingIndex = 0;

    const executeNode = async (node: ToolCallNode, isBlockedByParent: boolean): Promise<boolean> => {
      if (batchSignal.aborted) return false;
      if ("name" in node && typeof (node as ToolCall).name === "string") {
        const call = node as ToolCall;
        lineIndex++;
        const idx = lineIndex;
        if (isBlockedByParent) {
          const blockedRes = fail("DEPENDENCY_BLOCKED", "前序依赖步骤执行失败或被拒绝，已跳过");
          lines.push(serializeBlockedLine(idx, call, blockedRes));
          return false;
        }
        let toRun: ToolCall | undefined;
        let blockedResult: ActionResult<unknown> | undefined;
        if (blockedMap.has(call)) {
          blockedResult = blockedMap.get(call);
        } else if (allowedSet.has(call)) {
          toRun = call;
        } else if (pendingSet.has(call)) {
          const allowed = decisions[pendingIndex++] ?? false;
          if (allowed) {
            toRun = call;
          } else {
            blockedResult = fail("USER_DENIED", decision?.timedOut === true ? "审批超时，未执行" : "用户未授权，未执行");
          }
        }

        if (toRun !== undefined) {
          let result: ActionResult<unknown>;
          try {
            result = await Promise.race([
              executeTool(this.#organs, toRun.name, toRun.arguments, batchSignal, {
                workspace: this.workspace,
              }),
              abortSignalPromise(batchSignal),
            ]);
          } catch {
            return false;
          }
          lines.push(serializeResultLine(idx, toRun, result));
          return result.success;
        } else if (blockedResult !== undefined) {
          lines.push(serializeBlockedLine(idx, call, blockedResult));
          return blockedResult.success;
        }
        return false;
      }

      if ("mode" in node && node.mode === "pipeline") {
        let pipelineFailed = isBlockedByParent;
        for (const child of node.calls) {
          const childSuccess = await executeNode(child, pipelineFailed);
          if (!childSuccess) {
            pipelineFailed = true;
          }
        }
        return !pipelineFailed;
      } else if ("mode" in node && node.mode === "batch") {
        let batchAllSuccess = true;
        for (const child of node.calls) {
          const childSuccess = await executeNode(child, isBlockedByParent);
          if (!childSuccess) {
            batchAllSuccess = false;
          }
        }
        return batchAllSuccess && !isBlockedByParent;
      }
      return false;
    };

    for (const node of nodes) {
      await executeNode(node, false);
    }

    if (this.#signal.aborted) return; // 全局中断：丢弃批次不排队
    if (batchSignal.aborted) {
      this.#pushMessage(`⚠️ 工具执行超时（超过 ${this.#timeoutMs}ms），已终止`);
      return;
    }
    this.#pushMessage(serializeFeedback(lines));
  }

  #pushMessage(message: string): void {
    this.#outbox.push({ type: "message", message });
    this.#logger?.(`回填消息已入队（outbox 深度 ${this.#outbox.length}）`);
    this.#wakeWaiter();
  }

  #wakeWaiter(): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter();
  }

  /** 审批请求入队并返回裁决 promise 与 cancel；兜底超时（approvalTimeoutMs）全部按拒绝。 */
  #requestApproval(calls: readonly ToolCall[]): {
    id: number;
    promise: Promise<ApprovalDecision>;
    cancel: () => void;
  } {
    const id = this.#nextApprovalId++;
    let settle!: (decision: ApprovalDecision) => void;
    const timer = setTimeout(() => {
      if (this.#approvals.delete(id)) settle({ allowed: calls.map(() => false), timedOut: true });
    }, this.#approvalTimeoutMs);
    const promise = new Promise<ApprovalDecision>((resolve) => {
      settle = (decision) => {
        clearTimeout(timer);
        resolve(decision);
      };
    });
    this.#approvals.set(id, { settle, count: calls.length, calls: [...calls] });
    this.#outbox.push({ type: "approval", id, calls: [...calls] });
    this.#logger?.(`审批请求已入队（id ${id}，${calls.length} 条待授权调用）`);
    this.#wakeWaiter();
    return {
      id,
      promise,
      cancel: () => {
        this.#approvals.delete(id);
        clearTimeout(timer);
      },
    };
  }

  /** 收扩展审批结果：校验 allowed 与 whitelist → 放行 → settle；未知 id → 404。 */
  #handleApprovalRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readJsonBody(req).then(
      (body) => {
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        const id = typeof record.id === "number" ? record.id : NaN;
        const entry = this.#approvals.get(id);
        if (entry === undefined) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "审批不存在或已过期" }));
          return;
        }
        const allowed = (Array.isArray(record.allowed) ? record.allowed : []).map((v) => v === true);
        if (allowed.length !== entry.calls.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "allowed 必须与调用数一致" }));
          return;
        }
        if (record.whitelist !== undefined) {
          const entries = Array.isArray(record.whitelist) ? record.whitelist : null;
          if (entries === null || !this.#isValidWhitelist(entries, entry.calls, allowed)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "whitelist 条目不合法" }));
            return;
          }
          for (const w of entries) void this.addWhitelistEntry(w as WhitelistEntry);
        }
        this.#approvals.delete(id);
        entry.settle({ allowed, timedOut: false });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体必须为合法 JSON" }));
      },
    );
  }

  /** 校验：每条目必须对应本批中 allowed=true 的调用。 */
  #isValidWhitelist(raw: unknown[], calls: readonly ToolCall[], allowed: boolean[]): boolean {
    const allowedCalls = calls.filter((_, i) => allowed[i] === true);
    return raw.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const w = item as Record<string, unknown>;
      if (typeof w.tool !== "string" || typeof w.key !== "string") return false;
      if (w.kind !== "exact" && w.kind !== "path") return false;
      const entry: WhitelistEntry = { tool: w.tool, key: w.key, kind: w.kind };
      return allowedCalls.some((call) => {
        if (entry.kind === "exact") {
          return toolMatches(entry.tool, call.name) && entry.key === this.keyFor(call);
        }
        if (call.name !== "write_file" && call.name !== "apply_patch" && call.name !== "edit_file") return false;
        const path = typeof call.arguments.path === "string" ? normalizePath(call.arguments.path) : "";
        if (!toolMatches(entry.tool, call.name)) return false;
        if (entry.key === path) return true; // 文件条目
        const i = path.lastIndexOf("/");
        if (i <= 0 || (i === 2 && path[1] === ":")) return false;
        return entry.key === `${path.slice(0, i)}/`;
      });
    });
  }
}

/** 批 signal 中止即拒绝。 */
function abortSignalPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
    else {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    }
  });
}

/** 回填消息格式：`N. 工具 {name} 参数 {args} → 成功/失败`，附 ActionResult JSON 代码块。 */
function serializeResultLine(index: number, call: ToolCall, result: ActionResult<unknown>): string {
  const status = result.success ? "成功" : "失败";
  const fence = "```";
  return `${index}. 工具 ${call.name} 参数 ${JSON.stringify(call.arguments)} → ${status}：\n${fence}json\n${JSON.stringify(result)}\n${fence}`;
}

/** 拒绝/阻断行：`已拒绝/已阻断（{错误码}：{原因}）`。 */
function serializeBlockedLine(index: number, call: ToolCall, result: ActionResult<unknown>): string {
  const code = result.error?.code ?? "UNKNOWN";
  const reason = result.error?.message ?? JSON.stringify(result);
  const status = code === "DEPENDENCY_BLOCKED" ? "已阻断" : "已拒绝";
  return `${index}. 工具 ${call.name} 参数 ${JSON.stringify(call.arguments)} → ${status}（${code}：${reason}）`;
}

function serializeFeedback(lines: string[]): string {
  return `工具执行结果（human-agent）：\n${lines.join("\n")}`;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}