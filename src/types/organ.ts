// 各器官的标准入参/出参契约（设计文档 §3、§6.1）

// ---------- 通用工具结果契约：双手/眼睛无论成败必须返回，严禁抛错 (§6.1) ----------

export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
}

export function ok<T>(data: T): ActionResult<T> {
  return { success: true, data };
}

export function fail<T = never>(code: string, message: string, stack?: string): ActionResult<T> {
  return {
    success: false,
    error: {
      code,
      message,
      ...(stack !== undefined ? { stack } : {}),
    },
  };
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

export interface EyesContract {
  readFile(path: string): Promise<ActionResult<string>>;
  readDir(path: string): Promise<ActionResult<string[]>>;
  searchCode(pattern: string, dir?: string): Promise<ActionResult<string[]>>;
  fetchPageAsMarkdown(url: string): Promise<ActionResult<string>>;
}

export interface EarsContract {
  prompt(question: string): Promise<string>;
}

/** 白名单条目：exact 精确整串 / path 写类路径（目录条目 key 以 / 结尾）。 */
export interface WhitelistEntry {
  tool: string;
  key: string;
  kind: "exact" | "path";
}

/** 审批提示：工具名 + 匹配键 + 条目类型（写类为 path，其余 exact）。 */
export interface ApprovalPrompt {
  tool: string;
  key: string;
  kind: "exact" | "path";
}

export type ApprovalChoice =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "whitelist"; entry: WhitelistEntry };

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
  executeCommand(command: string, signal?: AbortSignal, timeoutMs?: number): Promise<ActionResult<string>>;
}

export interface NoseContract {
  checkRisk(command: string): RiskLevel;
  getEnvSnapshot(): EnvSnapshot;
  checkPorts(ports: number[]): Promise<PortStatus[]>;
}
