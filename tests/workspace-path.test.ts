import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  normalizeMatchKey,
  resolveStartupWorkspace,
  resolveWorkspacePath,
} from "../src/nose/workspace-path.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "ws-path-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("resolveWorkspacePath", () => {
  it("相对值以工作区为基准绝对化（探针②修复）", () => {
    const ws = realpathSync(tmpRoot);
    const r = resolveWorkspacePath("src/foo.ts", ws);
    expect(r).not.toBeNull();
    expect(r!.execPath).toBe(join(ws, "src", "foo.ts"));
    expect(r!.matchKey).toBe(normalizeMatchKey(join(ws, "src", "foo.ts")));
  });

  it(".. 段有基准可正确消解（探针①前提）", () => {
    const deep = join(realpathSync(tmpRoot), "deep", "nested");
    mkdirSync(deep, { recursive: true });
    const r = resolveWorkspacePath(join("..", "..", "outside.txt"), deep);
    expect(r).not.toBeNull();
    expect(r!.execPath).toBe(join(realpathSync(tmpRoot), "outside.txt"));
  });

  it("深层不存在的尾段：最深已存在祖先归实 + 尾段拼回（新文件写入可判定）", () => {
    const ws = realpathSync(tmpRoot);
    const r = resolveWorkspacePath("new-dir/sub/new.txt", ws);
    expect(r!.execPath).toBe(join(ws, "new-dir", "sub", "new.txt"));
    expect(r!.matchKey).toBe(normalizeMatchKey(join(ws, "new-dir", "sub", "new.txt")));
  });

  it("junction/symlink 别名收敛同一匹配键（realpath 归实）", () => {
    const real = join(realpathSync(tmpRoot), "real-target");
    const alias = join(realpathSync(tmpRoot), "alias-link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    const viaAlias = resolveWorkspacePath(join(alias, "f.txt"), realpathSync(tmpRoot));
    const viaReal = resolveWorkspacePath(join(real, "f.txt"), realpathSync(tmpRoot));
    expect(viaAlias!.matchKey).toBe(viaReal!.matchKey);
  });

  it("realpath 全链失败 → null（绝不回退词法）", () => {
    const boom = () => {
      throw new Error("realpath unavailable");
    };
    expect(resolveWorkspacePath("a.txt", realpathSync(tmpRoot), boom)).toBeNull();
  });

  it.runIf(process.platform === "win32")("win32：匹配键小写 + 正斜杠；execPath 保留规范大小写", () => {
    const ws = realpathSync(tmpRoot);
    const r = resolveWorkspacePath("SRC\\A.TS", ws);
    expect(r!.matchKey).toBe(normalizeMatchKey(join(ws, "SRC", "A.TS")));
    expect(r!.matchKey).not.toMatch(/[A-Z]/);
    expect(r!.matchKey).toContain("/");
    expect(r!.execPath).not.toContain("/");
  });
});

describe("resolveStartupWorkspace", () => {
  it("优先级：--workspace > 环境变量 > CWD", () => {
    const a = mkdtempSync(join(tmpdir(), "ws-a-"));
    const b = mkdtempSync(join(tmpdir(), "ws-b-"));
    try {
      expect(resolveStartupWorkspace(a, b, tmpRoot)).toEqual({ ok: true, workspace: realpathSync(a) });
      expect(resolveStartupWorkspace(undefined, b, tmpRoot)).toEqual({ ok: true, workspace: realpathSync(b) });
      expect(resolveStartupWorkspace(undefined, undefined, a)).toEqual({ ok: true, workspace: realpathSync(a) });
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("相对值按 CWD 解析 + realpath 规范化", () => {
    mkdirSync(join(tmpRoot, "sub-ws"), { recursive: true });
    expect(resolveStartupWorkspace("sub-ws", undefined, tmpRoot)).toEqual({
      ok: true,
      workspace: realpathSync(join(tmpRoot, "sub-ws")),
    });
  });

  it("空串按缺省处理（空环境变量不生效）", () => {
    expect(resolveStartupWorkspace("", "", tmpRoot)).toEqual({ ok: true, workspace: realpathSync(tmpRoot) });
  });

  it("不存在 → 友好报错（含原值）", () => {
    const r = resolveStartupWorkspace("no-such-dir-xyz", undefined, tmpRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no-such-dir-xyz");
  });

  it("是文件不是目录 → 友好报错", () => {
    const file = join(tmpRoot, "afile.txt");
    writeFileSync(file, "x");
    const r = resolveStartupWorkspace(file, undefined, tmpRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不是目录");
  });
});
