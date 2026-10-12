import { describe, expect, it } from "vitest";
import { covers, isToolName, meta, names, schemas, tool, type TrustEntry } from "../src/tool/index.js";

describe("tool 域", () => {
  it("names 顺序 = 协议展示顺序（spec §2）", () => {
    expect([...names]).toEqual([
      "file_read", "file_write", "file_edit", "file_patch",
      "dir_list", "code_search", "command_run", "page_fetch",
    ]);
  });

  it("schemas 与 names 键集一致；meta 穷尽", () => {
    expect(Object.keys(schemas).sort()).toEqual([...names].sort());
    expect(Object.keys(meta).sort()).toEqual([...names].sort());
  });

  it("meta 表逐项正确（spec §2 元数据表）", () => {
    expect(meta).toEqual({
      file_read: { target: "path", access: "read" },
      file_write: { target: "path", access: "write" },
      file_edit: { target: "path", access: "write" },
      file_patch: { target: "path", access: "write" },
      dir_list: { target: "path", access: "read" },
      code_search: { target: "path", access: "read" },
      command_run: { target: "command", access: "write" },
      page_fetch: { target: "url", access: "read" },
    });
  });

  it("isToolName 判别", () => {
    expect(isToolName("file_read")).toBe(true);
    expect(isToolName("read_file")).toBe(false);
  });

  it("covers 矩阵（工具方向 + 键方向）", () => {
    const wsWrite: TrustEntry = { tool: "file_write", key: "/ws/", scope: "subtree" };
    expect(covers(wsWrite, { name: "file_read", key: "/ws/a/b.txt" })).toBe(true);   // 写覆盖读（同 target 前缀）
    expect(covers(wsWrite, { name: "file_read", key: "/ws" })).toBe(true);           // 目录条目自覆盖（去尾 /）
    expect(covers(wsWrite, { name: "file_read", key: "/ws-evil/a" })).toBe(false);   // 段级前缀边界
    const readSub: TrustEntry = { tool: "file_read", key: "/ws/src/", scope: "subtree" };
    expect(covers(readSub, { name: "file_write", key: "/ws/src/x.ts" })).toBe(false); // 读不覆盖写
    expect(covers(readSub, { name: "file_read", key: "/ws/src/x.ts" })).toBe(true);
    const cmd: TrustEntry = { tool: "command_run", key: "git status", scope: "self" };
    expect(covers(cmd, { name: "command_run", key: "git status" })).toBe(true);
    expect(covers(cmd, { name: "command_run", key: "git push" })).toBe(false);
    const selfWrite: TrustEntry = { tool: "file_write", key: "/ws/a.txt", scope: "self" };
    expect(covers(selfWrite, { name: "file_read", key: "/ws/a.txt" })).toBe(true);   // 写 self 覆盖读同键
    expect(covers(selfWrite, { name: "file_read", key: "/ws/b.txt" })).toBe(false);
    const unknown: TrustEntry = { tool: "mystery", key: "x", scope: "self" };
    expect(covers(unknown, { name: "mystery", key: "x" })).toBe(true);               // 表外工具仅同名
    expect(covers(unknown, { name: "file_read", key: "x" })).toBe(false);
  });

  it("infos 按 names 顺序且携带 parameters", () => {
    expect(tool.infos.map((i) => i.name)).toEqual([...names]);
    expect(tool.infos[0]?.parameters).toMatchObject({ type: "object" });
  });

  it("protocol 含全部新名、不含任何旧名（规则正文仅工具名逐字替换；DEPENDENCY_BLOCKED 保留）", () => {
    const text = tool.protocol();
    for (const name of names) expect(text).toContain(name);
    for (const old of ["read_file", "read_dir", "search_code", "write_file", "edit_file", "apply_patch", "fetch_page"]) {
      expect(text).not.toContain(old);
    }
    expect(text).not.toMatch(/\bterminal\b/);
    expect(text).toContain("DEPENDENCY_BLOCKED");
    expect(text).toContain("【human-agent 工具协议】");
  });

  it("硬规 5：tool 面成员快照", () => {
    expect(Object.keys(tool).sort()).toEqual(["covers", "infos", "meta", "names", "protocol", "schemas"]);
  });
});
