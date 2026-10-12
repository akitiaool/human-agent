import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeTool } from "../src/heart/executor.js";
import { Terminal } from "../src/hands/terminal.js";
import type { ActionResult, EyesContract, HandsContract } from "../src/types/index.js";

const ws = mkdtempSync(join(tmpdir(), "exec-ws-"));
const wsReal = realpathSync(ws);
afterAll(() => rmSync(ws, { recursive: true, force: true }));

function ok<T>(data: T): ActionResult<T> {
  return { status: "ok", data };
}

function makeRecordingOrgans() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const eyes: EyesContract = {
    readFile: async (path) => {
      calls.push({ name: "read_file", args: { path } });
      return ok("x");
    },
    readDir: async (path) => {
      calls.push({ name: "read_dir", args: { path } });
      return ok([]);
    },
    searchCode: async (pattern, dir) => {
      calls.push({ name: "search_code", args: { pattern, dir } });
      return ok([]);
    },
    fetchPageAsMarkdown: async (url) => {
      calls.push({ name: "fetch_page", args: { url } });
      return ok("#");
    },
  };
  const hands: HandsContract = {
    writeFile: async (path, content) => {
      calls.push({ name: "write_file", args: { path, content } });
      return ok(undefined);
    },
    applyPatch: async (path, patch) => {
      calls.push({ name: "apply_patch", args: { path, patch } });
      return ok(undefined);
    },
    editFile: async (path, hunks) => {
      calls.push({ name: "edit_file", args: { path } });
      return ok({ path, newVersionId: "v", hunksApplied: hunks.length });
    },
    executeCommand: async (command) => {
      calls.push({ name: "terminal", args: { command } });
      return ok("out");
    },
  };
  return { calls, eyes, hands };
}

describe("executeTool 执行一致性（执行落点 = 判定落点）", () => {
  it("相对路径经管道归实为绝对 execPath 传给器官（写/读一致）", async () => {
    const organs = makeRecordingOrgans();
    await executeTool(organs, "write_file", { path: "src/a.ts", content: "x" }, undefined, { workspace: wsReal });
    await executeTool(organs, "read_file", { path: "src/a.ts" }, undefined, { workspace: wsReal });
    await executeTool(organs, "read_dir", { path: "sub" }, undefined, { workspace: wsReal });
    const expected = join(wsReal, "src", "a.ts");
    expect(organs.calls[0]).toEqual({ name: "write_file", args: { path: expected, content: "x" } });
    expect(organs.calls[1]).toEqual({ name: "read_file", args: { path: expected } });
    expect(organs.calls[2]).toEqual({ name: "read_dir", args: { path: join(wsReal, "sub") } });
  });

  it("search_code dir 缺省 = 工作区根（判定与执行同标准）", async () => {
    const organs = makeRecordingOrgans();
    await executeTool(organs, "search_code", { pattern: "foo" }, undefined, { workspace: wsReal });
    expect(organs.calls[0]).toEqual({ name: "search_code", args: { pattern: "foo", dir: wsReal } });
  });

  it("管道失败（realpath 不可用）执行回退词法绝对化——执行不因归实失败搁浅", async () => {
    const organs = makeRecordingOrgans();
    const boom = () => {
      throw new Error("boom");
    };
    await executeTool(organs, "write_file", { path: "src/a.ts", content: "x" }, undefined, {
      workspace: wsReal,
      realpathFn: boom,
    });
    expect(organs.calls[0]).toEqual({
      name: "write_file",
      args: { path: resolve(wsReal, "src", "a.ts"), content: "x" },
    });
  });

  it("terminal cwd 钉到工作区（相对命令目标落在工作区内）", async () => {
    const terminal = new Terminal({ cwd: wsReal });
    const result = await terminal.executeCommand('node -e "console.log(process.cwd())"');
    expect(result.status).toBe("ok");
    expect(realpathSync(String(result.data).trim())).toBe(wsReal);
  });

  it("未提供 context 时参数原样透传（兼容既有调用）", async () => {
    const organs = makeRecordingOrgans();
    await executeTool(organs, "read_file", { path: "rel/a.ts" });
    expect(organs.calls[0]).toEqual({ name: "read_file", args: { path: "rel/a.ts" } });
  });
});
