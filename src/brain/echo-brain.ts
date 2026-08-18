import type { ConversationContext } from "./context.js";
import type { BrainInference, BrainInferenceResult, ToolInfo } from "./llm.js";

/** 占位大脑：回显最后一条 user 消息。接入真实大模型前的默认实现。 */
export class EchoBrain implements BrainInference {
  async infer(
    context: ConversationContext,
    _tools: readonly ToolInfo[],
  ): Promise<BrainInferenceResult> {
    const messages = context.getAll();
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    return { text: `（echo）${lastUser?.content ?? ""}` };
  }
}
