// 管线（旧桥状态机移植）：网页内容 → 严格解析 → 统一裁决 → 批量审批 → 执行 → 回填入队。
// 不变量：parseToolCalls 严格解析（无容错兜底）、无调用 processed:false 自终止（不做服务端去重）、
// pending 批量审批（兜底超时全拒）、批级执行超时、候选两钩子（审批回执落地即记、兜底超时 settle 记拒绝）、
// close 释放不记候选；审批载荷 options 预构造（扩展零手抄载体，spec §4）。
import { z } from "zod";
import { ASTParser, flattenToolCalls } from "../brain/ast-parser.js";
import type { BrainInferenceResult, ReflectionVerdict, ToolCall, ToolCallNode } from "../brain/llm.js";
import { executeTool, type ToolOrgans } from "../heart/executor.js";
import type { CandidateRecord, GrantResult, Permission } from "../permission/index.js";
import { covers, isToolName, meta, tool, type TrustEntry } from "../tool/index.js";
import { fail, type ActionResult, type EyesContract, type HandsContract } from "../types/index.js";

export interface TaskMessage {
  type: "message";
  message: string;
}

export interface TaskApproval {
  type: "approval";
  id: number;
  calls: ToolCall[];
  options: TrustEntry[][];
}

export type TaskItem = TaskMessage | TaskApproval;

/** 审批裁决：allowed 逐条对应 pending 调用顺序；timedOut 标记兜底超时（拒绝文案区分）。 */
type ApprovalDecision = { allowed: boolean[]; timedOut: boolean };

export interface Pipeline {
  takeTask(): Promise<TaskItem | null>;
  submitReply(body: unknown): { ok: true; processed: boolean } | { ok: false; message: string };
  submitApproval(body: unknown): Promise<
    { ok: true } | { ok: false; code: "unknown-approval" | "invalid-body"; message: string }
  >;
  candidates(): CandidateRecord[];
  entries(): TrustEntry[];
  grant(items: unknown, scope: unknown): { ok: true; grants: GrantResult[] } | { ok: false; message: string };
  revoke(items: unknown): { ok: true; revoked: TrustEntry[] } | { ok: false; message: string };
  dismiss(items: unknown): { ok: true; dropped: number } | { ok: false; message: string };
  protocolText(): string;
  close(): void;
}

export interface PipelineOptions {
  permission: Permission;
  reflection: { reflect(calls: readonly ToolCall[]): ReflectionVerdict };
  eyes: EyesContract;
  hands: HandsContract;
  /** 单批执行超时（毫秒），0 表示禁用。 */
  timeoutMs: number;
  /** 审批兜底超时（毫秒）：未应答时全部按拒绝。 */
  approvalTimeoutMs: number;
  /** 全局中断 AbortSignal（Ctrl+C 级联）；缺省为永不中断的控制器。 */
  signal?: AbortSignal;
  logger?: (message: string) => void;
}

/** 审批条目：calls 与 options 同序对应；timer 到点记候选后 settle。 */
interface ApprovalEntry {
  calls: ToolCall[];
  options: TrustEntry[][];
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const trustEntrySchema = z.strictObject({
  tool: z.string(),
  key: z.string(),
  scope: z.enum(["self", "subtree"]),
});

/** 三字段回显比较（spec §5.3：回显条目须 deep-equal 某 allowed=true 调用的 options 成员）。 */
function entryEquals(a: TrustEntry, b: TrustEntry): boolean {
  return a.tool === b.tool && a.key === b.key && a.scope === b.scope;
}

/** 解析工具调用代码块（由 ASTParser 状态机执行确定性解析）。零歧义铁律：含任何非工具文本即普通对话。 */
export function parseToolCalls(text: string): BrainInferenceResult {
  const parser = new ASTParser();
  const res = parser.parseToInference(text);
  if (res !== null) {
    return res;
  }
  return { text: text.trim() };
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { permission, reflection } = options;
  const organs: ToolOrgans = { eyes: options.eyes, hands: options.hands };
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = options.timeoutMs;
  const approvalTimeoutMs = options.approvalTimeoutMs;
  const logger = options.logger;

  const outbox: TaskItem[] = [];
  const waiters: Array<() => void> = [];
  const approvals = new Map<number, ApprovalEntry>();
  let nextApprovalId = 1;
  /** 单批串行队列：一次只处理一批，避免并发批交错。 */
  let busy: Promise<void> = Promise.resolve();
  /** close() 后置位：此后到达的长轮询立即释放（close 时请求可能尚未到达服务端）。 */
  let closed = false;

  /** 长轮询：有出队消息立即返回；无则挂起 ~25s 后 null（204）。 */
  function takeTask(): Promise<TaskItem | null> {
    if (closed) return Promise.resolve(null);
    const next = outbox.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise<TaskItem | null>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(outbox.shift() ?? null);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        resolve(null);
      }, 25_000);
      waiters.push(waiter);
    });
  }

  function wakeWaiter(): void {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter();
  }

  function pushMessage(message: string): void {
    outbox.push({ type: "message", message });
    logger?.(`回填消息已入队（outbox 深度 ${outbox.length}）`);
    wakeWaiter();
  }

  /** 收网页内容：校验 → 解析 tool_call → 有则入串行队列。重复控制属模型侧，服务端不做静默去重。 */
  function submitReply(body: unknown): { ok: true; processed: boolean } | { ok: false; message: string } {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const reply = typeof record.reply === "string" ? record.reply : "";
    if (reply.length === 0 || reply.length > 200_000) {
      return { ok: false, message: "reply 必须为非空字符串且不超过 200000 字符" };
    }
    const processed = enqueue(reply);
    logger?.(`收到网页内容（${reply.length} 字符，${processed ? "已入队" : "未处理"}）`);
    return { ok: true, processed };
  }

  function enqueue(reply: string): boolean {
    const parsed = parseToolCalls(reply);
    const nodes = parsed.toolTree ?? (parsed.toolCalls ? parsed.toolCalls : []);
    if (nodes.length === 0) return false;
    busy = busy.then(() => processBatch(nodes));
    return true;
  }

  /** 单批流水线：统一裁决 → 需授权的批量审批 → 执行流控（pipeline 短路与 batch 独立执行）→ 回填。 */
  async function processBatch(nodes: readonly ToolCallNode[]): Promise<void> {
    if (signal.aborted) return; // 全局中断：丢弃批次
    const batchSignal =
      timeoutMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal;

    const flatCalls = flattenToolCalls(nodes);
    const verdict = await reflection.reflect(flatCalls);
    const pending = verdict.pending;

    // 批量审批：一条请求含全部待授权调用；批中止时作废审批条目并清除兜底定时器
    let decision: ApprovalDecision | undefined;
    if (pending.length > 0) {
      const { promise, cancel } = requestApproval(pending);
      try {
        decision = await Promise.race([promise, abortSignalPromise(batchSignal)]);
      } catch {
        cancel();
        if (signal.aborted) return; // 全局中断：丢弃批次
        pushMessage(`⚠️ 工具执行超时（超过 ${timeoutMs}ms），已终止`);
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
          const blockedRes = fail("dependency-blocked", "前序依赖步骤执行失败或被拒绝，已跳过");
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
            blockedResult = fail("user-denied", decision?.timedOut === true ? "审批超时，未执行" : "用户未授权，未执行");
          }
        }

        if (toRun !== undefined) {
          let result: ActionResult<unknown>;
          try {
            result = await Promise.race([
              executeTool(organs, toRun.name, toRun.arguments, batchSignal, { permission }),
              abortSignalPromise(batchSignal),
            ]);
          } catch {
            return false;
          }
          lines.push(serializeResultLine(idx, toRun, result));
          return result.status === "ok";
        } else if (blockedResult !== undefined) {
          lines.push(serializeBlockedLine(idx, call, blockedResult));
          return blockedResult.status === "ok";
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

    if (signal.aborted) return; // 全局中断：丢弃批次不排队
    if (batchSignal.aborted) {
      pushMessage(`⚠️ 工具执行超时（超过 ${timeoutMs}ms），已终止`);
      return;
    }
    pushMessage(serializeFeedback(lines));
  }

  /** 审批请求入队并返回裁决 promise 与 cancel；兜底超时逐调用记 denied 后 settle 全拒。 */
  function requestApproval(calls: readonly ToolCall[]): {
    id: number;
    promise: Promise<ApprovalDecision>;
    cancel: () => void;
  } {
    const id = nextApprovalId++;
    const options = calls.map((call) => permission.key.optionsFor(call));
    let resolve!: (decision: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((res) => {
      resolve = res;
    });
    const timer = setTimeout(() => {
      if (approvals.delete(id)) {
        // 桥自记：兜底超时 settle 全拒时入档（覆盖扩展盲区）
        for (const call of calls) {
          const key = permission.key.of(call);
          if (key !== undefined && key !== "") permission.candidates.record(call.name, key, "denied");
        }
        resolve({ allowed: calls.map(() => false), timedOut: true });
      }
    }, approvalTimeoutMs);
    approvals.set(id, { calls: [...calls], options, resolve, timer });
    outbox.push({ type: "approval", id, calls: [...calls], options });
    logger?.(`审批请求已入队（id ${id}，${calls.length} 条待授权调用）`);
    wakeWaiter();
    return {
      id,
      promise,
      cancel: () => {
        approvals.delete(id);
        clearTimeout(timer);
      },
    };
  }

  /** 收扩展审批结果：结构校验 → 回显校验 → 桥自记候选 → 白名单落盘+核销 → settle；未知 id → unknown-approval。 */
  async function submitApproval(
    body: unknown,
  ): Promise<{ ok: true } | { ok: false; code: "unknown-approval" | "invalid-body"; message: string }> {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    // 1. 结构校验：id 数字、allowed boolean[]、whitelist 缺省或数组
    const id = typeof record.id === "number" ? record.id : NaN;
    const allowedRaw = record.allowed;
    if (typeof record.id !== "number" || !Number.isFinite(id)) {
      return { ok: false, code: "invalid-body", message: "id 必须为数字" };
    }
    if (!Array.isArray(allowedRaw) || !allowedRaw.every((v) => typeof v === "boolean")) {
      return { ok: false, code: "invalid-body", message: "allowed 必须为布尔数组" };
    }
    const allowed = allowedRaw as boolean[];
    const whitelistRaw = record.whitelist === undefined ? [] : record.whitelist;
    if (!Array.isArray(whitelistRaw)) {
      return { ok: false, code: "invalid-body", message: "whitelist 必须为数组" };
    }
    // 2. id 查找（不存在或已 settle）
    const entry = approvals.get(id);
    if (entry === undefined) {
      return { ok: false, code: "unknown-approval", message: "审批不存在或已过期" };
    }
    // 3. allowed 与调用数一致
    if (allowed.length !== entry.calls.length) {
      return { ok: false, code: "invalid-body", message: "allowed 必须与调用数一致" };
    }
    // 4. 回显校验：条目须 field-equal 某 allowed=true 调用的 options 成员（任一非法整批不落盘）
    const entries: TrustEntry[] = [];
    for (const item of whitelistRaw) {
      const parsed = trustEntrySchema.safeParse(item);
      if (!parsed.success || !isToolName(parsed.data.tool)) {
        return { ok: false, code: "invalid-body", message: "whitelist 条目不合法" };
      }
      entries.push(parsed.data);
    }
    for (const candidateEntry of entries) {
      const matches = entry.calls.some(
        (_, i) => allowed[i] === true && entry.options[i]?.some((option) => entryEquals(option, candidateEntry)) === true,
      );
      if (!matches) {
        return { ok: false, code: "invalid-body", message: "whitelist 条目不合法" };
      }
    }
    // 5. 桥自记：裁决落地即入档（档位无关）；先记账后核销
    entry.calls.forEach((call, i) => {
      const key = permission.key.of(call);
      if (key !== undefined && key !== "") {
        permission.candidates.record(call.name, key, allowed[i] === true ? "allowed" : "denied");
      }
    });
    // 6. 白名单落盘（grant 内部核销候选）
    for (const candidateEntry of entries) {
      permission.whitelist.grant(candidateEntry);
    }
    // 7. settle
    approvals.delete(id);
    clearTimeout(entry.timer);
    entry.resolve({ allowed, timedOut: false });
    return { ok: true };
  }

  /** 命中白名单外的当前候选（滤除已被白名单覆盖）。 */
  function candidates(): CandidateRecord[] {
    const entries = permission.whitelist.list();
    return permission.candidates
      .list()
      .filter((r) => !entries.some((e) => covers(e, { name: r.tool, key: r.key })));
  }

  /** 候选批量入库：全量原子校验（任一非法整批不落盘）；entryFor 物化后逐条 grant。 */
  function grant(items: unknown, scope: unknown): { ok: true; grants: GrantResult[] } | { ok: false; message: string } {
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, message: "items 必须为非空数组" };
    }
    if (scope !== "self" && scope !== "subtree") {
      return { ok: false, message: "scope 必须为 self 或 subtree" };
    }
    const entries: TrustEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (typeof item !== "object" || item === null) {
        return { ok: false, message: `items[${i}] 条目不合法` };
      }
      const record = item as Record<string, unknown>;
      if (typeof record.tool !== "string" || !isToolName(record.tool)) {
        return { ok: false, message: `items[${i}] 工具名不合法：${String(record.tool)}` };
      }
      if (typeof record.key !== "string" || record.key === "") {
        return { ok: false, message: `items[${i}] 键不能为空` };
      }
      if (scope === "subtree" && meta[record.tool].target !== "path") {
        return { ok: false, message: `items[${i}] 非路径工具不支持子树粒度：${record.tool}` };
      }
      const entry = permission.key.entryFor(record.tool, record.key, scope);
      if (entry === null) {
        return { ok: false, message: `items[${i}] 条目不合法` };
      }
      entries.push(entry);
    }
    const grants = entries.map((entry) => permission.whitelist.grant(entry));
    return { ok: true, grants };
  }

  /** 查看当前工作区白名单（存储形态原样返回）。 */
  function entries(): TrustEntry[] {
    return permission.whitelist.list();
  }

  /** 撤销所选白名单条目：全量原子校验（任一不合法整批 400）；三字段精确匹配命中才删，未命中跳过。 */
  function revoke(items: unknown): { ok: true; revoked: TrustEntry[] } | { ok: false; message: string } {
    if (!Array.isArray(items)) {
      return { ok: false, message: "items 必须为数组" };
    }
    const parsed: TrustEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const result = trustEntrySchema.safeParse(items[i]);
      if (!result.success) {
        return { ok: false, message: `items[${i}] 条目不合法` };
      }
      parsed.push(result.data);
    }
    const revoked: TrustEntry[] = [];
    for (const entry of parsed) {
      if (permission.whitelist.revoke(entry)) revoked.push(entry);
    }
    return { ok: true, revoked };
  }

  /** 清除所选候选（持久化删除，不写白名单）。 */
  function dismiss(items: unknown): { ok: true; dropped: number } | { ok: false; message: string } {
    if (!Array.isArray(items)) {
      return { ok: false, message: "items 必须为数组" };
    }
    const list: Array<{ tool: string; key: string }> = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (typeof item !== "object" || item === null) {
        return { ok: false, message: `items[${i}] 条目不合法` };
      }
      const record = item as Record<string, unknown>;
      if (typeof record.tool !== "string" || typeof record.key !== "string") {
        return { ok: false, message: `items[${i}] 条目不合法` };
      }
      list.push({ tool: record.tool, key: record.key });
    }
    return { ok: true, dropped: permission.candidates.drop(list) };
  }

  /** 协议文本：工作区声明 + 工具协议（单一来源 tool.protocol()）。 */
  function protocolText(): string {
    return `${permission.workspace.constraint()}\n\n${tool.protocol()}`;
  }

  /** 关闭：挂起审批全部按拒绝释放（不记候选，兜底定时器清除）、长轮询释放、清空回填队列。 */
  function close(): void {
    closed = true;
    for (const entry of approvals.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ allowed: new Array<boolean>(entry.calls.length).fill(false), timedOut: true });
    }
    approvals.clear();
    outbox.length = 0;
    for (const waiter of waiters) waiter();
    waiters.length = 0;
  }

  return { takeTask, submitReply, submitApproval, candidates, entries, grant, revoke, dismiss, protocolText, close };
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
  const status = result.status === "ok" ? "成功" : "失败";
  const fence = "```";
  return `${index}. 工具 ${call.name} 参数 ${JSON.stringify(call.arguments)} → ${status}：\n${fence}json\n${JSON.stringify(result)}\n${fence}`;
}

/** 拒绝/阻断行：`已拒绝/已阻断（{错误码}：{原因}）`。 */
function serializeBlockedLine(index: number, call: ToolCall, result: ActionResult<unknown>): string {
  const code = result.status === "error" ? result.error.code : "unknown";
  const reason = result.status === "error" ? result.error.message : JSON.stringify(result);
  const status = code === "dependency-blocked" ? "已阻断" : "已拒绝";
  return `${index}. 工具 ${call.name} 参数 ${JSON.stringify(call.arguments)} → ${status}（${code}：${reason}）`;
}

function serializeFeedback(lines: string[]): string {
  return `工具执行结果（human-agent）：\n${lines.join("\n")}`;
}
