// 反思层：createReflection({permission}) 裁决顺序（黑名单 → 未知/非法 → 白名单 → pending）与拦截码。
// 工具名已切新词根；夹具 = tmp 工作区 + tmp 白名单/候选文件（隔离防污染真实文件）。
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReflection } from "../src/brain/reflection.js";
import type { ToolCall } from "../src/brain/llm.js";
import { createPermission, normalizeMatchKey } from "../src/permission/index.js";
import type { ActionResult } from "../src/types/index.js";

const wsDir = mkdtempSync(join(tmpdir(), "reflect-ws-"));
const wsReal = realpathSync.native(wsDir);
const fixtureDir = mkdtempSync(join(tmpdir(), "reflect-fixture-"));
const outDir = mkdtempSync(join(tmpdir(), "reflect-out-"));
const outReal = normalizeMatchKey(realpathSync.native(outDir));
const outsidePath = join(tmpdir(), "reflect-outside.txt");
let seq = 0;

afterAll(() => {
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

function makeReflection() {
  const base = join(fixtureDir, `case-${seq++}`);
  const permission = createPermission({
    workspace: wsReal,
    whitelistFile: `${base}-whitelist.json`,
    candidatesFile: `${base}-candidates.json`,
  });
  return { permission, reflection: createReflection({ permission }) };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { name, arguments: args };
}

function blockedCode(result: ActionResult<unknown>): string {
  return result.status === "error" ? result.error.code : "ok";
}

describe("Reflection 权限集成裁决", () => {
  it("① 黑名单命中 → blacklist 拦截（无审批无白名单）", async () => {
    const { reflection } = makeReflection();
    const verdict = await reflection.reflect([call("command_run", { command: "rm -rf /" })]);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.pending).toEqual([]);
    expect(verdict.blocked).toHaveLength(1);
    expect(blockedCode(verdict.blocked[0]!.result)).toBe("blacklist");
  });

  it("② 白名单命中 → 放行（不进 pending）", async () => {
    const { permission, reflection } = makeReflection();
    permission.whitelist.grant({ tool: "command_run", key: "git status", scope: "self" });
    const verdict = await reflection.reflect([call("command_run", { command: "git status" })]);
    expect(verdict.allowed).toHaveLength(1);
    expect(verdict.pending).toEqual([]);
    expect(verdict.blocked).toEqual([]);
  });

  it("③ 未命中白名单（结构合法）→ pending（需授权）", async () => {
    const { reflection } = makeReflection();
    const verdict = await reflection.reflect([
      call("command_run", { command: "ls -la" }),
      call("file_read", { path: outsidePath }),
    ]);
    expect(verdict.pending).toHaveLength(2);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.blocked).toEqual([]);
  });

  it("④ 未知工具 / 参数非法 → 拦截（先于白名单与 pending）", async () => {
    const { reflection } = makeReflection();
    const verdict = await reflection.reflect([
      call("ghost_tool", {}),
      call("command_run", {}),
    ]);
    expect(verdict.blocked.map((b) => blockedCode(b.result))).toEqual(["unknown-tool", "invalid-args"]);
    expect(verdict.pending).toEqual([]);
  });

  it("⑤ 危险但未入黑名单的命令 → pending（黑名单是唯一硬拒来源）", async () => {
    const { reflection } = makeReflection();
    const verdict = await reflection.reflect([
      call("command_run", { command: "git push --force origin main" }),
    ]);
    expect(verdict.pending).toHaveLength(1);
  });

  it("⑥ 写蕴含读（端到端）：file_write 子树条目覆盖文件读；界外读仍 pending", async () => {
    // 用工作区外目录树验证：界内路径已被构造期工作区信任覆盖，无法证伪
    const { permission, reflection } = makeReflection();
    const grant = permission.whitelist.grant({
      tool: "file_write",
      key: `${outReal}/src/`,
      scope: "subtree",
    });
    expect(grant.add.status).toBe("added");
    const verdict = await reflection.reflect([
      call("file_read", { path: join(outDir, "src", "a.ts") }),
      call("file_read", { path: outsidePath }),
    ]);
    expect(verdict.allowed).toHaveLength(1);
    expect(verdict.allowed[0]!.name).toBe("file_read");
    expect(verdict.pending).toHaveLength(1);
    expect(verdict.blocked).toEqual([]);
  });
});
