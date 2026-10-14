// 移植注：原 tests/workspace-path.test.ts 的 resolveWorkspacePath 6 例 +
// tests/policy.test.ts 的归一（3 断言）/ matchKeyFor（5 断言）/「规范匹配键管道（缺陷实证探针）」10 例，
// 断言层一律改为 createKey 的 of/normalize/execPath（白名单/黑名单/classify 归后续任务）。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/brain/llm.js";
import { createKey, normalizeMatchKey, type RealpathFn } from "../src/permission/key.js";

// 夹具：tmp 目录 + realpath 实测；createKey 收 realpath 原大小写工作区（裁定 5）；
// 匹配键断言一律经 normalizeMatchKey（win32 小写）。
const wsDir = mkdtempSync(join(tmpdir(), "key-"));
const wsReal = realpathSync.native(wsDir);
const wsKey = normalizeMatchKey(wsReal);
afterAll(() => rmSync(wsDir, { recursive: true, force: true }));

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { name, arguments: args };
}

describe("路径管道（移植 resolveWorkspacePath 用例 → of/execPath）", () => {
  it("相对值以工作区为基准绝对化（探针②修复）", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.execPath("src/foo.ts")).toBe(join(wsReal, "src", "foo.ts"));
    expect(key.of(call("file_read", { path: "src/foo.ts" }))).toBe(
      normalizeMatchKey(join(wsReal, "src", "foo.ts")),
    );
  });

  it(".. 段有基准可正确消解（探针①前提）", () => {
    const deep = join(wsReal, "deep", "nested");
    mkdirSync(deep, { recursive: true });
    const key = createKey({ workspace: deep });
    const target = join("..", "..", "outside.txt");
    expect(key.execPath(target)).toBe(join(wsReal, "outside.txt"));
    expect(key.of(call("file_read", { path: target }))).toBe(normalizeMatchKey(join(wsReal, "outside.txt")));
  });

  it("深层不存在的尾段：最深已存在祖先归实 + 尾段拼回（新文件写入可判定）", () => {
    const key = createKey({ workspace: wsReal });
    const target = "new-dir/sub/new.txt";
    expect(key.execPath(target)).toBe(join(wsReal, "new-dir", "sub", "new.txt"));
    expect(key.of(call("file_write", { path: target, content: "x" }))).toBe(
      normalizeMatchKey(join(wsReal, "new-dir", "sub", "new.txt")),
    );
  });

  it("junction/symlink 别名收敛同一匹配键（realpath 归实）", () => {
    const key = createKey({ workspace: wsReal });
    const real = join(wsReal, "real-target");
    const alias = join(wsReal, "alias-link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    const viaAlias = key.of(call("file_read", { path: join(alias, "f.txt") }));
    const viaReal = key.of(call("file_read", { path: join(real, "f.txt") }));
    expect(viaAlias).toBe(viaReal);
  });

  it("realpath 全链失败 → of 返回 undefined（绝不回退词法）", () => {
    const boom: RealpathFn = () => {
      throw new Error("realpath unavailable");
    };
    const key = createKey({ workspace: wsReal, realpathFn: boom });
    expect(key.of(call("file_write", { path: "a.txt", content: "x" }))).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("win32：匹配键小写 + 正斜杠；execPath 保留规范大小写", () => {
    const key = createKey({ workspace: wsReal });
    const viaCall = key.of(call("file_write", { path: "SRC\\A.TS", content: "x" }));
    expect(viaCall).toBe(normalizeMatchKey(join(wsReal, "SRC", "A.TS")));
    expect(viaCall).not.toMatch(/[A-Z]/);
    expect(viaCall).toContain("/");
    expect(key.execPath("SRC\\A.TS")).toBe(join(wsReal, "SRC", "A.TS"));
    expect(key.execPath("SRC\\A.TS")).not.toContain("/");
  });
});

describe("条目归一（移植 normalizePath/normalizeCommand 用例 → key.normalize）", () => {
  it("路径：反斜杠转正斜杠 + 段级解析（跨平台）", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.normalize({ tool: "file_write", key: "src\\nested\\utils.ts" })).toBe("src/nested/utils.ts");
    expect(key.normalize({ tool: "file_write", key: "src//utils.ts" })).toBe("src/utils.ts");
  });

  it.runIf(process.platform === "win32")("路径：win32 小写", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.normalize({ tool: "file_write", key: "C:\\Windows\\System32" })).toBe("c:/windows/system32");
  });

  it("命令：空白折叠 + 反斜杠转正斜杠", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.normalize({ tool: "command_run", key: "git   status --f" })).toBe("git status --f");
  });
});

describe("of（移植 matchKeyFor 用例）", () => {
  it("command_run 取命令、路径类走管道、page_fetch 取排序参数 JSON", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.of(call("command_run", { command: "ls -la" }))).toBe("ls -la");
    expect(key.of(call("file_write", { path: "src/a.ts", content: "x" }))).toBe(
      normalizeMatchKey(join(wsReal, "src", "a.ts")),
    );
    expect(key.of(call("page_fetch", { url: "https://a.com" }))).toBe('{"url":"https://a.com"}');
    expect(key.of(call("file_write", {}))).toBeUndefined();
    expect(key.of(call("command_run", {}))).toBeUndefined();
  });
});

describe("规范匹配键管道（缺陷实证探针）", () => {
  it("探针②：界内相对写入 → 归实为界内绝对键，被工作区子树条目覆盖", () => {
    const key = createKey({ workspace: wsReal });
    const k = key.of(call("file_write", { path: "src/foo.ts", content: "x" }))!;
    expect(k).toBe(normalizeMatchKey(join(wsReal, "src", "foo.ts")));
    expect(k.startsWith(`${wsKey}/`)).toBe(true); // 工作区条目（file_write subtree = wsKey/）在键级覆盖
  });

  it("探针③：读界内键在工作区内（写蕴含读）、读界外键在界外", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.of(call("file_read", { path: "src/a.ts" }))).toBe(normalizeMatchKey(join(wsReal, "src", "a.ts")));
    expect(key.of(call("dir_list", { path: "src" }))).toBe(normalizeMatchKey(join(wsReal, "src")));
    expect(key.of(call("code_search", { pattern: "foo" }))).toBe(wsKey); // 缺省 dir = 工作区根
    const outside = key.of(call("file_read", { path: join(tmpdir(), "policy-outside.txt") }));
    expect(outside).toBe(normalizeMatchKey(join(realpathSync.native(tmpdir()), "policy-outside.txt")));
    expect(outside!.startsWith(`${wsKey}/`)).toBe(false); // 界外：工作区条目覆盖不了
  });

  it("探针①对照（跨平台）：穿越键 = 以工作区为基准归实后的绝对路径，界外", () => {
    const key = createKey({ workspace: wsReal });
    const k = key.of(call("file_write", { path: join("..", "..", "..", "..", "outside-probe.txt"), content: "x" }));
    expect(k).toBeDefined();
    expect(k!.startsWith(wsKey)).toBe(false); // 已归实为界外绝对键，而非相对字面量
    expect(k!.endsWith("outside-probe.txt")).toBe(true);
  });

  it.runIf(process.platform === "win32")("探针①：相对穿越写 System32 → canonical 键（黑名单命中归 Task 4 裁决）", () => {
    const key = createKey({ workspace: wsReal });
    const segments = wsKey.split("/").filter((s) => s !== ""); // ["c:", "users", ...]
    const ups = "../".repeat(segments.length - 1); // 从工作区升到盘符根再进 Windows
    expect(key.of(call("file_write", { path: `${ups}Windows/System32/evil.exe`, content: "x" }))).toBe(
      "c:/windows/system32/evil.exe",
    );
  });

  it("链接穿墙：junction/symlink 指向界外 → 归实为界外绝对键", () => {
    const outside = mkdtempSync(join(tmpdir(), "key-outside-"));
    const link = join(wsReal, "escape-link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const key = createKey({ workspace: wsReal });
      expect(key.of(call("file_write", { path: join("escape-link", "evil.txt"), content: "x" }))).toBe(
        normalizeMatchKey(join(realpathSync.native(outside), "evil.txt")),
      );
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("realpath 失败 → of undefined（绝不回退词法）", () => {
    const boom: RealpathFn = () => {
      throw new Error("boom");
    };
    const key = createKey({ workspace: wsReal, realpathFn: boom });
    expect(key.of(call("file_write", { path: "src/a.ts", content: "x" }))).toBeUndefined();
  });

  it("旧词法相对条目失效：归一后相对键不是绝对调用键的前缀（不自动迁移）", () => {
    const key = createKey({ workspace: wsReal });
    const k = key.of(call("file_write", { path: "src/a.ts", content: "x" }))!;
    const staleEntry = key.normalize({ tool: "file_write", key: "src/" });
    expect(k).toBe(normalizeMatchKey(join(wsReal, "src", "a.ts")));
    expect(k.startsWith(staleEntry)).toBe(false);
  });

  it("目录条目自身匹配（w/ 匹配 w）：读目录键 = 工作区根自身", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.of(call("dir_list", { path: "." }))).toBe(wsKey);
  });

  it("读类 matchKey：行区间/pattern 不进键；code_search dir 显式进键", () => {
    const key = createKey({ workspace: wsReal });
    const plain = key.of(call("file_read", { path: "a.ts" }));
    expect(key.of(call("file_read", { path: "a.ts", start_line: 3, line_count: 10 }))).toBe(plain);
    expect(key.of(call("code_search", { pattern: "tmp", dir: "src" }))).toBe(
      normalizeMatchKey(join(wsReal, "src")),
    );
  });

  it.runIf(process.platform === "win32")("写系统目录：读写同一 canonical 键（写形态黑名单仅写类命中归 Task 4 裁决）", () => {
    const key = createKey({ workspace: wsReal });
    const target = "C:\\Windows\\System32\\drivers\\hosts";
    const viaWrite = key.of(call("file_write", { path: target, content: "x" }));
    const viaRead = key.of(call("file_read", { path: target }));
    expect(viaWrite).toBe("c:/windows/system32/drivers/hosts");
    expect(viaRead).toBe(viaWrite);
  });
});

describe("permission/key 新增语义", () => {
  it("管道失败（realpath 抛错）→ of 返回 undefined，绝不回退词法结果", () => {
    const throwing: RealpathFn = () => { throw new Error("boom"); };
    const key = createKey({ workspace: wsReal, realpathFn: throwing });
    expect(key.of({ name: "file_read", arguments: { path: "a.txt" } })).toBeUndefined();
  });

  it("execPath 管道失败回退词法绝对化（永不为 null）", () => {
    const throwing: RealpathFn = () => { throw new Error("boom"); };
    const key = createKey({ workspace: wsReal, realpathFn: throwing });
    expect(key.execPath("sub/x.txt")).toBe(join(wsReal, "sub/x.txt"));
  });

  it("normalize：非路径工具仅 trim（URL 不被 mangle——修复旧 normalizeEntryKey 的潜在 bug）", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.normalize({ tool: "page_fetch", key: " https://api.example.com//x " })).toBe("https://api.example.com//x");
  });

  it("normalize：目录条目尾 / 保留（含根形态原样）；command_run 走命令归一", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.normalize({ tool: "file_write", key: "src\\" })).toMatch(/\/$/);
    expect(key.normalize({ tool: "file_write", key: "c:/" })).toBe("c:/"); // 盘符根段级解析后尾 / 保回
    expect(key.normalize({ tool: "file_write", key: "/" })).toBe("/");     // 根形态原样
    expect(key.normalize({ tool: "command_run", key: "git   status " })).toBe("git status");
  });

  it("entryFor：subtree 读目录类 = 目标自身 + /；写文件 = 父目录 + /；根级降级 self", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.entryFor("dir_list", "/ws/src", "subtree")).toEqual({ tool: "dir_list", key: "/ws/src/", scope: "subtree" });
    expect(key.entryFor("file_write", "/ws/src/x.ts", "subtree")).toEqual({ tool: "file_write", key: "/ws/src/", scope: "subtree" });
    expect(key.entryFor("file_write", "/x.ts", "subtree")).toEqual({ tool: "file_write", key: "/x.ts", scope: "self" });
    expect(key.entryFor("command_run", "git status", "subtree")).toBeNull();
    expect(key.entryFor("file_read", "", "self")).toBeNull();
  });

  it("optionsFor：路径两粒度、其余单粒度、键缺失空集", () => {
    const key = createKey({ workspace: wsReal });
    const two = key.optionsFor({ name: "file_write", arguments: { path: "src/x.ts", content: "" } });
    expect(two.map((o) => o.scope)).toEqual(["self", "subtree"]);
    const one = key.optionsFor({ name: "command_run", arguments: { command: "git status" } });
    expect(one).toHaveLength(1);
    expect(key.optionsFor({ name: "file_read", arguments: {} })).toEqual([]);
  });

  it("code_search 缺 dir 按 '.' 计", () => {
    const key = createKey({ workspace: wsReal });
    const call: ToolCall = { name: "code_search", arguments: { pattern: "x" } };
    expect(key.of(call)).toBe(normalizeMatchKey(wsReal));
  });
});
