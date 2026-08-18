import { Readable, Writable } from "node:stream";
import type { ConversationContext, Message } from "../src/brain/context.js";
import { FileReader } from "../src/eyes/file-reader.js";
import { FileWriter } from "../src/hands/file-writer.js";
import { Terminal } from "../src/hands/terminal.js";
import type { BrainInference, BrainInferenceResult, ToolInfo } from "../src/brain/llm.js";
import type { EarsContract, EyesContract, HandsContract } from "../src/types/index.js";

/** 类方法在 prototype 上，对象展开不会复制，必须显式组合（agent.ts 组装时同理）。 */
export function buildHands(): HandsContract {
  const writer = new FileWriter();
  const terminal = new Terminal();
  return {
    writeFile: (path, content) => writer.writeFile(path, content),
    applyPatch: (path, patch) => writer.applyPatch(path, patch),
    executeCommand: (command, signal) => terminal.executeCommand(command, signal),
  };
}

export function buildEyes(): EyesContract {
  const reader = new FileReader();
  return {
    readFile: (path) => reader.readFile(path),
    readDir: (path) => reader.readDir(path),
    searchCode: (pattern, dir) => reader.searchCode(pattern, dir),
    fetchPageAsMarkdown: () => Promise.reject(new Error("web-crawler 尚未实现")),
  };
}

export class FakeWritable extends Writable {
  public output = "";
  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += String(chunk);
    callback();
  }
}

export function inputFrom(text: string): Readable {
  return new Readable({
    read() {
      this.push(text);
      this.push(null);
    },
  });
}

/** 按脚本依次返回输入；脚本耗尽后抛错模拟 EOF。 */
export class FakeEars implements EarsContract {
  public promptCalls = 0;
  constructor(private readonly answers: string[]) {}

  async prompt(_question: string): Promise<string> {
    this.promptCalls++;
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("EOF");
    return answer;
  }
}

export interface ScriptedBrainStep {
  result?: BrainInferenceResult;
  error?: Error;
}

/** 按脚本依次返回推理结果；可抛出错误。记录每次 infer 的上下文快照。 */
export class ScriptedBrain implements BrainInference {
  private readonly calls: { messages: readonly Message[]; tools: readonly ToolInfo[] }[] = [];

  constructor(private readonly steps: ScriptedBrainStep[]) {}

  async infer(
    context: ConversationContext,
    tools: readonly ToolInfo[],
  ): Promise<BrainInferenceResult> {
    const step = this.steps.shift();
    if (step === undefined) throw new Error("ScriptedBrain 调用次数超出脚本");
    this.calls.push({ messages: context.getAll(), tools });
    if (step.error !== undefined) throw step.error;
    return step.result!;
  }

  callCount(): number {
    return this.calls.length;
  }

  messagesOf(call: number): readonly Message[] {
    const entry = this.calls[call];
    if (entry === undefined) throw new Error(`第 ${call} 次调用不存在`);
    return entry.messages;
  }
}
