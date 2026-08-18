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

// ---------- 心脏：生命周期 (§2、§6.2，中断时置为 INTERRUPTED) ----------

export type AgentStatus = "IDLE" | "RUNNING" | "INTERRUPTED" | "ERROR";

export type AgentPhase =
  | "LISTENING" // 听取指令
  | "THINKING" // 大脑思考
  | "SNIFFING" // 鼻子嗅探
  | "ACTING" // 手眼执行
  | "FEEDBACK"; // 反馈结果

// ---------- 器官契约：方法与文档 §3 一一对应 ----------

export interface EyesContract {
  readFile(path: string): Promise<ActionResult<string>>;
  readDir(path: string): Promise<ActionResult<string[]>>;
  searchCode(pattern: string): Promise<ActionResult<string[]>>;
  fetchPageAsMarkdown(url: string): Promise<ActionResult<string>>;
}

export interface EarsContract {
  prompt(question: string): Promise<string>;
}

export interface MouthContract {
  confirm(message: string): Promise<boolean>;
}

export interface HandsContract {
  writeFile(path: string, content: string): Promise<ActionResult<void>>;
  applyPatch(path: string, patch: string): Promise<ActionResult<void>>;
  executeCommand(command: string, signal?: AbortSignal): Promise<ActionResult<string>>;
}

export interface NoseContract {
  checkRisk(command: string): RiskLevel;
  getEnvSnapshot(): EnvSnapshot;
}
