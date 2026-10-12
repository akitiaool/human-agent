// OllamaThinking：独立 BrainInference 实现（自带 permission + createReflection 委托）；
// infer 工具列表断言一律经 tool.infos（工具知识唯一来源）。
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OllamaThinking } from "../src/brain/ollama-thinking.js";
import { ConversationContext } from "../src/brain/context.js";
import type { Message } from "../src/brain/llm.js";
import { normalizeMatchKey } from "../src/permission/index.js";
import { tool } from "../src/tool/index.js";

function contextOf(...messages: Message[]): ConversationContext {
  const context = new ConversationContext({ maxTokens: 8000 });
  for (const message of messages) context.add(message);
  return context;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("OllamaThinking", () => {
  // 临时工作区与白名单/候选文件：构造即注册工作区写白名单（落盘），严禁触碰真实 ~/.human-agent/*
  const wsDir = mkdtempSync(join(tmpdir(), "ollama-thinking-ws-"));
  const wsReal = realpathSync.native(wsDir);
  const fixtureDir = mkdtempSync(join(tmpdir(), "ollama-thinking-fixture-"));
  let seq = 0;
  afterAll(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  function whitelistPath(): string {
    return join(fixtureDir, `whitelist-${seq++}.json`);
  }

  function makeBrain(fetchImpl: typeof fetch, whitelistFile: string = whitelistPath()) {
    return new OllamaThinking({ fetchImpl, whitelistFile, workspace: wsReal });
  }

  it("纯文本回复映射为 text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "你好" } }));
    const brain = makeBrain(fetchImpl);
    const result = await brain.infer(contextOf({ role: "user", content: "hi" }), tool.infos);
    expect(result.text).toBe("你好");
    expect(result.toolCalls).toBeUndefined();
  });

  it("工具调用映射为 toolCalls（arguments 为对象）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "command_run", arguments: { command: "echo hi" } } }],
        },
      }),
    );
    const brain = makeBrain(fetchImpl);
    const result = await brain.infer(contextOf({ role: "user", content: "执行" }), tool.infos);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([{ name: "command_run", arguments: { command: "echo hi" } }]);
  });

  it("同时返回文本与多个工具调用", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        message: {
          role: "assistant",
          content: "我先看看",
          tool_calls: [
            { function: { name: "file_read", arguments: { path: "a.txt" } } },
            { function: { name: "dir_list", arguments: { path: "." } } },
          ],
        },
      }),
    );
    const brain = makeBrain(fetchImpl);
    const result = await brain.infer(contextOf({ role: "user", content: "看看" }), tool.infos);
    expect(result.text).toBe("我先看看");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![1]).toEqual({ name: "dir_list", arguments: { path: "." } });
  });

  it("非 200 响应抛错", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "model not found" }, 404));
    const brain = makeBrain(fetchImpl);
    await expect(brain.infer(contextOf({ role: "user", content: "hi" }), tool.infos)).rejects.toThrow("404");
  });

  it("网络异常向上抛出", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const brain = makeBrain(fetchImpl);
    await expect(brain.infer(contextOf({ role: "user", content: "hi" }), tool.infos)).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("请求体包含 model、messages 与 tool.infos 派生的 tools", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "ok" } }));
    const brain = makeBrain(fetchImpl);
    await brain.infer(
      contextOf(
        { role: "system", content: "你是助手" },
        { role: "user", content: "请读取文件" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ name: "file_read", arguments: { path: "a.txt" } }],
        },
        { role: "tool", name: "file_read", content: '{"status":"ok"}' },
      ),
      tool.infos,
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
        tool_calls: [{ function: { name: "file_read", arguments: { path: "a.txt" } } }],
      },
      { role: "tool", content: '{"status":"ok"}' },
    ]);
    const sentTools = body.tools as Array<{ type: string; function: { name: string } }>;
    expect(sentTools).toHaveLength(tool.infos.length);
    expect(sentTools.map((entry) => entry.function.name)).toEqual(tool.infos.map((info) => info.name));
    expect(sentTools[0]).toEqual({ type: "function", function: tool.infos[0] });
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
    await brain.infer(contextOf({ role: "user", content: "hi" }), tool.infos, controller.signal);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init!.signal).toBe(controller.signal);
  });

  it("可自定义 baseUrl 与 model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: { role: "assistant", content: "ok" } }));
    const brain = new OllamaThinking({
      baseUrl: "http://10.0.0.2:8080",
      model: "qwen3:8b",
      fetchImpl,
      whitelistFile: whitelistPath(),
      workspace: wsReal,
    });
    await brain.infer(contextOf({ role: "user", content: "hi" }), tool.infos);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://10.0.0.2:8080/api/chat");
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.model).toBe("qwen3:8b");
  });

  it("reflect 委托 Reflection（自带 permission）：黑名单拦截 / 白名单放行 / 未列 pending", async () => {
    const whitelistFile = whitelistPath();
    writeFileSync(
      whitelistFile,
      JSON.stringify({
        version: 1,
        workspaces: {
          [normalizeMatchKey(wsReal)]: [{ tool: "command_run", key: "git status", scope: "self" }],
        },
      }),
      "utf8",
    );
    const brain = new OllamaThinking({ fetchImpl: vi.fn(), whitelistFile, workspace: wsReal });
    const blocked = await brain.reflect([{ name: "command_run", arguments: { command: "rm -rf /" } }]);
    const result = blocked.blocked[0]!.result;
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("blacklist");
    const allowed = await brain.reflect([{ name: "command_run", arguments: { command: "git status" } }]);
    expect(allowed.allowed).toHaveLength(1);
    const pending = await brain.reflect([{ name: "command_run", arguments: { command: "ls -la" } }]);
    expect(pending.pending).toHaveLength(1);
  });
});
