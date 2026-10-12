// 执行器：新工具名路由 + {permission} 上下文（执行落点 = 判定落点，路径类经 execPath 归实）。
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeTool } from "../src/heart/executor.js";
import { Terminal } from "../src/hands/terminal.js";
import { createPermission } from "../src/permission/index.js";
import type { ActionResult, EyesContract, HandsContract } from "../src/types/index.js";

const wsDir = mkdtempSync(join(tmpdir(), "exec-ws-"));
const wsReal = realpathSync.native(wsDir);
const fixtureDir = mkdtempSync(join(tmpdir(), "exec-fixture-"));
let seq = 0;
afterAll(() => {
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

function makePermission(realpathFn?: (path: string) => string) {
  const base = join(fixtureDir, `case-${seq++}`);
  return createPermission({
    workspace: wsReal,
    whitelistFile: `${base}-whitelist.json`,
    candidatesFile: `${base}-candidates.json`,
    ...(realpathFn !== undefined ? { realpathFn } : {}),
  });
}

function ok<T>(data: T): ActionResult<T> {
  return { status: "ok", data };
}

function makeRecordingOrgans() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const eyes: EyesContract = {
    readFile: async (path) => {
      calls.push({ name: "file_read", args: { path } });
      return ok("x");
    },
    readDir: async (path) => {
      calls.push({ name: "dir_list", args: { path } });
      return ok([]);
    },
    searchCode: async (pattern, dir) => {
      calls.push({ name: "code_search", args: { pattern, dir } });
      return ok([]);
    },
    fetchPageAsMarkdown: async (url) => {
      calls.push({ name: "page_fetch", args: { url } });
      return ok("#");
    },
  };
  const hands: HandsContract = {
    writeFile: async (path, content) => {
      calls.push({ name: "file_write", args: { path, content } });
      return ok(undefined);
    },
    applyPatch: async (path, patch) => {
      calls.push({ name: "file_patch", args: { path, patch } });
      return ok(undefined);
    },
    editFile: async (path, hunks) => {
      calls.push({ name: "file_edit", args: { path } });
      return ok({ path, newVersionId: "v", hunksApplied: hunks.length });
    },
    executeCommand: async (command) => {
      calls.push({ name: "command_run", args: { command } });
      return ok("out");
    },
  };
  return { calls, eyes, hands };
}

describe("executeTool 执行一致性（执行落点 = 判定落点）", () => {
  it("相对路径经管道归实为绝对 execPath 传给器官（写/读/目录一致）", async () => {
    const organs = makeRecordingOrgans();
    const permission = makePermission();
    await executeTool(organs, "file_write", { path: "src/a.ts", content: "x" }, undefined, { permission });
    await executeTool(organs, "file_read", { path: "src/a.ts" }, undefined, { permission });
    await executeTool(organs, "dir_list", { path: "sub" }, undefined, { permission });
    const expected = join(wsReal, "src", "a.ts");
    expect(organs.calls[0]).toEqual({ name: "file_write", args: { path: expected, content: "x" } });
    expect(organs.calls[1]).toEqual({ name: "file_read", args: { path: expected } });
    expect(organs.calls[2]).toEqual({ name: "dir_list", args: { path: join(wsReal, "sub") } });
  });

  it("code_search dir 缺省 = 工作区根（判定与执行同标准）", async () => {
    const organs = makeRecordingOrgans();
    const permission = makePermission();
    await executeTool(organs, "code_search", { pattern: "foo" }, undefined, { permission });
    await executeTool(organs, "code_search", { pattern: "foo", dir: "src" }, undefined, { permission });
    expect(organs.calls[0]).toEqual({ name: "code_search", args: { pattern: "foo", dir: wsReal } });
    expect(organs.calls[1]).toEqual({
      name: "code_search",
      args: { pattern: "foo", dir: join(wsReal, "src") },
    });
  });

  it("管道失败（realpath 不可用）执行回退词法绝对化——执行不因归实失败搁浅", async () => {
    const organs = makeRecordingOrgans();
    const boom = () => {
      throw new Error("boom");
    };
    await executeTool(organs, "file_write", { path: "src/a.ts", content: "x" }, undefined, {
      permission: makePermission(boom),
    });
    expect(organs.calls[0]).toEqual({
      name: "file_write",
      args: { path: resolve(wsReal, "src", "a.ts"), content: "x" },
    });
  });

  it("terminal cwd 钉到工作区（相对命令目标落在工作区内）", async () => {
    const terminal = new Terminal({ cwd: wsReal });
    const result = await terminal.executeCommand('node -e "console.log(process.cwd())"');
    expect(result.status).toBe("ok");
    expect(realpathSync(String(result.data).trim())).toBe(wsReal);
  });

  it("缺必填参数 / 未知工具 → 结构化拦截（不触器官）", async () => {
    const organs = makeRecordingOrgans();
    const permission = makePermission();
    const missing = await executeTool(organs, "file_read", {}, undefined, { permission });
    expect(missing.status).toBe("error");
    if (missing.status === "error") expect(missing.error.code).toBe("invalid-args");
    const unknown = await executeTool(organs, "ghost_tool", {}, undefined, { permission });
    expect(unknown.status).toBe("error");
    if (unknown.status === "error") expect(unknown.error.code).toBe("unknown-tool");
    expect(organs.calls).toEqual([]);
  });
});
