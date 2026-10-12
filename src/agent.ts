import { ConversationContext } from "./brain/context.js";
import { GeminiBridgeThinking } from "./brain/gemini-bridge-thinking.js";
import { OllamaThinking } from "./brain/ollama-thinking.js";
import type { BrainInference } from "./brain/llm.js";
import { TextInput } from "./ears/text-input.js";
import { FileReader } from "./eyes/file-reader.js";
import { WebCrawler } from "./eyes/web-crawler.js";
import { FileWriter } from "./hands/file-writer.js";
import { Terminal } from "./hands/terminal.js";
import { AgentLoop } from "./heart/loop.js";
import { InterruptController } from "./heart/interrupt.js";
import { TextOutput } from "./mouth/text-output.js";
import { AskUser } from "./mouth/ask-user.js";
import { EnvChecker } from "./nose/env-checker.js";
import { RiskChecker } from "./nose/risk-checker.js";
import type {
  AgentOutput,
  AgentStatus,
  EarsContract,
  EyesContract,
  HandsContract,
  MouthContract,
  NoseContract,
} from "./types/index.js";

export interface HumanAgentOptions {
  brain?: BrainInference;
  ears?: EarsContract;
  mouth?: MouthContract;
  nose?: NoseContract;
  eyes?: EyesContract;
  hands?: HandsContract;
  output?: AgentOutput;
  context?: ConversationContext;
  maxIterations?: number;
  /** 单轮任务超时（毫秒），0 表示禁用；会话中可用 /timeout 动态调整。 */
  timeoutMs?: number;
  /** 白名单文件；缺省 ~/.human-agent/whitelist.json（注入隔离测试/多实例用） */
  whitelistFile?: string;
  /** 工作区（启动 realpath 规范化）；缺省 process.cwd()。 */
  workspace?: string;
}

/** 人体合一组装类：构造注入各器官（设计文档 §5.3），默认提供完整默认组装。 */
export class HumanAgent {
  readonly interrupt: InterruptController;
  readonly brain: BrainInference;
  readonly eyes: EyesContract;
  readonly hands: HandsContract;
  readonly nose: NoseContract;
  readonly mouth: MouthContract;
  readonly ears: EarsContract;
  readonly output: AgentOutput;
  readonly context: ConversationContext;
  readonly maxIterations: number;
  readonly timeoutMs: number | undefined;
  readonly #loopWorkspace: string | undefined;

  constructor(options: HumanAgentOptions = {}) {
    this.interrupt = new InterruptController();
    this.eyes = options.eyes ?? buildDefaultEyes();
    this.hands = options.hands ?? buildDefaultHands(options.workspace);
    this.#loopWorkspace = options.workspace;
    this.nose = options.nose ?? buildDefaultNose();
    this.mouth = options.mouth ?? new AskUser();
    this.ears = options.ears ?? new TextInput();
    this.output = options.output ?? new TextOutput();
    this.context = options.context ?? new ConversationContext({ maxTokens: 8000 });
    this.maxIterations = options.maxIterations ?? 10;
    this.timeoutMs = options.timeoutMs;
    this.brain = options.brain ?? buildDefaultBrain(options.whitelistFile, options.workspace);
  }

  async run(): Promise<AgentStatus> {
    if (!this.context.getAll().some((message) => message.role === "system")) {
      this.context.add({ role: "system", content: this.brain.workspaceConstraint() });
    }
    const loop = new AgentLoop({
      brain: this.brain,
      ears: this.ears,
      eyes: this.eyes,
      hands: this.hands,
      mouth: this.mouth,
      output: this.output,
      signal: this.interrupt.getSignal(),
      context: this.context,
      maxIterations: this.maxIterations,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.#loopWorkspace !== undefined ? { workspace: this.#loopWorkspace } : {}),
    });
    await loop.run();
    return loop.getStatus();
  }
}

function buildDefaultBrain(whitelistFile?: string, workspace?: string): BrainInference {
  return new OllamaThinking({
    ...(process.env.OLLAMA_BASE_URL !== undefined ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
    ...(process.env.OLLAMA_MODEL !== undefined ? { model: process.env.OLLAMA_MODEL } : {}),
    ...(whitelistFile !== undefined ? { whitelistFile } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
  });
}

export interface BridgeServiceOptions {
  port?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: (text: string) => void;
  /** 白名单文件；缺省 ~/.human-agent/whitelist.json（注入隔离测试/多实例用） */
  whitelistFile?: string;
  /** 信任候选档案文件；缺省 ~/.human-agent/candidates.json（注入隔离测试/多实例用） */
  candidatesFile?: string;
  /** 工作区（启动 realpath 规范化）；缺省 process.cwd()。 */
  workspace?: string;
}

/** 桥模式组装：网页对话 + 智能体仅执行工具。port 缺省读 GEMINI_BRIDGE_PORT（非法回退 8765）。 */
export function buildBridgeService(options: BridgeServiceOptions = {}): GeminiBridgeThinking {
  const hands = buildDefaultHands(options.workspace);
  const eyes = buildDefaultEyes();
  const port = options.port ?? (() => {
    const raw = process.env.GEMINI_BRIDGE_PORT;
    if (raw === undefined) return 8765;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 8765;
  })();
  return new GeminiBridgeThinking({
    port,
    hands,
    eyes,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.whitelistFile !== undefined ? { whitelistFile: options.whitelistFile } : {}),
    ...(options.candidatesFile !== undefined ? { candidatesFile: options.candidatesFile } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
  });
}

function buildDefaultNose(): NoseContract {
  const riskChecker = new RiskChecker();
  const envChecker = new EnvChecker();
  return {
    checkRisk: (command) => riskChecker.checkRisk(command),
    getEnvSnapshot: () => envChecker.getEnvSnapshot(),
    checkPorts: (ports) => envChecker.checkPorts(ports),
  };
}

function buildDefaultEyes(): EyesContract {
  const reader = new FileReader();
  const crawler = new WebCrawler();
  return {
    readFile: (path, options) => reader.readFile(path, options),
    readDir: (path) => reader.readDir(path),
    searchCode: (pattern, dir) => reader.searchCode(pattern, dir),
    fetchPageAsMarkdown: (url) => crawler.fetchPageAsMarkdown(url),
  };
}

function buildDefaultHands(workspace?: string): HandsContract {
  const writer = new FileWriter();
  const terminal = new Terminal({ ...(workspace !== undefined ? { cwd: workspace } : {}) });
  return {
    writeFile: (path, content) => writer.writeFile(path, content),
    applyPatch: (path, patch) => writer.applyPatch(path, patch),
    editFile: (path, hunks, baseVersion) => writer.editFile(path, hunks, baseVersion),
    executeCommand: (command, signal, timeoutMs) =>
      terminal.executeCommand(command, signal, timeoutMs),
  };
}
