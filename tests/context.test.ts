import { describe, expect, it } from "vitest";
import { ConversationContext, estimateTokens } from "../src/brain/context.js";

describe("estimateTokens", () => {
  it("按约 4 字符 1 token 估算", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("ConversationContext", () => {
  it("add 后按顺序读取全部消息", () => {
    const context = new ConversationContext({ maxTokens: 1000 });
    context.add({ role: "system", content: "sys" });
    context.add({ role: "user", content: "hi" });
    context.add({ role: "assistant", content: "hello" });
    expect(context.getAll()).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("超过预算时自动裁剪最旧的非 system 消息", () => {
    const context = new ConversationContext({ maxTokens: 4 });
    context.add({ role: "system", content: "sys" }); // 1 token
    context.add({ role: "user", content: "aaaa" }); // 1 token
    context.add({ role: "user", content: "bbbb" }); // 1 token
    context.add({ role: "user", content: "cccc" }); // 1 token
    context.add({ role: "user", content: "dddd" }); // 超预算 → 裁剪最旧的 aaaa
    const roles = context.getAll().map((m) => m.content);
    expect(roles).toEqual(["sys", "bbbb", "cccc", "dddd"]);
  });

  it("system 消息永不裁剪", () => {
    const context = new ConversationContext({ maxTokens: 4 });
    context.add({ role: "system", content: "important" }); // 3 token
    context.add({ role: "system", content: "more" }); // 1 token
    context.add({ role: "user", content: "bbbb" }); // 已 4 token，再加超预算
    context.add({ role: "user", content: "cccc" });
    const systemCount = context.getAll().filter((m) => m.role === "system").length;
    expect(systemCount).toBe(2);
    expect(context.getAll().length).toBe(2); // 两条 user 都被裁剪
  });

  it("只有 system 消息且超预算时不崩溃并保留", () => {
    const context = new ConversationContext({ maxTokens: 1 });
    context.add({ role: "system", content: "very long system prompt" });
    expect(context.getAll().length).toBe(1);
  });

  it("clear 清空全部消息", () => {
    const context = new ConversationContext({ maxTokens: 1000 });
    context.add({ role: "user", content: "hi" });
    context.clear();
    expect(context.getAll()).toEqual([]);
  });

  it("tool 消息可携带工具名", () => {
    const context = new ConversationContext({ maxTokens: 1000 });
    context.add({ role: "tool", name: "terminal", content: "{\"status\":\"ok\"}" });
    expect(context.getAll()[0]).toEqual({
      role: "tool",
      name: "terminal",
      content: '{"status":"ok"}',
    });
  });
});
