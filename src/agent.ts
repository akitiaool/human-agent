import { ConversationContext } from "./brain/context.js";
import { OllamaBrain } from "./brain/ollama-brain.js";
import type { BrainInference } from "./brain/llm.js";
import { TextInput } from "./ears/text-input.js";
import { FileReader } from "./eyes/file-reader.js";
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

  constructor(options: HumanAgentOptions = {}) {
    this.interrupt = new InterruptController();
    this.brain = options.brain ?? buildDefaultBrain();
    this.eyes = options.eyes ?? buildDefaultEyes();
    this.hands = options.hands ?? buildDefaultHands();
    this.nose = options.nose ?? buildDefaultNose();
    this.mouth = options.mouth ?? new AskUser();
    this.ears = options.ears ?? new TextInput();
    this.output = options.output ?? new TextOutput();
    this.context = options.context ?? new ConversationContext({ maxTokens: 8000 });
    this.maxIterations = options.maxIterations ?? 10;
  }

  async run(): Promise<AgentStatus> {
    const loop = new AgentLoop({
      brain: this.brain,
      ears: this.ears,
      nose: this.nose,
      mouth: this.mouth,
      eyes: this.eyes,
      hands: this.hands,
      output: this.output,
      signal: this.interrupt.getSignal(),
      context: this.context,
      maxIterations: this.maxIterations,
    });
    await loop.run();
    return loop.getStatus();
  }
}

function buildDefaultBrain(): BrainInference {
  return new OllamaBrain({
    ...(process.env.OLLAMA_BASE_URL !== undefined ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
    ...(process.env.OLLAMA_MODEL !== undefined ? { model: process.env.OLLAMA_MODEL } : {}),
  });
}

function buildDefaultNose(): NoseContract {
  const riskChecker = new RiskChecker();
  const envChecker = new EnvChecker();
  return {
    checkRisk: (command) => riskChecker.checkRisk(command),
    getEnvSnapshot: () => envChecker.getEnvSnapshot(),
  };
}

function buildDefaultEyes(): EyesContract {
  const reader = new FileReader();
  return {
    readFile: (path) => reader.readFile(path),
    readDir: (path) => reader.readDir(path),
    searchCode: (pattern, dir) => reader.searchCode(pattern, dir),
    fetchPageAsMarkdown: () => Promise.reject(new Error("web-crawler 尚未实现")),
  };
}

function buildDefaultHands(): HandsContract {
  const writer = new FileWriter();
  const terminal = new Terminal();
  return {
    writeFile: (path, content) => writer.writeFile(path, content),
    applyPatch: (path, patch) => writer.applyPatch(path, patch),
    executeCommand: (command, signal) => terminal.executeCommand(command, signal),
  };
}
