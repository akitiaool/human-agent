// tests/policy.test.ts
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../src/brain/llm.js";
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
