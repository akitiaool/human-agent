import { ConversationContext } from "./brain/context.js";
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
import { createPermission } from "./permission/index.js";
import type { Permission } from "./permission/index.js";
import type {
  AgentOutput,
  AgentStatus,
  EarsContract,
  EyesContract,
  HandsContract,
  MouthContract,
} from "./types/index.js";

export interface HumanAgentOptions {
  brain?: BrainInference;
  ears?: EarsContract;
  mouth?: MouthContract;
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
  readonly mouth: MouthContract;
  readonly ears: EarsContract;
  readonly output: AgentOutput;
  readonly context: ConversationContext;
  readonly maxIterations: number;
  readonly timeoutMs: number | undefined;
  readonly #permission: Permission;

  constructor(options: HumanAgentOptions = {}) {
    this.interrupt = new InterruptController();
    this.eyes = options.eyes ?? buildDefaultEyes();
    this.hands = options.hands ?? buildDefaultHands(options.workspace);
    this.mouth = options.mouth ?? new AskUser();
    this.ears = options.ears ?? new TextInput();
    this.output = options.output ?? new TextOutput();
    this.context = options.context ?? new ConversationContext({ maxTokens: 8000 });
    this.maxIterations = options.maxIterations ?? 10;
    this.timeoutMs = options.timeoutMs;
    this.#permission = createPermission({
      workspace: options.workspace ?? process.cwd(),
      ...(options.whitelistFile !== undefined ? { whitelistFile: options.whitelistFile } : {}),
    });
    this.brain =
      options.brain ??
      new OllamaThinking({
        permission: this.#permission,
        ...(process.env.OLLAMA_BASE_URL !== undefined ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
        ...(process.env.OLLAMA_MODEL !== undefined ? { model: process.env.OLLAMA_MODEL } : {}),
      });
  }

  async run(): Promise<AgentStatus> {
    if (!this.context.getAll().some((message) => message.role === "system")) {
      this.context.add({ role: "system", content: this.#permission.workspace.constraint() });
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
      permission: this.#permission,
    });
    await loop.run();
    return loop.getStatus();
  }
}

export function buildDefaultEyes(): EyesContract {
  const reader = new FileReader();
  const crawler = new WebCrawler();
  return {
    readFile: (path, options) => reader.readFile(path, options),
    readDir: (path) => reader.readDir(path),
    searchCode: (pattern, dir) => reader.searchCode(pattern, dir),
    fetchPageAsMarkdown: (url) => crawler.fetchPageAsMarkdown(url),
  };
}

export function buildDefaultHands(workspace?: string): HandsContract {
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
