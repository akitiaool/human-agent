// 思考层的网页 Gemini 桥实现：内嵌 HTTP 服务与浏览器扩展通信。
// infer 组装协议消息 → 任务队列 → 插件在 AI Studio 页面发送并回传回复 → 解析工具调用。
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ConversationContext, Message } from "../context.js";
import { serializeToolProtocol } from "../knowledge.js";
import type {
  BrainInference,
  BrainInferenceResult,
  ReflectionVerdict,
  ToolCall,
  ToolInfo,
} from "../llm.js";
import { Reflection } from "../reflection.js";
import type { MouthContract, NoseContract } from "../../types/index.js";

export interface GeminiBridgeThinkingOptions {
  port?: number;
  host?: string;
  nose: NoseContract;
  mouth: MouthContract;
}

interface PendingTask {
  id: string;
  message: string;
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
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

export class GeminiBridgeThinking implements BrainInference {
  readonly #server: http.Server;
  readonly #portPromise: Promise<number>;
  readonly #reflection: Reflection;
  readonly #pending = new Map<string, PendingTask>();
  readonly #waiters: Array<(task: PendingTask | null) => void> = [];
  #sentCount = 0;

  constructor(options: GeminiBridgeThinkingOptions) {
    this.#reflection = new Reflection(options.nose, options.mouth);
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

  /** 关闭 HTTP 服务并释放所有等待中的任务与长轮询。 */
  close(): void {
    for (const waiter of this.#waiters) waiter(null);
    this.#waiters.length = 0;
    for (const task of this.#pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Gemini 桥服务已关闭"));
    }
    this.#pending.clear();
    this.#server.close();
    this.#server.closeAllConnections();
  }

  async infer(
    context: ConversationContext,
    _tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult> {
    const increment = this.#collectIncrement(context);
    const message =
      increment === "" ? serializeToolProtocol() : `${serializeToolProtocol()}\n\n${increment}`;
    const reply = await this.#publish(message, signal);
    return parseToolCalls(reply);
  }

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    return this.#reflection.reflect(calls);
  }

  /** 页面会话保留历史，每轮只发上次发送之后的新消息（新指令 / 工具结果）。 */
  #collectIncrement(context: ConversationContext): string {
    const all = context.getAll();
    const start = Math.min(this.#sentCount, all.length);
    this.#sentCount = all.length;
    return all
      .slice(start)
      .map(toIncrementText)
      .filter((part) => part !== "")
      .join("\n\n");
  }

  #publish(message: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const task: PendingTask = { id, message, resolve, reject, timer: undefined! };
      this.#armTimeout(task);
      this.#pending.set(task.id, task);
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(task);
      if (signal !== undefined) {
        signal.addEventListener(
          "abort",
          () => {
            this.#pending.delete(id);
            clearTimeout(task.timer);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }
    });
  }

  #armTimeout(task: PendingTask): void {
    task.timer = setTimeout(() => {
      this.#pending.delete(task.id);
      task.reject(new Error("等待插件回传超时"));
    }, 60_000);
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

  /** 长轮询：有待发任务立即返回；无任务挂起约 25s 后 204。 */
  #handleTaskRequest(res: http.ServerResponse): void {
    const next = this.#pending.values().next();
    if (!next.done) {
      this.#serveTask(next.value, res);
      return;
    }
    const waiter = (task: PendingTask | null): void => {
      clearTimeout(timer);
      if (task === null) {
        res.writeHead(204).end();
        return;
      }
      this.#serveTask(task, res);
    };
    const timer = setTimeout(() => {
      const index = this.#waiters.indexOf(waiter);
      if (index !== -1) this.#waiters.splice(index, 1);
      res.writeHead(204).end();
    }, 25_000);
    this.#waiters.push(waiter);
  }

  /** 任务交给插件后仍保留在 #pending（结果按 id 匹配回传），只重置回传超时。 */
  #serveTask(task: PendingTask, res: http.ServerResponse): void {
    clearTimeout(task.timer);
    this.#armTimeout(task);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: task.id, message: task.message }));
  }

  #handleResultRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readJsonBody(req).then(
      (body) => {
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const reply = typeof record.reply === "string" ? record.reply : "";
        const task = this.#pending.get(id);
        if (task !== undefined) {
          clearTimeout(task.timer);
          this.#pending.delete(task.id);
          task.resolve(reply);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      () => {
        res.writeHead(400).end();
      },
    );
  }
}

function toIncrementText(message: Message): string {
  switch (message.role) {
    case "system":
      return "";
    case "user":
      return message.content;
    case "assistant":
      return message.content;
    case "tool":
      return `工具 ${message.name} 返回：${message.content}`;
  }
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
