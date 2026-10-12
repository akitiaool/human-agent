import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/nose/policy.js";
import { Reflection } from "../src/brain/reflection.js";
import { normalizeMatchKey } from "../src/nose/workspace-path.js";

function policy(entries = []) {
  return new PermissionPolicy({ workspace: "/ws", entries });
}

describe("Reflection 权限集成裁决", () => {
  it("黑名单命中 → blacklist 拦截（无审批无白名单）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "rm -rf /" } },
    ]);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.pending).toEqual([]);
    expect(verdict.blocked).toHaveLength(1);
    expect(verdict.blocked[0]!.result.error?.code).toBe("blacklist");
  });

  it("白名单命中 → 放行（不进 pending）", async () => {
    const verdict = await new Reflection(
      policy([{ tool: "terminal", key: "git status", kind: "exact" }]),
    ).reflect([{ name: "terminal", arguments: { command: "git status" } }]);
    expect(verdict.allowed).toHaveLength(1);
    expect(verdict.pending).toEqual([]);
    expect(verdict.blocked).toEqual([]);
  });

  it("未命中白名单（结构合法）→ pending（需授权）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "ls -la" } },
      { name: "read_file", arguments: { path: "src/a.ts" } },
    ]);
    expect(verdict.pending).toHaveLength(2);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.blocked).toEqual([]);
  });

  it("未知工具 / 参数非法 → 拦截（无论白名单）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "ghost_tool", arguments: {} },
      { name: "terminal", arguments: {} },
    ]);
    expect(verdict.blocked.map((b) => b.result.error?.code)).toEqual(["unknown-tool", "invalid-args"]);
    expect(verdict.pending).toEqual([]);
  });

  it("危险但未入黑名单的命令 → pending（不再嘴巴确认）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "git push --force origin main" } },
    ]);
    expect(verdict.pending).toHaveLength(1);
  });

  it("读界内 allowed（写 path-dir 覆盖读）、读界外 pending", async () => {
    const ws = mkdtempSync(join(tmpdir(), "reflect-ws-"));
    try {
      const wsReal = realpathSync(ws);
      const p = new PermissionPolicy({
        workspace: wsReal,
        entries: [{ tool: "write_file", key: `${normalizeMatchKey(wsReal)}/`, kind: "path" }],
      });
      const outside = process.platform === "win32" ? "D:\\secrets.txt" : "/etc/secrets.txt";
      const verdict = await new Reflection(p).reflect([
        { name: "read_file", arguments: { path: "src/a.ts" } },
        { name: "read_file", arguments: { path: outside } },
      ]);
      expect(verdict.allowed).toHaveLength(1);
      expect(verdict.pending).toHaveLength(1);
      expect(verdict.blocked).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
