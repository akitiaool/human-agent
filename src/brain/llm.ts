import type { ConversationContext } from "./context.js";
import type { ActionResult } from "../types/index.js";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema 形式（`{ type: "object", properties, required }`），供大模型工具调用协议使用。 */
  parameters: Record<string, unknown>;
}

export interface BrainInferenceResult {
  text: string;
  toolCalls?: ToolCall[];
}

/** 反思裁决：逐条调用给出 放行 或 拦截+错误反馈（大脑反思层的输出契约）。 */
export interface BlockedCall {
  call: ToolCall;
  result: ActionResult<unknown>;
}

export interface ReflectionVerdict {
  allowed: ToolCall[];
  blocked: BlockedCall[];
}

/** 大脑统一推理接口：输入上下文与可用工具，返回思考文本或工具调用意图（设计文档 §3.1）。 */
export interface BrainInference {
  infer(
    context: ConversationContext,
    tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult>;
  /** 反思：对候选工具调用做可行性裁决（存在性/结构/危险嗅探），放行或拦截+错误反馈。 */
  reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict>;
}
