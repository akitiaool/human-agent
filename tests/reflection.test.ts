import { describe, expect, it, vi } from "vitest";
import { Reflection } from "../src/brain/reflection.js";
import type { MouthContract, NoseContract, RiskLevel } from "../src/types/index.js";

function makeNose(risk: RiskLevel): NoseContract {
  return {
    checkRisk: () => risk,
    getEnvSnapshot: () => ({ os: "test", cwd: "/tmp" }),
    checkPorts: async () => [],
  };
}

function makeMouth(approve: boolean): MouthContract {
  return { confirm: async () => approve };
}

describe("Reflection", () => {
  it("安全命令放行", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const call = { name: "terminal", arguments: { command: "echo hi" } };
    const verdict = await reflection.reflect([call]);
    expect(verdict.allowed).toEqual([call]);
    expect(verdict.blocked).toEqual([]);
  });

  it("未知工具拦截为 UNKNOWN_TOOL", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const call = { name: "hack_the_planet", arguments: {} };
    const verdict = await reflection.reflect([call]);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("UNKNOWN_TOOL");
  });

  it("参数不合法拦截为 INVALID_ARGS", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const call = { name: "read_file", arguments: {} };
    const verdict = await reflection.reflect([call]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("INVALID_ARGS");
  });

  it("危险命令经用户拒绝后拦截为 USER_DENIED", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const reflection = new Reflection(makeNose("DANGEROUS"), { confirm });
    const call = { name: "terminal", arguments: { command: "rm -rf /" } };
    const verdict = await reflection.reflect([call]);
    expect(verdict.blocked[0]?.result.error?.code).toBe("USER_DENIED");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("rm -rf /"));
  });

  it("危险命令经用户确认后放行", async () => {
    const reflection = new Reflection(makeNose("DANGEROUS"), makeMouth(true));
    const call = { name: "terminal", arguments: { command: "rm -rf /tmp/test" } };
    const verdict = await reflection.reflect([call]);
    expect(verdict.allowed).toEqual([call]);
  });

  it("混合调用逐条裁决", async () => {
    const reflection = new Reflection(makeNose("SAFE"), makeMouth(true));
    const good = { name: "read_file", arguments: { path: "a.txt" } };
    const bad = { name: "read_file", arguments: {} };
    const verdict = await reflection.reflect([good, bad]);
    expect(verdict.allowed).toEqual([good]);
    expect(verdict.blocked).toHaveLength(1);
  });
});
