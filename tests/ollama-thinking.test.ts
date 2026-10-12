import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OllamaThinking } from "../src/brain/ollama-thinking.js";
import { ConversationContext } from "../src/brain/context.js";
import type { Message, ToolInfo } from "../src/brain/llm.js";

function contextOf(...messages: Message[]): ConversationContext {
  const context = new ConversationContext({ maxTokens: 8000 });
  for (const message of messages) context.add(message);
  return context;
}

const TOOLS: readonly ToolInfo[] = [
  {
    name: "terminal",
    description: "执行 shell 命令",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("OllamaBrain", () => {
  // 临时白名单文件：BaseThinking 构造即注册工作区写白名单（落盘），严禁触碰真实 ~/.human-agent/whitelist.json
  const tempDir = mkdtempSync(join(tmpdir(), "ollama-thinking-test-"));
  const whitelistFile = join(tempDir, "whitelist.json");
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  function makeBrain(fetchImpl: typeof fetch) {
    return new OllamaThinking({ fetchImpl, whitelistFile, workspace: "/ws-test" });
  }

  it("纯文本回复映射为 text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "你好" } }));
    const brain = makeBrain(fetchImpl);
    const result = await brain.infer(contextOf({ role: "user", content: "hi" }), TOOLS);
    expect(result.text).toBe("你好");
    expect(result.toolCalls).toBeUndefined();
  });

  it("工具调用映射为 toolCalls（arguments 为对象）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "terminal", arguments: { command: "echo hi" } } }],
        },
      }),
    );
    const brain = makeBrain(fetchImpl);
    const result = await brain.infer(contextOf({ role: "user", content: "执行" }), TOOLS);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([{ name: "terminal", arguments: { command: "echo hi" } }]);
  });

  it("同时返回文本与多个工具调用", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        message: {
          role: "assistant",
          content: "我先看看",
          tool_calls: [
            { function: { name: "read_file", arguments: { path: "a.txt" } } },
            { function: { name: "read_dir", arguments: { path: "." } } },
          ],
        },
      }),
    );
    const brain = makeBrain(fetchImpl);
    const result = await brain.infer(contextOf({ role: "user", content: "看看" }), TOOLS);
    expect(result.text).toBe("我先看看");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![1]).toEqual({ name: "read_dir", arguments: { path: "." } });
  });

  it("非 200 响应抛错", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "model not found" }, 404));
    const brain = makeBrain(fetchImpl);
    await expect(brain.infer(contextOf({ role: "user", content: "hi" }), TOOLS)).rejects.toThrow("404");
  });

  it("网络异常向上抛出", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const brain = makeBrain(fetchImpl);
    await expect(brain.infer(contextOf({ role: "user", content: "hi" }), TOOLS)).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("请求体包含 model、messages 与带 parameters 的 tools", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "ok" } }));
    const brain = makeBrain(fetchImpl);
    await brain.infer(
      contextOf(
        { role: "system", content: "你是助手" },
        { role: "user", content: "请读取文件" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ name: "terminal", arguments: { command: "echo x" } }],
        },
        { role: "tool", name: "terminal", content: '{"status":"ok"}' },
      ),
      TOOLS,
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.model).toBe("qwen3:4b");
    expect(body.messages).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "请读取文件" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "terminal", arguments: { command: "echo x" } } }],
      },
      { role: "tool", content: '{"status":"ok"}' },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "terminal",
          description: "执行 shell 命令",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
    ]);
  });

  it("工具列表为空时请求体不发送 tools 字段", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "ok" } }));
    const brain = makeBrain(fetchImpl);
    await brain.infer(contextOf({ role: "user", content: "hi" }), []);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

  it("infer 把 signal 传给 fetch，中断可取消请求", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "ok" } }));
    const brain = makeBrain(fetchImpl);
    const controller = new AbortController();
    await brain.infer(contextOf({ role: "user", content: "hi" }), TOOLS, controller.signal);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init!.signal).toBe(controller.signal);
  });

  it("可自定义 baseUrl 与 model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "ok" } }));
    const brain = new OllamaThinking({
      baseUrl: "http://10.0.0.2:8080",
      model: "qwen3:8b",
      fetchImpl,
      whitelistFile,
      workspace: "/ws-test",
    });
    await brain.infer(contextOf({ role: "user", content: "hi" }), TOOLS);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://10.0.0.2:8080/api/chat");
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.model).toBe("qwen3:8b");
  });

  it("reflect 继承 BaseThinking：黑名单拦截 / 未列命令进 pending", async () => {
    const brain = new OllamaThinking({ fetchImpl: vi.fn(), whitelistFile, workspace: "/ws-test" });
    const verdict = await brain.reflect([{ name: "terminal", arguments: { command: "rm -rf /" } }]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("blacklist");
    const pending = await brain.reflect([{ name: "terminal", arguments: { command: "ls -la" } }]);
    expect(pending.pending).toHaveLength(1);
  });
});
