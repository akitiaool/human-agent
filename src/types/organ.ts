// 各器官的标准入参/出参契约（设计文档 §3、§6.1）
import type { DiffHunk } from "../brain/llm.js";
import type { TrustEntry } from "../tool/index.js";

// ---------- 通用工具结果契约：双手/眼睛无论成败必须返回，严禁抛错 (§6.1) ----------

export type ActionResult<T = unknown> =
  | { status: "ok"; data?: T }
  | { status: "error"; error: { code: string; message: string; stack?: string } };

export function ok<T>(data?: T): ActionResult<T> {
  return data === undefined ? { status: "ok" } : { status: "ok", data };
}

export function fail(code: string, message: string, stack?: string): ActionResult<never> {
  return { status: "error", error: stack !== undefined ? { code, message, stack } : { code, message } };
}

// ---------- 鼻子：嗅探与预警 (§3.7) ----------

export type RiskLevel = "SAFE" | "DANGEROUS";

export interface EnvSnapshot {
  os: string;
  cwd: string;
  gitBranch?: string;
}

export interface PortStatus {
  port: number;
  occupied: boolean;
}

// ---------- 心脏：生命周期 (§2、§6.2，中断时置为 INTERRUPTED) ----------

export type AgentStatus = "IDLE" | "RUNNING" | "INTERRUPTED" | "ERROR";

export type AgentPhase =
  | "LISTENING" // 听取指令
  | "THINKING" // 大脑思考
  | "ACTING" // 手眼执行
  | "FEEDBACK"; // 反馈结果

// ---------- 器官契约：方法与文档 §3 一一对应 ----------

export interface ReadFileResult {
  content: string;
  versionId: string;
  totalLines: number;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

export interface EditFileResult {
  path: string;
  newVersionId: string;
  hunksApplied: number;
}

export interface EyesContract {
  readFile(path: string, options?: { startLine?: number | undefined; lineCount?: number | undefined }): Promise<ActionResult<string | ReadFileResult>>;
  readDir(path: string): Promise<ActionResult<string[]>>;
  searchCode(pattern: string, dir?: string): Promise<ActionResult<string[]>>;
  fetchPageAsMarkdown(url: string): Promise<ActionResult<string>>;
}

export interface EarsContract {
  prompt(question: string): Promise<string>;
}

/** 审批提示：工具名 + 匹配键 + 预构造的合法信任条目选项（顺序即展示顺序）。 */
export interface ApprovalPrompt {
  tool: string;
  key: string;
  options: TrustEntry[];
}

export type ApprovalChoice =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "whitelist"; entry: TrustEntry };

export interface MouthContract {
  confirm(message: string): Promise<boolean>;
  /** 需授权调用的人工三选：允许 / 拒绝 / 加入白名单（写类另有「此目录」）。 */
  askApproval(prompt: ApprovalPrompt): Promise<ApprovalChoice>;
}

/** 嘴巴输出契约（TextOutput 的结构化视图，便于测试注入）。 */
export interface AgentOutput {
  speak(text: string): Promise<void>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  printDiff(diff: string): void;
}

export interface HandsContract {
  writeFile(path: string, content: string): Promise<ActionResult<void>>;
  applyPatch(path: string, patch: string): Promise<ActionResult<void>>;
  editFile(path: string, hunks: readonly DiffHunk[], baseVersion?: string | undefined): Promise<ActionResult<EditFileResult>>;
  executeCommand(command: string, signal?: AbortSignal, timeoutMs?: number | undefined): Promise<ActionResult<string>>;
}

export interface NoseContract {
  checkRisk(command: string): RiskLevel;
  getEnvSnapshot(): EnvSnapshot;
  checkPorts(ports: number[]): Promise<PortStatus[]>;
}
