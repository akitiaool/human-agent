import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPermission, permission } from "../src/permission/index.js";
import { normalizeMatchKey } from "../src/permission/key.js";

const wsTmp = mkdtempSync(join(tmpdir(), "perm-ws-"));
const wsReal = realpathSync.native(wsTmp);

const mkPerm = () => {
  const tmp = mkdtempSync(join(tmpdir(), "perm-"));
  return createPermission({
    workspace: wsReal, // realpath 实测的 tmp 工作区
    whitelistFile: join(tmp, "whitelist.json"),
    candidatesFile: join(tmp, "candidates.json"),
  });
};

describe("permission 门面", () => {
  it("构造即注册工作区写白名单（幂等：二次构造 + list 仍单条）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "perm-"));
    const file = join(tmp, "whitelist.json");
    createPermission({ workspace: wsReal, whitelistFile: file, candidatesFile: join(tmp, "candidates.json") });
    const p2 = createPermission({ workspace: wsReal, whitelistFile: file, candidatesFile: join(tmp, "candidates.json") });
    expect(p2.whitelist.list()).toHaveLength(1);
    expect(p2.whitelist.list()[0]).toMatchObject({ tool: "file_write", scope: "subtree" });
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });

  it("constraint 文案沿用现措辞", () => {
    expect(mkPerm().workspace.constraint()).toBe(`你的工作区是 ${wsReal}，工具调用请保持在界内；界外操作需要用户授权。`);
  });

  it("blacklist.list 形状 {command, write-path}（模式源串视图）", () => {
    const list = mkPerm().blacklist.list();
    expect(list.command.length).toBeGreaterThan(0);
    expect(list["write-path"].length).toBeGreaterThan(0);
    expect(typeof list.command[0]).toBe("string");
  });

  it("模块级 resolve：--workspace > 环境变量 > CWD；不存在/非目录 → workspace-invalid", () => {
    const a = mkdtempSync(join(tmpdir(), "a-"));
    const b = mkdtempSync(join(tmpdir(), "b-"));
    expect(permission.workspace.resolve(a, b, process.cwd())).toEqual({ status: "ok", workspace: realpathSync.native(a) });
    // 注：resolve 返回 realpath 原大小写（裁定 5）；b/cwd 分支同理
    const nonexist = permission.workspace.resolve(join(a, "nope"), undefined, process.cwd());
    expect(nonexist.status).toBe("error");
    if (nonexist.status === "error") expect(nonexist.error.code).toBe("workspace-invalid");
  });

  it("空串按缺省处理（空 cli/空环境变量不生效）", () => {
    const cwdDir = mkdtempSync(join(tmpdir(), "cwd-"));
    expect(permission.workspace.resolve("", undefined, cwdDir)).toEqual({
      status: "ok",
      workspace: realpathSync.native(cwdDir),
    });
    expect(permission.workspace.resolve(undefined, "", cwdDir)).toEqual({
      status: "ok",
      workspace: realpathSync.native(cwdDir),
    });
  });

  it("相对值按传入 cwd 解析 + realpath 规范化", () => {
    const base = mkdtempSync(join(tmpdir(), "base-"));
    mkdirSync(join(base, "sub"));
    expect(permission.workspace.resolve("sub", undefined, base)).toEqual({
      status: "ok",
      workspace: realpathSync.native(join(base, "sub")),
    });
  });

  it("硬规 5：Permission 各子命名空间成员快照", () => {
    const p = mkPerm();
    expect(Object.keys(p).sort()).toEqual(["blacklist", "candidates", "key", "verdict", "whitelist", "workspace"]);
    expect(Object.keys(p.key).sort()).toEqual(["entryFor", "execPath", "normalize", "of", "optionsFor"]);
    expect(Object.keys(p.verdict)).toEqual(["decide"]);
    expect(Object.keys(p.whitelist).sort()).toEqual(["grant", "list", "revoke"]);
    expect(Object.keys(p.blacklist)).toEqual(["list"]);
    expect(Object.keys(p.workspace)).toEqual(["constraint"]);
    expect(Object.keys(p.candidates).sort()).toEqual(["drop", "dropCoveredBy", "list", "record"]);
  });
});
