// tests/policy.test.ts
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/brain/llm.js";
import type { WhitelistEntry } from "../src/types/index.js";
import {
  PermissionPolicy,
  buildWhitelistEntry,
  dirEntryKey,
  keyMatches,
  matchKeyFor,
  normalizeCommand,
  normalizeEntryKey,
  normalizePath,
  toolMatches,
} from "../src/nose/policy.js";
import { normalizeMatchKey } from "../src/nose/workspace-path.js";

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { name, arguments: args };
}

const wlDir = mkdtempSync(join(tmpdir(), "policy-wl-"));
const wlFile = join(wlDir, "whitelist.json");
const ws = mkdtempSync(join(tmpdir(), "policy-ws-"));
const wsReal = realpathSync(ws);
const wsKey = normalizeMatchKey(wsReal);
afterAll(() => {
  rmSync(wlDir, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});
beforeEach(() => rmSync(wlFile, { force: true }));

describe("归一化（文本层，保留兜底职责）", () => {
  it("路径：反斜杠转正斜杠 + 空白折叠 + win32 小写 + 段级解析", () => {
    expect(normalizePath("C:\\Windows\\System32")).toBe("c:/windows/system32");
    expect(normalizePath("src//utils.ts")).toBe("src/utils.ts");
  });
  it("命令：空白折叠 + 反斜杠转正斜杠", () => {
    expect(normalizeCommand("git   status --f")).toBe("git status --f");
  });
  it("normalizeEntryKey：目录条目尾 / 保留（normalizePath 会丢尾斜杠）；根形态原样；terminal 走命令归一", () => {
    expect(normalizeEntryKey({ tool: "write_file", key: "C:\\WS\\SRC\\" })).toBe("c:/ws/src/");
    expect(normalizeEntryKey({ tool: "write_file", key: "c:/ws/src/a.ts" })).toBe("c:/ws/src/a.ts");
    expect(normalizeEntryKey({ tool: "write_file", key: "c:/" })).toBe("c:/");
    expect(normalizeEntryKey({ tool: "write_file", key: "/" })).toBe("/");
    expect(normalizeEntryKey({ tool: "terminal", key: "git  status" })).toBe("git status");
  });
  it("matchKeyFor：terminal 取命令、路径类走管道、fetch_page 取排序参数 JSON", () => {
    expect(matchKeyFor(call("terminal", { command: "ls -la" }), wsReal)).toBe("ls -la");
    expect(matchKeyFor(call("write_file", { path: "src/a.ts", content: "x" }), wsReal)).toBe(
      normalizeMatchKey(join(wsReal, "src", "a.ts")),
    );
    expect(matchKeyFor(call("fetch_page", { url: "https://a.com" }), wsReal)).toBe('{"url":"https://a.com"}');
    expect(matchKeyFor(call("write_file", {}), wsReal)).toBeUndefined();
    expect(matchKeyFor(call("terminal", {}), wsReal)).toBeUndefined();
  });
});

describe("规范匹配键管道（缺陷实证探针）", () => {
  it("探针②：界内相对写入静默（工作区写 path-dir 条目覆盖）", () => {
    const p = new PermissionPolicy({ workspace: wsReal, file: wlFile, entries: [] });
    p.ensureWorkspace();
    expect(p.classify(call("write_file", { path: "src/foo.ts", content: "x" })).status).toBe("allowed");
  });

  it("探针③：读界内 allowed（写蕴含读）、读界外 unlisted", () => {
    const p = new PermissionPolicy({ workspace: wsReal, file: wlFile, entries: [] });
    p.ensureWorkspace();
    expect(p.classify(call("read_file", { path: "src/a.ts" })).status).toBe("allowed");
    expect(p.classify(call("read_dir", { path: "src" })).status).toBe("allowed");
    expect(p.classify(call("search_code", { pattern: "foo" })).status).toBe("allowed"); // 缺省 dir = 工作区根
    expect(p.classify(call("read_file", { path: join(tmpdir(), "policy-outside.txt") })).status).toBe("unlisted");
  });

  it("探针①对照（跨平台）：穿越键 = 以工作区为基准归实后的绝对路径，界外 → 未信任", () => {
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "write_file", key: `${wsKey}/`, kind: "path" }],
    });
    const cls = p.classify(call("write_file", { path: join("..", "..", "..", "..", "outside-probe.txt"), content: "x" }));
    expect(cls.status).toBe("unlisted");
    expect(cls.key).toBeDefined();
    expect(cls.key!.startsWith(wsKey)).toBe(false); // 已归实为界外绝对键，而非相对字面量
  });

  it.runIf(process.platform === "win32")("探针①：相对穿越写 System32 → canonical 键命中黑名单写形态", () => {
    const segments = wsKey.split("/").filter((s) => s !== ""); // ["c:", "users", ...]
    const ups = "../".repeat(segments.length - 1); // 从工作区升到盘符根再进 Windows
    const p = new PermissionPolicy({ workspace: wsReal, file: wlFile, entries: [] });
    const cls = p.classify(call("write_file", { path: `${ups}Windows/System32/evil.exe`, content: "x" }));
    expect(cls.status).toBe("blacklist");
    expect(cls.key).toBe("c:/windows/system32/evil.exe");
  });

  it("链接穿墙：junction/symlink 指向界外 → realpath 归实后 unlisted", () => {
    const outside = mkdtempSync(join(tmpdir(), "policy-outside-"));
    const link = join(wsReal, "escape-link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const p = new PermissionPolicy({ workspace: wsReal, file: wlFile, entries: [] });
      p.ensureWorkspace();
      const cls = p.classify(call("write_file", { path: join("escape-link", "evil.txt"), content: "x" }));
      expect(cls.status).toBe("unlisted");
      expect(cls.key).toBe(normalizeMatchKey(join(realpathSync(outside), "evil.txt")));
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("realpath 失败 → 未信任（keyFor undefined，绝不回退词法）", () => {
    const boom = () => {
      throw new Error("boom");
    };
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "write_file", key: `${wsKey}/`, kind: "path" }],
      realpathFn: boom,
    });
    const cls = p.classify(call("write_file", { path: "src/a.ts", content: "x" }));
    expect(cls.status).toBe("unlisted");
    expect(cls.key).toBeUndefined();
  });

  it("旧词法条目失效 → 重新按未信任处置（不自动迁移、不崩溃）", () => {
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "write_file", key: "src/", kind: "path" }], // 旧相对词法条目
    });
    expect(p.classify(call("write_file", { path: "src/a.ts", content: "x" })).status).toBe("unlisted");
  });

  it("目录条目自身匹配（w/ 匹配 w）：覆盖工作区根调用", () => {
    const root = `${wsKey}/`;
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "read_dir", key: root, kind: "path" }],
    });
    expect(p.classify(call("read_dir", { path: "." })).status).toBe("allowed"); // 键 = 工作区根自身
  });

  it("读类 matchKey：行区间/pattern 不进键；search_code dir 显式进键", () => {
    const p = new PermissionPolicy({ workspace: wsReal, file: wlFile, entries: [] });
    const plain = p.keyFor(call("read_file", { path: "a.ts" }));
    expect(p.keyFor(call("read_file", { path: "a.ts", start_line: 3, line_count: 10 }))).toBe(plain);
    expect(p.keyFor(call("search_code", { pattern: "tmp", dir: "src" }))).toBe(
      normalizeMatchKey(join(wsReal, "src")),
    );
  });

  it.runIf(process.platform === "win32")("写系统目录黑名单仅写类命中：读 System32 → unlisted（不硬拒）", () => {
    const p = new PermissionPolicy({ workspace: wsReal, file: wlFile, entries: [] });
    expect(
      p.classify(call("write_file", { path: "C:\\Windows\\System32\\drivers\\hosts", content: "x" })).status,
    ).toBe("blacklist");
    expect(
      p.classify(call("read_file", { path: "C:\\Windows\\System32\\drivers\\hosts" })).status,
    ).toBe("unlisted");
  });
});

describe("黑名单（terminal 命令形态，行为不变）", () => {
  const p = new PermissionPolicy({ workspace: wsReal, file: wlFile, entries: [] });
  const cls = (command: string) => p.classify(call("terminal", { command })).status;

  it("命中：根/盘符根/系统目录递归删除", () => {
    expect(cls("rm -rf /")).toBe("blacklist");
    expect(cls("rm -rf c:/")).toBe("blacklist");
    expect(cls("rm -rf C:\\Windows")).toBe("blacklist");
    expect(cls("rm -rf C:\\Windows\\System32")).toBe("blacklist");
    expect(cls("rm -rf /boot")).toBe("blacklist");
    expect(cls("rm -rf C:\\Windows\\")).toBe("blacklist");
  });
  it("命中：磁盘级操作与必崩进程", () => {
    expect(cls("format c:")).toBe("blacklist");
    expect(cls("diskpart clean")).toBe("blacklist");
    expect(cls("dd if=/dev/zero of=/dev/sda")).toBe("blacklist");
    expect(cls("taskkill /f /im lsass.exe")).toBe("blacklist");
    expect(cls("reg delete HKLM\\SYSTEM")).toBe("blacklist");
    expect(cls("del C:\\boot")).toBe("blacklist");
    expect(cls("Format-Volume -DriveLetter C")).toBe("blacklist");
    expect(cls("Remove-Item HKLM:\\SYSTEM")).toBe("blacklist");
    expect(cls("mke2fs /dev/sda")).toBe("blacklist");
    expect(cls("fdisk /dev/sda delete")).toBe("blacklist");
    expect(cls("chmod -R 000 /usr")).toBe("blacklist");
    expect(cls("chmod -R 000 /*")).toBe("blacklist");
    expect(cls("del bootmgr")).toBe("blacklist");
    expect(cls("bcdedit /delete {bootmgr}")).toBe("blacklist");
    expect(cls("echo garbage > /dev/sda")).toBe("blacklist");
  });
  it("不命中：不破坏系统的同类命令", () => {
    expect(cls("rm -rf /tmp/approval-test")).toBe("unlisted");
    expect(cls("rm -rf node_modules")).toBe("unlisted");
    expect(cls("rm -rf C:\\Windows\\Temp")).toBe("unlisted");
    expect(cls("taskkill /f /im notepad.exe")).toBe("unlisted");
    expect(cls("shutdown /s")).toBe("unlisted");
    expect(cls("kill -9 1234")).toBe("unlisted");
    expect(cls("echo hi > /dev/null")).toBe("unlisted");
    expect(cls("del boot.txt")).toBe("unlisted");
    expect(cls("del C:\\proj\\boot")).toBe("unlisted");
    expect(cls("Get-Volume | Format-Table DriveLetter, Size")).toBe("unlisted");
    expect(cls("dd if=/dev/zero of=/dev/null")).toBe("unlisted");
  });
  it("黑名单优先级最高：白名单中有系统破坏条目也不放行", () => {
    const pb = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "terminal", key: "rm -rf /", kind: "exact" }],
    });
    expect(pb.classify(call("terminal", { command: "rm -rf /" })).status).toBe("blacklist");
  });
});

describe("白名单匹配（工作区绝对键）", () => {
  it("exact：命令整串相等（空白折叠后）", () => {
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "terminal", key: "git status", kind: "exact" }],
    });
    expect(p.classify(call("terminal", { command: "git status" })).status).toBe("allowed");
    expect(p.classify(call("terminal", { command: "git  status" })).status).toBe("allowed");
    expect(p.classify(call("terminal", { command: "git status -v" })).status).toBe("unlisted");
  });

  it("exact 非 terminal（fetch_page 全参数）", () => {
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "fetch_page", key: '{"url":"https://a.com"}', kind: "exact" }],
    });
    expect(p.classify(call("fetch_page", { url: "https://a.com" })).status).toBe("allowed");
    expect(p.classify(call("fetch_page", { url: "https://b.com" })).status).toBe("unlisted");
  });

  it("path：目录条目段级前缀（src-evil 反例）", () => {
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "write_file", key: `${wsKey}/src/`, kind: "path" }],
    });
    expect(p.classify(call("write_file", { path: "src/utils.ts", content: "x" })).status).toBe("allowed");
    expect(p.classify(call("write_file", { path: "src/components/button.tsx", content: "x" })).status).toBe("allowed");
    expect(p.classify(call("write_file", { path: "src-evil/secret.txt", content: "x" })).status).toBe("unlisted");
  });

  it("path：文件条目仅命中自身；跨工具对 apply_patch 生效", () => {
    const fileKey = normalizeMatchKey(join(wsReal, "src", "utils.ts"));
    const p = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "write_file", key: fileKey, kind: "path" }],
    });
    expect(p.classify(call("write_file", { path: "src/utils.ts", content: "x" })).status).toBe("allowed");
    expect(p.classify(call("write_file", { path: "src/other.ts", content: "x" })).status).toBe("unlisted");
    expect(p.classify(call("apply_patch", { path: "src/utils.ts", patch: "+x" })).status).toBe("allowed");
  });

  it("方向性：写条目命中读调用；读条目不命中写调用", () => {
    const k = normalizeMatchKey(join(wsReal, "shared.txt"));
    const pWrite = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "write_file", key: k, kind: "path" }],
    });
    expect(pWrite.classify(call("read_file", { path: "shared.txt" })).status).toBe("allowed");
    const pRead = new PermissionPolicy({
      workspace: wsReal,
      file: wlFile,
      entries: [{ tool: "read_file", key: k, kind: "path" }],
    });
    expect(pRead.classify(call("write_file", { path: "shared.txt", content: "x" })).status).toBe("unlisted");
  });

  it("读类 buildWhitelistEntry：文件/目录两粒度（read_dir 自身 + /，search_code 缺省 = 工作区根）", () => {
    const srcKey = normalizeMatchKey(join(wsReal, "src"));
    expect(buildWhitelistEntry(call("read_file", { path: "src/a.ts" }), "path", wsReal)).toEqual({
      tool: "read_file",
      key: normalizeMatchKey(join(wsReal, "src", "a.ts")),
      kind: "path",
    });
    expect(buildWhitelistEntry(call("read_file", { path: "src/a.ts" }), "dir", wsReal)).toEqual({
      tool: "read_file",
      key: `${srcKey}/`,
      kind: "path",
    });
    expect(buildWhitelistEntry(call("read_dir", { path: "src" }), "dir", wsReal)).toEqual({
      tool: "read_dir",
      key: `${srcKey}/`,
      kind: "path",
    });
    expect(buildWhitelistEntry(call("search_code", { pattern: "x" }), "dir", wsReal)).toEqual({
      tool: "search_code",
      key: `${wsKey}/`,
      kind: "path",
    });
  });

  it("buildWhitelistEntry：terminal exact / 写类此路径 / 界内目录粒度 / 根级降级", () => {
    expect(buildWhitelistEntry(call("terminal", { command: "git status" }), "exact", wsReal)).toEqual({
      tool: "terminal",
      key: "git status",
      kind: "exact",
    });
    expect(buildWhitelistEntry(call("write_file", { path: "src/utils.ts", content: "x" }), "path", wsReal)).toEqual({
      tool: "write_file",
      key: normalizeMatchKey(join(wsReal, "src", "utils.ts")),
      kind: "path",
    });
    // 界内文件「此目录」= 父目录（界内文件按定义必被工作区条目覆盖，此形仅测试形状）
    expect(buildWhitelistEntry(call("write_file", { path: "src/utils.ts", content: "x" }), "dir", wsReal)).toEqual({
      tool: "write_file",
      key: `${normalizeMatchKey(join(wsReal, "src"))}/`,
      kind: "path",
    });
    // 盘符根/根级下的单文件：无父目录可越 → 降级文件条目
    const rootFile = process.platform === "win32" ? "c:/x.txt" : "/x.txt";
    expect(buildWhitelistEntry(call("write_file", { path: rootFile, content: "x" }), "dir", wsReal)).toEqual({
      tool: "write_file",
      key: normalizeMatchKey(rootFile),
      kind: "path",
    });
  });
});

describe("工具辅助", () => {
  it("toolMatches：写条目覆盖写∪读；读条目仅覆盖读；其余仅同名", () => {
    expect(toolMatches("write_file", "apply_patch")).toBe(true);
    expect(toolMatches("write_file", "edit_file")).toBe(true);
    expect(toolMatches("write_file", "read_file")).toBe(true);
    expect(toolMatches("read_dir", "search_code")).toBe(true);
    expect(toolMatches("read_file", "write_file")).toBe(false);
    expect(toolMatches("write_file", "terminal")).toBe(false);
    expect(toolMatches("terminal", "fetch_page")).toBe(false);
  });
  it("keyMatches：目录条目自覆盖 + 前缀 / 文件条目相等", () => {
    const e: WhitelistEntry = { tool: "write_file", key: "c:/ws/src/", kind: "path" };
    expect(keyMatches(e, "c:/ws/src")).toBe(true); // w/ 匹配 w（自覆盖）
    expect(keyMatches(e, "c:/ws/src/a.ts")).toBe(true);
    expect(keyMatches(e, "c:/ws/src-evil/a.ts")).toBe(false);
    expect(keyMatches({ tool: "write_file", key: "c:/ws/src/utils.ts", kind: "path" }, "c:/ws/src/utils.ts")).toBe(true);
    expect(keyMatches({ tool: "write_file", key: "c:/ws/src/utils.ts", kind: "path" }, "c:/ws/src/utils.ts/x")).toBe(false);
  });
  it("dirEntryKey：读目录类 = 自身 + /；其余 = 父 + /；根级/盘符根 null", () => {
    expect(dirEntryKey("read_dir", "c:/ws/src")).toBe("c:/ws/src/");
    expect(dirEntryKey("search_code", "c:/ws/src")).toBe("c:/ws/src/");
    expect(dirEntryKey("read_file", "c:/ws/src/a.ts")).toBe("c:/ws/src/");
    expect(dirEntryKey("write_file", "c:/ws/src/a.ts")).toBe("c:/ws/src/");
    expect(dirEntryKey("write_file", "c:/x.txt")).toBeNull();
    expect(dirEntryKey("read_dir", "c:/")).toBeNull();
    expect(dirEntryKey("read_dir", "/")).toBeNull();
    expect(dirEntryKey("write_file", "/x")).toBeNull();
  });
});

describe("PermissionPolicy 持久化与清理", () => {
  it("addEntry 落盘；重新构造可加载", () => {
    const p1 = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    expect(p1.addEntry({ tool: "terminal", key: "git status", kind: "exact" })).toBe(true);
    const p2 = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    expect(p2.entries()).toEqual([{ tool: "terminal", key: "git status", kind: "exact" }]);
  });

  it("按工作区分节：不同 workspace 互不可见", () => {
    const a = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    a.addEntry({ tool: "terminal", key: "ls -la", kind: "exact" });
    const b = new PermissionPolicy({ file: wlFile, workspace: join(ws, "other-ws") });
    expect(b.entries()).toEqual([]);
    expect(b.classify(call("terminal", { command: "ls -la" })).status).toBe("unlisted");
  });

  it("加父去子：新增目录条目删除被覆盖子条目（含自覆盖：目录条目清掉同键文件条目）", () => {
    const base = `${wsKey}/src`;
    const p = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    p.addEntry({ tool: "write_file", key: `${base}/utils.ts`, kind: "path" });
    p.addEntry({ tool: "write_file", key: base, kind: "path" });
    expect(p.addEntry({ tool: "write_file", key: `${base}/`, kind: "path" })).toBe(true);
    expect(p.entries()).toEqual([{ tool: "write_file", key: `${base}/`, kind: "path" }]);
  });

  it("加子被父盖：已有父目录则跳过", () => {
    const base = `${wsKey}/src`;
    const p = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    p.addEntry({ tool: "write_file", key: `${base}/`, kind: "path" });
    expect(p.addEntry({ tool: "write_file", key: `${base}/utils.ts`, kind: "path" })).toBe(false);
    expect(p.entries()).toEqual([{ tool: "write_file", key: `${base}/`, kind: "path" }]);
  });

  it("方向盲区修复：读目录条目不得吞掉写子条目（写审批照常入库）", () => {
    const base = `${wsKey}/src`;
    const p = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    p.addEntry({ tool: "read_dir", key: `${base}/`, kind: "path" });
    expect(p.addEntry({ tool: "write_file", key: `${base}/a.ts`, kind: "path" })).toBe(true);
    expect(p.entries()).toEqual([
      { tool: "read_dir", key: `${base}/`, kind: "path" },
      { tool: "write_file", key: `${base}/a.ts`, kind: "path" },
    ]);
  });

  it("方向盲区修复：读目录条目不得删除既有写子条目（用户配置不静默丢失）", () => {
    const base = `${wsKey}/src`;
    const p = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    p.addEntry({ tool: "write_file", key: `${base}/a.ts`, kind: "path" });
    expect(p.addEntry({ tool: "read_dir", key: `${base}/`, kind: "path" })).toBe(true);
    expect(p.entries()).toEqual([
      { tool: "write_file", key: `${base}/a.ts`, kind: "path" },
      { tool: "read_dir", key: `${base}/`, kind: "path" },
    ]);
  });

  it("方向逻辑回归钉：写目录条目照旧删除被覆盖的读子条目（写信任蕴含读）", () => {
    const base = `${wsKey}/src`;
    const p = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    p.addEntry({ tool: "read_file", key: `${base}/a.ts`, kind: "path" });
    expect(p.addEntry({ tool: "write_file", key: `${base}/`, kind: "path" })).toBe(true);
    expect(p.entries()).toEqual([{ tool: "write_file", key: `${base}/`, kind: "path" }]);
  });

  it("精确重复条目跳过；终端条目按归一后去重", () => {
    const p = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    p.addEntry({ tool: "terminal", key: "git status", kind: "exact" });
    expect(p.addEntry({ tool: "terminal", key: "git  status", kind: "exact" })).toBe(false);
  });

  it("文件损坏/不存在降级为空白名单（不崩溃）", () => {
    const bad = join(wlDir, "bad.json");
    const p = new PermissionPolicy({ file: bad, workspace: wsReal });
    expect(p.entries()).toEqual([]);
    expect(p.classify(call("terminal", { command: "anything" })).status).toBe("unlisted");
  });

  it("ensureWorkspace：注册工作区目录条目（写类 path-dir）且幂等；覆盖读类", () => {
    const p = new PermissionPolicy({ file: wlFile, workspace: wsReal });
    p.ensureWorkspace();
    expect(p.entries()).toEqual([{ tool: "write_file", key: `${wsKey}/`, kind: "path" }]);
    p.ensureWorkspace();
    expect(p.entries()).toHaveLength(1);
    expect(p.classify(call("write_file", { path: "src/a.ts", content: "x" })).status).toBe("allowed");
    expect(p.classify(call("read_dir", { path: "src" })).status).toBe("allowed");
  });

  it("内容损坏（非 JSON）降级为空白名单", () => {
    const bad = join(wlDir, "corrupt.json");
    writeFileSync(bad, "{ not json", "utf8");
    const p = new PermissionPolicy({ file: bad, workspace: wsReal });
    expect(p.entries()).toEqual([]);
  });

  it("垃圾条目（缺 key/非法 kind/非数组分节）被过滤，classify 不崩溃", () => {
    const bad = join(wlDir, "junk.json");
    writeFileSync(
      bad,
      JSON.stringify({
        [wsKey]: [{ tool: "write_file" }, { tool: "terminal", key: "ls", kind: "exact" }, { tool: "write_file", key: "x" }],
        "/ws2": "not-array",
      }),
      "utf8",
    );
    const p = new PermissionPolicy({ file: bad, workspace: wsReal });
    expect(p.entries()).toEqual([{ tool: "terminal", key: "ls", kind: "exact" }]);
    expect(p.classify(call("terminal", { command: "ls" })).status).toBe("allowed");
  });
});
