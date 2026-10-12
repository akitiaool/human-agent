// 移植注：原 tests/policy.test.ts 的黑名单（4 例）、「规范匹配键管道（缺陷实证探针）」（10 例）、
// 「白名单匹配」（7 例，含 2 例 buildWhitelistEntry 构造用例）——断言层一律改为 createVerdict.decide
// 三态裁决（旧 allowed/blacklist/unlisted 保留），旧 entries/ensureWorkspace 一律改为注入 entries: () => [...]，
// buildWhitelistEntry 构造路径改为 key.optionsFor / key.entryFor（条目再喂入裁决）。
// 工具名同步新词根：terminal→command_run、write_file→file_write、read_file→file_read、
// read_dir→dir_list、search_code→code_search、fetch_page→page_fetch、apply_patch→file_patch。
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/brain/llm.js";
import { createKey, normalizeMatchKey } from "../src/permission/key.js";
import { createVerdict } from "../src/permission/verdict.js";
import type { TrustEntry } from "../src/tool/index.js";

// 夹具同 Task 3（wsReal）：createKey 收 realpath 原大小写工作区；匹配键断言一律经 normalizeMatchKey。
const wsDir = mkdtempSync(join(tmpdir(), "verdict-"));
const wsReal = realpathSync.native(wsDir);
const wsKey = normalizeMatchKey(wsReal);
afterAll(() => rmSync(wsDir, { recursive: true, force: true }));

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { name, arguments: args };
}

// makeVerdict(entries) = createVerdict({ key: createKey({workspace: wsReal}), entries: () => entries })
function makeVerdict(entries: readonly TrustEntry[]) {
  return createVerdict({ key: createKey({ workspace: wsReal }), entries: () => entries });
}

describe("permission/verdict", () => {
  it("黑名单命令直接命中（rm -rf 根）", () => {
    expect(makeVerdict([]).decide({ name: "command_run", arguments: { command: "rm -rf /" } }).status).toBe("blacklist");
  });
  it("写形态黑名单仅写类路径工具命中（读 System32 不硬拒）", () => {
    const call = (name: string) => ({ name, arguments: { path: "C:\\Windows\\System32\\drivers\\x.sys" } });
    expect(makeVerdict([]).decide(call("file_write")).status).toBe("blacklist");
    expect(makeVerdict([]).decide(call("file_read")).status).toBe("unlisted");
  });
  it("白名单命中 → allowed（写条目覆盖读调用）", () => {
    const entries: TrustEntry[] = [{ tool: "file_write", key: `${normalizeMatchKey(wsReal)}/`, scope: "subtree" }];
    expect(makeVerdict(entries).decide({ name: "file_read", arguments: { path: "a.txt" } }).status).toBe("allowed");
  });
  it("管道失败（key undefined）→ unlisted，不落黑名单也不落白名单", () => {
    const key = createKey({ workspace: wsReal, realpathFn: () => { throw new Error("boom"); } });
    const entries: TrustEntry[] = [{ tool: "file_write", key: `${normalizeMatchKey(wsReal)}/`, scope: "subtree" }];
    const verdict = createVerdict({ key, entries: () => entries });
    expect(verdict.decide({ name: "file_read", arguments: { path: "a.txt" } })).toEqual({ status: "unlisted" });
  });
  it("未列 → unlisted 且带 key", () => {
    const v = makeVerdict([]).decide({ name: "file_read", arguments: { path: "a.txt" } });
    expect(v.status).toBe("unlisted");
    expect(v.key).toBeDefined();
  });
});

describe("黑名单（命令形态，移植 policy.test.ts）", () => {
  const v = makeVerdict([]);
  const cls = (command: string) => v.decide(call("command_run", { command })).status;

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
    const vb = makeVerdict([{ tool: "command_run", key: "rm -rf /", scope: "self" }]);
    expect(vb.decide(call("command_run", { command: "rm -rf /" })).status).toBe("blacklist");
  });
});

describe("规范匹配键管道（缺陷实证探针，移植 policy.test.ts → decide 裁决）", () => {
  // 旧 ensureWorkspace() 等价：工作区子树条目 [file_write, `${wsKey}/`, subtree]
  const wsEntries: TrustEntry[] = [{ tool: "file_write", key: `${wsKey}/`, scope: "subtree" }];

  it("探针②：界内相对写入静默（工作区子树条目覆盖）", () => {
    expect(makeVerdict(wsEntries).decide(call("file_write", { path: "src/foo.ts", content: "x" })).status).toBe("allowed");
  });

  it("探针③：读界内 allowed（写蕴含读）、读界外 unlisted", () => {
    const v = makeVerdict(wsEntries);
    expect(v.decide(call("file_read", { path: "src/a.ts" })).status).toBe("allowed");
    expect(v.decide(call("dir_list", { path: "src" })).status).toBe("allowed");
    expect(v.decide(call("code_search", { pattern: "foo" })).status).toBe("allowed"); // 缺省 dir = 工作区根
    expect(v.decide(call("file_read", { path: join(tmpdir(), "verdict-outside.txt") })).status).toBe("unlisted");
  });

  it("探针①对照（跨平台）：穿越键 = 以工作区为基准归实后的绝对路径，界外 → 未信任", () => {
    const v = makeVerdict(wsEntries).decide(
      call("file_write", { path: join("..", "..", "..", "..", "outside-probe.txt"), content: "x" }),
    );
    expect(v.status).toBe("unlisted");
    expect(v.key).toBeDefined();
    expect(v.key!.startsWith(wsKey)).toBe(false); // 已归实为界外绝对键，而非相对字面量
  });

  it.runIf(process.platform === "win32")("探针①：相对穿越写 System32 → canonical 键命中黑名单写形态", () => {
    const segments = wsKey.split("/").filter((s) => s !== ""); // ["c:", "users", ...]
    const ups = "../".repeat(segments.length - 1); // 从工作区升到盘符根再进 Windows
    const v = makeVerdict([]).decide(call("file_write", { path: `${ups}Windows/System32/evil.exe`, content: "x" }));
    expect(v.status).toBe("blacklist");
    expect(v.key).toBe("c:/windows/system32/evil.exe");
  });

  it("链接穿墙：junction/symlink 指向界外 → realpath 归实后 unlisted", () => {
    const outside = mkdtempSync(join(tmpdir(), "verdict-outside-"));
    const link = join(wsReal, "escape-link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const v = makeVerdict(wsEntries).decide(call("file_write", { path: join("escape-link", "evil.txt"), content: "x" }));
      expect(v.status).toBe("unlisted");
      expect(v.key).toBe(normalizeMatchKey(join(realpathSync.native(outside), "evil.txt")));
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("realpath 失败 → 未信任（key undefined，绝不回退词法）", () => {
    const key = createKey({ workspace: wsReal, realpathFn: () => { throw new Error("boom"); } });
    const v = createVerdict({ key, entries: () => wsEntries }).decide(
      call("file_write", { path: "src/a.ts", content: "x" }),
    );
    expect(v.status).toBe("unlisted");
    expect(v.key).toBeUndefined();
  });

  it("旧词法条目失效 → 重新按未信任处置（不自动迁移、不崩溃）", () => {
    const stale: TrustEntry[] = [{ tool: "file_write", key: "src/", scope: "subtree" }]; // 旧相对词法条目
    expect(makeVerdict(stale).decide(call("file_write", { path: "src/a.ts", content: "x" })).status).toBe("unlisted");
  });

  it("目录条目自身匹配（w/ 匹配 w）：覆盖工作区根调用", () => {
    const entries: TrustEntry[] = [{ tool: "dir_list", key: `${wsKey}/`, scope: "subtree" }];
    expect(makeVerdict(entries).decide(call("dir_list", { path: "." })).status).toBe("allowed"); // 键 = 工作区根自身
  });

  it("读类键粒度：行区间/pattern 不进键；code_search dir 显式进键", () => {
    const fileKey = normalizeMatchKey(join(wsReal, "a.ts"));
    const vFile = makeVerdict([{ tool: "file_read", key: fileKey, scope: "self" }]);
    expect(vFile.decide(call("file_read", { path: "a.ts", start_line: 3, line_count: 10 })).status).toBe("allowed");
    expect(vFile.decide(call("file_read", { path: "b.ts" })).status).toBe("unlisted");
    const srcKey = normalizeMatchKey(join(wsReal, "src"));
    const vSearch = makeVerdict([{ tool: "code_search", key: srcKey, scope: "self" }]);
    expect(vSearch.decide(call("code_search", { pattern: "tmp", dir: "src" })).status).toBe("allowed");
    expect(vSearch.decide(call("code_search", { pattern: "另一 pattern", dir: "src" })).status).toBe("allowed"); // pattern 不进键
    expect(vSearch.decide(call("code_search", { pattern: "tmp" })).status).toBe("unlisted"); // 缺省 dir = 工作区根 ≠ src
  });

  it.runIf(process.platform === "win32")("写系统目录黑名单仅写类命中：读 System32 → unlisted（不硬拒）", () => {
    const v = makeVerdict([]);
    expect(v.decide(call("file_write", { path: "C:\\Windows\\System32\\drivers\\hosts", content: "x" })).status).toBe("blacklist");
    expect(v.decide(call("file_read", { path: "C:\\Windows\\System32\\drivers\\hosts" })).status).toBe("unlisted");
  });
});

describe("白名单匹配（covers 统一判定，移植 policy.test.ts）", () => {
  it("self：命令整串相等（空白折叠后）", () => {
    const entries: TrustEntry[] = [{ tool: "command_run", key: "git status", scope: "self" }];
    const v = makeVerdict(entries);
    expect(v.decide(call("command_run", { command: "git status" })).status).toBe("allowed");
    expect(v.decide(call("command_run", { command: "git  status" })).status).toBe("allowed");
    expect(v.decide(call("command_run", { command: "git status -v" })).status).toBe("unlisted");
  });

  it("self 非命令类（page_fetch 全参数）", () => {
    const entries: TrustEntry[] = [{ tool: "page_fetch", key: '{"url":"https://a.com"}', scope: "self" }];
    const v = makeVerdict(entries);
    expect(v.decide(call("page_fetch", { url: "https://a.com" })).status).toBe("allowed");
    expect(v.decide(call("page_fetch", { url: "https://b.com" })).status).toBe("unlisted");
  });

  it("subtree：目录条目段级前缀（src-evil 反例）", () => {
    const entries: TrustEntry[] = [{ tool: "file_write", key: `${wsKey}/src/`, scope: "subtree" }];
    const v = makeVerdict(entries);
    expect(v.decide(call("file_write", { path: "src/utils.ts", content: "x" })).status).toBe("allowed");
    expect(v.decide(call("file_write", { path: "src/components/button.tsx", content: "x" })).status).toBe("allowed");
    expect(v.decide(call("file_write", { path: "src-evil/secret.txt", content: "x" })).status).toBe("unlisted");
  });

  it("self：文件条目仅命中自身；跨工具对 file_patch 生效", () => {
    const fileKey = normalizeMatchKey(join(wsReal, "src", "utils.ts"));
    const entries: TrustEntry[] = [{ tool: "file_write", key: fileKey, scope: "self" }];
    const v = makeVerdict(entries);
    expect(v.decide(call("file_write", { path: "src/utils.ts", content: "x" })).status).toBe("allowed");
    expect(v.decide(call("file_write", { path: "src/other.ts", content: "x" })).status).toBe("unlisted");
    expect(v.decide(call("file_patch", { path: "src/utils.ts", patch: "+x" })).status).toBe("allowed");
  });

  it("方向性：写条目命中读调用；读条目不命中写调用", () => {
    const k = normalizeMatchKey(join(wsReal, "shared.txt"));
    const vWrite = makeVerdict([{ tool: "file_write", key: k, scope: "self" }]);
    expect(vWrite.decide(call("file_read", { path: "shared.txt" })).status).toBe("allowed");
    const vRead = makeVerdict([{ tool: "file_read", key: k, scope: "self" }]);
    expect(vRead.decide(call("file_write", { path: "shared.txt", content: "x" })).status).toBe("unlisted");
  });

  it("读类两粒度构造（移植 buildWhitelistEntry 读类例 → optionsFor 条目喂入裁决）", () => {
    const key = createKey({ workspace: wsReal });
    const aKey = normalizeMatchKey(join(wsReal, "src", "a.ts"));
    const srcKey = normalizeMatchKey(join(wsReal, "src"));

    // 此路径（self）：仅命中自身
    const readOpts = key.optionsFor(call("file_read", { path: "src/a.ts" }));
    expect(readOpts).toEqual([
      { tool: "file_read", key: aKey, scope: "self" },
      { tool: "file_read", key: `${srcKey}/`, scope: "subtree" },
    ]);
    const vSelf = makeVerdict([readOpts[0]!]);
    expect(vSelf.decide(call("file_read", { path: "src/a.ts" })).status).toBe("allowed");
    expect(vSelf.decide(call("file_read", { path: "src/b.ts" })).status).toBe("unlisted");

    // 此目录（subtree）：读类「此目录」= 父目录 + /，同目录其余文件也覆盖
    const vSub = makeVerdict([readOpts[1]!]);
    expect(vSub.decide(call("file_read", { path: "src/b.ts" })).status).toBe("allowed");
    expect(vSub.decide(call("file_read", { path: "other/b.ts" })).status).toBe("unlisted");

    // 读目录类：目标自身 + /
    const dirOpts = key.optionsFor(call("dir_list", { path: "src" }));
    expect(dirOpts).toEqual([
      { tool: "dir_list", key: srcKey, scope: "self" },
      { tool: "dir_list", key: `${srcKey}/`, scope: "subtree" },
    ]);
    const vDir = makeVerdict([dirOpts[1]!]);
    expect(vDir.decide(call("dir_list", { path: "src" })).status).toBe("allowed"); // 目录条目自覆盖（w/ 匹配 w）
    expect(vDir.decide(call("dir_list", { path: "src/sub" })).status).toBe("allowed");

    // code_search 缺省 dir = 工作区根
    const searchOpts = key.optionsFor(call("code_search", { pattern: "x" }));
    expect(searchOpts).toEqual([
      { tool: "code_search", key: wsKey, scope: "self" },
      { tool: "code_search", key: `${wsKey}/`, scope: "subtree" },
    ]);
    const vSearch = makeVerdict([searchOpts[1]!]);
    expect(vSearch.decide(call("code_search", { pattern: "x" })).status).toBe("allowed");
  });

  it("构造粒度（移植 buildWhitelistEntry 写类/命令例 → entryFor 条目喂入裁决）", () => {
    const key = createKey({ workspace: wsReal });

    // 命令：exact ↔ self
    const cmdKey = key.of(call("command_run", { command: "git status" }))!;
    const cmdEntry = key.entryFor("command_run", cmdKey, "self");
    expect(cmdEntry).toEqual({ tool: "command_run", key: "git status", scope: "self" });
    expect(makeVerdict([cmdEntry!]).decide(call("command_run", { command: "git status" })).status).toBe("allowed");

    // 写类此路径（self）：仅命中自身
    const fileKey = normalizeMatchKey(join(wsReal, "src", "utils.ts"));
    const selfEntry = key.entryFor("file_write", fileKey, "self");
    expect(selfEntry).toEqual({ tool: "file_write", key: fileKey, scope: "self" });
    const vSelf = makeVerdict([selfEntry!]);
    expect(vSelf.decide(call("file_write", { path: "src/utils.ts", content: "x" })).status).toBe("allowed");
    expect(vSelf.decide(call("file_write", { path: "src/other.ts", content: "x" })).status).toBe("unlisted");

    // 界内文件「此目录」= 父目录 + /（界内文件按定义必被工作区条目覆盖，此形测试形状与覆盖）
    const dirEntry = key.entryFor("file_write", fileKey, "subtree");
    expect(dirEntry).toEqual({ tool: "file_write", key: `${normalizeMatchKey(join(wsReal, "src"))}/`, scope: "subtree" });
    const vDir = makeVerdict([dirEntry!]);
    expect(vDir.decide(call("file_write", { path: "src/utils.ts", content: "x" })).status).toBe("allowed");
    expect(vDir.decide(call("file_write", { path: "src/deep/new.ts", content: "x" })).status).toBe("allowed");

    // 盘符根/根级下的单文件：无父目录可越 → 降级 self
    const rootFile = process.platform === "win32" ? "c:/x.txt" : "/x.txt";
    const rootEntry = key.entryFor("file_write", normalizeMatchKey(rootFile), "subtree");
    expect(rootEntry).toEqual({ tool: "file_write", key: normalizeMatchKey(rootFile), scope: "self" });
    expect(makeVerdict([rootEntry!]).decide(call("file_write", { path: rootFile, content: "x" })).status).toBe("allowed");
  });
});
