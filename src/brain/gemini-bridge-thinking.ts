// 执行型桥服务（v2）：网页驱动对话，智能体只执行。
// 接收网页内容（POST /result）→ 解析 ```tool_call``` → 反思层裁决 → 共享执行器执行
// → 序列化回填消息入队；插件经长轮询（GET /task）取回填。
// 不再实现 BrainInference（无模型推理，不运行心脏循环）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { executeTool, type ToolOrgans } from "../heart/executor.js";
import type { ActionResult, EyesContract, HandsContract, NoseContract } from "../types/index.js";
import { serializeToolProtocol } from "./knowledge.js";
import type { BrainInferenceResult, ToolCall } from "./llm.js";
import { Reflection } from "./reflection.js";

export interface GeminiBridgeThinkingOptions {
  port?: number;
  host?: string;
  nose: NoseContract;
  hands: HandsContract;
  eyes: EyesContract;
  /** 全局中断 AbortSignal（Ctrl+C 级联）；缺省为永不中断的控制器。 */
  signal?: AbortSignal;
  /** 单批执行超时（毫秒），0 表示禁用；默认 300s。 */
  timeoutMs?: number;
  /** 可选状态日志回调（宿主 cli 打印）。 */
  logger?: (message: string) => void;
}

/** 容错解析 ```tool_call``` JSON 代码块：坏 JSON 块丢弃、其余原文拼回 text。 */
export function parseToolCalls(text: string): BrainInferenceResult {
  const pattern = /```tool_call\s*\n([\s\S]*?)(?:\n)?```/g;
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      if (isToolCall(parsed)) calls.push(parsed);
    } catch {
      // 坏 JSON 块丢弃
    }
  }
  const stripped = text.replace(pattern, "").trim();
  return { text: stripped, ...(calls.length > 0 ? { toolCalls: calls } : {}) };
}

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.arguments === "object" &&
    candidate.arguments !== null
  );
}

/** 回填消息队列（outbox）+ 长轮询 waiter 的唤醒协议。 */
export class GeminiBridgeThinking {
  readonly #server: http.Server;
  readonly #portPromise: Promise<number>;
  readonly #reflection: Reflection;
  readonly #organs: ToolOrgans;
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #logger: ((message: string) => void) | undefined;
  readonly #outbox: string[] = [];
  readonly #waiters: Array<() => void> = [];
  /** 单批串行队列：一次只处理一批，避免并发批交错。 */
  #busy: Promise<void> = Promise.resolve();
  /** 最近一次处理（含 tool_call）的内容，用于去重。 */
  #lastContent: string | undefined;
  /** close() 后置位：此后到达的长轮询请求立即 204（close 时请求可能尚未到达服务端）。 */
  #closed = false;

  constructor(options: GeminiBridgeThinkingOptions) {
    // 桥模式注入"永远拒绝"的嘴巴：危险命令自动拒绝，不打扰 CLI 用户
    this.#reflection = new Reflection(options.nose, { confirm: async () => false });
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
    // 启动即入队工具协议：让网页 Gemini 一开始就知道 ```tool_call``` 格式
    this.#outbox.push(serializeToolProtocol());
  }

  async getPort(): Promise<number> {
    return this.#portPromise;
  }

  /** 关闭桥服务：挂起的长轮询全部以 204 释放、清空回填队列、关服务与连接。 */
  close(): void {
    this.#closed = true;
    this.#outbox.length = 0;
    for (const waiter of this.#waiters) waiter();
    this.#waiters.length = 0;
    // 延迟关闭：挂起的长轮询可能在 close() 时尚未完成 TCP 连接/请求解析
    // （此时会走到 #closed 分支立即 204），立即停监听会使其 fetch 收到
    // ECONNREFUSED、立即强杀会截断 204；留出窗口让 204 送达后再清理。
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
    if (req.method === "POST" && url.pathname === "/result") {
      this.#handleResultRequest(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  /** 长轮询：有回填消息立即出队返回 {message}；无则挂起约 25s 后 204。 */
  #handleTaskRequest(res: http.ServerResponse): void {
    if (this.#closed) {
      res.writeHead(204).end();
      return;
    }
    const next = this.#outbox.shift();
    if (next !== undefined) {
      this.#serveMessage(next, res);
      return;
    }
    const waiter = (): void => {
      clearTimeout(timer);
      const message = this.#outbox.shift();
      if (message !== undefined) this.#serveMessage(message, res);
      else res.writeHead(204).end();
    };
    const timer = setTimeout(() => {
      const index = this.#waiters.indexOf(waiter);
      if (index !== -1) this.#waiters.splice(index, 1);
      res.writeHead(204).end();
    }, 25_000);
    this.#waiters.push(waiter);
  }

  #serveMessage(message: string, res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message }));
  }

  /** 收网页内容：校验 → 去重 → 解析 tool_call → 有则入串行队列；响应立即返回（不等待批完成）。 */
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

  /** 去重（与最近一次处理内容完全相同则不处理）→ 解析 tool_call；无则不排队。 */
  #enqueue(reply: string): boolean {
    if (reply === this.#lastContent) return false;
    const calls = parseToolCalls(reply).toolCalls ?? [];
    if (calls.length === 0) return false;
    this.#lastContent = reply;
    this.#busy = this.#busy.then(() => this.#process(calls));
    return true;
  }

  /** 单批流水线：反思裁决 → 放行逐个经共享执行器执行 → 拦截收集 → 序列化回填。 */
  async #process(calls: readonly ToolCall[]): Promise<void> {
    if (this.#signal.aborted) return; // 全局中断：丢弃批次
    const batchSignal =
      this.#timeoutMs > 0
        ? AbortSignal.any([this.#signal, AbortSignal.timeout(this.#timeoutMs)])
        : this.#signal;
    const verdict = await this.#reflection.reflect(calls);
    const lines: string[] = [];
    let index = 0;
    for (const call of verdict.allowed) {
      if (batchSignal.aborted) break; // 批中止（超时或全局中断）：停止执行
      index++;
      let result: ActionResult<unknown>;
      try {
        result = await Promise.race([
          executeTool(this.#organs, call.name, call.arguments, batchSignal),
          abortSignalPromise(batchSignal),
        ]);
      } catch {
        break; // 批 signal 已中止（执行未在超时前返回）
      }
      lines.push(serializeResultLine(index, call, result));
    }
    for (const item of verdict.blocked) {
      index++;
      lines.push(serializeBlockedLine(index, item.call, item.result));
    }
    if (this.#signal.aborted) return; // 全局中断：丢弃批次不排队
    if (batchSignal.aborted) {
      this.#pushMessage(`⚠️ 工具执行超时（超过 ${this.#timeoutMs}ms），已终止`);
      return;
    }
    this.#pushMessage(serializeFeedback(lines));
  }

  #pushMessage(message: string): void {
    this.#outbox.push(message);
    this.#logger?.(`回填消息已入队（outbox 深度 ${this.#outbox.length}）`);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter();
  }
}

/** 批 signal 中止即拒绝（与工具执行赛跑：超时/中断时快速放弃本轮，不阻塞回填）。 */
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
  return `${index}. 工具 ${call.name} 参数 ${JSON.stringify(call.arguments)} → ${status}：\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``;
}

/** 拒绝行：`已拒绝（{错误码}：{原因}）`；USER_DENIED → 危险命令自动拒绝，其余 → 原文 message。 */
function serializeBlockedLine(index: number, call: ToolCall, result: ActionResult<unknown>): string {
  const code = result.error?.code ?? "UNKNOWN";
  const reason =
    code === "USER_DENIED" ? "危险命令自动拒绝，未执行" : (result.error?.message ?? JSON.stringify(result));
  return `${index}. 工具 ${call.name} 参数 ${JSON.stringify(call.arguments)} → 已拒绝（${code}：${reason}）`;
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
