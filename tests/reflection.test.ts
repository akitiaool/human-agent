import { describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/nose/policy.js";
import { Reflection } from "../src/brain/reflection.js";

function policy(entries = []) {
  return new PermissionPolicy({ workspace: "/ws", entries });
}

describe("Reflection 权限集成裁决", () => {
  it("黑名单命中 → BLACKLIST 拦截（无审批无白名单）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "rm -rf /" } },
    ]);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.pending).toEqual([]);
    expect(verdict.blocked).toHaveLength(1);
    expect(verdict.blocked[0]!.result.error?.code).toBe("BLACKLIST");
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
    expect(verdict.blocked.map((b) => b.result.error?.code)).toEqual(["UNKNOWN_TOOL", "INVALID_ARGS"]);
    expect(verdict.pending).toEqual([]);
  });

  it("危险但未入黑名单的命令 → pending（不再嘴巴确认）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "git push --force origin main" } },
    ]);
    expect(verdict.pending).toHaveLength(1);
  });
});
