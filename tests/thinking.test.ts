import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BaseThinking } from "../src/brain/thinking.js";

class TestThinking extends BaseThinking {}

describe("BaseThinking 通用确定性层", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "thinking-test-"));
  const file = join(tempDir, "whitelist.json");
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it("启动即注册工作区写白名单（write_file path-dir，跨工具命中 apply_patch）", () => {
    const ws = mkdtempSync(join(tmpdir(), "thinking-ws-"));
    try {
      const wsReal = realpathSync(ws);
      const t = new TestThinking({ workspace: wsReal, whitelistFile: file });
      expect(
        t.classify({ name: "write_file", arguments: { path: join(wsReal, "src", "a.ts"), content: "x" } }).status,
      ).toBe("allowed");
      expect(
        t.classify({ name: "apply_patch", arguments: { path: join(wsReal, "a.ts"), patch: "+x" } }).status,
      ).toBe("allowed");
      expect(
        t.classify({ name: "write_file", arguments: { path: join(tmpdir(), "other", "a.ts"), content: "x" } }).status,
      ).toBe("unlisted");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("reflect 统一裁决入口", async () => {
    const t = new TestThinking({ workspace: "/ws", whitelistFile: file });
    const verdict = await t.reflect([
      { name: "terminal", arguments: { command: "rm -rf /" } },
      { name: "terminal", arguments: { command: "ls -la" } },
    ]);
    expect(verdict.blocked[0]!.result.error?.code).toBe("BLACKLIST");
    expect(verdict.pending).toHaveLength(1);
  });

  it("toolProtocol 含工作区声明与协议标记", () => {
    const t = new TestThinking({ workspace: "/home/u/proj", whitelistFile: file });
    const protocol = t.toolProtocol();
    expect(protocol).toContain("工作区是 /home/u/proj");
    expect(protocol).toContain("【human-agent 工具协议】");
  });

  it("addWhitelistEntry 落盘后 classify 生效", async () => {
    const t = new TestThinking({ workspace: "/ws", whitelistFile: file });
    await t.addWhitelistEntry({ tool: "terminal", key: "git status", kind: "exact" });
    const t2 = new TestThinking({ workspace: "/ws", whitelistFile: file });
    expect(t2.classify({ name: "terminal", arguments: { command: "git status" } }).status).toBe("allowed");
  });

  it("workspace getter / keyFor / whitelistEntries（管道 + 条目快照）", () => {
    const t = new TestThinking({ workspace: "/home/u/proj", whitelistFile: file });
    expect(t.workspace).toBe("/home/u/proj");
    expect(t.keyFor({ name: "terminal", arguments: { command: "git   status" } })).toBe("git status");
    expect(t.whitelistEntries().some((e) => e.kind === "path")).toBe(true); // ensureWorkspace 条目
  });

  it("defaultWhitelistFile 指向 ~/.human-agent/whitelist.json", () => {
    expect(BaseThinking.defaultWhitelistFile()).toContain(".human-agent");
  });
});
