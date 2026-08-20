// tests/policy.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/brain/llm.js";
import type { WhitelistEntry } from "../src/types/index.js";
import {
  PermissionPolicy,
  buildWhitelistEntry,
  classify,
  keyMatches,
  matchKeyFor,
  normalizeCommand,
  normalizePath,
  toolMatches,
} from "../src/nose/policy.js";

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { name, arguments: args };
}

describe("归一化", () => {
  it("路径：反斜杠转正斜杠 + 空白折叠", () => {
    expect(normalizePath("C:\\Windows\\System32")).toBe("c:/windows/system32");
    expect(normalizePath("src//utils.ts")).toBe("src/utils.ts");
  });
  it("命令：空白折叠 + 反斜杠转正斜杠", () => {
    expect(normalizeCommand("git   status --f")).toBe("git status --f");
  });
  it("matchKeyFor：terminal 取命令、写类取 path、其余取排序参数 JSON", () => {
    expect(matchKeyFor(call("terminal", { command: "ls -la" }))).toBe("ls -la");
    expect(matchKeyFor(call("write_file", { path: "src/a.ts", content: "x" }))).toBe("src/a.ts");
    expect(matchKeyFor(call("read_file", { path: "b.ts", dir: "a" }))).toBe('{"dir":"a","path":"b.ts"}');
    expect(matchKeyFor(call("write_file", {}))).toBeUndefined();
  });
});

describe("黑名单（系统破坏目标锚定）", () => {
  it("命中：根/盘符根/系统目录递归删除", () => {
    expect(classify(call("terminal", { command: "rm -rf /" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "rm -rf c:/" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "rm -rf C:\\Windows" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "rm -rf C:\\Windows\\System32" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "rm -rf /boot" }))).toBe("blacklist");
  });
  it("命中：磁盘级操作与必崩进程", () => {
    expect(classify(call("terminal", { command: "format c:" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "diskpart clean" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "dd if=/dev/zero of=/dev/sda" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "taskkill /f /im lsass.exe" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "reg delete HKLM\\SYSTEM" }))).toBe("blacklist");
  });
  it("命中：附录 A 补全（Format-Volume/Remove-Item HKLM/mke2fs/fdisk/chmod 系统目录）", () => {
    expect(classify(call("terminal", { command: "del C:\\boot" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "Format-Volume -DriveLetter C" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "Remove-Item HKLM:\\SYSTEM" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "mke2fs /dev/sda" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "fdisk /dev/sda delete" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "chmod -R 000 /usr" }))).toBe("blacklist");
  });
  it("命中：rm 系统目录尾斜杠形态 + chmod 权限全毁 /* 形态", () => {
    expect(classify(call("terminal", { command: "rm -rf C:\\Windows\\" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "chmod -R 000 /*" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "rm -rf C:\\Windows\\Temp" }))).toBe("unlisted");
  });
  it("命中：启动文件删除与块设备重定向", () => {
    expect(classify(call("terminal", { command: "del bootmgr" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "bcdedit /delete {bootmgr}" }))).toBe("blacklist");
    expect(classify(call("terminal", { command: "echo garbage > /dev/sda" }))).toBe("blacklist");
  });
  it("不命中：不破坏系统的同类命令", () => {
    expect(classify(call("terminal", { command: "rm -rf /tmp/approval-test" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "rm -rf node_modules" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "rm -rf C:\\Windows\\Temp" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "taskkill /f /im notepad.exe" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "shutdown /s" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "kill -9 1234" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "echo hi > /dev/null" }))).toBe("unlisted");
  });
  it("不命中：黑名单误杀防护（任意 boot 文件/Format-Table）", () => {
    expect(classify(call("terminal", { command: "del boot.txt" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "del C:\\proj\\boot" }))).toBe("unlisted");
    expect(classify(call("terminal", { command: "Get-Volume | Format-Table DriveLetter, Size" }))).toBe("unlisted");
  });
  it("dd 写 /dev/null 不命中（非物理盘）", () => {
    expect(classify(call("terminal", { command: "dd if=/dev/zero of=/dev/null" }))).toBe("unlisted");
  });
  it("写类工具按 path 匹配系统目标", () => {
    expect(classify(call("write_file", { path: "C:\\Windows\\System32\\drivers\\hosts", content: "x" }))).toBe("blacklist");
    expect(classify(call("write_file", { path: "src/a.ts", content: "x" }))).toBe("unlisted");
  });
});

describe("路径穿越折叠（.. 段解析）", () => {
  it("路径穿越折叠：.. 段解析（黑名单锚定不被绕过、工作区边界不被穿透）", () => {
    expect(normalizePath("c:/users/me/project/../../../windows/system32/drivers/hosts")).toBe("c:/windows/system32/drivers/hosts");
    expect(classify(call("write_file", { path: "C:/users/me/project/../../../windows/system32/drivers/hosts", content: "x" }))).toBe("blacklist");
    expect(classify(call("write_file", { path: "/ws/../secret.txt", content: "x" }))).toBe("unlisted");
    const p = new PermissionPolicy({
      workspace: "/ws",
      entries: [{ tool: "write_file", key: "/ws/", kind: "path" }],
    });
    expect(p.classify(call("write_file", { path: "/ws/a/../b.txt", content: "x" }))).toBe("whitelist");
  });
});

describe("白名单匹配（PermissionPolicy 内存版）", () => {
  it("exact：命令整串相等（空白折叠后）", () => {
    const p = new PermissionPolicy({
      workspace: "/ws",
      entries: [{ tool: "terminal", key: "git status", kind: "exact" }],
    });
    expect(p.classify(call("terminal", { command: "git status" }))).toBe("whitelist");
    expect(p.classify(call("terminal", { command: "git  status" }))).toBe("whitelist");
    expect(p.classify(call("terminal", { command: "git status -v" }))).toBe("unlisted");
  });
  it("path：目录条目段级前缀（src-evil 反例）", () => {
    const p = new PermissionPolicy({
      workspace: "/ws",
      entries: [{ tool: "write_file", key: "src/", kind: "path" }],
    });
    expect(p.classify(call("write_file", { path: "src/utils.ts", content: "x" }))).toBe("whitelist");
    expect(p.classify(call("write_file", { path: "src/components/button.tsx", content: "x" }))).toBe("whitelist");
    expect(p.classify(call("write_file", { path: "src-evil/secret.txt", content: "x" }))).toBe("unlisted");
  });
  it("path：文件条目仅命中自身；跨工具对 apply_patch 生效", () => {
    const p = new PermissionPolicy({
      workspace: "/ws",
      entries: [{ tool: "write_file", key: "src/utils.ts", kind: "path" }],
    });
    expect(p.classify(call("write_file", { path: "src/utils.ts", content: "x" }))).toBe("whitelist");
    expect(p.classify(call("write_file", { path: "src/other.ts", content: "x" }))).toBe("unlisted");
    expect(p.classify(call("apply_patch", { path: "src/utils.ts", patch: "+x" }))).toBe("whitelist");
  });
  it("exact 非 terminal：完整参数 JSON", () => {
    const p = new PermissionPolicy({
      workspace: "/ws",
      entries: [{ tool: "read_file", key: '{"path":"src/a.ts"}', kind: "exact" }],
    });
    expect(p.classify(call("read_file", { path: "src/a.ts" }))).toBe("whitelist");
    expect(p.classify(call("read_file", { path: "src/b.ts" }))).toBe("unlisted");
  });
  it("黑名单优先级最高：白名单中有系统破坏条目也不放行", () => {
    const p = new PermissionPolicy({
      workspace: "/ws",
      entries: [{ tool: "terminal", key: "rm -rf /", kind: "exact" }],
    });
    expect(p.classify(call("terminal", { command: "rm -rf /" }))).toBe("blacklist");
  });
});

describe("工具辅助", () => {
  it("toolMatches：path 条目跨写类工具", () => {
    expect(toolMatches("write_file", "apply_patch")).toBe(true);
    expect(toolMatches("write_file", "terminal")).toBe(false);
  });
  it("keyMatches：目录条目前缀 / 文件条目相等", () => {
    expect(keyMatches({ tool: "write_file", key: "src/", kind: "path" }, "src/a.ts")).toBe(true);
    expect(keyMatches({ tool: "write_file", key: "src/utils.ts", kind: "path" }, "src/utils.ts")).toBe(true);
    expect(keyMatches({ tool: "write_file", key: "src/utils.ts", kind: "path" }, "src/utils.ts/x")).toBe(false);
  });
  it("buildWhitelistEntry：命令/此路径/此目录", () => {
    expect(buildWhitelistEntry(call("terminal", { command: "git status" }), "exact")).toEqual({
      tool: "terminal",
      key: "git status",
      kind: "exact",
    });
    expect(buildWhitelistEntry(call("write_file", { path: "src/utils.ts", content: "x" }), "path")).toEqual({
      tool: "write_file",
      key: "src/utils.ts",
      kind: "path",
    });
    expect(buildWhitelistEntry(call("write_file", { path: "src/utils.ts", content: "x" }), "dir")).toEqual({
      tool: "write_file",
      key: "src/",
      kind: "path",
    });
  });
  it("buildWhitelistEntry dir：根级/盘符根降级为文件条目", () => {
    expect(buildWhitelistEntry(call("write_file", { path: "README.md", content: "x" }), "dir")).toEqual({
      tool: "write_file",
      key: "readme.md",
      kind: "path",
    });
    expect(buildWhitelistEntry(call("write_file", { path: "C:\\x.txt", content: "x" }), "dir")).toEqual({
      tool: "write_file",
      key: "c:/x.txt",
      kind: "path",
    });
    expect(buildWhitelistEntry(call("write_file", { path: "src/utils.ts", content: "x" }), "dir")).toEqual({
      tool: "write_file",
      key: "src/",
      kind: "path",
    });
  });
});

describe("PermissionPolicy 持久化与清理", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "policy-test-"));
  const file = join(tempDir, "whitelist.json");
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
  // 用例共享同一文件：每例先清空，防跨用例条目泄漏
  beforeEach(() => rmSync(file, { force: true }));

  it("addEntry 落盘；重新构造可加载", () => {
    const p1 = new PermissionPolicy({ file, workspace: "/ws" });
    expect(p1.addEntry({ tool: "terminal", key: "git status", kind: "exact" })).toBe(true);
    const p2 = new PermissionPolicy({ file, workspace: "/ws" });
    expect(p2.entries()).toEqual([{ tool: "terminal", key: "git status", kind: "exact" }]);
  });

  it("按工作区分节：不同 workspace 互不可见", () => {
    const a = new PermissionPolicy({ file, workspace: "/wsA" });
    a.addEntry({ tool: "terminal", key: "ls -la", kind: "exact" });
    const b = new PermissionPolicy({ file, workspace: "/wsB" });
    expect(b.entries()).toEqual([]);
    expect(b.classify({ name: "terminal", arguments: { command: "ls -la" } })).toBe("unlisted");
  });

  it("加父去子：新增目录条目删除被覆盖子条目", () => {
    const p = new PermissionPolicy({ file, workspace: "/ws" });
    p.addEntry({ tool: "write_file", key: "src/utils.ts", kind: "path" });
    p.addEntry({ tool: "write_file", key: "src/components/", kind: "path" });
    expect(p.addEntry({ tool: "write_file", key: "src/", kind: "path" })).toBe(true);
    expect(p.entries()).toEqual([{ tool: "write_file", key: "src/", kind: "path" }]);
  });

  it("加子被父盖：已有父目录则跳过", () => {
    const p = new PermissionPolicy({ file, workspace: "/ws" });
    p.addEntry({ tool: "write_file", key: "src/", kind: "path" });
    expect(p.addEntry({ tool: "write_file", key: "src/utils.ts", kind: "path" })).toBe(false);
    expect(p.entries()).toEqual([{ tool: "write_file", key: "src/", kind: "path" }]);
  });

  it("跨工具父目录去重：apply_patch 的目录条目覆盖 write_file 子条目", () => {
    const p = new PermissionPolicy({ file, workspace: "/ws" });
    p.addEntry({ tool: "write_file", key: "src/utils.ts", kind: "path" });
    expect(p.addEntry({ tool: "apply_patch", key: "src/", kind: "path" })).toBe(true);
    expect(p.entries()).toEqual([{ tool: "apply_patch", key: "src/", kind: "path" }]);
  });

  it("精确重复条目跳过", () => {
    const p = new PermissionPolicy({ file, workspace: "/ws" });
    p.addEntry({ tool: "terminal", key: "git status", kind: "exact" });
    expect(p.addEntry({ tool: "terminal", key: "git status", kind: "exact" })).toBe(false);
  });

  it("文件损坏/不存在降级为空白名单（不崩溃）", () => {
    const bad = join(tempDir, "bad.json");
    const p = new PermissionPolicy({ file: bad, workspace: "/ws" });
    expect(p.entries()).toEqual([]);
    expect(p.classify({ name: "terminal", arguments: { command: "anything" } })).toBe("unlisted");
  });

  it("ensureWorkspace：注册工作区目录条目（写类 path-dir）且幂等", () => {
    const p = new PermissionPolicy({ file, workspace: "/home/u/proj" });
    p.ensureWorkspace();
    expect(p.entries()).toEqual([{ tool: "write_file", key: "/home/u/proj/", kind: "path" }]);
    p.ensureWorkspace();
    expect(p.entries()).toHaveLength(1);
    expect(p.classify({ name: "write_file", arguments: { path: "/home/u/proj/src/a.ts", content: "x" } })).toBe("whitelist");
    expect(p.classify({ name: "write_file", arguments: { path: "/home/u/elsewhere/a.ts", content: "x" } })).toBe("unlisted");
  });

  it("内容损坏（非 JSON）降级为空白名单", () => {
    const bad = join(tempDir, "corrupt.json");
    writeFileSync(bad, "{ not json", "utf8");
    const p = new PermissionPolicy({ file: bad, workspace: "/ws" });
    expect(p.entries()).toEqual([]);
  });

  it("垃圾条目（缺 key/非法 kind/非数组分节）被过滤，classify 不崩溃", () => {
    const bad = join(tempDir, "junk.json");
    writeFileSync(
      bad,
      JSON.stringify({
        "/ws": [{ tool: "write_file" }, { tool: "terminal", key: "ls", kind: "exact" }, { tool: "write_file", key: "x" }],
        "/ws2": "not-array",
      }),
      "utf8",
    );
    const p = new PermissionPolicy({ file: bad, workspace: "/ws" });
    expect(p.entries()).toEqual([{ tool: "terminal", key: "ls", kind: "exact" }]);
    expect(p.classify({ name: "terminal", arguments: { command: "ls" } })).toBe("whitelist");
  });
});
