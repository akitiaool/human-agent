# 黑白名单统一权限模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 黑白名单统一裁决矩阵 + 通用 Thinking 基类 + 工作区绑定，覆盖桥模式与 CLI 模式全部工具调用。

**Architecture:** 新增 `PermissionPolicy`（黑名单正则 + 白名单文件化匹配/冗余清理）与 `BaseThinking` 基类（持有 Reflection+Policy+workspace，`reflect` 成为唯一裁决入口）；桥服务与 OllamaThinking 继承 BaseThinking；审批协议扩展白名单字段；CLI loop 用嘴巴三选处理「需授权」。

**Tech Stack:** TypeScript（strict, NodeNext ESM）、vitest 4（TDD）、Node ≥20（`node:fs`/`node:path`/`node:os`，白名单文件用同步读写——启动期小文件，保持构造函数同步）。

**Spec:** `docs/superpowers/specs/2026-08-20-permission-model-design.md`

## Global Constraints

- **TS strict，严禁 `any`**；未知结构用 `unknown` + 类型守卫（项目编码规范）。
- **ESM**：相对导入必须带 `.js` 扩展名（NodeNext）。
- **TDD**：每个任务先写失败测试 → 确认 RED → 实现 → GREEN → `pnpm build` 干净 → commit。
- **commit 不署名**：禁止 "Co-Authored-By" 等任何署名/生成标记（用户级规范）。
- 工具名一律 snake_case（`write_file`/`apply_patch`/`terminal`/`read_file`/`read_dir`/`search_code`/`fetch_page`）。
- 器官类可实例化、无单例/全局状态、构造注入（测试友好）。
- 执行器 `executeTool`（src/heart/executor.ts）不改动。
- `pnpm test` = vitest 全量；单文件跑 `pnpm exec vitest run <file>`；`pnpm build` = tsc 到 dist/。
- **测试严禁触碰真实用户文件**：任何 `PermissionPolicy`/`BaseThinking`/桥构造都必须注入 `whitelistFile`（临时目录）与 `workspace`（测试工作区）；缺省会写 `~/.human-agent/whitelist.json` 并注册真实 CWD 工作区条目（污染用户白名单）。
- 已核实的现状（实现时勿与以下假设冲突）：
  - `tests/helpers.ts`：`ScriptedBrain`（infer 脚本 + 可注入 `reflectVerdict`）、`buildStubMouth(approve)`（仅 `confirm`）、`buildStubNose(risk)`、`inputFrom`、`FakeEars`、`buildEyes`、`buildHands`。
  - `tests/gemini-bridge-thinking.test.ts` helper：`makeBridge(options)`（现传 `nose`）、`getMessage(port)`（返回 body|null）、`getMessageText(port)`、`postApproval(port, id, allowed)`、`postReply(port, reply)`、`toolCall(name, args)`；`makeRecordingOrgans`。
  - `tests/loop.test.ts`：`makeLoop` + 8 处内联 `new AgentLoop`；3 个内联 Brain 类（`AbortableBrain`/`TimeoutThenAnswerBrain`/`ReflectBoomBrain`）。
  - `src/brain/gemini-bridge-thinking.ts`：#process 现含预筛 + 审批 + reflect 三段；`#requestApproval` 返回 `{id, promise, cancel}`；`#approvals = Map<number, {settle, count}>`；`ApprovalDecision = { allowed: boolean[]; timedOut: boolean }`；序列化 helper `serializeResultLine`/`serializeBlockedLine`/`serializeFeedback` 不动。
  - `src/heart/loop.ts`：`#execute(calls, turnSignal)` 现为 allowed 段 + blocked 段；`#finish`/`#emit`/`#turnTimedOut`/`#signal`/`#output`/`#brain`/`#context`/`#eyes`/`#hands` 均已存在。
  - CLI 模式（Ollama）**当前没有任何 system 消息**（bin/cli.ts、loop.ts 均无）；工作区声明由 `HumanAgent.run()` 注入 system 消息。
  - `src/brain/knowledge.ts` 导出 `schemas`、`TOOLS`、`serializeToolProtocol()`（文本以「【human-agent 工具协议】」开头）。

**相对 spec 的两处实现澄清（本计划为准）：**

1. **reflect 裁决顺序**：`黑名单 → 未知工具/参数非法 → 白名单 → 需授权`（spec §8 写的是白名单在结构校验前）。理由：非法参数调用若落入「需授权」，用户一旦批准会带着坏参数执行（executeTool 不重复校验）。结构校验必须先于白名单。
2. **工作区条目注册一条**（`{tool:"write_file", key: workspace+"/", kind:"path"}`）：spec §4 的 path 条目跨工具生效（write_file/apply_patch 共用），注册两条同 key 条目与「白名单最小」冲突；一条即覆盖两个写类工具。

---

### Task 1: 黑名单规则集 + PermissionPolicy 匹配/分类

**Files:**
- Create: `src/nose/blacklist.ts`
- Create: `src/nose/policy.ts`
- Modify: `src/types/organ.ts`（新增 `WhitelistEntry`）
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `ToolCall`（src/brain/llm.ts）；`WhitelistEntry`（本任务在 types/organ.ts 定义）。
- Produces: `BLACKLIST_PATTERNS: readonly RegExp[]`；`Classification = "blacklist" | "whitelist" | "unlisted"`；`normalizePath`/`normalizeCommand`/`serializeArgs`/`matchKeyFor`/`toolMatches`/`keyMatches`/`buildWhitelistEntry`/`classify`；`PermissionPolicy` 内存版（`classify`/`entries`，无文件——文件持久化在 Task 2）。

- [ ] **Step 1: 在 types/organ.ts 定义白名单条目类型**

在 `MouthContract` 上方加入：

```ts
/** 白名单条目：exact 精确整串 / path 写类路径（目录条目 key 以 / 结尾）。 */
export interface WhitelistEntry {
  tool: string;
  key: string;
  kind: "exact" | "path";
}
```

- [ ] **Step 2: 写失败测试**

```ts
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
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm exec vitest run tests/policy.test.ts`
Expected: 编译/引用错误（policy.ts 不存在）→ RED。

- [ ] **Step 4: 实现 `src/nose/blacklist.ts`**

```ts
// 黑名单：确定性系统破坏操作模式（随版本内置；用户可手动编辑，责任自负）。
// 匹配对象为归一化文本（反斜杠已转正斜杠，空白折叠；terminal 不转小写，模式一律 /i）。
export const BLACKLIST_PATTERNS: readonly RegExp[] = [
  // rm -rf 跟 根（"/" 或 "/*"）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+\/(?:\s|$|\*)/i,
  // rm -rf 跟 盘符根（"c:/" 后即结尾/空白）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+[a-z]:\/(?:\s|$)/i,
  // rm -rf 跟 Windows 系统目录：windows[/system32|/boot] 或裸 windows 结尾；
  // 注意终结符——"c:/windows/temp" 不命中（temp 可恢复，走审批）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+[a-z]:\/windows(?:\/(?:system32|boot)(?:\s|$|\/)|\s|$)/i,
  // rm -rf 跟 System Volume Information（系统还原区）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+[a-z]:\/system\s+volume\s+information(?:\s|$|\/)/i,
  // rm -rf 跟 Unix 系统目录（/boot /etc /usr /bin /sbin /lib /lib64）
  /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+\/(?:boot|etc|usr|bin|sbin|lib(?:64)?)(?:\s|$|\/)/i,
  // rd /s、rmdir /s 跟盘符（Windows 递归删除目录）
  /\b(?:rd|rmdir)\s+\/s\b[^\n|;]*[a-z]:\/[^\n|;]*/i,
  // del /f（可 /s）跟盘符
  /\bdel\s+\/f(?:\s+\/s)?\b[^\n|;]*[a-z]:\/[^\n|;]*/i,
  // 启动文件删除：bootmgr / boot.ini（磁盘根级）
  /\bdel\b[^\n|;]*(?:bootmgr|boot\.ini)/i,
  // PowerShell Remove-Item 跟盘符
  /\bRemove-Item\b[^\n|;]*-[^\n|;]*[a-z]:\/[^\n|;]*/i,
  // 系统盘格式化
  /\b(?:format|Format-Volume)\b[^\n|;]*(?:[a-z]:|SystemDrive)/i,
  // 整盘擦除
  /\bdiskpart\b[^\n|;]*clean/i,
  /\bClear-Disk\b/i,
  /\bcipher\s+\/w\b[^\n|;]*[a-z]:/i,
  // 块设备直写：dd of= 物理盘（归一化后 \\ 已是 /，物理盘为 //./ 前缀）
  /\bdd\b[^\n|;]*of=(?:\/\/\.\/|\/dev\/)/i,
  // 块设备重定向：> /dev/sdX、/dev/nvme*（不含 /dev/null、/dev/shm）
  />\s*\/dev\/(?:sd[a-z]+\d*|nvme\d+n\d+)/i,
  // 文件系统重建 / 分区表 / 磁盘擦除
  /\bmkfs(?:\.[a-z0-9]+)?\b[^\n|;]*(?:\/dev\/|[a-z]:)/i,
  /\bparted\b[^\n|;]*mklabel/i,
  /\bdiskutil\b[^\n|;]*erase/i,
  /\bshred\b[^\n|;]*\s+(?:\/dev\/|[a-z]:)/i,
  // 启动配置删除 / Boot 关键注册表删除 / 杀之必崩进程
  /\bbcdedit\b[^\n|;]*\/delete/i,
  /\breg\s+delete\b[^\n|;]*(?:HKLM\/SYSTEM|Windows NT\/CurrentVersion)/i,
  /\btaskkill\b[^\n|;]*\/f[^\n|;]*(?:lsass|csrss|wininit|winlogon)/i,
  // 权限全毁（chmod -R 000 跟 / 或 /etc）
  /\bchmod\s+-R\s+000\s+\/(?:\s|$|etc)/i,
];
```

- [ ] **Step 5: 实现 `src/nose/policy.ts`（内存版，无文件）**

```ts
// 权限裁决模块：黑名单（绝对禁止）+ 白名单（用户信任）统一匹配。
// 只做文本匹配，不做命令分类/路径分析；白名单条目跨写类工具生效。
import type { ToolCall } from "../brain/llm.js";
import type { WhitelistEntry } from "../types/index.js";
import { BLACKLIST_PATTERNS } from "./blacklist.js";

export type Classification = "blacklist" | "whitelist" | "unlisted";

const WRITE_TOOLS = new Set(["write_file", "apply_patch"]);

/** 归一化：空白折叠 + 反斜杠转正斜杠；win32 额外小写（路径键用）。 */
export function normalizePath(input: string): string {
  const out = input.trim().replace(/\s+/g, " ").replace(/\\/g, "/");
  return process.platform === "win32" ? out.toLowerCase() : out;
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

/** 其余工具（非 terminal/写类）：排序参数 JSON（深层空白归一）。 */
export function serializeArgs(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) sorted[key] = normalizeValue(args[key]);
  return JSON.stringify(sorted);
}

/** 匹配键：terminal → 命令；写类 → path；其余 → 排序参数 JSON。参数不合法返回 undefined。 */
export function matchKeyFor(call: ToolCall): string | undefined {
  if (call.name === "terminal") {
    return typeof call.arguments.command === "string" ? normalizeCommand(call.arguments.command) : undefined;
  }
  if (WRITE_TOOLS.has(call.name)) {
    return typeof call.arguments.path === "string" ? normalizePath(call.arguments.path) : undefined;
  }
  return serializeArgs(call.arguments);
}

/** 条目工具与调用工具是否相关：path 条目跨写类工具；exact 条目仅同名。 */
export function toolMatches(entryTool: string, callName: string): boolean {
  if (WRITE_TOOLS.has(entryTool) && WRITE_TOOLS.has(callName)) return true;
  return entryTool === callName;
}

/** 条目键匹配：exact 相等；path 目录条目段级前缀（key 以 / 结尾）、文件条目相等。 */
export function keyMatches(entry: WhitelistEntry, key: string): boolean {
  if (entry.kind === "exact") return entry.key === key;
  if (entry.key.endsWith("/")) return key === entry.key || key.startsWith(entry.key);
  return entry.key === key;
}

/** 由调用构造白名单条目：granularity 为 "exact"（命令/整串）、"path"（此路径）、"dir"（此目录）。 */
export function buildWhitelistEntry(call: ToolCall, granularity: "exact" | "path" | "dir"): WhitelistEntry {
  if (WRITE_TOOLS.has(call.name)) {
    const path = typeof call.arguments.path === "string" ? normalizePath(call.arguments.path) : "";
    if (granularity === "dir") {
      const parent = path.slice(0, path.lastIndexOf("/"));
      return { tool: call.name, key: `${parent}/`, kind: "path" };
    }
    return { tool: call.name, key: path, kind: "path" };
  }
  return { tool: call.name, key: matchKeyFor(call) ?? "", kind: "exact" };
}

/** 黑名单判定：模式命中匹配键即拒（写类按 path、terminal 按命令）。 */
export function classify(call: ToolCall): "blacklist" | "unlisted" {
  const key = matchKeyFor(call);
  if (key === undefined) return "unlisted";
  return BLACKLIST_PATTERNS.some((pattern) => pattern.test(key)) ? "blacklist" : "unlisted";
}

export interface PermissionPolicyOptions {
  /** 工作区（CWD）；缺省 process.cwd()，仅用于分节键。 */
  workspace?: string;
  /** 测试注入条目；缺省空。文件加载在 Task 2 加入。 */
  entries?: WhitelistEntry[];
}

/** 白名单匹配（内存版）：黑名单 → 白名单 → 未列。文件持久化与冗余清理在 Task 2。 */
export class PermissionPolicy {
  readonly #workspaceKey: string;
  #sections: Record<string, WhitelistEntry[]>;

  constructor(options: PermissionPolicyOptions = {}) {
    this.#workspaceKey = normalizePath(options.workspace ?? process.cwd());
    this.#sections =
      options.entries === undefined ? {} : { [this.#workspaceKey]: [...options.entries] };
  }

  classify(call: ToolCall): Classification {
    const key = matchKeyFor(call);
    if (key === undefined) return "unlisted";
    if (BLACKLIST_PATTERNS.some((pattern) => pattern.test(key))) return "blacklist";
    for (const entry of this.entries()) {
      if (toolMatches(entry.tool, call.name) && keyMatches(entry, key)) return "whitelist";
    }
    return "unlisted";
  }

  entries(): WhitelistEntry[] {
    return this.#sections[this.#workspaceKey] ?? [];
  }
}
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm exec vitest run tests/policy.test.ts`
Expected: 全部 PASS（内存版即可，无需跳过用例）。

- [ ] **Step 7: 全量回归 + 构建 + 提交**

Run: `pnpm test`（存量 145 项应全绿——本任务仅新增文件与类型）+ `pnpm build`
Commit: `git add src/types/organ.ts src/nose/blacklist.ts src/nose/policy.ts tests/policy.test.ts && git commit -m "权限：黑名单规则集 + 匹配/分类核心（归一化、段级前缀、系统目标锚定）"`

---

### Task 2: 白名单持久化 + 冗余清理

**Files:**
- Modify: `src/nose/policy.ts`（`PermissionPolicy` 补文件加载/save/`addEntry`/`ensureWorkspace`）
- Test: `tests/policy.test.ts`（追加持久化/清理用例）

**Interfaces:**
- Consumes: Task 1 的 `normalizePath`/`matchKeyFor`/`toolMatches`/`keyMatches`/`PermissionPolicyOptions`/`WhitelistEntry`。
- Produces: `PermissionPolicy` 全量：`new PermissionPolicy({ file?, workspace?, entries? })`（`file` 缺省 `join(homedir(), ".human-agent", "whitelist.json")`；`entries` 缺省从文件加载）、`classify`、`entries()`、`addEntry(entry): boolean`（去重 + 冗余清理 + 落盘）、`ensureWorkspace(): void`（幂等注册工作区写白名单条目）。

- [ ] **Step 1: 写失败测试（追加到 tests/policy.test.ts）**

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { WhitelistEntry } from "../src/types/index.js";

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
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/policy.test.ts`
Expected: RED（`addEntry`/`ensureWorkspace` 不存在、构造参数 `file` 未接受）。

- [ ] **Step 3: 实现（policy.ts 追加/替换 PermissionPolicy）**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PermissionPolicyOptions {
  /** 白名单文件；缺省 ~/.human-agent/whitelist.json */
  file?: string;
  /** 工作区（CWD）；缺省 process.cwd()，仅用于分节键。 */
  workspace?: string;
  /** 测试注入条目；缺省从文件加载。 */
  entries?: WhitelistEntry[];
}

/** 白名单按工作区分节的单文件存储；同步读写（启动期小文件，构造函数保持同步）。 */
export class PermissionPolicy {
  readonly #file: string;
  readonly #workspaceKey: string;
  #sections: Record<string, WhitelistEntry[]>;

  constructor(options: PermissionPolicyOptions = {}) {
    this.#workspaceKey = normalizePath(options.workspace ?? process.cwd());
    this.#file = options.file ?? join(homedir(), ".human-agent", "whitelist.json");
    this.#sections =
      options.entries === undefined
        ? loadSections(this.#file)
        : { [this.#workspaceKey]: [...options.entries] };
  }

  /** 分类：黑名单 → 白名单 → 未列。匹配键缺失（参数不合法）视为未列。 */
  classify(call: ToolCall): Classification {
    const key = matchKeyFor(call);
    if (key === undefined) return "unlisted";
    if (BLACKLIST_PATTERNS.some((pattern) => pattern.test(key))) return "blacklist";
    for (const entry of this.entries()) {
      if (toolMatches(entry.tool, call.name) && keyMatches(entry, key)) return "whitelist";
    }
    return "unlisted";
  }

  entries(): WhitelistEntry[] {
    return this.#sections[this.#workspaceKey] ?? [];
  }

  /** 加条目（去重 + 冗余清理后落盘）；返回是否新增。 */
  addEntry(entry: WhitelistEntry): boolean {
    const current = this.entries();
    if (current.some((e) => e.tool === entry.tool && e.kind === entry.kind && e.key === entry.key)) {
      return false;
    }
    if (entry.kind === "path" && current.some((e) => e.kind === "path" && covers(e.key, entry.key))) {
      return false; // 子被父盖：跳过（跨工具同判——path 是写权限概念，不按工具拆分）
    }
    const kept =
      entry.kind === "path"
        ? current.filter((e) => !(e.kind === "path" && covers(entry.key, e.key))) // 加父去子
        : current;
    this.#sections[this.#workspaceKey] = [...kept, entry];
    this.#save();
    return true;
  }

  /** 启动时注册工作区写白名单（write_file path-dir，跨工具覆盖 apply_patch）；幂等。 */
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

/** 目录条目是否覆盖子键（父以 / 结尾，段级前缀）。 */
function covers(parentKey: string, childKey: string): boolean {
  return parentKey.endsWith("/") && (childKey === parentKey || childKey.startsWith(parentKey));
}

function loadSections(file: string): Record<string, WhitelistEntry[]> {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, WhitelistEntry[]>;
    }
  } catch {
    // 损坏/不存在 → 空白名单（默认模式全弹窗、自动模式黑名单外全放行，不崩溃）
  }
  return {};
}
```

注意：`WhitelistEntry`/`ToolCall`/`Classification`/`normalizePath`/`matchKeyFor`/`toolMatches`/`keyMatches`/`BLACKLIST_PATTERNS` 的导入在文件顶部补上（Task 1 已有 `import type { ToolCall }` 与 `import type { WhitelistEntry }`——`WhitelistEntry` 从 types 导入已在 Task 1 完成；`PermissionPolicyOptions` 替换 Task 1 的旧定义，`classify`/`entries` 保留原实现）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/policy.test.ts`
Expected: 全部 PASS（含 Task 1 用例——`classify`/`entries` 行为不变）。

- [ ] **Step 5: 全量回归 + 构建 + 提交**

Run: `pnpm test` + `pnpm build`（应全绿）
Commit: `git add src/nose/policy.ts tests/policy.test.ts && git commit -m "权限：白名单持久化（按工作区分节）+ 冗余清理（父盖子/子被父盖/跨工具去重）"`

---

### Task 3: Reflection 集成权限层 + 裁决契约扩展

**Files:**
- Modify: `src/brain/llm.ts`（`ReflectionVerdict` 增 `pending`）
- Modify: `src/brain/reflection.ts`（构造注入 `PermissionPolicy`，删除 nose/mouth；裁决顺序按 Global Constraints 澄清 1）
- Test: `tests/reflection.test.ts`（全量重写）

**Interfaces:**
- Consumes: Task 2 的 `PermissionPolicy`；`matchKeyFor`（拒绝文案）。
- Produces: `ReflectionVerdict = { allowed: ToolCall[]; pending: ToolCall[]; blocked: BlockedCall[] }`；`new Reflection(policy: PermissionPolicy)`；`reflect(calls)` 顺序：黑名单(BLACKLIST) → 未知工具(UNKNOWN_TOOL) → 参数非法(INVALID_ARGS) → 白名单放行 → 其余 pending（待授权，宿主走审批通道）。

- [ ] **Step 1: 写失败测试（tests/reflection.test.ts 全量重写）**

```ts
// tests/reflection.test.ts
import { describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/nose/policy.js";
import { Reflection } from "../src/brain/reflection.js";

function policy(entries = []) {
  return new PermissionPolicy({ workspace: "/ws", entries });
}

describe("Reflection 权限集成裁决", () => {
  it("黑名单命中 → BLACKLIST 拦截（无审批无白名单）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "rm -rf /" } },
    ]);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.pending).toEqual([]);
    expect(verdict.blocked).toHaveLength(1);
    expect(verdict.blocked[0]!.result.error?.code).toBe("BLACKLIST");
  });

  it("白名单命中 → 放行（不进 pending）", async () => {
    const verdict = await new Reflection(
      policy([{ tool: "terminal", key: "git status", kind: "exact" }]),
    ).reflect([{ name: "terminal", arguments: { command: "git status" } }]);
    expect(verdict.allowed).toHaveLength(1);
    expect(verdict.pending).toEqual([]);
    expect(verdict.blocked).toEqual([]);
  });

  it("未命中白名单（结构合法）→ pending（需授权）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "ls -la" } },
      { name: "read_file", arguments: { path: "src/a.ts" } },
    ]);
    expect(verdict.pending).toHaveLength(2);
    expect(verdict.allowed).toEqual([]);
    expect(verdict.blocked).toEqual([]);
  });

  it("未知工具 / 参数非法 → 拦截（无论白名单）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "ghost_tool", arguments: {} },
      { name: "terminal", arguments: {} },
    ]);
    expect(verdict.blocked.map((b) => b.result.error?.code)).toEqual(["UNKNOWN_TOOL", "INVALID_ARGS"]);
    expect(verdict.pending).toEqual([]);
  });

  it("危险但未入黑名单的命令 → pending（不再嘴巴确认）", async () => {
    const verdict = await new Reflection(policy()).reflect([
      { name: "terminal", arguments: { command: "git push --force origin main" } },
    ]);
    expect(verdict.pending).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/reflection.test.ts`
Expected: RED（`pending` 字段缺失 / 构造签名变化）。

- [ ] **Step 3: 实现 llm.ts + reflection.ts**

`src/brain/llm.ts`：

```ts
export interface ReflectionVerdict {
  /** 白名单放行，直接执行。 */
  allowed: ToolCall[];
  /** 需授权（结构合法且未命中白名单）：由宿主走审批通道。 */
  pending: ToolCall[];
  blocked: BlockedCall[];
}
```

`src/brain/reflection.ts`（整文件替换）：

```ts
// 反思层（潜意识）：决策后再想"可行吗"。确定性代码，不经过模型。
// 裁决顺序：权限黑名单 → 存在性 → 结构 → 白名单放行 → 其余需授权。
// 权限层注入 PermissionPolicy；"需授权"仅作标记，审批通道由宿主（桥/loop）负责。
import { schemas } from "./knowledge.js";
import { matchKeyFor, type PermissionPolicy } from "../nose/policy.js";
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
      if (this.#policy.classify(call) === "blacklist") {
        blocked.push({
          call,
          result: fail("BLACKLIST", `系统破坏操作，禁止执行：${matchKeyFor(call) ?? call.name}`),
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
      if (this.#policy.classify(call) === "whitelist") allowed.push(call);
      else pending.push(call);
    }
    return { allowed, pending, blocked };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/reflection.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 全量回归 + 构建 + 提交（预期红灯清单）**

Run: `pnpm test` + `pnpm build`
预期（均为后续任务修复范围，本任务只记录不修）：
- `tests/ollama-thinking.test.ts` RED（构造仍传 nose/mouth）+ `pnpm build` RED（`OllamaThinking` 仍 `new Reflection(nose, mouth)`）→ Task 4 修复
- `tests/gemini-bridge-thinking.test.ts` RED（构造仍传 nose）→ Task 6 修复
- `tests/loop.test.ts` / `tests/agent.test.ts` 暂绿（pending 字段新增不破坏现有断言；`ReflectionVerdict` 类型新增字段对现有 fake 赋值兼容）
Commit: `git add src/brain/llm.ts src/brain/reflection.ts tests/reflection.test.ts && git commit -m "权限：Reflection 集成权限裁决（BLACKLIST/白名单/pending）+ 裁决契约扩展"`

---

### Task 4: BaseThinking 通用基类 + 工作区注册 + toolProtocol

**Files:**
- Create: `src/brain/thinking.ts`
- Modify: `src/brain/ollama-thinking.ts`（extends BaseThinking；options 去掉 nose/mouth，加 workspace/whitelistFile）
- Modify: `src/brain/gemini-bridge-thinking.ts`（extends BaseThinking；options 去掉 nose；删 `#reflection`/`#nose`；首条协议消息用 `toolProtocol()`）
- Modify: `src/agent.ts`（`buildBridgeService` 不再传 nose、删除 `buildDefaultNose()` 调用）
- Test: `tests/thinking.test.ts`（新）、`tests/ollama-thinking.test.ts`（改构造 + reflect 用例）

**Interfaces:**
- Consumes: Task 2 `PermissionPolicy`、Task 3 `Reflection`。
- Produces: `abstract class BaseThinking`：`constructor({ workspace?, whitelistFile? })`（内部建 policy + `ensureWorkspace()` + Reflection）；`reflect(calls)`、`classify(call)`、`addWhitelistEntry(entry): Promise<void>`、`workspaceConstraint(): string`、`toolProtocol(): string`；`static defaultWhitelistFile(): string`。
- 子类构造签名：`OllamaThinkingOptions = BaseThinkingOptions & { baseUrl?, model?, fetchImpl? }`；`GeminiBridgeThinkingOptions = BaseThinkingOptions & { port?, host?, hands, eyes, signal?, timeoutMs?, approvalTimeoutMs?, logger? }`。
- 本任务**不动** `#process`（Task 6 改）、`#approvals`、`#requestApproval`——仅构造与协议消息。

- [ ] **Step 1: 写失败测试**

```ts
// tests/thinking.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BaseThinking } from "../src/brain/thinking.js";

class TestThinking extends BaseThinking {}

describe("BaseThinking 通用确定性层", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "thinking-test-"));
  const file = join(tempDir, "whitelist.json");
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it("启动即注册工作区写白名单（write_file path-dir，跨工具命中 apply_patch）", () => {
    const t = new TestThinking({ workspace: "/home/u/proj", whitelistFile: file });
    expect(t.classify({ name: "write_file", arguments: { path: "/home/u/proj/src/a.ts", content: "x" } })).toBe("whitelist");
    expect(t.classify({ name: "apply_patch", arguments: { path: "/home/u/proj/a.ts", patch: "+x" } })).toBe("whitelist");
    expect(t.classify({ name: "write_file", arguments: { path: "/home/u/other/a.ts", content: "x" } })).toBe("unlisted");
  });

  it("reflect 统一裁决入口", async () => {
    const t = new TestThinking({ workspace: "/ws", whitelistFile: file });
    const verdict = await t.reflect([
      { name: "terminal", arguments: { command: "rm -rf /" } },
      { name: "terminal", arguments: { command: "ls -la" } },
    ]);
    expect(verdict.blocked[0]!.result.error?.code).toBe("BLACKLIST");
    expect(verdict.pending).toHaveLength(1);
  });

  it("toolProtocol 含工作区声明与协议标记", () => {
    const t = new TestThinking({ workspace: "/home/u/proj", whitelistFile: file });
    const protocol = t.toolProtocol();
    expect(protocol).toContain("工作区是 /home/u/proj");
    expect(protocol).toContain("【human-agent 工具协议】");
  });

  it("addWhitelistEntry 落盘后 classify 生效", async () => {
    const t = new TestThinking({ workspace: "/ws", whitelistFile: file });
    await t.addWhitelistEntry({ tool: "terminal", key: "git status", kind: "exact" });
    const t2 = new TestThinking({ workspace: "/ws", whitelistFile: file });
    expect(t2.classify({ name: "terminal", arguments: { command: "git status" } })).toBe("whitelist");
  });

  it("defaultWhitelistFile 指向 ~/.human-agent/whitelist.json", () => {
    expect(BaseThinking.defaultWhitelistFile()).toContain(".human-agent");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/thinking.test.ts`
Expected: RED（thinking.ts 不存在）。

- [ ] **Step 3: 实现 `src/brain/thinking.ts`**

```ts
// 通用 Thinking 基类：确定性层（权限 + 反思 + 工作区）单一实现，
// OllamaThinking / GeminiBridgeThinking 继承升级，桥与 CLI 裁决行为必然一致。
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "./llm.js";
import { Reflection } from "./reflection.js";
import { serializeToolProtocol } from "./knowledge.js";
import { PermissionPolicy, type Classification } from "../nose/policy.js";
import type { WhitelistEntry } from "../types/index.js";

export interface BaseThinkingOptions {
  /** 工作区（CWD）；缺省 process.cwd()，启动后不可被智能体更改。 */
  workspace?: string;
  /** 白名单文件；缺省 ~/.human-agent/whitelist.json */
  whitelistFile?: string;
}

export abstract class BaseThinking {
  readonly #workspace: string;
  readonly #reflection: Reflection;
  readonly #permission: PermissionPolicy;

  constructor(options: BaseThinkingOptions = {}) {
    this.#workspace = options.workspace ?? process.cwd();
    this.#permission = new PermissionPolicy({
      workspace: this.#workspace,
      ...(options.whitelistFile !== undefined ? { file: options.whitelistFile } : {}),
    });
    this.#permission.ensureWorkspace();
    this.#reflection = new Reflection(this.#permission);
  }

  /** 统一裁决入口：黑名单 → 未知/非法 → 白名单 → 需授权。 */
  reflect(calls: readonly ToolCall[]): ReturnType<Reflection["reflect"]> {
    return this.#reflection.reflect(calls);
  }

  classify(call: ToolCall): Classification {
    return this.#permission.classify(call);
  }

  /** 白名单落盘（用户经弹窗/嘴巴批准后由宿主调用）；同步内部实现，返回 Promise 兼容接口。 */
  addWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    this.#permission.addEntry(entry);
    return Promise.resolve();
  }

  /** 工作区声明（软约束）：协议文本 / system prompt 共用。 */
  workspaceConstraint(): string {
    return `你的工作区是 ${this.#workspace}，工具调用请保持在界内；界外操作需要用户授权。`;
  }

  /** 工具协议文本：工作区声明 + 工具清单与调用规则。 */
  toolProtocol(): string {
    return `${this.workspaceConstraint()}\n\n${serializeToolProtocol()}`;
  }

  static defaultWhitelistFile(): string {
    return join(homedir(), ".human-agent", "whitelist.json");
  }
}
```

- [ ] **Step 4: 改造子类构造**

`src/brain/ollama-thinking.ts`（整文件替换）：

```ts
import type { ConversationContext, Message } from "./context.js";
import type {
  BrainInference,
  BrainInferenceResult,
  ToolCall,
  ToolInfo,
} from "./llm.js";
import { BaseThinking, type BaseThinkingOptions } from "./thinking.js";

export interface OllamaThinkingOptions extends BaseThinkingOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

/** 思考层的 Ollama 实现：走本机 /api/chat 协议，支持工具调用；确定性层继承 BaseThinking。 */
export class OllamaThinking extends BaseThinking implements BrainInference {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: OllamaThinkingOptions = {}) {
    super(options);
    this.#baseUrl = options.baseUrl ?? "http://localhost:11434";
    this.#model = options.model ?? "qwen3:4b";
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async infer(
    context: ConversationContext,
    tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult> {
    // 以下原样保留（infer 逻辑不动）：
    // body 拼装 → fetch `/api/chat` → 非 200 抛错 → 映射 BrainInferenceResult
  }

  // reflect / classify / addWhitelistEntry / workspaceConstraint / toolProtocol 继承自 BaseThinking
}

// toOllamaMessage / toOllamaTool / toToolCall 三个纯函数原样保留
```

`src/brain/gemini-bridge-thinking.ts`（构造部分改造，`#process` 等不动）：

```ts
import { BaseThinking, type BaseThinkingOptions } from "./thinking.js";

export interface GeminiBridgeThinkingOptions extends BaseThinkingOptions {
  port?: number;
  host?: string;
  hands: HandsContract;
  eyes: EyesContract;
  signal?: AbortSignal;
  timeoutMs?: number;
  approvalTimeoutMs?: number;
  logger?: (message: string) => void;
}

export class GeminiBridgeThinking extends BaseThinking {
  // 删除：readonly #reflection、readonly #nose、import { Reflection }、
  //       import { serializeToolProtocol }、NoseContract 类型导入
  // 构造函数改为：
  constructor(options: GeminiBridgeThinkingOptions) {
    super(options); // 内部建 policy + ensureWorkspace + Reflection
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 600_000;
    this.#organs = { eyes: options.eyes, hands: options.hands };
    this.#signal = options.signal ?? new AbortController().signal;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#logger = options.logger;
    this.#server = http.createServer((req, res) => this.#handleRequest(req, res));
    this.#portPromise = new Promise<number>((resolve, reject) => {
      this.#server.on("error", reject);
      this.#server.listen(options.port ?? 8765, options.host ?? "127.0.0.1", () => {
        const address = this.#server.address() as AddressInfo;
        resolve(address.port);
      });
    });
    // 首条协议消息：工作区声明 + 工具协议（toolProtocol）
    this.#outbox.push({ type: "message", message: this.toolProtocol() });
  }
}
```

`src/agent.ts`（`buildBridgeService` 同步改——否则 Task 4 提交时 build 就红）：

```ts
export function buildBridgeService(options: BridgeServiceOptions = {}): GeminiBridgeThinking {
  const hands = buildDefaultHands();
  const eyes = buildDefaultEyes();
  // 删除：const nose = buildDefaultNose(); 与其在 GeminiBridgeThinking 构造中的 nose 传参
  const port = options.port ?? (() => { /* 原样保留 */ })();
  return new GeminiBridgeThinking({
    port,
    hands,
    eyes,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
```

（`buildDefaultNose` 函数保留——`HumanAgent` 的 `this.nose` 默认值仍用它；`NoseContract` 导入保留。）

- [ ] **Step 5: 修 tests/ollama-thinking.test.ts**

1. `makeBrain`：`new OllamaThinking({ fetchImpl, nose: buildStubNose(), mouth: buildStubMouth() })` → `new OllamaThinking({ fetchImpl })`（删除 `buildStubNose`/`buildStubMouth` 导入）。
2. 「可自定义 baseUrl 与 model」用例：同样去掉 `nose`/`mouth` 传参。
3. 末尾「reflect 委托共享反思层」用例重写（新模型下 `rm -rf /` 是 BLACKLIST，不再走嘴巴）：

```ts
it("reflect 继承 BaseThinking：黑名单拦截 / 未列命令进 pending", async () => {
  const brain = new OllamaThinking({ fetchImpl: vi.fn() });
  const verdict = await brain.reflect([{ name: "terminal", arguments: { command: "rm -rf /" } }]);
  expect(verdict.blocked[0]?.result.error?.code).toBe("BLACKLIST");
  const pending = await brain.reflect([{ name: "terminal", arguments: { command: "ls -la" } }]);
  expect(pending.pending).toHaveLength(1);
});
```

注意：此用例的 `OllamaThinking` 不注入 whitelistFile/workspace → 会用默认文件。改成注入临时目录：

```ts
const brain = new OllamaThinking({ fetchImpl: vi.fn(), whitelistFile: join(tmpdir(), `ollama-wl-${Date.now()}.json`), workspace: "/ws-test" });
```

（或直接在文件顶部建临时目录——参考 tests/thinking.test.ts 的 mkdtempSync 模式。）

- [ ] **Step 6: 运行确认通过**

Run: `pnpm exec vitest run tests/thinking.test.ts tests/ollama-thinking.test.ts`
Expected: PASS。`tests/gemini-bridge-thinking.test.ts` / `tests/loop.test.ts` / `tests/agent.test.ts` 仍红（Task 6/7 修复）。

- [ ] **Step 7: 全量回归 + 构建 + 提交**

Run: `pnpm test` + `pnpm build`（build 应绿——agent.ts 已同步；gemini-bridge 测试运行时红属预期）
Commit: `git add src/brain/thinking.ts src/brain/ollama-thinking.ts src/brain/gemini-bridge-thinking.ts src/agent.ts tests/thinking.test.ts tests/ollama-thinking.test.ts && git commit -m "权限：通用 Thinking 基类（确定性层收敛 + 工作区注册 + 协议文本含工作区声明）"`

---

### Task 5: Mouth 三选升级（askApproval）

**Files:**
- Modify: `src/types/organ.ts`（`ApprovalPrompt`/`ApprovalChoice`；`MouthContract` 增 `askApproval`）
- Modify: `src/mouth/ask-user.ts`
- Modify: `tests/helpers.ts`（`buildStubMouth` 补 `askApproval`——保持 build/测试全绿）
- Test: `tests/ask-user.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 `WhitelistEntry`。
- Produces: `ApprovalPrompt = { tool: string; key: string; kind: "exact" | "path" }`；`ApprovalChoice = { action: "allow" } | { action: "deny" } | { action: "whitelist"; entry: WhitelistEntry }`；`MouthContract.askApproval(prompt): Promise<ApprovalChoice>`（`confirm` 保留）。

- [ ] **Step 1: 写失败测试（追加到 tests/ask-user.test.ts，沿用顶部 `inputFrom` helper）**

```ts
import type { ApprovalPrompt, ApprovalChoice } from "../src/types/index.js";

describe("askApproval 三选", () => {
  it("y → allow", async () => {
    const ask = new AskUser({ input: inputFrom("y\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls -la", kind: "exact" });
    expect(choice).toEqual({ action: "allow" });
  });
  it("n → deny", async () => {
    const ask = new AskUser({ input: inputFrom("n\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls -la", kind: "exact" });
    expect(choice).toEqual({ action: "deny" });
  });
  it("w → whitelist（exact 条目）", async () => {
    const ask = new AskUser({ input: inputFrom("w\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls -la", kind: "exact" });
    expect(choice).toEqual({ action: "whitelist", entry: { tool: "terminal", key: "ls -la", kind: "exact" } });
  });
  it("写类：w → 此路径；d → 此目录", async () => {
    const ask1 = new AskUser({ input: inputFrom("w\n") });
    const pathChoice = await ask1.askApproval({ tool: "write_file", key: "src/utils.ts", kind: "path" });
    expect(pathChoice).toEqual({
      action: "whitelist",
      entry: { tool: "write_file", key: "src/utils.ts", kind: "path" },
    });
    const ask2 = new AskUser({ input: inputFrom("d\n") });
    const dirChoice = await ask2.askApproval({ tool: "write_file", key: "src/utils.ts", kind: "path" });
    expect(dirChoice).toEqual({
      action: "whitelist",
      entry: { tool: "write_file", key: "src/", kind: "path" },
    });
  });
  it("非法输入循环追问（x 后 y 生效）", async () => {
    const ask = new AskUser({ input: inputFrom("x\ny\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls", kind: "exact" });
    expect(choice).toEqual({ action: "allow" });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/ask-user.test.ts`
Expected: RED（askApproval 不存在）。

- [ ] **Step 3: 实现 types + ask-user**

`src/types/organ.ts`（WhitelistEntry 旁）：

```ts
/** 审批提示：工具名 + 匹配键 + 条目类型（写类为 path，其余 exact）。 */
export interface ApprovalPrompt {
  tool: string;
  key: string;
  kind: "exact" | "path";
}

export type ApprovalChoice =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "whitelist"; entry: WhitelistEntry };

export interface MouthContract {
  confirm(message: string): Promise<boolean>;
  /** 需授权调用的人工三选：允许 / 拒绝 / 加入白名单（写类另有「此目录」）。 */
  askApproval(prompt: ApprovalPrompt): Promise<ApprovalChoice>;
}
```

`src/mouth/ask-user.ts`（在类内追加方法；confirm 原样保留）：

```ts
async askApproval(prompt: ApprovalPrompt): Promise<ApprovalChoice> {
  const rl = createInterface({ input: this.#input, output: this.#output });
  try {
    const isPath = prompt.kind === "path";
    for (;;) {
      const suffix = isPath ? "  [d] 白名单(此目录)" : "";
      const answer = (
        await rl.question(`${prompt.tool} ${prompt.key}\n[y] 允许  [n] 拒绝  [w] 加入白名单${suffix} → `)
      ).trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") return { action: "allow" };
      if (answer === "n" || answer === "no") return { action: "deny" };
      if (answer === "w") {
        return { action: "whitelist", entry: { tool: prompt.tool, key: prompt.key, kind: prompt.kind } };
      }
      if (answer === "d" && isPath) {
        const parent = prompt.key.slice(0, prompt.key.lastIndexOf("/"));
        return {
          action: "whitelist",
          entry: { tool: prompt.tool, key: `${parent}/`, kind: "path" },
        };
      }
      this.#output?.write(`请输入 y / n / w${isPath ? " / d" : ""}。\n`);
    }
  } finally {
    rl.close();
  }
}
```

顶部导入改为：`import type { ApprovalChoice, ApprovalPrompt } from "../types/index.js";`

- [ ] **Step 4: 修 tests/helpers.ts（保持 build/测试全绿）**

`buildStubMouth`：

```ts
export function buildStubMouth(approve = true): MouthContract {
  return {
    confirm: async () => approve,
    askApproval: async () => ({ action: "allow" }),
  };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run tests/ask-user.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量回归 + 构建 + 提交**

Run: `pnpm test` + `pnpm build`（应全绿——loop/gemini-bridge 尚未消费 mouth/askApproval，其测试不受影响）
Commit: `git add src/types/organ.ts src/mouth/ask-user.ts tests/helpers.ts tests/ask-user.test.ts && git commit -m "权限：嘴巴三选审批（允许/拒绝/加入白名单，写类支持此目录）"`

---

### Task 6: 桥服务裁决链改造 + 审批 whitelist 协议

**Files:**
- Modify: `src/brain/gemini-bridge-thinking.ts`（`#process` 用 `this.reflect` 统一裁决；`#requestApproval` 条目携带 calls；`#handleApprovalRequest` 校验并应用 whitelist；删除预筛与多余导入）
- Modify: `extensions/gemini-bridge/background.js`（`approve` 消息透传 `whitelist` 字段）
- Test: `tests/gemini-bridge-thinking.test.ts`（改造：makeBridge 注入临时白名单、既有审批用例换未列命令、新增协议用例）

**Interfaces:**
- Consumes: Task 4 `BaseThinking.reflect`/`addWhitelistEntry`；Task 2 `matchKeyFor`/`normalizePath`/`toolMatches`。
- Produces: `POST /approval` 请求体 `{ id, allowed, whitelist?: WhitelistEntry[] }`；`GET /task` approval 项不变 `{ type: "approval", id, calls }`；黑名单命中不下发审批、直接回填 BLACKLIST 拒绝行。

- [ ] **Step 1: 改造测试（先 RED）**

`tests/gemini-bridge-thinking.test.ts` 改造要点：

1. **顶部**：新增临时白名单文件 + `seedWhitelist`/`tryGetMessage` helper：

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { WhitelistEntry } from "../src/types/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "bridge-wl-"));
const tmpFile = join(tmpDir, "whitelist.json");
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => rmSync(tmpFile, { force: true }));

/** 预置白名单（构造前写入；桥构造时加载）。 */
function seedWhitelist(workspace: string, entries: WhitelistEntry[]): void {
  writeFileSync(tmpFile, JSON.stringify({ [workspace]: entries }), "utf8");
}

/** 限时取一条出队消息；超时返回 null（挂起的 GET /task 由 afterEach bridge.close() 释放）。 */
async function tryGetMessage(port: number, ms: number): Promise<OutboxBody | null> {
  return Promise.race([
    getMessage(port),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
```

2. **makeBridge**：删除 `nose` 传参，缺省注入临时白名单与测试工作区（**严禁缺省走真实 `~/.human-agent/whitelist.json`**）：

```ts
async function makeBridge(options: {
  workspace?: string;
  whitelistFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  approvalTimeoutMs?: number;
} = {}) {
  const organs = makeRecordingOrgans();
  const bridge = new GeminiBridgeThinking({
    port: 0,
    workspace: options.workspace ?? "/ws-test",
    whitelistFile: options.whitelistFile ?? tmpFile,
    hands: organs.hands,
    eyes: organs.eyes,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
  });
  openBridges.push(bridge);
  const port = await bridge.getPort();
  return { bridge, port, organs };
}
```

（删除 `buildStubNose` 导入与 `NoseContract` 类型导入——如无他用。）

3. **postApproval** 增加可选 `whitelist` 参数：

```ts
async function postApproval(port: number, id: number, allowed: boolean[], whitelist?: WhitelistEntry[]): Promise<number> {
  const body: Record<string, unknown> = { id, allowed };
  if (whitelist !== undefined && whitelist.length > 0) body.whitelist = whitelist;
  const res = await fetch(`http://127.0.0.1:${port}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.json().catch(() => undefined);
  return res.status;
}
```

4. **既有用例逐条改造规则**（语义已变：无「危险命令预筛」概念——未命中白名单一律审批；`rm -rf /` 现在是 BLACKLIST 直接拒绝）：

| 现有用例 | 改造 |
|---|---|
| 首条任务为工具协议 | 不变（断言 contains 「【human-agent 工具协议】」仍成立——toolProtocol 前置工作区行） |
| 含 tool_call 的内容执行后回填结果消息 | `read_file a.txt` 现为未列 → `seedWhitelist("/ws-test", [{ tool: "read_file", key: '{"path":"a.txt"}', kind: "exact" }])` 后再 makeBridge |
| 无 tool_call 的内容不回填 | 不变 |
| 多个 tool_call 汇总为一条消息并全部执行 | `read_file a.txt` + `terminal echo hi` 都预置白名单 |
| 危险命令需审批，未授权不执行 | 改名「未列入白名单的调用下发审批」；命令改 `echo hi`；`makeBridge({ workspace: "/ws-test" })`（不预置）→ approval 类型 + organs.calls 为空 |
| 多个危险命令合并为一条审批请求 | 命令改 `git push --force origin main` + `echo hi`（均未列）→ approval calls 长度 2 与 arguments 断言随之改 |
| 审批允许后执行并回填结果 | 命令改 `echo hi`；其余不变 |
| 审批逐条裁决 | 命令改 `ls -la` + `echo ok`（[false, true]） |
| 未知审批 id 返回 404 | 不变 |
| 审批兜底超时全部拒绝 | 命令改 `echo hi`（approvalTimeoutMs 50） |
| close 释放挂起审批 | 命令改 `echo hi` |
| 全局中断作废审批并丢弃批次 | 命令改 `echo hi` |
| 参数非法的危险命令不进审批 | 不变（terminal {} → INVALID_ARGS） |
| 安全命令批不产生审批消息 | **删除**——前提已亡（read_file 未列会进审批）；由新增「白名单命中静默执行」替代 |
| 未知工具与参数非法拒绝 | 不变 |
| 相同内容重复提交只处理一次 | `read_file a.txt` 预置白名单 |
| 批超时队列执行超时说明 | `terminal slow` 预置 exact 白名单（否则先进审批、无执行） |
| 全局中断丢弃批次 | 不变（abort 先于 postReply，#process 首行 return） |
| close 释放挂起长轮询 | 不变 |
| 非法 reply 返回 400 | 不变 |

5. **新增用例**：

```ts
it("黑名单命中直接回填拒绝，不下发审批", async () => {
  const { port, organs } = await makeBridge();
  await getMessageText(port); // 排空协议首条
  await postReply(port, toolCall("terminal", { command: "rm -rf /" }));
  const message = await getMessageText(port);
  expect(message).toContain("BLACKLIST");
  expect(message).toContain("系统破坏操作，禁止执行");
  expect(await tryGetMessage(port, 300)).toBeNull(); // 无审批请求
  expect(organs.calls).toEqual([]);
});

it("白名单命中静默执行（不下发审批）", async () => {
  seedWhitelist("/ws-test", [{ tool: "terminal", key: "git status", kind: "exact" }]);
  const { port, organs } = await makeBridge();
  await getMessageText(port);
  await postReply(port, toolCall("terminal", { command: "git status" }));
  const message = await getMessageText(port);
  expect(message).toContain("工具执行结果");
  expect(message).toContain("成功");
  expect(organs.calls.some((c) => c.args.command === "git status")).toBe(true);
});

it("审批带回 whitelist 条目 → 落盘后生效", async () => {
  const { port } = await makeBridge({ workspace: "/ws-test" });
  await getMessageText(port);
  await postReply(port, toolCall("terminal", { command: "ls -la" }));
  const body = await getMessage(port);
  expect(body?.type).toBe("approval");
  const id = (body as { id: number }).id;
  expect(await postApproval(port, id, [true], [{ tool: "terminal", key: "ls -la", kind: "exact" }])).toBe(200);
  await getMessageText(port); // 执行结果
  const raw = JSON.parse(readFileSync(tmpFile, "utf8")) as Record<string, WhitelistEntry[]>;
  expect(raw["/ws-test"]).toContainEqual({ tool: "terminal", key: "ls -la", kind: "exact" });
});

it("非法 whitelist 条目 → 400 拒绝（不落盘不执行）", async () => {
  const { port, organs } = await makeBridge({ workspace: "/ws-test" });
  await getMessageText(port);
  await postReply(port, toolCall("terminal", { command: "ls -la" }));
  const body = await getMessage(port);
  expect(body?.type).toBe("approval");
  const id = (body as { id: number }).id;
  const res = await postApproval(port, id, [true], [{ tool: "write_file", key: "/etc/passwd", kind: "path" }]);
  expect(res).toBe(400);
  expect(organs.calls).toEqual([]); // 未执行
});

it("工作区启动即注册：界内写入静默执行（apply_patch 同样命中）", async () => {
  const { port, organs } = await makeBridge({ workspace: "/ws" });
  await getMessageText(port);
  await postReply(port, toolCall("write_file", { path: "/ws/a.txt", content: "hi" }));
  const message = await getMessageText(port);
  expect(message).toContain("成功");
  expect(organs.calls.some((c) => c.name === "write_file")).toBe(true);
});

it("界外写入未入白名单 → 下发审批", async () => {
  const { port } = await makeBridge({ workspace: "/ws" });
  await getMessageText(port);
  await postReply(port, toolCall("write_file", { path: "/tmp/evil.txt", content: "x" }));
  const body = await getMessage(port);
  expect(body?.type).toBe("approval");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/gemini-bridge-thinking.test.ts`
Expected: RED（预筛逻辑还在、无 whitelist 协议、既有用例语义不符）。

- [ ] **Step 3: 改造 `src/brain/gemini-bridge-thinking.ts`**

**#process 重写**（替换原「预筛 + 审批 + reflect 三段」）：

```ts
/** 单批流水线：统一裁决（黑名单/未知/非法/白名单/需授权）→ 需授权的批量审批 → 按原 calls 顺序执行/拒绝 → 回填。 */
async #process(calls: readonly ToolCall[]): Promise<void> {
  if (this.#signal.aborted) return; // 全局中断：丢弃批次
  const batchSignal =
    this.#timeoutMs > 0
      ? AbortSignal.any([this.#signal, AbortSignal.timeout(this.#timeoutMs)])
      : this.#signal;

  const verdict = await this.reflect(calls);
  const pending = verdict.pending;

  // 批量审批：一条请求含全部待授权调用；批中止时作废审批条目并清除兜底定时器
  let decision: ApprovalDecision | undefined;
  if (pending.length > 0) {
    const { id, promise, cancel } = this.#requestApproval(pending);
    try {
      decision = await Promise.race([promise, abortSignalPromise(batchSignal)]);
    } catch {
      cancel();
      if (this.#signal.aborted) return; // 全局中断：丢弃批次
      this.#pushMessage(`⚠️ 工具执行超时（超过 ${this.#timeoutMs}ms），已终止`);
      return;
    }
  }

  const allowedSet = new Set(verdict.allowed);
  const pendingSet = new Set(pending);
  const blockedMap = new Map(verdict.blocked.map((item) => [item.call, item.result] as const));
  const decisions = decision?.allowed ?? [];
  const lines: string[] = [];
  let index = 0;
  let pendingIndex = 0;
  for (const call of calls) {
    // 原 calls 顺序执行与输出（执行顺序 = 原顺序，逐条串行）
    let toRun: ToolCall | undefined;
    let blockedResult: ActionResult<unknown> | undefined;
    if (blockedMap.has(call)) {
      blockedResult = blockedMap.get(call);
    } else if (allowedSet.has(call)) {
      toRun = call;
    } else if (pendingSet.has(call)) {
      const allowed = decisions[pendingIndex++] ?? false;
      if (allowed) {
        toRun = call;
      } else {
        blockedResult = fail("USER_DENIED", decision?.timedOut === true ? "审批超时，未执行" : "用户未授权，未执行");
      }
    }
    if (toRun !== undefined) {
      index++;
      if (batchSignal.aborted) break; // 批中止：停止执行
      let result: ActionResult<unknown>;
      try {
        result = await Promise.race([
          executeTool(this.#organs, toRun.name, toRun.arguments, batchSignal),
          abortSignalPromise(batchSignal),
        ]);
      } catch {
        break; // 批 signal 已中止（执行未在超时前返回）
      }
      lines.push(serializeResultLine(index, toRun, result));
    } else if (blockedResult !== undefined) {
      index++;
      lines.push(serializeBlockedLine(index, call, blockedResult));
    }
  }
  if (this.#signal.aborted) return; // 全局中断：丢弃批次不排队
  if (batchSignal.aborted) {
    this.#pushMessage(`⚠️ 工具执行超时（超过 ${this.#timeoutMs}ms），已终止`);
    return;
  }
  this.#pushMessage(serializeFeedback(lines));
}
```

**#approvals 条目扩展 + #requestApproval**（`#approvals` 类型声明改为 `Map<number, { settle: (decision: ApprovalDecision) => void; count: number; calls: ToolCall[] }>`）：

```ts
#requestApproval(calls: readonly ToolCall[]): {
  id: number;
  promise: Promise<ApprovalDecision>;
  cancel: () => void;
} {
  const id = this.#nextApprovalId++;
  let settle!: (decision: ApprovalDecision) => void;
  const timer = setTimeout(() => {
    if (this.#approvals.delete(id)) settle({ allowed: calls.map(() => false), timedOut: true });
  }, this.#approvalTimeoutMs);
  const promise = new Promise<ApprovalDecision>((resolve) => {
    settle = (decision) => {
      clearTimeout(timer);
      resolve(decision);
    };
  });
  this.#approvals.set(id, { settle, count: calls.length, calls: [...calls] });
  this.#outbox.push({ type: "approval", id, calls: [...calls] });
  this.#logger?.(`审批请求已入队（id ${id}，${calls.length} 条待授权调用）`);
  this.#wakeWaiter();
  return {
    id,
    promise,
    cancel: () => {
      this.#approvals.delete(id);
      clearTimeout(timer);
    },
  };
}
```

**#handleApprovalRequest 重写**（`readJsonBody` 之后整段替换；注意 404/400 分支语义）：

```ts
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
      if (record.whitelist !== undefined) {
        const entries = Array.isArray(record.whitelist) ? record.whitelist : null;
        if (entries === null || !this.#isValidWhitelist(entries, entry.calls, allowed)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "whitelist 条目不合法" }));
          return;
        }
        for (const w of entries) void this.addWhitelistEntry(w as WhitelistEntry);
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

/** 校验：每条目必须对应本批中 allowed=true 的调用（exact：tool+key 与匹配键完全一致；path：此路径或此目录）。 */
#isValidWhitelist(raw: unknown[], calls: readonly ToolCall[], allowed: boolean[]): boolean {
  const allowedCalls = calls.filter((_, i) => allowed[i] === true);
  return raw.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const w = item as Record<string, unknown>;
    if (typeof w.tool !== "string" || typeof w.key !== "string") return false;
    if (w.kind !== "exact" && w.kind !== "path") return false;
    const entry: WhitelistEntry = { tool: w.tool, key: w.key, kind: w.kind };
    return allowedCalls.some((call) => {
      if (entry.kind === "exact") {
        return toolMatches(entry.tool, call.name) && entry.key === matchKeyFor(call);
      }
      if (call.name !== "write_file" && call.name !== "apply_patch") return false;
      const path = typeof call.arguments.path === "string" ? normalizePath(call.arguments.path) : "";
      if (!toolMatches(entry.tool, call.name)) return false;
      return entry.key === path || entry.key === `${path.slice(0, path.lastIndexOf("/"))}/`;
    });
  });
}
```

**导入清理**（改造后不再使用，全部删除）：
- `import { schemas, serializeToolProtocol } from "./knowledge.js";` → `serializeToolProtocol` 删（构造用 `this.toolProtocol()`）；`schemas` 删（预筛删除）
- `import { Reflection } from "./reflection.js";` 删（继承 BaseThinking）
- `import type { ... NoseContract ... }` 从 types 导入中删除
- 新增：`import { BaseThinking, type BaseThinkingOptions } from "./thinking.js";`、`import { matchKeyFor, normalizePath, toolMatches } from "../nose/policy.js";`、`import type { WhitelistEntry } from "../types/index.js";`（类型导入可与现有 types 导入合并）

**文件顶部注释**同步更新（预筛/危险清单措辞 → 统一裁决）。

`extensions/gemini-bridge/background.js` 的 `approve` 分支：

```js
if (message.type === "approve") {
  const id = Number(message?.id);
  const allowed = Array.isArray(message?.allowed) ? message.allowed.map((v) => v === true) : [];
  if (!Number.isInteger(id) || allowed.length === 0) {
    sendResponse({ ok: false, error: "invalid approval" });
    return;
  }
  const body = { id, allowed };
  const whitelist = Array.isArray(message?.whitelist) ? message.whitelist : [];
  if (whitelist.length > 0) body.whitelist = whitelist;
  // ...fetch POST /approval 发送 JSON.stringify(body)，其余逻辑原样
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/gemini-bridge-thinking.test.ts`
Expected: 全部 PASS（含改造后既有用例 + 新增用例）。

- [ ] **Step 5: 全量回归 + 构建 + 提交**

Run: `pnpm test`（loop/agent 相关仍红——Task 7 修复）+ `pnpm build`（应绿）
Commit: `git add src/brain/gemini-bridge-thinking.ts extensions/gemini-bridge/background.js tests/gemini-bridge-thinking.test.ts && git commit -m "权限：桥裁决链接入统一 reflect（pending 审批 + BLACKLIST 拦截 + whitelist 落盘协议）"`

---

### Task 7: CLI loop 接入 + agent 装配 + 工作区 system 消息

**Files:**
- Modify: `src/brain/llm.ts`（`BrainInference` 增 `addWhitelistEntry` 与 `workspaceConstraint`）
- Modify: `src/heart/loop.ts`（`AgentLoopOptions` 增 `mouth`；`#execute` 处理 `pending`）
- Modify: `src/agent.ts`（`buildDefaultBrain()` 去掉 nose/mouth 传参；`run()` 注入工作区 system 消息；loop 构造传 mouth）
- Modify: `tests/helpers.ts`（`ScriptedBrain` 增两方法 + `addedWhitelist` 记录）
- Test: `tests/loop.test.ts`、`tests/agent.test.ts`（改造 + 新增用例）

**Interfaces:**
- Consumes: Task 5 `MouthContract.askApproval`/`ApprovalPrompt`/`ApprovalChoice`；Task 2 `matchKeyFor`。
- Produces: `BrainInference.addWhitelistEntry(entry: WhitelistEntry): Promise<void>`、`BrainInference.workspaceConstraint(): string`（OllamaThinking 继承 BaseThinking 实现）；`AgentLoopOptions.mouth: MouthContract`。

- [ ] **Step 1: 改造测试（先 RED）**

`tests/helpers.ts`：

```ts
// ScriptedBrain 增补（import type { WhitelistEntry } 加进类型导入）：
async addWhitelistEntry(entry: WhitelistEntry): Promise<void> {
  this.addedWhitelist.push(entry);
}
workspaceConstraint(): string {
  return "你的工作区是 /ws-test（测试）";
}
public readonly addedWhitelist: WhitelistEntry[] = [];
```

`tests/loop.test.ts` 改造要点：

1. `makeLoop` 增 `mouth` 参数并传给 AgentLoop；8 处内联 `new AgentLoop` 一律补 `mouth: { confirm: async () => true, askApproval: async () => ({ action: "allow" }) }`（可在文件顶部定义共享 `const autoAllowMouth: MouthContract = ...` 复用）。
2. 三个内联 Brain 类（`AbortableBrain`/`TimeoutThenAnswerBrain`/`ReflectBoomBrain`）与 `ScriptedBrain` 补 `addWhitelistEntry: async () => {}` 与 `workspaceConstraint: () => "test"`（ScriptedBrain 用 helpers 里的实现；内联类各加两行桩）。
3. 新增用例：

```ts
import type { ApprovalChoice, ApprovalPrompt, WhitelistEntry } from "../src/types/index.js";

function pendingBrain(call: ToolCall) {
  return new ScriptedBrain(
    [
      { result: { text: "", toolCalls: [call] } },
      { result: { text: "结束" } },
    ],
    { allowed: [], pending: [call], blocked: [] },
  );
}

it("pending 允许：嘴巴三选 allow → 执行并反馈 tool 消息", async () => {
  const call = { name: "terminal", arguments: { command: "ls -la" } };
  const brain = pendingBrain(call);
  const prompts: ApprovalPrompt[] = [];
  const loop = new AgentLoop({
    brain,
    ears: new FakeEars(["任务", "/exit"]),
    eyes: buildEyes(),
    hands: buildHands(),
    output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
    signal: new AbortController().signal,
    mouth: {
      confirm: async () => true,
      askApproval: async (prompt) => {
        prompts.push(prompt);
        return { action: "allow" };
      },
    },
  });
  await loop.run();
  expect(prompts).toEqual([{ tool: "terminal", key: "ls -la", kind: "exact" }]);
  const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
  expect(JSON.parse(toolMessage!.content) as { success: boolean }).toMatchObject({ success: true });
});

it("pending 拒绝：USER_DENIED 反馈，不执行", async () => {
  const call = { name: "terminal", arguments: { command: "ls -la" } };
  const brain = pendingBrain(call);
  const loop = new AgentLoop({
    brain,
    ears: new FakeEars(["任务", "/exit"]),
    eyes: buildEyes(),
    hands: buildHands(),
    output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
    signal: new AbortController().signal,
    mouth: { confirm: async () => true, askApproval: async () => ({ action: "deny" }) },
  });
  await loop.run();
  const toolMessage = brain.messagesOf(1).find((m) => m.role === "tool");
  const parsed = JSON.parse(toolMessage!.content) as { success: boolean; error?: { code: string } };
  expect(parsed.success).toBe(false);
  expect(parsed.error?.code).toBe("USER_DENIED");
});

it("pending 加入白名单：条目落盘后执行", async () => {
  const call = { name: "write_file", arguments: { path: "src/a.ts", content: "x" } };
  const brain = pendingBrain(call);
  const entry: WhitelistEntry = { tool: "write_file", key: "src/a.ts", kind: "path" };
  const loop = new AgentLoop({
    brain,
    ears: new FakeEars(["任务", "/exit"]),
    eyes: buildEyes(),
    hands: buildHands(),
    output: new TextOutput({ stdout: new FakeWritable(), intervalMs: 0 }),
    signal: new AbortController().signal,
    mouth: {
      confirm: async () => true,
      askApproval: async (prompt: ApprovalPrompt) =>
        prompt.kind === "path" ? { action: "whitelist", entry } : { action: "allow" },
    },
  });
  await loop.run();
  expect(brain.addedWhitelist).toEqual([entry]);
  expect(brain.messagesOf(1).find((m) => m.role === "tool")).toBeDefined();
});
```

`tests/agent.test.ts` 追加：

```ts
it("运行前向上下文注入工作区 system 消息（brain 提供 workspaceConstraint）", async () => {
  const brain = new ScriptedBrain([{ result: { text: "回答" } }]);
  const agent = new HumanAgent({
    brain,
    ears: new FakeEars(["hi", "/exit"]),
    output: new FakeOutput(),
  });
  await agent.run();
  const system = brain.messagesOf(0).find((m) => m.role === "system");
  expect(system?.content).toContain("工作区是");
});

it("上下文已有 system 消息时不重复注入", async () => {
  const brain = new ScriptedBrain([{ result: { text: "回答" } }]);
  const agent = new HumanAgent({
    brain,
    ears: new FakeEars(["hi", "/exit"]),
    output: new FakeOutput(),
    context: new ConversationContext({ maxTokens: 8000 }),
  });
  agent.context.add({ role: "system", content: "自定义系统提示" });
  await agent.run();
  const systems = brain.messagesOf(0).filter((m) => m.role === "system");
  expect(systems).toHaveLength(1);
  expect(systems[0]!.content).toBe("自定义系统提示");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/loop.test.ts tests/agent.test.ts`
Expected: RED（mouth 缺失 / pending 未处理 / BrainInference 缺方法）。

- [ ] **Step 3: 实现 llm.ts + loop.ts + agent.ts**

`src/brain/llm.ts`：

```ts
import type { ActionResult, WhitelistEntry } from "../types/index.js";

/** 大脑统一推理接口：输入上下文与可用工具，返回思考文本或工具调用意图（设计文档 §3.1）。 */
export interface BrainInference {
  infer(
    context: ConversationContext,
    tools: readonly ToolInfo[],
    signal?: AbortSignal,
  ): Promise<BrainInferenceResult>;
  /** 反思：对候选工具调用做可行性裁决（存在性/结构/权限），放行、待授权或拦截+错误反馈。 */
  reflect(calls: readonly ToolCall[]): Promise<ReflectionVerdict>;
  /** 加入白名单（用户经嘴巴/弹窗批准后落盘）。 */
  addWhitelistEntry(entry: WhitelistEntry): Promise<void>;
  /** 工作区声明（软约束）：宿主注入 system 消息/协议文本。 */
  workspaceConstraint(): string;
}
```

`src/heart/loop.ts`（增量修改，不动既有 allowed/blocked 段）：

```ts
import { matchKeyFor } from "../nose/policy.js";
import { fail, type ApprovalPrompt, type MouthContract } from "../types/index.js";

export interface AgentLoopOptions {
  // ...现有字段...
  mouth: MouthContract;
}

export class AgentLoop {
  // ...现有字段...
  readonly #mouth: MouthContract;

  constructor(options: AgentLoopOptions) {
    // ...现有赋值...
    this.#mouth = options.mouth;
  }

  // #execute 中，allowed 段之后、blocked 段之前插入 pending 段：
  for (const call of verdict.pending) {
    if (this.#signal.aborted) {
      this.#status = "INTERRUPTED";
      return;
    }
    if (this.#turnTimedOut) {
      this.#output.warn("任务超时，已终止本轮。");
      return;
    }
    const isWrite = call.name === "write_file" || call.name === "apply_patch";
    const prompt: ApprovalPrompt = {
      tool: call.name,
      key: matchKeyFor(call) ?? "",
      kind: isWrite ? "path" : "exact",
    };
    const choice = await this.#mouth.askApproval(prompt);
    if (choice.action === "deny") {
      const denied = fail("USER_DENIED", `用户拒绝了工具调用: ${call.name}`);
      this.#finish(call.name, denied);
      this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(denied) });
      continue;
    }
    if (choice.action === "whitelist") {
      await this.#brain.addWhitelistEntry(choice.entry);
      this.#output.info(`已加入白名单：${choice.entry.tool} ${choice.entry.key}`);
    }
    this.#emit("ACTING", call.name);
    const result = await executeTool(
      { eyes: this.#eyes, hands: this.#hands },
      call.name,
      call.arguments,
      turnSignal,
    );
    this.#finish(call.name, result);
    this.#context.add({ role: "tool", name: call.name, content: JSON.stringify(result) });
  }
```

`src/agent.ts`：

```ts
// HumanAgent.run()：loop 构造加 mouth；运行前注入工作区 system 消息（幂等）
async run(): Promise<AgentStatus> {
  if (!this.context.getAll().some((message) => message.role === "system")) {
    this.context.add({ role: "system", content: this.brain.workspaceConstraint() });
  }
  const loop = new AgentLoop({
    brain: this.brain,
    mouth: this.mouth,
    // ...其余不变
  });
  await loop.run();
  return loop.getStatus();
}

// buildDefaultBrain 不再接收 nose/mouth：
function buildDefaultBrain(): BrainInference {
  return new OllamaThinking({
    ...(process.env.OLLAMA_BASE_URL !== undefined ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
    ...(process.env.OLLAMA_MODEL !== undefined ? { model: process.env.OLLAMA_MODEL } : {}),
  });
}
// 构造处：this.brain = options.brain ?? buildDefaultBrain();
```

（`HumanAgentOptions.nose`/`mouth` 与 `this.nose`/`this.mouth` 字段保留——仍可由外部注入；`buildDefaultNose` 保留。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/loop.test.ts tests/agent.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + 构建 + 提交**

Run: `pnpm test`（应全绿）+ `pnpm build`
Commit: `git add src/brain/llm.ts src/heart/loop.ts src/agent.ts tests/helpers.ts tests/loop.test.ts tests/agent.test.ts && git commit -m "权限：CLI loop 接入统一裁决（pending 走嘴巴三选 + 白名单落盘 + 工作区 system 消息）"`

---

### Task 8: 扩展 content.js 审批弹窗白名单按钮 + 协议

**Files:**
- Modify: `extensions/gemini-bridge/content.js`
- 复核: `extensions/gemini-bridge/background.js`（Task 6 已透传 whitelist）
- 手动 E2E（无测试框架）

**Interfaces:**
- Consumes: Task 6 协议（approval 请求含完整 ToolCall；`POST /approval {id, allowed, whitelist}`）。
- Produces: 弹窗每条调用行内新增白名单按钮：非写类 `[白名单]`；写类（write_file/apply_patch）`[白名单(此路径)] [白名单(此目录)]`；点击后把条目并入本次提交的 `whitelist` 数组并自动勾选该条 allowed。

- [ ] **Step 1: content.js 弹窗改造**

在现有 `showApprovalDialog` 的每条调用行（允许/拒绝按钮旁）追加：

```js
const isWrite = call.name === "write_file" || call.name === "apply_patch";
const wlBtn = document.createElement("button");
wlBtn.textContent = isWrite ? "白名单(此路径)" : "白名单";
wlBtn.className = "ha-btn ha-btn-wl";
wlBtn.onclick = () => {
  decisions[index] = true; // 白名单即允许
  whitelist[index] = buildEntry(call, isWrite ? "path" : "exact");
  refreshRow(row, index);
};
if (isWrite) {
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
```

工具函数（与 policy 归一化一致：路径反斜杠转正斜杠、win32 小写；命令空白折叠；非 terminal/写类的完整参数**深归一 + 键排序**——与桥侧 `serializeArgs` 对齐，否则 exact 校验 400）：

```js
function deepNorm(value) {
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ").replace(/\\/g, "/");
  }
  if (Array.isArray(value)) return value.map(deepNorm);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = deepNorm(value[k]);
    return out;
  }
  return value;
}

function normalizeKey(call, granularity) {
  const args = call.arguments ?? {};
  if (call.name === "write_file" || call.name === "apply_patch") {
    const p = String(args.path ?? "").trim().replace(/\s+/g, " ").replace(/\\/g, "/");
    const lower = /^win/i.test(navigator.platform) ? p.toLowerCase() : p;
    if (granularity === "dir") {
      const i = lower.lastIndexOf("/");
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

function buildEntry(call, granularity) {
  const { key, kind } = normalizeKey(call, granularity);
  return { tool: call.name, key, kind };
}
```

提交逻辑（现有 `postApproval` 调用处改为）：

```js
const payload = { id, allowed: decisions.map(Boolean) };
const wl = Object.values(whitelist).filter(Boolean);
if (wl.length > 0) payload.whitelist = wl;
await postApproval(payload);
```

（`decisions`/`whitelist` 为弹窗级数组：`const decisions = []; const whitelist = [];`，按调用 index 记录；「全部允许」时 whitelist 不自动填充——白名单始终是显式按钮动作。）

- [ ] **Step 2: 手动 E2E 清单（人工验证，不自动化）**

1. 桥服务启动（`GEMINI_BRIDGE_PORT=8765 pnpm dev`）→ 重载扩展。
2. 对话让 Gemini 执行 `ls -la`（未白名单）→ 弹窗出现（而非直接执行）→ 点「白名单」→ 执行成功；再让它执行 `ls -la` → 静默执行无弹窗。
3. 写文件 `write_file {"path":"src/x.ts"}`（工作区内）→ 启动时已注册工作区 → 静默执行无弹窗。
4. 写 `write_file {"path":"/tmp/evil.txt"}`（界外）→ 弹窗 → 「白名单(此目录)」→ 执行；再写 `/tmp/other.txt` → 静默。
5. 让 Gemini 执行 `rm -rf /` → 桥直接回填「BLACKLIST」拒绝，**无弹窗**。
6. 自动授权开关打开 → 未白名单调用静默放行；黑名单仍拦截。
7. 重启桥服务 → 白名单持久化生效（`~/.human-agent/whitelist.json` 存在）。

- [ ] **Step 3: 提交**

Commit: `git add extensions/gemini-bridge/content.js && git commit -m "权限：扩展审批弹窗白名单按钮（路径/目录粒度）+ whitelist 协议"`

---

### Task 9: 文档更新

**Files:**
- Modify: `extensions/gemini-bridge/README.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-08-19-approval-design.md`（v2 spec 审批机制章节修订）

- [ ] **Step 1: extensions README**

「危险命令审批」节改为「权限模型」：裁决矩阵（默认：黑名单→白名单→弹窗；自动：黑名单外全放行）、白名单文件 `~/.human-agent/whitelist.json`（按工作区分节、写类段级前缀、冗余清理）、黑名单内置随版本（系统破坏目标锚定，用户可手改责任自负）、工作区 = 启动 CWD 自动入写白名单（协议文本含工作区声明）、弹窗按钮说明（允许/拒绝/白名单（路径/目录））、状态行「等待授权」保留。
同时改两处旧语义：「首条协议消息以工作区声明开头（其后为【human-agent 工具协议】）」（原「以【human-agent 工具协议】开头」）；「安全」节删除「危险命令不再自动拒绝」措辞 → 统一矩阵描述。

- [ ] **Step 2: 根 README + CLAUDE.md**

架构描述更新：`src/brain/thinking.ts`（BaseThinking 确定性层：权限+反思+工作区）、`src/nose/policy.ts`（PermissionPolicy）、`src/nose/blacklist.ts`、reflection 裁决顺序（黑名单→未知/非法→白名单→pending）、桥与 loop 的 pending 审批通道、MouthContract.askApproval、OllamaThinking/GeminiBridgeThinking 继承 BaseThinking、工作区注册与约束（system 消息 / 协议文本）、BrainInference 增 addWhitelistEntry/workspaceConstraint。删除「鼻子 DANGEROUS 弹窗确认」旧语义（reflection 不再走嘴巴；鼻子保留为独立嗅探模块）。

- [ ] **Step 3: v2 spec 审批章节修订**

`docs/superpowers/specs/2026-08-19-approval-design.md` 中审批机制章节（Ruling ④ 相关）改为新矩阵语义：BLACKLIST / NEEDS_APPROVAL（pending）、whitelist 协议字段与校验、弹窗按钮形态；注明本 spec 与 2026-08-20-permission-model-design 的从属关系（后者为准）。

- [ ] **Step 4: 全量回归 + 构建 + 提交**

Run: `pnpm test` + `pnpm build`（应全绿）
Commit: `git add extensions/gemini-bridge/README.md README.md CLAUDE.md docs/superpowers/specs/2026-08-19-approval-design.md && git commit -m "文档：权限模型语义更新（裁决矩阵 / 白名单 / 黑名单 / BaseThinking）"`

---

## Self-Review 记录

- **Spec 覆盖**：矩阵（Task 1/2/3）、匹配串（Task 1）、白名单持久化/清理/工作区条目（Task 2/4）、黑名单 v1 内容（Task 1 blacklist.ts，含附录 A 全部类别：根/系统目录删除、rd/del/Remove-Item、启动文件、格式化、整盘擦除、块设备直写与重定向、mkfs/分区表、Boot 注册表、必崩进程、权限全毁）、工作区绑定与提示词约束（Task 4 toolProtocol + Task 7 system 消息 + workspaceConstraint）、弹窗与协议（Task 6/8）、BaseThinking（Task 4）、桥裁决链（Task 6）、CLI 三选（Task 5/7）、文件存储与降级（Task 2）、测试策略（各 Task）、文档（Task 9）。
- **两处澄清**见 Global Constraints（裁决顺序、工作区单条目）。
- **类型一致性**：`WhitelistEntry` 在 types/organ.ts 唯一定义（Task 1）；`ApprovalPrompt`/`ApprovalChoice` 同处（Task 5）；`ReflectionVerdict.pending` 全程一致（Task 3 → 6/7）；`matchKeyFor`/`buildWhitelistEntry`/`normalizePath`/`normalizeCommand`/`toolMatches`/`keyMatches` 命名全程一致；`PermissionPolicy` 公开面 Task 1（内存）→ Task 2（+file/addEntry/ensureWorkspace）只增不改；BrainInference 两新方法（Task 7）与 BaseThinking 同名方法一一对应。
- **已修的计划内缺陷（对照现有代码核实）**：`#permission` 为基类私有字段，桥侧改用公开 `addWhitelistEntry`（Task 6 代码即如此）；Task 6 测试 helper 名与实际文件对齐（makeBridge/postReply/toolCall/getMessageText/postApproval + 新增 tryGetMessage/seedWhitelist）；所有桥/thinking 测试强制注入临时白名单（防污染真实 `~/.human-agent/whitelist.json`）；Task 2 测试共享文件加 beforeEach 清理；黑名单正则与归一化对齐（reg delete 正斜杠、dd of= 归一化、windows 目录终结符防 `C:\Windows\Temp` 误判、补启动文件与块设备重定向模式）；CLI 工作区声明落实为 BrainInference.workspaceConstraint + agent.run() 注入（非占位）；Task 4 同步 agent.ts buildBridgeService（防 build 红）；ollama-thinking.test.ts reflect 用例按新语义重写。
