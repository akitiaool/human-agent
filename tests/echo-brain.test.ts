import { describe, expect, it } from "vitest";
import { ConversationContext } from "../src/brain/context.js";
import { EchoBrain } from "../src/brain/echo-brain.js";

describe("EchoBrain", () => {
  it("回显上下文中最后一条 user 消息", async () => {
    const brain = new EchoBrain();
    const context = new ConversationContext({ maxTokens: 1000 });
    context.add({ role: "system", content: "sys" });
    context.add({ role: "user", content: "你好" });
    context.add({ role: "assistant", content: "旧回答" });
    context.add({ role: "user", content: "最新问题" });
    const result = await brain.infer(context, []);
    expect(result.text).toBe("（echo）最新问题");
    expect(result.toolCalls).toBeUndefined();
  });

  it("没有 user 消息时输出空回显", async () => {
    const brain = new EchoBrain();
    const context = new ConversationContext({ maxTokens: 1000 });
    context.add({ role: "system", content: "sys" });
    const result = await brain.infer(context, []);
    expect(result.text).toBe("（echo）");
  });
});
