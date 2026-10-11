# 工作区一等化与权限模型修订 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec（2026-10-11）实现工作区一等化（`--workspace`/`HUMAN_AGENT_WORKSPACE`/CWD 三级决议 + 启动 realpath + 进程级不可变 + CLI/`GET /info`/面板呈现）、规范匹配键管道（探针 ①②③ 三缺陷修复）、读类路径级信任（写蕴含读）、三档未信任处置（扩展侧默认弹窗/默认拒绝/默认允许）、信任候选档案（桥自记 + 面板一键入库）。

**Architecture:** 判定与执行同基准是核心不变式——新增 `src/nose/workspace-path.ts` 管道（`path.resolve(workspace, input)` → realpath 深度归实 → win32 小写 matchKey），policy/桥校验/执行器/扩展镜像全部改为走管道；桥在审批必经之路自记候选（`CandidatesArchive`，镜像 whitelist.json 按工作区分节），扩展退化为视图（三档 = 三种回执通道策略，桥无档位概念）。

**Tech Stack:** TypeScript（strict + NodeNext ESM + exactOptionalPropertyTypes + noUncheckedIndexedAccess）、vitest 4、pnpm 11；**零新增依赖**。扩展为 MV3 纯 JS（无测试框架，真实浏览器 E2E 惯例）。

**Spec:** `docs/superpowers/specs/2026-10-11-workspace-permission-design.md`（已批准）。本计划相对 spec 有一处细化（评审时一并确认）：§4 说读类「此目录」= 父目录 + "/"，对 `read_dir`/`search_code`（目标本身即目录）实现为**目标自身 + "/"**（否则「此目录」不能覆盖其自身调用，与 §3「目录条目自身匹配」矛盾）；写类与 `read_file` 维持父目录 + "/"。统一由 `dirEntryKey()` 表达。

## Global Constraints

- 全部代码 TS strict；**严禁 `any`**；ESM 相对导入带 `.js` 扩展名；可选属性一律 conditional spread（`...(x !== undefined ? { k: x } : {})`）适配 `exactOptionalPropertyTypes`。
- 提交信息中文、只写变更本身，**不加** Co-Authored-By / Generated 等署名（用户全局规范）。
- 每任务 TDD：先写失败测试 → 跑失败 → 最小实现 → 跑通过 → 提交。任务结束跑全量 `pnpm test`（当前基线 246 用例；本计划会显著增加，以全绿为准）与 `pnpm build`（tsc 含 bin/ 与 src/）。
- 桥端点惯例：GET 类 close 后 204（`/protocol` 模式）；`POST /approval` 未知 id 404；错误体 `{ error }`；**桥无档位概念**——档位字符串（popup/deny/allow）不得出现在桥代码、协议、候选记录中。
- 候选档案 `~/.human-agent/candidates.json` 按工作区分节镜像 `whitelist.json`；损坏降级空白、落盘失败不崩溃（内存仍生效）。容量帽 200 条 / 30 天，超限按 `lastSeen` 丢最旧。
- 判定失败（realpath 错误）→ 按未信任处置，**绝不回退词法结果用于匹配**；执行器允许词法回退（执行不搁浅），两者不混淆。
- 扩展无测试框架：扩展任务的验证步骤为手动 E2E 清单（用户执行）；扩展设置迁移一次性映射后按三态选择器运行。
- 测试跨平台：Windows 专属断言用 `it.runIf(process.platform === "win32")`；一切路径期望值经运行时实算（mkdtemp + realpathSync + normalizeMatchKey），不写字面盘符。

## Review Focus

以下 5 类输入/条件是最容易被实现疏漏、且一错就伤用户的地方（spec 未逐字覆盖但必然是行为面）；每行都在所属任务的测试中钉住：

1. **`search_code` 缺省 `dir` 的判定键与执行落点都必须钉到工作区**（现实现落点是 `process.cwd()`，与判定基准脱节）→ Task 2 测试（键 = 工作区根）+ Task 4 测试（executor 缺省 dir = 工作区）。
2. **`read_dir`/`search_code` 的「此目录」自覆盖**（条目 `w/` 必须覆盖调用键 `w` 自身，含 `covers` 冗余清理同判）→ Task 2 测试（`w/` 匹配 `w` + addEntry 自覆盖清理）。
3. **realpath 失败按未信任且绝不回退词法**（键为 undefined → unlisted；不是「退回相对字面量碰运气」）→ Task 2 测试（注入全抛 realpath：`classify`=unlisted 且 `keyFor`=undefined）。
4. **旧白名单条目失效方向 = 重新按未信任处置、不崩溃**（相对/词法条目在新管道下不再命中，走弹窗而非放行，且 classify 不抛）→ Task 2 测试 + Task 6 桥测试（旧版 exact-JSON 读条目 → 下发审批而非 500）。
5. **候选聚合与容量帽**（同条被拒 10 次 = 一条 `denied: 10`；>200 按 `lastSeen` 丢最旧；30 天清理）→ Task 5 测试。

---

### Task 1: 规范匹配键管道模块（`src/nose/workspace-path.ts`）

**Files:**
- Create: `src/nose/workspace-path.ts`
- Test: `tests/workspace-path.test.ts`

**Interfaces:**
- Consumes: 无（仅 node:fs / node:path）。
- Produces（后续任务全部依赖）:
  - `type RealpathFn = (path: string) => string`
  - `const defaultRealpath: RealpathFn`（`realpathSync.native`）
  - `interface WorkspacePath { execPath: string; matchKey: string }`
  - `normalizeMatchKey(path: string): string`（反斜杠转正斜杠；win32 小写）
  - `resolveWorkspacePath(input: string, workspace: string, realpathFn?: RealpathFn): WorkspacePath | null`
  - `type StartupWorkspaceResult = { ok: true; workspace: string } | { ok: false; error: string }`
  - `resolveStartupWorkspace(cliValue: string | undefined, envValue: string | undefined, cwd: string, realpathFn?: RealpathFn): StartupWorkspaceResult`

- [ ] **Step 1: Write the failing test**（`tests/workspace-path.test.ts` 全新文件）

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/workspace-path.test.ts` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: Write minimal implementation**（`src/nose/workspace-path.ts` 全新文件）

```typescript
// 工作区路径管道：词法绝对化（工作区基准）→ realpath 深度归实 → win32 小写匹配键。
// 判定失败一律返回 null（调用方按未信任处置），绝不回退纯词法结果用于匹配。
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type RealpathFn = (path: string) => string;

export const defaultRealpath: RealpathFn = (path) => realpathSync.native(path);

export interface WorkspacePath {
  /** 执行用绝对路径（realpath 规范大小写；不存在的尾段拼回最深已存在祖先）。 */
  execPath: string;
  /** 匹配键：正斜杠 + win32 小写。 */
  matchKey: string;
}

/** 匹配键归一：反斜杠转正斜杠；win32 小写。 */
export function normalizeMatchKey(path: string): string {
  const forward = path.replace(/\\/g, "/");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/**
 * 路径类参数的统一管道。相对值以 workspace 为基准（探针②）；.. 段有基准可正确消解（探针①）。
 * realpath 深度归实：全路径不存在时逐段上溯找最深已存在祖先，realpath 后拼回剩余尾段。
 */
export function resolveWorkspacePath(
  input: string,
  workspace: string,
  realpathFn: RealpathFn = defaultRealpath,
): WorkspacePath | null {
  const lexical = resolve(workspace, input);
  const tail: string[] = [];
  let current = lexical;
  for (;;) {
    try {
      const real = realpathFn(current);
      const execPath = tail.length === 0 ? real : join(real, ...tail);
      return { execPath, matchKey: normalizeMatchKey(execPath) };
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export type StartupWorkspaceResult =
  | { ok: true; workspace: string }
  | { ok: false; error: string };

/** 启动工作区决议：--workspace > HUMAN_AGENT_WORKSPACE > 启动 CWD；realpath 规范化；必须为已存在目录。 */
export function resolveStartupWorkspace(
  cliValue: string | undefined,
  envValue: string | undefined,
  cwd: string,
  realpathFn: RealpathFn = defaultRealpath,
): StartupWorkspaceResult {
  const raw =
    cliValue !== undefined && cliValue.trim() !== ""
      ? cliValue
      : envValue !== undefined && envValue.trim() !== ""
        ? envValue
        : cwd;
  let real: string;
  try {
    real = realpathFn(resolve(cwd, raw));
  } catch {
    return { ok: false, error: `工作区不存在或不可访问：${raw}` };
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(real).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return { ok: false, error: `工作区不是目录：${raw}` };
  return { ok: true, workspace: real };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/workspace-path.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/nose/workspace-path.ts tests/workspace-path.test.ts
git commit -m "新增：规范匹配键管道模块 workspace-path（工作区基准 resolve + realpath 深度归实 + 启动工作区决议）"
```

---

### Task 2: policy 管道接入 + 黑名单拆分 + policy 测试重写

**Files:**
- Modify: `src/nose/blacklist.ts`（末尾两条写形态拆出为独立导出）
- Rewrite: `src/nose/policy.ts`（全文）
- Rewrite: `tests/policy.test.ts`（全文；旧版使用已删的 standalone `classify` 与 POSIX 字面工作区，整体迁移）

**Interfaces:**
- Consumes: Task 1 的 `resolveWorkspacePath` / `normalizeMatchKey` / `defaultRealpath` / `RealpathFn`。
- Produces:
  - `const WRITE_TOOLS: ReadonlySet<string>`（write_file/apply_patch/edit_file，单一来源）
  - `const READ_TOOLS: ReadonlySet<string>`（read_file/read_dir/search_code）
  - `isPathTool(name: string): boolean`
  - `pathTargetOf(call: ToolCall): string | undefined`
  - `matchKeyFor(call: ToolCall, workspace: string, realpathFn?: RealpathFn): string | undefined`
  - `normalizeEntryKey(entry: Pick<WhitelistEntry, "tool" | "key">): string`
  - `dirEntryKey(tool: string, key: string): string | null`
  - `buildWhitelistEntry(call, granularity: "exact" | "path" | "dir", workspace, realpathFn?): WhitelistEntry | null`
  - `interface Classification { status: "blacklist" | "allowed" | "unlisted"; key?: string }`
  - `PermissionPolicy.classify(call): Classification`（对象形态，替代原字符串返回值）、`keyFor(call): string | undefined`；`PermissionPolicyOptions.realpathFn?: RealpathFn`
  - 删除：standalone `classify(call)`（无 src 调用方，仅旧测试用）。
  - `BLACKLIST_WRITE_PATH_PATTERNS: readonly RegExp[]`（blacklist.ts 新导出；`BLACKLIST_PATTERNS` 不再含写形态两条）。

- [ ] **Step 1: Write the failing tests**（`tests/policy.test.ts` 全文重写为下面内容）

```typescript
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
```

备注：写文件时按实际使用整理 import（上面清单已对齐实际用法）。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/policy.test.ts` — Expected: FAIL（`dirEntryKey`/`normalizeEntryKey` 不存在、签名不匹配）。

- [ ] **Step 3a: blacklist.ts 拆分**（`src/nose/blacklist.ts` 末尾两条 + 注释替换）

将第 45-47 行（注释 + 两条写形态）替换为：

```typescript
];

/** 写类工具写系统目录：仅当调用为写类工具时由 policy 应用于路径匹配键（读类不硬拒，走信任门禁）。 */
export const BLACKLIST_WRITE_PATH_PATTERNS: readonly RegExp[] = [
  /^[a-z]:\/windows\/(?:system32|boot)(?:\/|$)/i,
  /^[a-z]:\/system volume\s+information(?:\/|$)/i,
];
```

即：`BLACKLIST_PATTERNS` 数组在第 44 行 `chmod` 一条后以 `];` 收口，删掉原第 45-47 行。

- [ ] **Step 3b: policy.ts 全文重写**（`src/nose/policy.ts` 替换为下面完整内容）

```typescript
// 权限裁决模块：黑名单（绝对禁止）+ 白名单（用户信任）统一匹配。
// 路径类调用经规范匹配键管道（workspace 基准 → realpath 深度归实 → win32 小写）产生匹配键；
// 管道失败按未信任处置（绝不回退词法结果用于匹配）。只做文本比对，不做命令分类/路径分析。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolCall } from "../brain/llm.js";
import type { WhitelistEntry } from "../types/index.js";
import { BLACKLIST_PATTERNS, BLACKLIST_WRITE_PATH_PATTERNS } from "./blacklist.js";
import {
  defaultRealpath,
  normalizeMatchKey,
  resolveWorkspacePath,
  type RealpathFn,
} from "./workspace-path.js";

/** 写类工具集（单一来源：policy/loop/桥/扩展镜像/测试共用）。 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "apply_patch", "edit_file"]);
/** 读类工具集（单一来源；进路径维度，行区间/pattern 等不进键）。 */
export const READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "read_dir", "search_code"]);

/** 目标为目录的读类工具：「此目录」粒度 = 目标目录自身 + /（其余 = 父目录 + /）。 */
const DIR_TARGET_TOOLS: ReadonlySet<string> = new Set(["read_dir", "search_code"]);

export function isPathTool(name: string): boolean {
  return WRITE_TOOLS.has(name) || READ_TOOLS.has(name);
}

/** 段级解析：折叠 . 与 ..（盘符根/根之上不可越）。条目归一等文本兜底用。 */
function resolvePathSegments(p: string): string {
  const isAbs = p.startsWith("/");
  const isDrive = /^[a-z]:\//i.test(p);
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length > (isDrive ? 1 : 0)) out.pop();
      continue;
    }
    out.push(s);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

/** 归一化：空白折叠 + 反斜杠转正斜杠 + 段级解析；win32 额外小写（路径键用）。 */
export function normalizePath(input: string): string {
  const out = input.trim().replace(/\s+/g, " ").replace(/\\/g, "/").replace(/\/+/g, "/");
  const resolved = resolvePathSegments(out);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeCommand(input: string): string {
  return input.trim().replace(/\s+/g, " ").replace(/\\/g, "/");
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeCommand(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeValue(v)]));
  }
  return value;
}

/** 其余工具（fetch_page 等非路径类）：排序参数 JSON（深层空白归一）。 */
export function serializeArgs(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) sorted[key] = normalizeValue(args[key]);
  return JSON.stringify(sorted);
}

/** 路径类调用的目标参数：file 类取 path；search_code 取 dir（缺省 "." = 工作区根）；非路径类 undefined。 */
export function pathTargetOf(call: ToolCall): string | undefined {
  const args: Record<string, unknown> = call.arguments ?? {};
  if (WRITE_TOOLS.has(call.name) || call.name === "read_file" || call.name === "read_dir") {
    const raw = args.path;
    return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
  }
  if (call.name === "search_code") {
    const raw = args.dir;
    return typeof raw === "string" && raw.trim() !== "" ? raw : ".";
  }
  return undefined;
}

/** 匹配键：terminal → 命令；路径类 → 管道 matchKey（失败 undefined）；其余 → 排序参数 JSON。 */
export function matchKeyFor(
  call: ToolCall,
  workspace: string,
  realpathFn: RealpathFn = defaultRealpath,
): string | undefined {
  if (call.name === "terminal") {
    const raw = (call.arguments ?? {}).command;
    return typeof raw === "string" ? normalizeCommand(raw) : undefined;
  }
  const target = pathTargetOf(call);
  if (target !== undefined) {
    const resolved = resolveWorkspacePath(target, workspace, realpathFn);
    return resolved?.matchKey;
  }
  return serializeArgs(call.arguments ?? {});
}

/** 条目工具与调用工具是否相关：写条目覆盖写∪读（写蕴含读）；读条目仅覆盖读；其余仅同名。 */
export function toolMatches(entryTool: string, callName: string): boolean {
  if (entryTool === callName) return true;
  if (WRITE_TOOLS.has(entryTool)) return WRITE_TOOLS.has(callName) || READ_TOOLS.has(callName);
  if (READ_TOOLS.has(entryTool)) return READ_TOOLS.has(callName);
  return false;
}

/** 条目键匹配：exact 相等；path 文件条目相等；path 目录条目（尾 /）段级前缀 + 覆盖条目自身路径（w/ 匹配 w）。 */
export function keyMatches(entry: WhitelistEntry, key: string): boolean {
  if (entry.kind === "exact") return entry.key === key;
  if (entry.key.endsWith("/")) {
    return key === entry.key || key === entry.key.slice(0, -1) || key.startsWith(entry.key);
  }
  return entry.key === key;
}

/** 「此目录」粒度键：读目录类工具 = 目标自身 + /；其余 = 父目录 + /；根级/盘符根返回 null（调用方降级文件条目）。 */
export function dirEntryKey(tool: string, key: string): string | null {
  if (key === "" || key === "/" || /^[a-z]:\/$/i.test(key)) return null;
  if (DIR_TARGET_TOOLS.has(tool)) return `${key}/`;
  const i = key.lastIndexOf("/");
  if (i <= 0 || (i === 2 && key[1] === ":")) return null;
  return `${key.slice(0, i)}/`;
}

/** 条目键归一：terminal 走命令归一；路径类走路径归一（保留目录条目尾 /；根 "/" 与盘符根 "c:/" 原样）。 */
export function normalizeEntryKey(entry: Pick<WhitelistEntry, "tool" | "key">): string {
  if (entry.tool === "terminal") return normalizeCommand(entry.key);
  const hadTrailing = entry.key.trim().endsWith("/");
  const normalized = normalizePath(entry.key);
  if (!hadTrailing || normalized === "" || normalized.endsWith("/")) return normalized;
  return `${normalized}/`;
}

export type WhitelistGranularity = "exact" | "path" | "dir";

/** 由调用构造白名单条目：exact（命令/整串）、path（此路径）、dir（此目录，根级降级文件条目）；键缺失 → null。 */
export function buildWhitelistEntry(
  call: ToolCall,
  granularity: WhitelistGranularity,
  workspace: string,
  realpathFn: RealpathFn = defaultRealpath,
): WhitelistEntry | null {
  const key = matchKeyFor(call, workspace, realpathFn);
  if (key === undefined || key === "") return null;
  if (granularity === "dir") {
    const dirKey = dirEntryKey(call.name, key);
    return { tool: call.name, key: dirKey ?? key, kind: "path" };
  }
  if (granularity === "exact") return { tool: call.name, key, kind: "exact" };
  return { tool: call.name, key, kind: "path" };
}

export interface Classification {
  status: "blacklist" | "allowed" | "unlisted";
  /** 匹配键（管道失败/参数缺失时缺省）。 */
  key?: string;
}

export interface PermissionPolicyOptions {
  /** 白名单文件；缺省 ~/.human-agent/whitelist.json */
  file?: string;
  /** 工作区绝对路径（启动已 realpath 规范化）；缺省 process.cwd()。用于分节键与匹配基准。 */
  workspace?: string;
  /** 测试注入条目；缺省从文件加载。 */
  entries?: WhitelistEntry[];
  /** realpath 注入（测试用）；缺省 fs realpathSync.native。 */
  realpathFn?: RealpathFn;
}

/** 白名单按工作区分节的单文件存储；同步读写（启动期小文件，构造函数保持同步）。 */
export class PermissionPolicy {
  readonly #file: string;
  readonly #workspaceKey: string;
  readonly #realpathFn: RealpathFn;
  #sections: Record<string, WhitelistEntry[]>;

  constructor(options: PermissionPolicyOptions = {}) {
    this.#workspaceKey = normalizePath(options.workspace ?? process.cwd());
    this.#file = options.file ?? join(homedir(), ".human-agent", "whitelist.json");
    this.#realpathFn = options.realpathFn ?? defaultRealpath;
    this.#sections =
      options.entries === undefined
        ? loadSections(this.#file)
        : { [this.#workspaceKey]: [...options.entries] };
  }

  /** 匹配键（规范匹配键管道；管道失败 undefined）。 */
  keyFor(call: ToolCall): string | undefined {
    return matchKeyFor(call, this.#workspaceKey, this.#realpathFn);
  }

  /** 分类：黑名单 → 白名单 → 未列。写形态黑名单仅写类工具命中（读类不硬拒）；键缺失视为未列。 */
  classify(call: ToolCall): Classification {
    const key = this.keyFor(call);
    if (key === undefined) return { status: "unlisted" };
    if (this.#blacklistHit(call, key)) return { status: "blacklist", key };
    for (const entry of this.entries()) {
      if (toolMatches(entry.tool, call.name) && keyMatches(entry, key)) {
        return { status: "allowed", key };
      }
    }
    return { status: "unlisted", key };
  }

  #blacklistHit(call: ToolCall, key: string): boolean {
    if (BLACKLIST_PATTERNS.some((pattern) => pattern.test(key))) return true;
    return (
      WRITE_TOOLS.has(call.name) &&
      BLACKLIST_WRITE_PATH_PATTERNS.some((pattern) => pattern.test(key))
    );
  }

  entries(): WhitelistEntry[] {
    return this.#sections[this.#workspaceKey] ?? [];
  }

  /** 加条目（归一 + 去重 + 冗余清理后落盘）；返回是否新增。 */
  addEntry(entry: WhitelistEntry): boolean {
    const normalized: WhitelistEntry = {
      tool: entry.tool,
      key: normalizeEntryKey(entry),
      kind: entry.kind,
    };
    const current = this.entries();
    if (
      current.some(
        (e) => e.tool === normalized.tool && e.kind === normalized.kind && e.key === normalized.key,
      )
    ) {
      return false;
    }
    if (normalized.kind === "path" && current.some((e) => e.kind === "path" && covers(e.key, normalized.key))) {
      return false; // 子被父盖：跳过（跨工具同判——path 是信任面概念，不按工具拆分）
    }
    const kept =
      normalized.kind === "path"
        ? current.filter((e) => !(e.kind === "path" && covers(normalized.key, e.key))) // 加父去子
        : current;
    this.#sections[this.#workspaceKey] = [...kept, normalized];
    this.#save();
    return true;
  }

  /** 启动时注册工作区写白名单（write_file path-dir，跨工具覆盖写∪读）；幂等。 */
  ensureWorkspace(): void {
    const root = `${this.#workspaceKey}/`;
    if (this.entries().some((e) => e.kind === "path" && e.key === root)) return;
    this.addEntry({ tool: "write_file", key: root, kind: "path" });
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, JSON.stringify(this.#sections, null, 2), "utf8");
    } catch {
      // 落盘失败不崩溃（内存条目仍生效）
    }
  }
}

/** 目录条目是否覆盖子键（父以 / 结尾：段级前缀 + 覆盖条目自身路径——w/ 覆盖 w）。 */
function covers(parentKey: string, childKey: string): boolean {
  return (
    parentKey.endsWith("/") &&
    (childKey === parentKey || childKey === parentKey.slice(0, -1) || childKey.startsWith(parentKey))
  );
}

/** 条目结构校验：tool/key 为 string、kind 为合法值；垃圾条目过滤（防手改文件导致 classify 崩溃）。 */
function isEntry(item: unknown): item is WhitelistEntry {
  if (typeof item !== "object" || item === null) return false;
  const w = item as Record<string, unknown>;
  return (
    typeof w.tool === "string" &&
    typeof w.key === "string" &&
    (w.kind === "exact" || w.kind === "path")
  );
}

function loadSections(file: string): Record<string, WhitelistEntry[]> {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const out: Record<string, WhitelistEntry[]> = {};
      for (const [workspace, entries] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        out[workspace] = entries.filter(isEntry);
      }
      return out;
    }
  } catch {
    // 损坏/不存在 → 空白名单（默认弹窗档全部走审批，不崩溃）
  }
  return {};
}
```

注意：`import { normalizeMatchKey }` 不在 policy 中使用（matchKey 由管道产出）——如未用则**不要导入**（tsc 会报未用仅当 noUnusedLocals，本项目未开，但从简）；上面代码块已不含该导入。

- [ ] **Step 3c: 同步修复编译断点**（本任务只做「能编译 + policy 测试通过」的最小面缝；行为接线在 Task 3/6）

此时 `src/brain/reflection.ts`（`classify` 返回对象 + 删了 standalone）、`src/brain/thinking.ts`（`Classification` 类型 import 仍在 policy 导出中，OK）、`src/heart/loop.ts`、`src/brain/gemini-bridge-thinking.ts`（`matchKeyFor` 签名变化）会编译失败。**Task 3/6 会做最终形态**；本任务先做最小适配使 `pnpm build` 通过：

- `src/brain/reflection.ts`：`const verdict = this.#policy.classify(call);`（一次），`verdict.status === "blacklist"`，消息用 `verdict.key ?? call.name`；白名单分支 `verdict.status === "allowed"`。删除 `matchKeyFor` import。（完整形态即 Task 3 所列。）
- `src/heart/loop.ts`：`matchKeyFor(call, process.cwd())` 临时过渡 + `isWrite` 改 `isPathTool(call.name)`（import 自 policy）。完整接线（workspace 注入）在 Task 3。
- `src/brain/gemini-bridge-thinking.ts`：`#isValidWhitelist` 的 `matchKeyFor(call)` 临时改 `this.keyFor(call)`（Task 3 会加 `keyFor` 到 BaseThinking）——若想收敛改动，可把本任务的桥临时改为 `matchKeyFor(call, this.workspace)` 并同时加 Task 3 的 thinking 三件套；建议直接按 Task 3 的 thinking.ts 增补做（顺序无碍）。

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/policy.test.ts && pnpm test` — Expected: policy 全绿；全量仅剩 Task 3/6 尚未迁移的用例（reflection/thinking/loop/bridge 的若干断言）失败——**允许**，Task 3/6 收口。`pnpm build` 必须通过。

- [ ] **Step 5: Commit**

```bash
git add src/nose/blacklist.ts src/nose/policy.ts src/brain/reflection.ts src/heart/loop.ts tests/policy.test.ts
git commit -m "修订：权限裁决走规范匹配键管道（探针①②③修复）、黑名单写形态限写类、目录条目自覆盖、读类进路径维度"
```

---

### Task 3: 读类信任接线（reflection / thinking / loop / 嘴巴 dirEntryKey）+ 测试迁移

**Files:**
- Modify: `src/brain/reflection.ts`（单次分类定稿）
- Modify: `src/brain/thinking.ts`（`workspace` getter、`keyFor`、`whitelistEntries`）
- Modify: `src/heart/loop.ts`（`workspace` 选项、`isPathTool`、`matchKeyFor(call, workspace)`）
- Modify: `src/mouth/ask-user.ts`（d 分支改 `dirEntryKey`）
- Test: `tests/reflection.test.ts`、`tests/thinking.test.ts`、`tests/loop.test.ts`、`tests/ask-user.test.ts`（增/改）

**Interfaces:**
- Consumes: Task 1/2 的 `matchKeyFor(call, workspace)`、`isPathTool`、`dirEntryKey`、`Classification`。
- Produces:
  - `BaseThinking.workspace: string`（getter）、`BaseThinking.keyFor(call): string | undefined`、`BaseThinking.whitelistEntries(): readonly WhitelistEntry[]`
  - `AgentLoopOptions.workspace?: string`（缺省 `process.cwd()`）
  - `ApprovalPrompt.kind` 对读类为 `"path"`（loop 侧；桥 Task 6、扩展 Task 7 同步）

- [ ] **Step 1: 更新测试**（先失败）

**1a. `tests/reflection.test.ts`** — 现有 5 用例全部保留（无需改动，`policy("/ws")` 直接构造 PermissionPolicy，无 ensureWorkspace，读类仍 pending）；新增 1 用例（文件头补 import `mkdirSync?` 不需要；需 `mkdtempSync, realpathSync, rmSync`（node:fs）、`tmpdir`（node:os）、`join`（node:path）、`normalizeMatchKey`（../src/nose/workspace-path.js））：

```typescript
  it("读界内 allowed（写 path-dir 覆盖读）、读界外 pending", async () => {
    const ws = mkdtempSync(join(tmpdir(), "reflect-ws-"));
    try {
      const wsReal = realpathSync(ws);
      const p = new PermissionPolicy({
        workspace: wsReal,
        entries: [{ tool: "write_file", key: `${normalizeMatchKey(wsReal)}/`, kind: "path" }],
      });
      const outside = process.platform === "win32" ? "D:\\secrets.txt" : "/etc/secrets.txt";
      const verdict = await new Reflection(p).reflect([
        { name: "read_file", arguments: { path: "src/a.ts" } },
        { name: "read_file", arguments: { path: outside } },
      ]);
      expect(verdict.allowed).toHaveLength(1);
      expect(verdict.pending).toHaveLength(1);
      expect(verdict.blocked).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
```

**1b. `tests/thinking.test.ts`** — 现有断言 `t.classify(...)` 返回对象，5 处 `.toBe("whitelist"/"unlisted")` 改为 `.classify(...).status`。新增：

```typescript
  it("workspace getter / keyFor / whitelistEntries（管道 + 条目快照）", () => {
    const t = new TestThinking({ workspace: "/home/u/proj", whitelistFile: file });
    expect(t.workspace).toBe("/home/u/proj");
    expect(t.keyFor({ name: "terminal", arguments: { command: "git   status" } })).toBe("git status");
    expect(t.whitelistEntries().some((e) => e.kind === "path")).toBe(true); // ensureWorkspace 条目
  });
```

**1c. `tests/loop.test.ts`** —
(i) `makeLoop` 与所有直接 `new AgentLoop` 的用例新增可选 `workspace?: string` 透传（`makeLoop` options 加字段并传给 AgentLoop）。
(ii) 「pending 加入白名单」用例替换为：

```typescript
  it("pending 加入白名单：提示键为管道匹配键，条目落盘后执行（临时工作区）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "loop-ws-"));
    try {
      const wsReal = realpathSync(ws);
      const call = { name: "write_file", arguments: { path: "src/a.ts", content: "x" } };
      const brain = pendingBrain(call);
      const entry: WhitelistEntry = {
        tool: "write_file",
        key: normalizeMatchKey(join(wsReal, "src", "a.ts")),
        kind: "path",
      };
      const prompts: ApprovalPrompt[] = [];
      const loop = new AgentLoop({
        brain,
        ears: new FakeEars(["任务", "/exit"]),
        eyes: buildEyes(),
        hands: buildHands(),
        output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
        signal: new AbortController().signal,
        workspace: wsReal,
        mouth: {
          confirm: async () => true,
          askApproval: async (prompt: ApprovalPrompt) => {
            prompts.push(prompt);
            return prompt.kind === "path" ? { action: "whitelist", entry } : { action: "allow" };
          },
        },
      });
      await loop.run();
      expect(prompts).toEqual([{ tool: "write_file", key: entry.key, kind: "path" }]);
      expect(brain.addedWhitelist).toEqual([entry]);
      expect(brain.messagesOf(1).find((m) => m.role === "tool")).toBeDefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
```

(iii) 新增读类/写类回归两个用例：

```typescript
  it("edit_file 属写类：审批提示 kind=path（WRITE_TOOLS 漏项回归）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "loop-ws-"));
    try {
      const wsReal = realpathSync(ws);
      const call = { name: "edit_file", arguments: { path: "x.ts", hunks: [{ search: "a", replace: "b" }] } };
      const brain = pendingBrain(call);
      const prompts: ApprovalPrompt[] = [];
      const loop = new AgentLoop({
        brain,
        ears: new FakeEars(["任务", "/exit"]),
        eyes: buildEyes(),
        hands: buildHands(),
        output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
        signal: new AbortController().signal,
        workspace: wsReal,
        mouth: {
          confirm: async () => true,
          askApproval: async (prompt: ApprovalPrompt) => {
            prompts.push(prompt);
            return { action: "deny" };
          },
        },
      });
      await loop.run();
      expect(prompts[0]).toEqual({
        tool: "edit_file",
        key: normalizeMatchKey(join(wsReal, "x.ts")),
        kind: "path",
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("读类调用审批：提示 kind=path，此目录条目 = read_dir 自身 + /", async () => {
    const ws = mkdtempSync(join(tmpdir(), "loop-ws-"));
    try {
      const wsReal = realpathSync(ws);
      const call = { name: "read_dir", arguments: { path: "sub" } };
      const brain = pendingBrain(call);
      const expected: WhitelistEntry = {
        tool: "read_dir",
        key: `${normalizeMatchKey(join(wsReal, "sub"))}/`,
        kind: "path",
      };
      const prompts: ApprovalPrompt[] = [];
      const loop = new AgentLoop({
        brain,
        ears: new FakeEars(["任务", "/exit"]),
        eyes: buildEyes(),
        hands: buildHands(),
        output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
        signal: new AbortController().signal,
        workspace: wsReal,
        mouth: {
          confirm: async () => true,
          askApproval: async (prompt: ApprovalPrompt) => {
            prompts.push(prompt);
            return { action: "whitelist", entry: expected };
          },
        },
      });
      await loop.run();
      expect(prompts[0]).toEqual({ tool: "read_dir", key: normalizeMatchKey(join(wsReal, "sub")), kind: "path" });
      expect(brain.addedWhitelist).toEqual([expected]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
```

loop.test.ts 文件头补 import：`mkdtempSync, realpathSync, rmSync`（node:fs）、`tmpdir`、`join`、`normalizeMatchKey`。
删除原用例尾部对 `rmSync("src/a.ts")` 的清理（已不存在）。

**1d. `tests/ask-user.test.ts`** — 现有 d 分支用例保留；新增：

```typescript
  it("读类 d 分支：read_dir 此目录 = 自身 + /；read_file = 父目录 + /", async () => {
    const ask1 = new AskUser({ input: inputFrom("d\n") });
    expect(await ask1.askApproval({ tool: "read_dir", key: "c:/ws/src", kind: "path" })).toEqual({
      action: "whitelist",
      entry: { tool: "read_dir", key: "c:/ws/src/", kind: "path" },
    });
    const ask2 = new AskUser({ input: inputFrom("d\n") });
    expect(await ask2.askApproval({ tool: "read_file", key: "c:/ws/src/a.ts", kind: "path" })).toEqual({
      action: "whitelist",
      entry: { tool: "read_file", key: "c:/ws/src/", kind: "path" },
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/reflection.test.ts tests/thinking.test.ts tests/loop.test.ts tests/ask-user.test.ts` — Expected: 新用例 FAIL（`t.workspace` undefined、loop workspace 选项不存在、ask-user 未用 dirEntryKey 时 read_dir d 分支返回 "c:/ws/" 而非 "c:/ws/src/" 等）。

- [ ] **Step 3: 实现**

**3a. `src/brain/reflection.ts`** 全文替换：

```typescript
// 反思层（潜意识）：决策后再想"可行吗"。确定性代码，不经过模型。
// 裁决顺序：权限黑名单 → 存在性 → 结构 → 白名单放行 → 其余需授权。
// 权限层注入 PermissionPolicy；"需授权"仅作标记，审批通道由宿主（桥/loop）负责。
import { schemas } from "./knowledge.js";
import type { PermissionPolicy } from "../nose/policy.js";
import type { ReflectionVerdict, ToolCall } from "./llm.js";
import { fail } from "../types/index.js";

export class Reflection {
  readonly #policy: PermissionPolicy;

  constructor(policy: PermissionPolicy) {
    this.#policy = policy;
  }

  async reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict> {
    const allowed: ToolCall[] = [];
    const pending: ToolCall[] = [];
    const blocked: ReflectionVerdict["blocked"] = [];
    for (const call of calls) {
      const verdict = this.#policy.classify(call);
      if (verdict.status === "blacklist") {
        blocked.push({
          call,
          result: fail("BLACKLIST", `系统破坏操作，禁止执行：${verdict.key ?? call.name}`),
        });
        continue;
      }
      const schema = schemas[call.name as keyof typeof schemas];
      if (schema === undefined) {
        blocked.push({ call, result: fail("UNKNOWN_TOOL", `未知工具: ${call.name}`) });
        continue;
      }
      const parsed = schema.safeParse(call.arguments);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        blocked.push({
          call,
          result: fail("INVALID_ARGS", `工具 ${call.name} 参数不合法: ${issues}`),
        });
        continue;
      }
      if (verdict.status === "allowed") allowed.push(call);
      else pending.push(call);
    }
    return { allowed, pending, blocked };
  }
}
```

**3b. `src/brain/thinking.ts`** — 新增三个成员（import 增 `matchKeyFor`；已有 `ToolCall`、`WhitelistEntry`）：

```typescript
// import 行改为：
import { matchKeyFor, PermissionPolicy, type Classification } from "../nose/policy.js";
```

在 `classify` 方法后插入：

```typescript
  /** 当前工作区（启动 realpath 规范化后的值，进程级不可变）。 */
  get workspace(): string {
    return this.#workspace;
  }

  /** 调用匹配键（规范匹配键管道；失败/参数缺失 undefined）。 */
  keyFor(call: ToolCall): string | undefined {
    return matchKeyFor(call, this.#workspace);
  }

  /** 当前工作区白名单条目快照（桥 /candidates 滤除已覆盖用）。 */
  whitelistEntries(): readonly WhitelistEntry[] {
    return this.#permission.entries();
  }
```

**3c. `src/heart/loop.ts`** —
(i) import 行 4 替换：`import { isPathTool, matchKeyFor } from "../nose/policy.js";`
(ii) `AgentLoopOptions` 增字段：

```typescript
  /** 工作区（判定/执行基准；缺省 process.cwd()）。 */
  workspace?: string;
```

(iii) 类字段与构造：`readonly #workspace: string;` + `this.#workspace = options.workspace ?? process.cwd();`
(iv) `#execute` pending 分支首两行替换：

```typescript
        const prompt: ApprovalPrompt = {
          tool: call.name,
          key: matchKeyFor(call, this.#workspace) ?? "",
          kind: isPathTool(call.name) ? "path" : "exact",
        };
```

（原 `const isWrite = ...` 行删除。）
(v) 两处 `executeTool(...)` 调用（allowed 分支与 pending 放行分支）追加第五参：`{ workspace: this.#workspace }`。此处的执行器第五参由 Task 4 引入——**本任务先只改到第 (iv) 步**，executeTool 签名不动；Task 4 再补第五参与调用点（避免跨任务中间态不可编译）。

**3d. `src/mouth/ask-user.ts`** —
(i) 文件头增 import：`import { dirEntryKey } from "../nose/policy.js";`
(ii) d 分支（53-66 行）替换为：

```typescript
        if (answer === "d" && isPath) {
          // 根级/盘符根：dir 条目=全部绝对路径/整盘超授权 → 降级文件条目；读目录类 = 自身 + /
          const dirKey = dirEntryKey(prompt.tool, prompt.key);
          return {
            action: "whitelist",
            entry: { tool: prompt.tool, key: dirKey ?? prompt.key, kind: "path" },
          };
        }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/reflection.test.ts tests/thinking.test.ts tests/loop.test.ts tests/ask-user.test.ts && pnpm test` — Expected: 四文件全绿；全量只剩 bridge 测试未迁移（Task 6）。`pnpm build` 通过。

- [ ] **Step 5: Commit**

```bash
git add src/brain/reflection.ts src/brain/thinking.ts src/heart/loop.ts src/mouth/ask-user.ts tests/reflection.test.ts tests/thinking.test.ts tests/loop.test.ts tests/ask-user.test.ts
git commit -m "接入：读类路径级信任链（反思单次分类 + thinking keyFor/whitelistEntries + loop 工作区基准 + 嘴巴目录粒度 dirEntryKey）"
```

---

### Task 4: 执行一致性（executor execPath / terminal cwd / agent / cli `--workspace`）

**Files:**
- Modify: `src/heart/executor.ts`（`ExecuteToolContext` + execPath 改写 + search_code 缺省钉工作区）
- Modify: `src/hands/terminal.ts`（构造 `cwd` 选项）
- Modify: `src/heart/loop.ts`（executeTool 第五参接线）
- Modify: `src/brain/gemini-bridge-thinking.ts`（executeTool 第五参接线；仅此一处，端点与候选在 Task 6）
- Modify: `src/agent.ts`（workspace 穿透 / buildDefaultHands cwd）
- Modify: `bin/cli.ts`（`--workspace` + 启动决议 + 横幅 + 退出码）
- Test: `tests/executor.test.ts`（新）

**Interfaces:**
- Consumes: Task 1 `resolveWorkspacePath`/`RealpathFn`；Task 3 `BaseThinking.workspace`、`AgentLoopOptions.workspace`。
- Produces:
  - `interface ExecuteToolContext { workspace?: string; realpathFn?: RealpathFn }`
  - `executeTool(organs, name, args, signal?, context?: ExecuteToolContext)`
  - `interface TerminalOptions { cwd?: string }`；`new Terminal({ cwd })`
  - `HumanAgentOptions.workspace?: string`；`BridgeServiceOptions.workspace?: string`

- [ ] **Step 1: Write the failing test**（`tests/executor.test.ts` 新文件）

```typescript
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
  return { success: true, data };
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
    expect(result.success).toBe(true);
    expect(realpathSync(String(result.data).trim())).toBe(wsReal);
  });

  it("未提供 context 时参数原样透传（兼容既有调用）", async () => {
    const organs = makeRecordingOrgans();
    await executeTool(organs, "read_file", { path: "rel/a.ts" });
    expect(organs.calls[0]).toEqual({ name: "read_file", args: { path: "rel/a.ts" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/executor.test.ts` — Expected: FAIL（executeTool 无第五参 / Terminal 无构造选项）。

- [ ] **Step 3: 实现**

**3a. `src/heart/executor.ts`** 全文替换：

```typescript
import { resolve as resolvePath } from "node:path";
import { fail, type ActionResult, type EyesContract, type HandsContract } from "../types/index.js";
import type { DiffHunk } from "../brain/llm.js";
import { resolveWorkspacePath, type RealpathFn } from "../nose/workspace-path.js";

export interface ToolOrgans {
  eyes: EyesContract;
  hands: HandsContract;
}

export interface ExecuteToolContext {
  /** 判定/执行基准工作区：路径类参数经管道归实为绝对 execPath；缺省时原样透传（兼容既有调用）。 */
  workspace?: string;
  /** realpath 注入（测试用）。 */
  realpathFn?: RealpathFn;
}

/** 执行落点：管道 execPath 优先；管道失败（realpath 不可用）回退词法绝对化——执行不因归实失败搁浅。 */
function execPathFor(target: string, context: ExecuteToolContext): string {
  if (context.workspace === undefined) return target;
  const resolved = resolveWorkspacePath(target, context.workspace, context.realpathFn);
  return resolved !== null ? resolved.execPath : resolvePath(context.workspace, target);
}

/** 工具执行路由：工具名 → 双手/眼睛方法（loop 与桥服务共用，保持单一映射）。 */
export async function executeTool(
  organs: ToolOrgans,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context: ExecuteToolContext = {},
): Promise<ActionResult<unknown>> {
  switch (name) {
    case "read_file": {
      const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
      const lineCount = typeof args.line_count === "number" ? args.line_count : undefined;
      const opts = {
        ...(startLine !== undefined ? { startLine } : {}),
        ...(lineCount !== undefined ? { lineCount } : {}),
      };
      return organs.eyes.readFile(
        execPathFor(args.path as string, context),
        Object.keys(opts).length > 0 ? opts : undefined,
      );
    }
    case "read_dir":
      return organs.eyes.readDir(execPathFor(args.path as string, context));
    case "search_code":
      return organs.eyes.searchCode(
        args.pattern as string,
        args.dir === undefined ? context.workspace : execPathFor(args.dir as string, context),
      );
    case "write_file":
      return organs.hands.writeFile(execPathFor(args.path as string, context), args.content as string);
    case "apply_patch":
      return organs.hands.applyPatch(execPathFor(args.path as string, context), args.patch as string);
    case "edit_file":
      return organs.hands.editFile(
        execPathFor(args.path as string, context),
        (args.hunks as DiffHunk[] | undefined) ?? [],
        args.base_version as string | undefined,
      );
    case "terminal":
      return organs.hands.executeCommand(
        args.command as string,
        signal,
        args.timeoutMs as number | undefined,
      );
    case "fetch_page":
      return organs.eyes.fetchPageAsMarkdown(args.url as string);
    default:
      return fail("UNKNOWN_TOOL", `未知工具: ${name}`);
  }
}
```

**3b. `src/hands/terminal.ts`** — 构造选项 + execa cwd（全文替换为下列内容，catch 分支与现实现逐字一致）：

```typescript
import { ExecaError, execa } from "execa";
import { fail, ok, type ActionResult } from "../types/index.js";

export interface TerminalOptions {
  /** 命令工作目录（钉到工作区；缺省继承进程 CWD）。 */
  cwd?: string;
}

export class Terminal {
  readonly #cwd: string | undefined;

  constructor(options: TerminalOptions = {}) {
    this.#cwd = options.cwd;
  }

  async executeCommand(
    command: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ActionResult<string>> {
    try {
      const { stdout, stderr } = await execa({
        shell: true,
        encoding: "utf8",
        ...(this.#cwd !== undefined ? { cwd: this.#cwd } : {}),
        ...(signal !== undefined ? { cancelSignal: signal } : {}),
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      })`${command}`;
      return ok(stdout || stderr || "Command executed with no output.");
    } catch (err) {
      if (err instanceof ExecaError) {
        if (err.timedOut) {
          return fail(
            "EXEC_TIMEOUT",
            `命令执行超时（${timeoutMs}ms）: ${err.shortMessage}`,
          );
        }
        return fail(
          "EXEC_ERROR",
          err.shortMessage,
          err.stderr || err.stdout || undefined,
        );
      }
      return fail(
        "EXEC_ERROR",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
```

**3c. `src/heart/loop.ts`** — Task 3 留白的接线：两处 `executeTool(...)` 追加第五参 `{ workspace: this.#workspace }`。

**3d. `src/brain/gemini-bridge-thinking.ts`** — 执行点（`#process` 内 `executeTool(this.#organs, toRun.name, toRun.arguments, batchSignal)`）追加第五参 `{ workspace: this.workspace }`。

**3e. `src/agent.ts`** —
- `HumanAgentOptions` 增：`/** 工作区（启动 realpath 规范化）；缺省 process.cwd()。 */ workspace?: string;`
- 构造函数：`this.brain = options.brain ?? buildDefaultBrain(options.whitelistFile, options.workspace);`
- `run()` 的 `new AgentLoop({...})` 增：`...(this.#workspaceOption !== undefined ? { workspace: this.#workspaceOption } : {})` —— 为避免新增私有字段，直接在构造时保存：增加 `readonly #workspaceOption: string | undefined;`（或把选项对象存下）。最简：类字段 `readonly #loopWorkspace: string | undefined;`，构造 `this.#loopWorkspace = options.workspace;`，run 中条件展开 `...(this.#loopWorkspace !== undefined ? { workspace: this.#loopWorkspace } : {})`。
- `buildDefaultBrain(whitelistFile?: string, workspace?: string)`：OllamaThinking 参数增 `...(workspace !== undefined ? { workspace } : {})`。
- `BridgeServiceOptions` 增 `workspace?: string` 与 `candidatesFile?: string`（candidatesFile 在 Task 6 由 GeminiBridgeThinkingOptions 接收；本任务先把 workspace 接上）：`buildBridgeService` 中 `const hands = buildDefaultHands(options.workspace);` 并把 `...(options.workspace !== undefined ? { workspace: options.workspace } : {})` 传给 GeminiBridgeThinking（其 options 已含 `workspace`——BaseThinkingOptions 透传）。`candidatesFile` 的穿透留到 Task 6。
- `buildDefaultHands(workspace?: string)`：`const terminal = new Terminal({ ...(workspace !== undefined ? { cwd: workspace } : {}) });`

**3f. `bin/cli.ts`** 全文替换：

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { buildBridgeService, HumanAgent } from "../src/agent.js";
import { InterruptController } from "../src/heart/interrupt.js";
import { TextInput } from "../src/ears/text-input.js";
import { resolveStartupWorkspace } from "../src/nose/workspace-path.js";

const program = new Command();

program
  .name("human-agent")
  .description("A humanoid modular AI Agent CLI tool")
  .version("0.1.0")
  .option("--workspace <path>", "工作区目录（优先于 HUMAN_AGENT_WORKSPACE；缺省为启动目录）");

program.parse(process.argv);

const startup = resolveStartupWorkspace(
  program.opts().workspace as string | undefined,
  process.env.HUMAN_AGENT_WORKSPACE,
  process.cwd(),
);
if (!startup.ok) {
  console.error(`启动失败：${startup.error}`);
  process.exit(1);
}
const workspace = startup.workspace;

if (process.env.GEMINI_BRIDGE_PORT !== undefined) {
  // 桥模式：对话在网页（AI Studio），CLI 仅宿主 HTTP 服务
  const interrupt = new InterruptController();
  const service = buildBridgeService({
    workspace,
    signal: interrupt.getSignal(),
    logger: (text) => console.log(`[gemini-bridge] ${text}`),
  });
  process.on("SIGINT", () => interrupt.abort());
  process.on("SIGTERM", () => interrupt.abort());
  try {
    const port = await service.getPort();
    console.log(`工作区：${workspace}`);
    console.log(`Gemini 桥已监听 http://127.0.0.1:${port}`);
    console.log("请在 AI Studio 页面与 Gemini 对话；插件会把 Gemini 的回复传给智能体执行工具，并把结果回填提交。");
  } catch (err) {
    console.error(`Gemini 桥无法监听端口：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  await new Promise<void>((resolve) => {
    if (interrupt.isAborted()) resolve();
    else interrupt.getSignal().addEventListener("abort", () => resolve(), { once: true });
  });
  service.close();
  process.exitCode = interrupt.isAborted() ? 130 : 0;
} else {
  const agent = new HumanAgent({ workspace });
  process.on("SIGINT", () => agent.interrupt.abort());
  process.on("SIGTERM", () => agent.interrupt.abort());
  console.log(`工作区：${workspace}`);
  const status = await agent.run();
  if (agent.ears instanceof TextInput) agent.ears.close();
  process.exitCode = status === "ERROR" ? 1 : status === "INTERRUPTED" ? 130 : 0;
}
```

- [ ] **Step 4: Run tests + 手动启动验证**

Run: `pnpm vitest run tests/executor.test.ts && pnpm test && pnpm build` — Expected: 全绿（除 bridge 待迁移用例）+ 编译通过。

手动验证启动决议（非交互，直接在终端跑）：

```bash
pnpm dev -- --workspace ./no-such-dir-xyz   # 期望：启动失败：工作区不存在或不可访问：./no-such-dir-xyz；退出码 1
HUMAN_AGENT_WORKSPACE="$PWD" pnpm dev        # 期望：REPL 启动前打印「工作区：<repo 绝对路径>」（Ctrl+C 退出）
```

- [ ] **Step 5: Commit**

```bash
git add src/heart/executor.ts src/hands/terminal.ts src/heart/loop.ts src/brain/gemini-bridge-thinking.ts src/agent.ts bin/cli.ts tests/executor.test.ts
git commit -m "接入：执行一致性（execPath 传递、search_code 缺省钉工作区、terminal cwd）+ --workspace/HUMAN_AGENT_WORKSPACE 启动决议与横幅"
```

---

### Task 5: 信任候选档案（`src/nose/candidates.ts`）

**Files:**
- Create: `src/nose/candidates.ts`
- Test: `tests/candidates.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `normalizePath` / `toolMatches` / `keyMatches` / `normalizeEntryKey`。
- Produces:
  - `interface CandidateRecord { tool: string; key: string; denied: number; allowed: number; firstSeen: string; lastSeen: string }`
  - `interface CandidatesArchiveOptions { workspace: string; file?: string; now?: () => Date; maxEntries?: number; maxAgeDays?: number }`
  - `class CandidatesArchive`：`record(tool, key, verdict: "allowed" | "denied")`、`list(): CandidateRecord[]`、`removeCovered(entry: WhitelistEntry)`、`remove(items: readonly { tool: string; key: string }[])`、`static defaultFile(): string`

- [ ] **Step 1: Write the failing test**（`tests/candidates.test.ts` 新文件）

```typescript
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CandidatesArchive } from "../src/nose/candidates.js";

const dir = mkdtempSync(join(tmpdir(), "cand-test-"));
const file = join(dir, "candidates.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(file, { force: true }));

const WS = "/ws";

describe("CandidatesArchive", () => {
  it("聚合：同 (tool,key) 计数累加，firstSeen 保持 / lastSeen 更新", () => {
    let t = 0;
    const now = () => new Date(1_700_000_000_000 + (t += 1000));
    const a = new CandidatesArchive({ workspace: WS, file, now });
    a.record("write_file", "c:/ws/a.ts", "denied");
    a.record("write_file", "c:/ws/a.ts", "denied");
    a.record("write_file", "c:/ws/a.ts", "allowed");
    const list = a.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: "write_file", key: "c:/ws/a.ts", denied: 2, allowed: 1 });
    expect(list[0]!.firstSeen).not.toBe(list[0]!.lastSeen);
  });

  it("持久化 + 重载（按工作区分节，镜像 whitelist.json）", () => {
    const a = new CandidatesArchive({ workspace: WS, file });
    a.record("terminal", "ls -la", "denied");
    expect(new CandidatesArchive({ workspace: WS, file }).list()).toHaveLength(1);
    expect(new CandidatesArchive({ workspace: "/other", file }).list()).toHaveLength(0);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[]>;
    expect(Object.keys(raw)).toContain(WS);
  });

  it("容量帽：超 200 按 lastSeen 丢最旧", () => {
    let t = 0;
    const now = () => new Date(1_700_000_000_000 + (t += 1000));
    const a = new CandidatesArchive({ workspace: WS, file, now, maxEntries: 200 });
    for (let i = 0; i < 205; i++) a.record("terminal", `cmd-${String(i).padStart(3, "0")}`, "denied");
    const list = a.list();
    expect(list).toHaveLength(200);
    expect(list.some((r) => r.key === "cmd-000")).toBe(false);
    expect(list.some((r) => r.key === "cmd-204")).toBe(true);
  });

  it("容量帽：超 30 天按 lastSeen 清理", () => {
    const day = 24 * 60 * 60 * 1000;
    const base = 1_700_000_000_000;
    let t = 0;
    const a = new CandidatesArchive({ workspace: WS, file, now: () => new Date(base + (t += 1000)) });
    a.record("terminal", "old-cmd", "denied");
    t = 31 * day; // 模拟 31 天后
    a.record("terminal", "new-cmd", "denied");
    const keys = a.list().map((r) => r.key);
    expect(keys).toContain("new-cmd");
    expect(keys).not.toContain("old-cmd");
  });

  it("removeCovered：条目覆盖的候选核销（前缀 + 目录自覆盖 w/ 匹配 w）", () => {
    const a = new CandidatesArchive({ workspace: WS, file });
    a.record("read_file", "c:/ws/src/a.ts", "denied");
    a.record("read_dir", "c:/ws/src", "denied");
    a.record("terminal", "ls", "denied");
    a.removeCovered({ tool: "write_file", key: "c:/ws/src/", kind: "path" });
    expect(a.list().map((r) => `${r.tool}:${r.key}`)).toEqual(["terminal:ls"]);
  });

  it("remove：按 (tool,key) 精确清除", () => {
    const a = new CandidatesArchive({ workspace: WS, file });
    a.record("terminal", "ls", "denied");
    a.record("terminal", "pwd", "denied");
    a.remove([{ tool: "terminal", key: "ls" }]);
    expect(a.list().map((r) => r.key)).toEqual(["pwd"]);
  });

  it("损坏/不存在降级空白；垃圾记录过滤不崩溃", () => {
    writeFileSync(file, "{ not json", "utf8");
    expect(new CandidatesArchive({ workspace: WS, file }).list()).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        [WS]: [
          { tool: "x" },
          {
            tool: "terminal",
            key: "ls",
            denied: 1,
            allowed: 0,
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    expect(new CandidatesArchive({ workspace: WS, file }).list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/candidates.test.ts` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: Write minimal implementation**（`src/nose/candidates.ts` 新文件）

```typescript
// 信任候选档案：白名单外一切裁决的持久记录（按工作区分节，镜像 whitelist.json）。
// 聚合键 (tool, key)；容量帽 200 条 / 30 天（超限按 lastSeen 丢最旧）；损坏降级空白、落盘失败不崩溃。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WhitelistEntry } from "../types/index.js";
import { keyMatches, normalizeEntryKey, normalizePath, toolMatches } from "./policy.js";

export interface CandidateRecord {
  tool: string;
  key: string;
  denied: number;
  allowed: number;
  firstSeen: string;
  lastSeen: string;
}

export interface CandidatesArchiveOptions {
  /** 工作区（分节键；与 PermissionPolicy 的 workspace 同值） */
  workspace: string;
  /** 档案文件；缺省 ~/.human-agent/candidates.json */
  file?: string;
  /** 时间源注入（测试用）；缺省 new Date() */
  now?: () => Date;
  /** 条目上限；缺省 200 */
  maxEntries?: number;
  /** 保留天数；缺省 30 */
  maxAgeDays?: number;
}

export class CandidatesArchive {
  readonly #workspaceKey: string;
  readonly #file: string;
  readonly #now: () => Date;
  readonly #maxEntries: number;
  readonly #maxAgeDays: number;
  #sections: Record<string, CandidateRecord[]>;

  constructor(options: CandidatesArchiveOptions) {
    this.#workspaceKey = normalizePath(options.workspace);
    this.#file = options.file ?? CandidatesArchive.defaultFile();
    this.#now = options.now ?? (() => new Date());
    this.#maxEntries = options.maxEntries ?? 200;
    this.#maxAgeDays = options.maxAgeDays ?? 30;
    this.#sections = loadSections(this.#file);
  }

  /** 裁决入档：同 (tool, key) 聚合计数 + 更新 lastSeen；容量帽在写入时收紧。 */
  record(tool: string, key: string, verdict: "allowed" | "denied"): void {
    if (key === "") return;
    const now = this.#now().toISOString();
    const list = this.#section();
    const found = list.find((r) => r.tool === tool && r.key === key);
    if (found !== undefined) {
      if (verdict === "allowed") found.allowed += 1;
      else found.denied += 1;
      found.lastSeen = now;
    } else {
      list.push({
        tool,
        key,
        denied: verdict === "denied" ? 1 : 0,
        allowed: verdict === "allowed" ? 1 : 0,
        firstSeen: now,
        lastSeen: now,
      });
    }
    this.#prune();
    this.#save();
  }

  /** 当前工作区分节快照（插入序）。 */
  list(): CandidateRecord[] {
    return [...this.#section()];
  }

  /** 入库核销：白名单条目覆盖的候选移除（写条目覆盖写∪读；目录条目自覆盖）。 */
  removeCovered(entry: WhitelistEntry): void {
    const normalized: WhitelistEntry = { ...entry, key: normalizeEntryKey(entry) };
    const list = this.#section();
    const kept = list.filter(
      (r) => !(toolMatches(normalized.tool, r.tool) && keyMatches(normalized, r.key)),
    );
    if (kept.length !== list.length) {
      this.#sections[this.#workspaceKey] = kept;
      this.#save();
    }
  }

  /** 清除所选：按 (tool, key) 精确移除。 */
  remove(items: readonly { tool: string; key: string }[]): void {
    const list = this.#section();
    const kept = list.filter((r) => !items.some((i) => i.tool === r.tool && i.key === r.key));
    if (kept.length !== list.length) {
      this.#sections[this.#workspaceKey] = kept;
      this.#save();
    }
  }

  #section(): CandidateRecord[] {
    const existing = this.#sections[this.#workspaceKey];
    if (existing !== undefined) return existing;
    const fresh: CandidateRecord[] = [];
    this.#sections[this.#workspaceKey] = fresh;
    return fresh;
  }

  #prune(): void {
    const cutoff = this.#now().getTime() - this.#maxAgeDays * 24 * 60 * 60 * 1000;
    let list = this.#section().filter((r) => new Date(r.lastSeen).getTime() >= cutoff);
    if (list.length > this.#maxEntries) {
      list = [...list]
        .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))
        .slice(list.length - this.#maxEntries); // 保留 lastSeen 最新的 maxEntries 条
    }
    this.#sections[this.#workspaceKey] = list;
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, JSON.stringify(this.#sections, null, 2), "utf8");
    } catch {
      // 落盘失败不崩溃（内存记录仍生效）
    }
  }

  static defaultFile(): string {
    return join(homedir(), ".human-agent", "candidates.json");
  }
}

function isRecord(item: unknown): item is CandidateRecord {
  if (typeof item !== "object" || item === null) return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.tool === "string" &&
    typeof r.key === "string" &&
    typeof r.denied === "number" &&
    typeof r.allowed === "number" &&
    typeof r.firstSeen === "string" &&
    typeof r.lastSeen === "string"
  );
}

function loadSections(file: string): Record<string, CandidateRecord[]> {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const out: Record<string, CandidateRecord[]> = {};
      for (const [workspace, records] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(records)) continue;
        out[workspace] = records.filter(isRecord);
      }
      return out;
    }
  } catch {
    // 损坏/不存在 → 空档案
  }
  return {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/candidates.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/nose/candidates.ts tests/candidates.test.ts
git commit -m "新增：信任候选档案 CandidatesArchive（聚合计数/容量帽 200 条·30 天/按工作区分节持久化/入库核销）"
```

---

### Task 6: 桥集成（/info /candidates /whitelist /candidates/dismiss + 桥自记两钩子 + 校验扩读类）+ bridge 测试迁移

**Files:**
- Modify: `src/brain/gemini-bridge-thinking.ts`
- Modify: `src/agent.ts`（`candidatesFile` 穿透）
- Test: `tests/gemini-bridge-thinking.test.ts`（迁移 + 新增）

**Interfaces:**
- Consumes: Task 2（`dirEntryKey`/`isPathTool`/`keyMatches`/`normalizeEntryKey`/`WRITE_TOOLS`/`READ_TOOLS`）、Task 3（`this.workspace`/`this.keyFor`/`this.whitelistEntries`）、Task 5（`CandidatesArchive`）。
- Produces: `GeminiBridgeThinkingOptions.candidatesFile?: string`；`BridgeServiceOptions.candidatesFile?: string`；四个新端点。

- [ ] **Step 1: bridge 测试迁移 + 新增用例（先失败）**

对 `tests/gemini-bridge-thinking.test.ts` 做以下替换（其余用例不动）：

(a) 头部（第 9-17 行区域）追加临时工作区与键助手：

```typescript
const wsDir = mkdtempSync(join(tmpdir(), "bridge-ws-"));
const wsReal = realpathSync(wsDir);
const outDir = mkdtempSync(join(tmpdir(), "bridge-out-"));
const candFile = join(tmpDir, "candidates.json");
afterAll(() => {
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});
// beforeEach 行追加：rmSync(candFile, { force: true });
import { normalizeMatchKey } from "../src/nose/workspace-path.js";
const keyOf = (rel: string): string => normalizeMatchKey(join(wsReal, rel));
// 界外文件路径与键助手：父目录经 realpath（与桥管道「最深已存在祖先归实」严格同键，免受大小写差异干扰）
const outPath = (name: string): string => join(outDir, name);
const outKey = (name: string): string => normalizeMatchKey(join(realpathSync(outDir), name));
```

（`realpathSync` 并入既有 node:fs import。）
`seedWhitelist(workspace, entries)` 保持签名；调用处 `"/ws-test"` 一律改 `wsReal`。

(b) `makeBridge`：默认 workspace 改 `options.workspace ?? wsReal`；新增 `candidatesFile?: string` 选项并透传 `candidatesFile: options.candidatesFile ?? candFile`。

(b2) stub 器官更新（执行落点改绝对 execPath 后，旧的相对匹配失效）：
- `readFile` 里 `if (path === "bad.txt")` → `if (path.endsWith("bad.txt"))`（pipeline/batch 失败分支依赖它触发）。
- 「含工具调用的内容执行后回填结果消息」的 `expect(message).toContain("内容:a.txt")` → 改 `expect(message).toContain("内容:")` + `expect(message).toContain("a.txt")`（回显路径已为绝对）。

(c) 用例级替换：
- L263 `你的工作区是 /ws-test` → `你的工作区是 ${wsReal}`。
- L271、L611：`{ tool: "read_file", key: '{"path":"a.txt"}', kind: "exact" }` → `{ tool: "read_file", key: keyOf("a.txt"), kind: "path" }`。
- L290-293、L318-321、L350-353：`read_file` 条目同样改为 `keyOf("a.txt")` / `keyOf("bad.txt")` 的 path 条目；`terminal` exact 条目不变。
- L279：`expect(organs.calls).toEqual([{ name: "read_file", args: { path: "a.txt" } }])` → `args: { path: join(wsReal, "a.txt") }`。
- L346：同理 `path: join(wsReal, "bad.txt")`。
- L382/L391/L420/L433/L469/L480/L491/L544/L555：`workspace: "/ws-test"` 全部改默认（删除该行或改 `wsReal`）。
- L565-574 盘符根用例：`makeBridge({ workspace: "/ws" })` → `makeBridge({ workspace: wsReal })` + `write_file path: "c:/x.txt"` 不变（entry `"c:/"` 由根级守卫 400，跨平台成立）。
- L576-582 工作区用例：`makeBridge({ workspace: "/ws" })` → `makeBridge()`（默认 wsReal）且 `write_file path: "/ws/a.txt"` → `path: join(wsReal, "a.txt")`。
- L584-589 界外用例：`makeBridge({ workspace: "/ws" })` → `makeBridge()`；`path: "/tmp/evil.txt"` → `path: outPath("evil.txt")`。
- L635-652「全局中断丢弃批次」断言 `c.args.path === "b.txt"` → `join(wsReal, "b.txt")`。

(d) 新增用例（追加到 describe 尾部）：

```typescript
  it("GET /info 返回当前工作区；close 后 204", async () => {
    const { bridge, port } = await makeBridge();
    const res = await fetch(`http://127.0.0.1:${port}/info`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; workspace: string }).toEqual({
      ok: true,
      workspace: wsReal,
    });
    bridge.close();
    await new Promise((r) => setTimeout(r, 80));
    const closed = await fetch(`http://127.0.0.1:${port}/info`).catch(() => null);
    if (closed !== null) expect(closed.status).toBe(204);
  });

  it("桥自记：审批裁决入档（批内聚合计数；允许/拒绝同形），close 释放不入档", async () => {
    const { port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    const body = await getMessage(port);
    const id = (body as { id: number }).id;
    expect(await postApproval(port, id, [false])).toBe(200);
    await getMessageText(port);
    const sections = JSON.parse(readFileSync(candFile, "utf8")) as Record<string, Array<Record<string, unknown>>>;
    const list = Object.values(sections)[0]!;
    expect(list).toContainEqual(expect.objectContaining({ tool: "terminal", key: "echo hi", denied: 1, allowed: 0 }));
    // 再来一次允许：同条聚合
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    const body2 = await getMessage(port);
    expect(await postApproval(port, (body2 as { id: number }).id, [true])).toBe(200);
    await getMessageText(port);
    const list2 = Object.values(JSON.parse(readFileSync(candFile, "utf8")) as Record<string, Array<Record<string, unknown>>>)[0]!;
    expect(list2).toContainEqual(expect.objectContaining({ tool: "terminal", key: "echo hi", denied: 1, allowed: 1 }));
  });

  it("桥自记：600s 兜底超时 settle 全拒时入档 denied", async () => {
    const { port } = await makeBridge({ approvalTimeoutMs: 50 });
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    await getMessage(port);
    await getMessageText(port); // 超时拒绝行
    const list = Object.values(JSON.parse(readFileSync(candFile, "utf8")) as Record<string, Array<Record<string, unknown>>>)[0]!;
    expect(list).toContainEqual(expect.objectContaining({ tool: "terminal", key: "echo hi", denied: 1 }));
  });

  it("close 释放的挂起审批不入档（非用户裁决，属关闭噪音）", async () => {
    const { bridge, port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("terminal", { command: "echo hi" }));
    await getMessage(port);
    bridge.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(candFile)).toBe(false);
  });

  it("GET /candidates：滤除已被白名单覆盖的陈旧条目；close 后 204", async () => {
    const { bridge, port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("terminal", { command: "ls -la" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [true], [{ tool: "terminal", key: "ls -la", kind: "exact" }]);
    await getMessageText(port);
    const res = await fetch(`http://127.0.0.1:${port}/candidates`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; candidates: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.candidates).toEqual([]); // 入库核销后不可见
    bridge.close();
    await new Promise((r) => setTimeout(r, 80));
    const closed = await fetch(`http://127.0.0.1:${port}/candidates`).catch(() => null);
    if (closed !== null) expect(closed.status).toBe(204);
  });

  it("POST /whitelist：候选批量入库（全量原子）+ 核销；再跑同调用静默", async () => {
    const outside = outPath("cand-out.txt");
    const { port, organs } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("write_file", { path: outside, content: "x" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [false]); // 生成候选（拒绝）
    await getMessageText(port);
    const candKey = outKey("cand-out.txt");
    const res = await fetch(`http://127.0.0.1:${port}/whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ tool: "write_file", key: candKey, kind: "path" }] }),
    });
    expect(res.status).toBe(200);
    const raw = JSON.parse(readFileSync(tmpFile, "utf8")) as Record<string, WhitelistEntry[]>;
    expect(raw[normalizePath(wsReal)]).toContainEqual({ tool: "write_file", key: candKey, kind: "path" });
    // 核销：候选已滤除
    const after = (await (await fetch(`http://127.0.0.1:${port}/candidates`)).json()) as { candidates: unknown[] };
    expect(after.candidates).toEqual([]);
    // 再跑同调用：白名单静默执行
    await postReply(port, toolCall("write_file", { path: outside, content: "x" }));
    const message = await getMessageText(port);
    expect(message).toContain("成功");
    expect(organs.calls.some((c) => c.name === "write_file")).toBe(true);
  });

  it("POST /whitelist 全量原子：任一不合法 → 400 全部不落盘", async () => {
    const outside = outPath("atomic-out.txt");
    const { port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("write_file", { path: outside, content: "x" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [false]);
    await getMessageText(port);
    const good = { tool: "write_file", key: outKey("atomic-out.txt"), kind: "path" };
    const bad = { tool: "read_file", key: "c:/whatever", kind: "exact" }; // 读类 exact 不合法
    const res = await fetch(`http://127.0.0.1:${port}/whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [good, bad] }),
    });
    expect(res.status).toBe(400);
    const raw = readFileSync(tmpFile, "utf8");
    expect(raw).not.toContain("bridge-atomic-out");
    const still = (await (await fetch(`http://127.0.0.1:${port}/candidates`)).json()) as { candidates: unknown[] };
    expect(still.candidates).toHaveLength(1); // 核销未发生
  });

  it("POST /whitelist 目录粒度对应：候选文件条目 → 父目录 + \"/\" 条目入库（200）", async () => {
    const target = outPath(join("dir-cand", "file.txt"));
    const { port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("write_file", { path: target, content: "x" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [false]);
    await getMessageText(port);
    const dirKey = `${normalizeMatchKey(join(realpathSync(outDir), "dir-cand"))}/`;
    const res = await fetch(`http://127.0.0.1:${port}/whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ tool: "write_file", key: dirKey, kind: "path" }] }),
    });
    expect(res.status).toBe(200);
    const raw = JSON.parse(readFileSync(tmpFile, "utf8")) as Record<string, WhitelistEntry[]>;
    expect(raw[normalizePath(wsReal)]).toContainEqual({ tool: "write_file", key: dirKey, kind: "path" });
    const after = (await (await fetch(`http://127.0.0.1:${port}/candidates`)).json()) as { candidates: unknown[] };
    expect(after.candidates).toEqual([]); // 入库即核销
  });

  it("POST /candidates/dismiss：清除所选（不写白名单）", async () => {
    const outside = outPath("dismiss-out.txt");
    const { port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("write_file", { path: outside, content: "x" }));
    const body = await getMessage(port);
    await postApproval(port, (body as { id: number }).id, [false]);
    await getMessageText(port);
    const res = await fetch(`http://127.0.0.1:${port}/candidates/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ tool: "write_file", key: outKey("dismiss-out.txt") }] }),
    });
    expect(res.status).toBe(200);
    const after = (await (await fetch(`http://127.0.0.1:${port}/candidates`)).json()) as { candidates: unknown[] };
    expect(after.candidates).toEqual([]);
  });

  it("/approval 的 whitelist 校验接受读类 path 条目（文件粒度）", async () => {
    const outside = outPath("read-out.txt");
    const { port } = await makeBridge({ approvalTimeoutMs: 5000 });
    await postReply(port, toolCall("read_file", { path: outside }));
    const body = await getMessage(port);
    expect(body?.type).toBe("approval");
    const id = (body as { id: number }).id;
    const entry = { tool: "read_file", key: outKey("read-out.txt"), kind: "path" };
    expect(await postApproval(port, id, [true], [entry])).toBe(200);
    await getMessageText(port);
    const raw = JSON.parse(readFileSync(tmpFile, "utf8")) as Record<string, WhitelistEntry[]>;
    expect(raw[normalizePath(wsReal)]).toContainEqual(entry);
  });

  it("旧版 exact-JSON 读条目失效 → 重新按未信任处置（界外读下发审批，不自动迁移不崩溃）", async () => {
    const outside = outPath("legacy-out.txt");
    // 旧版匹配键形态：read_file 走参数 JSON 序列化（反斜杠转正斜杠）——新管道下必然不命中
    const legacyKey = JSON.stringify({ path: outside.replace(/\\/g, "/") });
    seedWhitelist(wsReal, [{ tool: "read_file", key: legacyKey, kind: "exact" }]);
    const { port } = await makeBridge();
    const res = await postReply(port, toolCall("read_file", { path: outside }));
    expect(res.processed).toBe(true);
    const body = await getMessage(port);
    expect(body?.type).toBe("approval"); // 旧条目不再静默放行；界外 → 审批
  });
```

（新增用例需要的 import：`existsSync, realpathSync`（并入 node:fs）、`normalizePath`（../src/nose/policy.js）、`normalizeMatchKey`（../src/nose/workspace-path.js）；`normalizeMatchKey` 用于 keyOf/outKey 助手。）

- [ ] **Step 2: Run test to verify fail**

Run: `pnpm vitest run tests/gemini-bridge-thinking.test.ts` — Expected: 新增用例 FAIL（404 / 无记录钩子），迁移后既有用例部分 PASS。

- [ ] **Step 3: 实现（`src/brain/gemini-bridge-thinking.ts`）**

(1) import 行 10 替换：

```typescript
import { dirEntryKey, isPathTool, keyMatches, normalizeEntryKey, toolMatches, WRITE_TOOLS, READ_TOOLS } from "../nose/policy.js";
import { CandidatesArchive, type CandidateRecord } from "../nose/candidates.js";
```

(2) `GeminiBridgeThinkingOptions` 增：

```typescript
  /** 信任候选档案文件；缺省 ~/.human-agent/candidates.json */
  candidatesFile?: string;
```

(3) 类字段增：`readonly #candidates: CandidatesArchive;`
构造器（super 后）增：

```typescript
    this.#candidates = new CandidatesArchive({
      workspace: this.workspace,
      ...(options.candidatesFile !== undefined ? { file: options.candidatesFile } : {}),
    });
```

(4) `#handleRequest` 增四个路由（`/protocol` 分支后）：

```typescript
    if (req.method === "GET" && url.pathname === "/info") {
      this.#handleInfoRequest(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/candidates") {
      this.#handleCandidatesRequest(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/whitelist") {
      this.#handleWhitelistAddRequest(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/candidates/dismiss") {
      this.#handleCandidatesDismissRequest(req, res);
      return;
    }
```

(5) 新增方法（插在 `#handleProtocolRequest` 之后）：

```typescript
  /** 当前工作区（无状态幂等）；服务已关闭时 204。 */
  #handleInfoRequest(res: http.ServerResponse): void {
    if (this.#closed) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, workspace: this.workspace }));
  }

  /** 信任候选列表：返回前滤除已被白名单覆盖的条目；服务已关闭时 204。 */
  #handleCandidatesRequest(res: http.ServerResponse): void {
    if (this.#closed) {
      res.writeHead(204).end();
      return;
    }
    const entries = this.whitelistEntries();
    const candidates = this.#candidates
      .list()
      .filter((r) => !entries.some((e) => toolMatches(e.tool, r.tool) && keyMatches(e, r.key)));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, candidates }));
  }

  /** 候选批量入库：全量校验 all-or-nothing（任一不合法 400 全部不落盘）；成功后入库 + 核销。 */
  #handleWhitelistAddRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readJsonBody(req).then(
      (body) => {
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        const raw = Array.isArray(record.entries) ? record.entries : null;
        if (raw === null || raw.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "entries 必须为非空数组" }));
          return;
        }
        const validated: WhitelistEntry[] = [];
        for (const item of raw) {
          const entry = this.#validateWhitelistAdd(item);
          if (entry === null) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "whitelist 条目不合法" }));
            return;
          }
          validated.push(entry);
        }
        for (const entry of validated) {
          void this.addWhitelistEntry(entry);
          this.#candidates.removeCovered(entry); // 入库即核销
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体必须为合法 JSON" }));
      },
    );
  }

  /** 清除所选候选（持久化删除，不写白名单）。 */
  #handleCandidatesDismissRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readJsonBody(req).then(
      (body) => {
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        const raw = Array.isArray(record.items) ? record.items : null;
        if (raw === null || raw.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "items 必须为非空数组" }));
          return;
        }
        const items: Array<{ tool: string; key: string }> = [];
        for (const item of raw) {
          if (typeof item !== "object" || item === null) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "items 条目不合法" }));
            return;
          }
          const r = item as Record<string, unknown>;
          if (typeof r.tool !== "string" || typeof r.key !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "items 条目不合法" }));
            return;
          }
          items.push({ tool: r.tool, key: r.key });
        }
        this.#candidates.remove(items);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体必须为合法 JSON" }));
      },
    );
  }

  /**
   * /whitelist 条目校验：形态合法 → 工具与粒度匹配（路径类限 path、其余限 exact）→ 归一 →
   * 根级目录条目拒绝 → 必须对应现存候选（文件 = 键相等；目录 = dirEntryKey 段级前缀对应）。
   */
  #validateWhitelistAdd(item: unknown): WhitelistEntry | null {
    if (typeof item !== "object" || item === null) return null;
    const w = item as Record<string, unknown>;
    if (typeof w.tool !== "string" || typeof w.key !== "string" || w.key === "") return null;
    if (w.kind !== "exact" && w.kind !== "path") return null;
    const pathTool = WRITE_TOOLS.has(w.tool) || READ_TOOLS.has(w.tool);
    if (w.kind === "exact" && pathTool) return null;
    if (w.kind === "path" && !pathTool) return null;
    const normalized: WhitelistEntry = {
      tool: w.tool,
      key: normalizeEntryKey({ tool: w.tool, key: w.key }),
      kind: w.kind,
    };
    if (w.kind === "path" && (normalized.key === "/" || /^[a-z]:\/$/i.test(normalized.key))) return null;
    const corresponds = this.#candidates
      .list()
      .some((r) => this.#entryCorresponds(normalized, r));
    return corresponds ? normalized : null;
  }

  /** 条目与候选的对应性：文件粒度 = 键相等；目录粒度 = dirEntryKey（段级前缀，含 read_dir 自身 + /）。 */
  #entryCorresponds(entry: WhitelistEntry, candidate: CandidateRecord): boolean {
    if (!toolMatches(entry.tool, candidate.tool)) return false;
    if (entry.kind === "exact") return entry.key === candidate.key;
    if (entry.key === candidate.key) return true;
    const dirKey = dirEntryKey(candidate.tool, candidate.key);
    return dirKey !== null && entry.key === dirKey;
  }
```

(6) `#handleApprovalRequest` 全文替换（原 358-395 行）：

```typescript
  /** 收扩展审批结果：校验 allowed 与 whitelist → 桥自记候选 → 白名单落盘+核销 → settle；未知 id → 404。 */
  #handleApprovalRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readJsonBody(req).then(
      (body) => {
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        const id = typeof record.id === "number" ? record.id : NaN;
        const entry = this.#approvals.get(id);
        if (entry === undefined) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "审批不存在或已过期" }));
          return;
        }
        const allowed = (Array.isArray(record.allowed) ? record.allowed : []).map((v) => v === true);
        if (allowed.length !== entry.calls.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "allowed 必须与调用数一致" }));
          return;
        }
        let whitelistEntries: unknown[] = [];
        if (record.whitelist !== undefined) {
          const raw = Array.isArray(record.whitelist) ? record.whitelist : null;
          if (raw === null || !this.#isValidWhitelist(raw, entry.calls, allowed)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "whitelist 条目不合法" }));
            return;
          }
          whitelistEntries = raw;
        }
        // 桥自记：裁决落地即入档（档位无关——人工、倒计时全拒、档位代答、600s 超时同形）；先记账后核销
        entry.calls.forEach((call, i) => {
          const key = this.keyFor(call);
          if (key !== undefined && key !== "") {
            this.#candidates.record(call.name, key, allowed[i] === true ? "allowed" : "denied");
          }
        });
        for (const w of whitelistEntries) {
          const whitelistEntry = w as WhitelistEntry;
          void this.addWhitelistEntry(whitelistEntry);
          this.#candidates.removeCovered(whitelistEntry); // 入库即核销
        }
        this.#approvals.delete(id);
        entry.settle({ allowed, timedOut: false });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体必须为合法 JSON" }));
      },
    );
  }
```

(7) `#isValidWhitelist` 全文替换：

```typescript
  /** 校验：每条目必须对应本批中 allowed=true 的调用（路径类限 path 文件/目录两粒度；非路径类限 exact）。 */
  #isValidWhitelist(raw: unknown[], calls: readonly ToolCall[], allowed: boolean[]): boolean {
    const allowedCalls = calls.filter((_, i) => allowed[i] === true);
    return raw.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const w = item as Record<string, unknown>;
      if (typeof w.tool !== "string" || typeof w.key !== "string") return false;
      if (w.kind !== "exact" && w.kind !== "path") return false;
      const entry: WhitelistEntry = { tool: w.tool, key: w.key, kind: w.kind };
      return allowedCalls.some((call) => {
        const key = this.keyFor(call);
        if (key === undefined || key === "") return false;
        if (!toolMatches(entry.tool, call.name)) return false;
        if (entry.kind === "exact") return !isPathTool(entry.tool) && entry.key === key;
        if (!isPathTool(call.name)) return false;
        const entryKey = normalizeEntryKey(entry);
        if (entryKey === key) return true; // 文件条目 = 调用路径自身 matchKey
        const dirKey = dirEntryKey(call.name, key);
        return dirKey !== null && entryKey === dirKey; // 目录条目（写/读文件 = 父目录 + /；读目录类 = 自身 + /）
      });
    });
  }
```

(8) `#requestApproval` 的超时钩子（335-337 行）替换：

```typescript
    const timer = setTimeout(() => {
      if (this.#approvals.delete(id)) {
        // 桥自记：兜底超时 settle 全拒时入档（覆盖扩展盲区）
        for (const call of calls) {
          const key = this.keyFor(call);
          if (key !== undefined && key !== "") this.#candidates.record(call.name, key, "denied");
        }
        settle({ allowed: calls.map(() => false), timedOut: true });
      }
    }, this.#approvalTimeoutMs);
```

(9) `src/agent.ts`：`BridgeServiceOptions` 增 `candidatesFile?: string` + 条件展开透传。

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/gemini-bridge-thinking.test.ts && pnpm test && pnpm build` — Expected: 全绿（全量）。

- [ ] **Step 5: Commit**

```bash
git add src/brain/gemini-bridge-thinking.ts src/agent.ts tests/gemini-bridge-thinking.test.ts
git commit -m "扩展：桥端点 /info /candidates /whitelist /candidates/dismiss + 桥自记候选两钩子（含 600s 超时/入库核销）+ 审批校验扩读类两粒度"
```

---

### Task 7: 扩展三档未信任处置 + 镜像集同步 + 工作区显示（content.js / background.js）

**Files:**
- Modify: `extensions/gemini-bridge/content.js`
- Modify: `extensions/gemini-bridge/background.js`

**Interfaces:**
- Consumes: 桥端点 `GET /info`（Task 6）。
- Produces: 设置键 `untrustedTier: "popup" | "deny" | "allow"`（替代 `autoApprove`）；`background.js` 消息 `get-info`（`{ workspace }`）；面板工作区行 `#ha-workspace`。

- [ ] **Step 1: 常量与设置默认值**

(a) 第 46 行 `autoApprove: false, ...` 注释行替换为：

```javascript
  untrustedTier: "popup", // 未信任调用处置：popup 默认弹窗 / deny 默认拒绝 / allow 默认允许（黑名单三档一致直接拒绝）
```

(b) `defaultSettings` 之后（约 50 行处）追加：

```javascript
const TIER_LABELS = { popup: "默认弹窗", deny: "默认拒绝", allow: "默认允许" };
// 工具分类镜像集（与服务端 policy.ts 的 WRITE_TOOLS/READ_TOOLS/DIR_TARGET_TOOLS 对齐；载荷键为近似值，落盘归一以桥为准）
const WRITE_TOOL_NAMES = new Set(["write_file", "apply_patch", "edit_file"]);
const READ_TOOL_NAMES = new Set(["read_file", "read_dir", "search_code"]);
const PATH_TOOL_NAMES = new Set([...WRITE_TOOL_NAMES, ...READ_TOOL_NAMES]);
const DIR_TARGET_TOOLS = new Set(["read_dir", "search_code"]);
function isPathToolName(name) {
  return PATH_TOOL_NAMES.has(name);
}
let bridgeWorkspace = ""; // 当前桥工作区（GET /info；仅显示与载荷近似归一用，不持久化）
```

- [ ] **Step 2: 面板 HTML（content.js 模板串）**

(a) 第 274-276 行（autoApprove label 行）替换为：

```html
<div class="ha-row">
  <span>未信任处置</span>
  <select id="ha-untrusted-tier" title="未信任（黑名单/白名单外）调用的去向；黑名单三档一致直接拒绝">
    <option value="popup">默认弹窗（逐条授权）</option>
    <option value="deny">默认拒绝（无人值守推荐）</option>
    <option value="allow">默认允许（仅黑名单拦截）</option>
  </select>
  <span id="ha-tier-warning" class="ha-tier-warning" hidden>⚠ 仅黑名单兜底</span>
</div>
```

(b) 「桥服务」行（315-318）后追加：

```html
<div class="ha-row">
  <span>工作区</span>
  <span id="ha-workspace" class="ha-value" title="">（未获取）</span>
</div>
```

(c) CSS（`</style>` 前）追加：

```css
.ha-tier-warning { color: #fbbf24; font-size: 12px; }
.ha-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
#ha-workspace { direction: rtl; }
```

（`direction: rtl` 让长路径省略头部保留尾部可读；若观感不符可换回 ltr——计划默认 rtl+尾部可读。）

- [ ] **Step 3: 设置读写与迁移**

(a) `applySettingsToPanel`（554-567）：第 565 行 `panel.querySelector("#ha-auto-approve").checked = settings.autoApprove;` 替换为：

```javascript
  panel.querySelector("#ha-untrusted-tier").value = settings.untrustedTier;
  panel.querySelector("#ha-tier-warning").hidden = settings.untrustedTier !== "allow";
```

(b) `setupPanelEvents`（653-658 的 auto-approve handler）替换为：

```javascript
  panel.querySelector("#ha-untrusted-tier").addEventListener("change", (e) => {
    settings.untrustedTier = ["popup", "deny", "allow"].includes(e.target.value) ? e.target.value : "popup";
    applySettingsToPanel();
    scheduleSaveSettings();
    log(`未信任处置：${TIER_LABELS[settings.untrustedTier]}`);
  });
```

(c) `init()` 迁移（1353 行 `autoApprove: ...` 行）替换为：

```javascript
      untrustedTier:
        saved.untrustedTier === "popup" || saved.untrustedTier === "deny" || saved.untrustedTier === "allow"
          ? saved.untrustedTier
          : typeof saved.autoApprove === "boolean"
            ? saved.autoApprove
              ? "allow"
              : "popup" // 一次性迁移：旧 autoApprove true→默认允许 / false→默认弹窗（行为不变）
            : defaultSettings.untrustedTier,
```

(d) `init()` 末尾 `log(...)` 之后追加 `void refreshWorkspace();`（桥未启动时静默失败，连接成功后由 noteBridgeSuccess 补拉）。
(e) `noteBridgeSuccess`（492-503）的 `bridgeDown` 复位块内追加 `void refreshWorkspace();`（幂等：已有值则直接返回）。

- [ ] **Step 4: 三档应答策略 + 工作区/镜像集**

(a) 新增 `refreshWorkspace`（放 `fetchProtocolText` 旁）：

```javascript
// 桥工作区（GET /info）：面板显示 + 载荷近似归一基准；已取得则不重复拉取
async function refreshWorkspace() {
  if (bridgeWorkspace !== "") return;
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "get-info", baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof resp?.workspace === "string" && resp.workspace !== "") {
    bridgeWorkspace = resp.workspace;
    const el = panel.querySelector("#ha-workspace");
    el.textContent = bridgeWorkspace;
    el.title = bridgeWorkspace;
  }
}
```

(b) `handleApproval`（899-917）全文替换：

```javascript
async function handleApproval(item) {
  if (settings.untrustedTier === "allow") {
    // 默认允许档：策略代答放行（桥不感知档位——同一回执通道）
    log(`默认允许档：放行 ${item.calls.length} 条未信任调用`);
    if (!(await postApproval({ id: item.id, allowed: item.calls.map(() => true) }))) setStatus("错误");
    log(`[信任候选] +${item.calls.length}（默认允许）`);
    return;
  }
  if (settings.untrustedTier === "deny") {
    // 默认拒绝档：策略代答拒绝（即时回决，无弹窗倒计时空耗）
    log(`默认拒绝档：拒绝 ${item.calls.length} 条未信任调用`);
    if (!(await postApproval({ id: item.id, allowed: item.calls.map(() => false) }))) setStatus("错误");
    log(`[信任候选] +${item.calls.length}（默认拒绝）`);
    return;
  }
  setStatus("等待授权");
  log(`收到审批请求（${item.calls.length} 条未信任调用），等待授权…`);
  const decision = await showApprovalDialog(item);
  const payload = { id: item.id, allowed: decision.allowed };
  const wl = decision.whitelist ?? [];
  if (wl.length > 0) payload.whitelist = wl;
  if (!(await postApproval(payload))) {
    setStatus("错误");
    log("审批结果提交失败——桥服务将在审批超时后按拒绝兜底");
    return;
  }
  setStatus("待命");
  log(`[信任候选] +${item.calls.length - wl.length}（默认弹窗）`);
}
```

(c) `showApprovalDialog`（922-1024）文案泛化 + 路径工具两粒度：
- 行模板：`<div class="ha-approval-hint">该命令可能删除或覆盖数据，请确认后授权</div>` 改为 `<div class="ha-approval-hint">${escapeHtml(approvalHint(call))}</div>`；标题 `危险命令授权` 改 `工具调用授权`。
- 新增函数（dialog 前）：

```javascript
// 审批提示语按调用类别泛化（读类不再套用写类文案）
function approvalHint(call) {
  if (WRITE_TOOL_NAMES.has(call.name)) return "该操作可能写入或覆盖文件，请确认后授权";
  if (READ_TOOL_NAMES.has(call.name)) return "该操作将读取工作区外的文件，请确认后授权";
  if (call.name === "terminal") return "该命令可能修改系统或数据，请确认后授权";
  return "该操作将访问外部网页，请确认后授权";
}
```

- 白名单按钮段（976-1001）替换：

```javascript
    // 每行追加白名单按钮：路径类两粒度 [白名单(此路径)] [白名单(此目录)]；其余 [白名单]（exact）
    [...box.querySelectorAll(".ha-approval-row")].forEach((row, index) => {
      const call = item.calls[index];
      const rowActions = row.querySelector(".ha-approval-btns");
      const pathTool = isPathToolName(call.name);
      const wlBtn = document.createElement("button");
      wlBtn.textContent = pathTool ? "白名单(此路径)" : "白名单";
      wlBtn.className = "ha-btn ha-btn-wl";
      wlBtn.onclick = () => {
        decisions[index] = true; // 白名单即允许
        whitelist[index] = buildEntry(call, pathTool ? "path" : "exact");
        refreshRow(row, index);
      };
      if (pathTool) {
        const dirBtn = document.createElement("button");
        dirBtn.textContent = "白名单(此目录)";
        dirBtn.className = "ha-btn ha-btn-wl";
        dirBtn.onclick = () => {
          decisions[index] = true;
          whitelist[index] = buildEntry(call, "dir");
          refreshRow(row, index);
        };
        rowActions.appendChild(dirBtn);
      }
      rowActions.appendChild(wlBtn);
    });
```

(d) `normalizeKey`（839-876）全文替换 + 新增 `resolveSegments`（放其前）：

```javascript
function resolveSegments(p) {
  const isAbs = p.startsWith("/");
  const isDrive = /^[a-z]:\//i.test(p);
  const out = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length > (isDrive ? 1 : 0)) out.pop();
      continue;
    }
    out.push(s);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

// 载荷键近似归一：写类补 edit_file、读类进路径维度；相对形态以桥工作区（GET /info）为基准。
// 仅作展示/近似用——落盘归一与对应性校验以桥侧管道为准（§3 归一职责上收）。
function normalizeKey(call, granularity) {
  const args = call.arguments ?? {};
  let target = null;
  if (PATH_TOOL_NAMES.has(call.name)) {
    if (call.name === "search_code") {
      target = typeof args.dir === "string" && args.dir.trim() !== "" ? args.dir : ".";
    } else {
      target = typeof args.path === "string" && args.path.trim() !== "" ? args.path : null;
    }
  }
  if (target !== null) {
    const p = String(target).trim().replace(/\s+/g, " ").replace(/\\/g, "/").replace(/\/+/g, "/");
    const base = bridgeWorkspace.replace(/\\/g, "/").replace(/\/+$/, "");
    const isAbs = p.startsWith("/");
    const isDrive = /^[a-z]:\//i.test(p);
    const joined = !isAbs && !isDrive && base !== "" ? resolveSegments(`${base}/${p}`) : resolveSegments(p);
    const lower = /^win/i.test(navigator.platform) ? joined.toLowerCase() : joined;
    if (granularity === "dir") {
      const root = lower === "/" || /^[a-z]:\/$/.test(lower);
      if (root) return { key: lower, kind: "path" }; // 根级/盘符根：降级文件条目
      if (DIR_TARGET_TOOLS.has(call.name)) return { key: `${lower}/`, kind: "path" };
      const i = lower.lastIndexOf("/");
      if (i <= 0 || (i === 2 && lower[1] === ":")) return { key: lower, kind: "path" };
      return { key: `${lower.slice(0, i)}/`, kind: "path" };
    }
    return { key: lower, kind: "path" };
  }
  if (call.name === "terminal") {
    return {
      key: String(args.command ?? "").trim().replace(/\s+/g, " ").replace(/\\/g, "/"),
      kind: "exact",
    };
  }
  return { key: JSON.stringify(deepNorm(args)), kind: "exact" };
}
```

- [ ] **Step 5: background.js 增 `get-info` 中继**

在 `get-protocol` 分支后追加（同模式）：

```javascript
      if (message.type === "get-info") {
        let res;
        try {
          res = await fetch(`${base}/info`, {
            signal: AbortSignal.timeout(GET_PROTOCOL_TIMEOUT_MS),
            cache: "no-store",
          });
        } catch (err) {
          sendResponse({
            error:
              err?.name === "TimeoutError" || err?.name === "AbortError"
                ? "GET /info 超时"
                : err instanceof Error
                  ? err.message
                  : String(err),
          });
          return;
        }
        if (res.status === 204) {
          sendResponse({ error: "桥服务正在关闭" });
          return;
        }
        if (!res.ok) {
          sendResponse({ status: res.status, error: `GET /info → HTTP ${res.status}` });
          return;
        }
        let workspace = "";
        try {
          const data = await res.json();
          workspace = typeof data?.workspace === "string" ? data.workspace : "";
        } catch {
          // 响应体非 JSON 按空处理
        }
        sendResponse({ workspace });
        return;
      }
```

- [ ] **Step 6: 手动 E2E（用户执行；扩展无测试框架）**

1. 重启桥服务（改过服务端代码）→ `chrome://extensions` 刷新扩展 → 刷新 AI Studio 页面。
2. **迁移映射**：在**扩展的 Service Worker 控制台**写入旧键（页面 DevTools 控制台访问不到 `chrome.storage`）——`chrome://extensions` → gemini-bridge 卡片点「Service Worker」打开控制台，执行 `chrome.storage.sync.set({ geminiBridgeSettings: { autoApprove: false } })` → 刷新 AI Studio 页面 → 选择器应显示「默认弹窗」；改存 `chrome.storage.sync.set({ geminiBridgeSettings: { autoApprove: true } })` → 刷新 → 显示「默认允许」+ 黄色警示「⚠ 仅黑名单兜底」。
3. **工作区显示**：面板「工作区」行显示桥启动横幅里的同一路径；桥未启动时显示「（未获取）」，桥连接成功后自动补上。
4. **默认弹窗**：让模型写界外文件 → 弹窗标题「工具调用授权」+ 写类提示语；读界外文件 → 读类提示语 + 两粒度按钮；写类同样两粒度；`edit_file` 也有两粒度；terminal/抓网页只有单「白名单」按钮。点「白名单(此目录)」→ 后续同目录调用静默。
5. **默认拒绝**：切三态到默认拒绝 → 发界外调用 → 面板日志「默认拒绝档：拒绝 N 条」→ 网页收到「用户未授权，未执行」回填；无弹窗。
6. **默认允许**：切到默认允许 → 界外调用直接执行；`rm -rf /` 仍被黑名单硬拒；警示常显。
7. **相对落点**：让模型 `write_file` 相对路径 `tmp-e2e.txt` → 文件出现在桥工作区目录（不是浏览器无关路径）；terminal `pwd` 输出为工作区。

- [ ] **Step 7: Commit**

```bash
git add extensions/gemini-bridge/content.js extensions/gemini-bridge/background.js
git commit -m "扩展：三档未信任处置选择器（默认弹窗/默认拒绝/默认允许 + autoApprove 迁移 + 允许档警示）+ 镜像集补 edit_file/读类 + 弹窗文案泛化 + 工作区显示（GET /info）"
```

---

### Task 8: 扩展信任候选面板（content.js / background.js）

**Files:**
- Modify: `extensions/gemini-bridge/content.js`
- Modify: `extensions/gemini-bridge/background.js`

**Interfaces:**
- Consumes: 桥端点 `GET /candidates`、`POST /whitelist`、`POST /candidates/dismiss`（Task 6）。
- Produces: `background.js` 消息 `get-candidates`（`{ candidates }`）、`whitelist-add`（`{ ok }`）、`candidates-dismiss`（`{ ok }`）；面板折叠区（`#ha-cand-toggle`/`#ha-cand-count`/`#ha-cand-body`/`#ha-cand-all`/`#ha-cand-gran`/`#ha-cand-add`/`#ha-cand-dismiss`/`#ha-cand-list`）。

- [ ] **Step 1: 面板 HTML + CSS**

(a) 「填入规则文本」按钮（319 行）后插入：

```html
<div class="ha-cand">
  <button id="ha-cand-toggle" class="ha-cand-head" title="白名单外裁决的持久记录：默认拒绝档=补种清单，默认允许档=放行审计">
    信任候选 <span id="ha-cand-count">(0)</span><span class="ha-cand-arrow">▸</span>
  </button>
  <div class="ha-cand-body" id="ha-cand-body" hidden>
    <div class="ha-cand-ops">
      <button id="ha-cand-all">全选</button>
      <span>粒度</span>
      <select id="ha-cand-gran" title="仅作用于路径类行；terminal/抓网页行恒 exact">
        <option value="file">文件</option>
        <option value="dir">目录</option>
      </select>
      <button id="ha-cand-add">入库所选 (0)</button>
      <button id="ha-cand-dismiss">清除所选</button>
    </div>
    <div class="ha-cand-list" id="ha-cand-list"></div>
  </div>
</div>
```

(b) CSS 追加：

```css
.ha-cand { border: 1px solid #374151; border-radius: 6px; margin-top: 6px; }
.ha-cand-head { display: flex; width: 100%; align-items: center; gap: 6px; background: none; border: none; color: #e8e8e8; font: inherit; padding: 5px 8px; cursor: pointer; }
.ha-cand-count { color: #9ca3af; }
.ha-cand-arrow { margin-left: auto; }
.ha-cand-ops { display: flex; align-items: center; gap: 6px; padding: 4px 8px; flex-wrap: wrap; }
.ha-cand-list { max-height: 140px; overflow-y: auto; padding: 0 8px 6px; }
.ha-cand-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; font-size: 12px; }
.ha-cand-tool { color: #93c5fd; flex: none; }
.ha-cand-key { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ha-cand-counts { color: #9ca3af; flex: none; }
```

- [ ] **Step 2: 候选区逻辑**

（放在 `handleApproval` 附近）新增：

```javascript
let candRows = []; // 最近一次拉取的候选列表

function buildCandidateEntry(tool, key, gran) {
  if (!PATH_TOOL_NAMES.has(tool)) return { tool, key, kind: "exact" };
  if (gran !== "dir") return { tool, key, kind: "path" };
  const dirKey = approximateDirKey(tool, key);
  return { tool, key: dirKey ?? key, kind: "path" };
}

// 「此目录」近似键（与服务端 dirEntryKey 同规则；桥侧复核，失败即 400）
function approximateDirKey(tool, key) {
  if (key === "" || key === "/" || /^[a-z]:\/$/i.test(key)) return null;
  if (DIR_TARGET_TOOLS.has(tool)) return `${key}/`;
  const i = key.lastIndexOf("/");
  if (i <= 0 || (i === 2 && key[1] === ":")) return null;
  return `${key.slice(0, i)}/`;
}

function checkedCandidateRows() {
  return [...panel.querySelectorAll("#ha-cand-list input[type=checkbox]:checked")].map((el) => ({
    tool: el.dataset.tool,
    key: el.dataset.key,
  }));
}

function updateAddButton() {
  const n = checkedCandidateRows().length;
  panel.querySelector("#ha-cand-add").textContent = `入库所选 (${n})`;
}

function renderCandidates(list) {
  candRows = list;
  panel.querySelector("#ha-cand-count").textContent = `(${list.length})`;
  const host = panel.querySelector("#ha-cand-list");
  host.textContent = "";
  for (const c of list) {
    const row = document.createElement("label");
    row.className = "ha-cand-row";
    row.title = `${c.tool} ${c.key}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.tool = c.tool;
    input.dataset.key = c.key;
    input.addEventListener("change", updateAddButton);
    const tool = document.createElement("span");
    tool.className = "ha-cand-tool";
    tool.textContent = c.tool;
    const key = document.createElement("span");
    key.className = "ha-cand-key";
    key.textContent = c.key;
    const counts = document.createElement("span");
    counts.className = "ha-cand-counts";
    counts.textContent = `拒 ${c.denied} / 放 ${c.allowed}`;
    row.append(input, tool, key, counts);
    host.appendChild(row);
  }
  updateAddButton();
}

// 拉取方语义：展开时 + 操作后拉取；桥不推送（未展开时也顺带更新计数徽标）
async function refreshCandidates() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "get-candidates", baseUrl: settings.baseUrl });
  } catch (err) {
    resp = { error: err instanceof Error ? err.message : String(err) };
  }
  if (Array.isArray(resp?.candidates)) {
    renderCandidates(resp.candidates);
  } else if (resp?.error) {
    log(`信任候选拉取失败：${resp.error}`);
  }
}
```

- [ ] **Step 3: 事件接线（setupPanelEvents 内追加）**

```javascript
  panel.querySelector("#ha-cand-toggle").addEventListener("click", () => {
    const body = panel.querySelector("#ha-cand-body");
    body.hidden = !body.hidden;
    panel.querySelector(".ha-cand-arrow").textContent = body.hidden ? "▸" : "▾";
    if (!body.hidden) void refreshCandidates(); // 展开时刷新
  });
  panel.querySelector("#ha-cand-all").addEventListener("click", () => {
    const boxes = [...panel.querySelectorAll("#ha-cand-list input[type=checkbox]")];
    const target = boxes.some((b) => !b.checked);
    for (const b of boxes) b.checked = target;
    updateAddButton();
  });
  panel.querySelector("#ha-cand-add").addEventListener("click", async () => {
    const rows = checkedCandidateRows();
    if (rows.length === 0) {
      log("信任候选：未选择任何行");
      return;
    }
    const gran = panel.querySelector("#ha-cand-gran").value;
    const entries = rows.map((r) => buildCandidateEntry(r.tool, r.key, gran));
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "whitelist-add", entries, baseUrl: settings.baseUrl });
    } catch (err) {
      resp = { error: err instanceof Error ? err.message : String(err) };
    }
    if (resp?.ok === true) {
      log(`信任候选：入库 ${entries.length} 条（${gran === "dir" ? "目录" : "文件"}粒度）`);
      void refreshCandidates();
    } else {
      log(`信任候选入库失败：${resp?.error ?? "未知错误"}（条目须对应现存候选，桥侧已拒绝）`);
    }
  });
  panel.querySelector("#ha-cand-dismiss").addEventListener("click", async () => {
    const items = checkedCandidateRows();
    if (items.length === 0) {
      log("信任候选：未选择任何行");
      return;
    }
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "candidates-dismiss", items, baseUrl: settings.baseUrl });
    } catch (err) {
      resp = { error: err instanceof Error ? err.message : String(err) };
    }
    if (resp?.ok === true) {
      log(`信任候选：清除 ${items.length} 条`);
      void refreshCandidates();
    } else {
      log(`信任候选清除失败：${resp?.error ?? "未知错误"}`);
    }
  });
```

同步：`handleApproval` 三个分支的 `[信任候选] +N` 日志后追加 `void refreshCandidates();`（徽标随裁决更新）。

- [ ] **Step 4: background.js 三个中继**

按 `get-protocol` 模式追加 `get-candidates`（GET，解析 `data?.candidates` 数组，`sendResponse({ candidates })`）、`whitelist-add`（POST `/whitelist` body `{ entries }`，非 2xx 答 `{ ok:false, status, error }`，2xx 答 `{ ok:true }`）、`candidates-dismiss`（POST `/candidates/dismiss` body `{ items }`，同形）。三个都用 `POST_RESULT_TIMEOUT_MS` 超时（GET 用 `GET_PROTOCOL_TIMEOUT_MS`）。具体代码按既有分支逐字仿写（`approve` 分支是最贴近的模板）。

- [ ] **Step 5: 手动 E2E（用户执行）**

1. 扩刷新 + 页面刷新。默认拒绝档下发一条界外写 → 面板日志出现 `[信任候选] +1（默认拒绝）`；展开「信任候选 (1)」→ 行显示 `write_file / <绝对键> / 拒 1 / 放 0`（单行省略号，悬停全量）。
2. 勾选该行 + 粒度[文件] → 按钮变「入库所选 (1)」→ 点入库 → 日志「入库 N 条」→ 行消失（核销）；再发同调用 → 静默执行（白名单生效）。
3. 多行多选 + 粒度[目录] → 入库；对写文件候选选目录粒度 → 入库后同目录其它文件调用静默。
4. [全选] / [清除所选]：清除的行不再出现在区里（持久化删除），且不写白名单（再跑原调用仍走弹窗/拒绝档）。
5. 弹窗档：放行/拒绝各一条 → 候选 `拒 a / 放 b` 计数累加；带白名单入库的条目不留在候选（核销）。
6. 区体固定约 140px、超高滚动、行内无按钮、面板宽度不被撑变形。
7. 旧版桥（无 /candidates）：日志「信任候选拉取失败：GET /candidates → HTTP 404」，面板其余功能正常。

- [ ] **Step 6: Commit**

```bash
git add extensions/gemini-bridge/content.js extensions/gemini-bridge/background.js
git commit -m "扩展：信任候选面板（折叠区/单选多选/文件·目录粒度/入库核销/清除所选 + 固定高滚动单行省略）"
```

---

### Task 9: 文档对齐（CLAUDE.md + 扩展 README）

**Files:**
- Modify: `CLAUDE.md`
- Modify: `extensions/gemini-bridge/README.md`

- [ ] **Step 1: CLAUDE.md**

(a) 「不可违反的设计原则」第 1 条全文替换：

```markdown
1. **动静绝对分离**：眼睛只读、无副作用；双手是破坏性操作必须受控；**一切工具调用**（含读取）经统一权限模型裁决——黑名单（确定性系统破坏）直接拒绝、白名单（用户信任）静默执行、未列入的按宿主档位处置（CLI 恒弹窗三选；桥扩展三档：默认弹窗/默认拒绝/默认允许）。读类进路径级信任维度（read_file/read_dir/search_code），方向为**写信任蕴含读**；审批通过可加入白名单（路径两粒度：此路径/此目录）。
```

(b) 「命令与依赖」段后追加说明：

```markdown
工作区经三级决议：`--workspace <path>` > `HUMAN_AGENT_WORKSPACE` > 启动 CWD；启动时 realpath 规范化且必须为已存在目录（否则友好报错 exit 1）；一进程一工作区不可变（切换=重启）。注意 `pnpm dev -- --workspace X`（`--` 透传）因为 pnpm 自身也识别 `--workspace`。
```

(c) 阶段六段落的 policy 描述更新（要点替换进现有条目）：`src/nose/policy.ts` 匹配键改「规范匹配键管道」（workspace 基准 resolve → realpath 深度归实 → win32 小写；失败按未信任绝不回退词法）；`addEntry` 条目归一（`normalizeEntryKey` 保留目录尾 /）与目录条目自覆盖；`WRITE_TOOLS`/`READ_TOOLS` 从 policy 导出为单一来源。新增 `src/nose/workspace-path.ts`（管道 + 启动决议）、`src/nose/candidates.ts`（信任候选档案）。
(d) 阶段五桥服务条目追加：新增端点 `GET /info`（当前工作区）、`GET /candidates`（滤除已覆盖）、`POST /whitelist`（候选批量入库，全量原子 + 核销）、`POST /candidates/dismiss`；桥自记候选两钩子（审批回执落地 / 600s 超时 settle）；`/approval` whitelist 校验扩读类两粒度。
(e) 架构核心段落：nose 行补 `workspace-path.ts`/`candidates.ts`；heart 行 `executor.ts` 补「执行落点 = 判定落点（execPath 传递）」；hands 行 Terminal 补 cwd 钉工作区。

- [ ] **Step 2: 扩展 README.md**

(a) 「权限模型」一节替换为（保留黑名单/工作区小节，重写模式表与增补）：

```markdown
## 权限模型

所有工具调用一律走服务端统一黑白名单裁决（`PermissionPolicy`），扩展只呈现审批交互：

| 档位（未信任调用去向） | 裁决 |
|---|---|
| **默认弹窗**（默认） | 黑名单直接拒绝（不下发审批）→ 白名单命中静默执行 → 其余下发弹窗逐条人工授权（路径两粒度：此路径/此目录） |
| **默认拒绝** | 未信任一律拒绝（桥标准拒绝文案回填），适合无人值守；黑名单不命中即回「拒绝」 |
| **默认允许** | 未信任一律放行，仅黑名单兜底（放弃边界，面板常显警示） |

- **黑名单**：内置随软件版本（`src/nose/blacklist.ts`），只拦确定性系统破坏操作；写类写系统目录两条形态（System32/Boot 子树、System Volume Information）**仅写类工具命中**——读 System32 不硬拒，走信任门禁。命中直接拒绝回填，不下发审批。
- **白名单**：`~/.human-agent/whitelist.json`，按工作区绝对路径分节；条目 `{ tool, key, kind }`——`exact` 整串（terminal/抓网页）；`path` 路径键（**写类与读类都进路径维度**），目录条目以 `/` 结尾段级前缀覆盖子树（含覆盖条目自身——`w/` 匹配 `w`）。**写信任蕴含读**：写条目同时覆盖读类调用；读条目不覆盖写。
- **规范匹配键管道**：路径类参数一律以工作区为基准 `resolve` → realpath 深度归实（junction/symlink 别名收敛）→ win32 小写（`matchKey`）。相对路径写入落在工作区内（判界内、静默），相对穿越到系统目录会被归实后命中黑名单；realpath 失败按未信任处置。执行落点 = 判定落点（执行用 realpath 后的 `execPath`；terminal cwd 钉工作区）。
- **工作区**：`--workspace` > `HUMAN_AGENT_WORKSPACE` > 启动 CWD；启动 realpath 规范化、必须已存在；一进程一工作区。面板「工作区」行显示当前值（`GET /info`）。
- **信任候选**：白名单外一切裁决由**桥自记**（`~/.human-agent/candidates.json`，按工作区分节，聚合 `(tool, key)` 计数，容量帽 200 条/30 天）。面板折叠区「信任候选 (N)」单选/多选一键入库（文件/目录粒度），入库即核销；也可「清除所选」。默认拒绝档 = 补种清单；默认允许档 = 放行审计。黑名单命中、白名单命中、close 释放不入档。
```

(b) 「面板设置」表：`自动授权危险命令` 行替换为 `未信任处置（三态选择器）` 行（默认弹窗/默认拒绝/默认允许三值说明 + 默认允许档常显 ⚠ 警示 + 旧 autoApprove 设置一次性迁移说明）；表后交互段补「信任候选」折叠区描述与「工作区」行。
(c) 「排查」表追加三行：`旧白名单条目失效（升级后同调用重新弹窗/被拒）` → 新管道下相对/词法旧条目不再命中，属安全向设计，重新入库即可；`信任候选区拉取失败 404` → 旧版桥服务无 /candidates，重启桥服务；`工作区行显示（未获取）` → 桥未连接，连接成功后自动补拉。
(d) 前置条件/使用步骤不动（GET /protocol 等现状不变）。

- [ ] **Step 3: 验证 + 提交**

Run: `pnpm test && pnpm build` — Expected: 全绿 + 编译通过（文档任务兜底回归）。

```bash
git add CLAUDE.md extensions/gemini-bridge/README.md
git commit -m "文档：CLAUDE.md 与扩展 README 对齐工作区一等化、规范匹配键管道、读类信任与三档/信任候选"
```

---

## 收尾回归（全部任务完成后）

- [ ] `pnpm test`：全量绿（预计 ~290+ 用例）。
- [ ] `pnpm build`：tsc 全绿。
- [ ] `grep -rn "autoApprove" extensions/gemini-bridge/`：仅剩 init 迁移分支中的旧键读取（应无其他引用）。
- [ ] `grep -rn "matchKeyFor(call)" src/`：零命中（全部带 workspace 实参）。
- [ ] 桥真实 E2E 一轮：`HUMAN_AGENT_WORKSPACE=<临时目录> GEMINI_BRIDGE_PORT=8765 pnpm dev` + 扩展三档各跑一遍（Task 7/8 手动清单）。
- [ ] 用户审阅期遗留：向用户提出 spec 的一行细化（读目录类「此目录」= 自身 + /），获批后（或按已实现）补进 spec 注记。
