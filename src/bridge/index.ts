// bridge 域：createBridge 组合 permission/reflection/执行器并绑定 127.0.0.1。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPermission, type Permission } from "../permission/index.js";
import { createReflection } from "../brain/reflection.js";
import { buildDefaultEyes, buildDefaultHands } from "../agent.js";
import type { EyesContract, HandsContract } from "../types/index.js";
import { errorEnvelope, okEnvelope, TRANSPORT_STATUS, type Envelope, type TransportCode } from "./envelope.js";
import { createPipeline } from "./pipeline.js";

export interface BridgeOptions {
  workspace: string;
  port?: number;                   // 缺省 8765
  signal?: AbortSignal;
  timeoutMs?: number;              // 批级执行超时，缺省 300_000
  logger?: (text: string) => void;
  whitelistFile?: string;
  candidatesFile?: string;
  eyes?: EyesContract;
  hands?: HandsContract;
  approvalTimeoutMs?: number;      // 审批兜底超时，缺省 600_000（测试注入）
}

export interface BridgeService {
  getPort(): Promise<number>;
  close(): void;
}

const ROUTES: Record<string, readonly string[]> = {
  "/task": ["GET"],
  "/task/reply": ["POST"],
  "/task/approval": ["POST"],
  "/permission/whitelist": ["POST"],
  "/permission/candidates": ["GET"],
  "/permission/candidates/dismiss": ["POST"],
  "/agent/protocol": ["GET"],
  "/agent/info": ["GET"],
};

export function createBridge(options: BridgeOptions): BridgeService {
  const logger = options.logger ?? ((text: string) => console.error(text));
  const permission = createPermission({
    workspace: options.workspace,
    ...(options.whitelistFile !== undefined ? { whitelistFile: options.whitelistFile } : {}),
    ...(options.candidatesFile !== undefined ? { candidatesFile: options.candidatesFile } : {}),
    logger,
  });
  const reflection = createReflection({ permission });
  const pipeline = createPipeline({
    permission,
    reflection,
    eyes: options.eyes ?? buildDefaultEyes(),
    hands: options.hands ?? buildDefaultHands(),
    timeoutMs: options.timeoutMs ?? 300_000,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 600_000,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    logger,
  });
  const server = createServer((req, res) => { void handle(req, res, pipeline, options.workspace); });
  server.listen(options.port ?? 8765, "127.0.0.1");
  return {
    getPort: () => new Promise<number>((resolve, reject) => {
      if (server.listening) { resolve(portOf(server)); return; }
      server.once("listening", () => resolve(portOf(server)));
      server.once("error", reject);
    }),
    close: () => {
      pipeline.close();
      // 延迟关服（旧桥行为）：挂起的长轮询须先把管道 close 释放的 204 写回，立即 closeAllConnections 会把在途响应 RST。
      setTimeout(() => {
        server.close();
        server.closeAllConnections();
      }, 50);
    },
  };
}

function portOf(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  pipeline: ReturnType<typeof createPipeline>,
  workspace: string,
): Promise<void> {
  const send = (status: number, envelope: Envelope): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(envelope));
  };
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const methods = ROUTES[pathname];
  if (methods === undefined) { send(404, errorEnvelope("unknown-endpoint", `未知端点：${pathname}`)); return; }
  const method = req.method ?? "";
  if (!methods.includes(method)) { send(405, errorEnvelope("method-not-allowed", `方法不允许：${method} ${pathname}`)); return; }
  let body: unknown = undefined;
  if (method === "POST") {
    try { body = await readJsonBody(req); }
    catch { send(400, errorEnvelope("invalid-body", "请求体不是合法 JSON")); return; }
  }
  try {
    if (pathname === "/task") {
      const item = await pipeline.takeTask();
      if (item === null) { res.writeHead(204); res.end(); return; }
      send(200, okEnvelope(item)); return;
    }
    if (pathname === "/agent/protocol") { send(200, okEnvelope({ protocol: pipeline.protocolText() })); return; }
    if (pathname === "/agent/info") { send(200, okEnvelope({ workspace })); return; }
    if (pathname === "/permission/candidates") { send(200, okEnvelope({ candidates: pipeline.candidates() })); return; }
    if (pathname === "/task/reply") {
      const result = pipeline.submitReply(body);
      if (!result.ok) { send(400, errorEnvelope("invalid-body", result.message)); return; }
      send(200, okEnvelope({ processed: result.processed })); return;
    }
    if (pathname === "/task/approval") {
      const result = await pipeline.submitApproval(body);
      if (!result.ok) { send(TRANSPORT_STATUS[result.code], errorEnvelope(result.code, result.message)); return; }
      send(200, okEnvelope()); return;
    }
    if (pathname === "/permission/whitelist") {
      const record = (body ?? {}) as { items?: unknown; scope?: unknown };
      const result = pipeline.grant(record.items, record.scope);
      if (!result.ok) { send(400, errorEnvelope("invalid-body", result.message)); return; }
      send(200, okEnvelope({ grants: result.grants })); return;
    }
    if (pathname === "/permission/candidates/dismiss") {
      const record = (body ?? {}) as { items?: unknown };
      const result = pipeline.dismiss(record.items);
      if (!result.ok) { send(400, errorEnvelope("invalid-body", result.message)); return; }
      send(200, okEnvelope({ dropped: result.dropped })); return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(500, errorEnvelope("internal", `服务器内部错误：${message}`));
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
