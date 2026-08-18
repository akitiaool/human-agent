import type { ConversationContext } from "./context.js";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface BrainInferenceResult {
  text: string;
  toolCalls?: ToolCall[];
}

/** 大脑统一推理接口：输入上下文与可用工具，返回思考文本或工具调用意图（设计文档 §3.1）。 */
export interface BrainInference {
  infer(context: ConversationContext, tools: readonly ToolInfo[]): Promise<BrainInferenceResult>;
}
