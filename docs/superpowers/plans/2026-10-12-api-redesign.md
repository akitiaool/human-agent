# API 重设计实施计划（三域三根 · 统一信封 · 扩展零手抄）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 完成 API 重设计：新增 `tool` / `permission` 两域并原子切换到新工具名、新面（`bridge.createBridge`）、统一 `status` 信封与判别联合 `ActionResult`，扩展侧零手抄，文档同步。

**Architecture:** 先并行新建 `src/tool/`（工具知识唯一来源）与 `src/permission/`（键/裁决/白名单/候选/黑名单，工厂函数 + 单一 `store.ts`），再翻转 `ActionResult` 为判别联合并对旧代码面做 kebab 错误码清扫（每个任务结束全绿），然后**一次原子切换**：重写 reflection/executor/loop/ollama-thinking/ask-user/agent/cli、新建 `src/bridge/`（createBridge + 统一信封路由 + 管线）、删除全部旧模块（knowledge/thinking/gemini-bridge-thinking/nose 四件套），最后切换扩展（端点 + options 渲染）与文档（CLAUDE.md 词根表 + README）。旧文件格式无迁移（version≠1 整档空）。

**Tech Stack:** TypeScript 7（strict、NodeNext ESM、exactOptionalPropertyTypes、noUncheckedIndexedAccess）、zod 4（`z.toJSONSchema`、`z.strictObject`）、vitest 4、node:http、pnpm。

**Spec:** `docs/superpowers/specs/2026-10-12-api-redesign-design.md`（本计划的绑定权威；冲突以 spec 为准）

## Global Constraints

- 词形规则全局唯一（spec §1/§7）：判别词唯一 `status`（`ok`/`success` 布尔判别全系统退役）；值词（错误码/裁决值/入库状态/type）全部 **kebab**；工具名 **snake**（file_read / file_write / file_edit / file_patch / dir_list / code_search / command_run / page_fetch）；JSON 结构键多词 kebab（`deny-count`、`write-path`、`first-seen`、`last-seen`）；Node errno 透传码（ENOENT 等）原样。
- 自有错误码（kebab）：blacklist、unknown-tool、invalid-args、user-denied、dependency-blocked、exec-timeout、exec-error、read-error、write-error、patch-not-found、empty-search、invalid-pattern、fetch-error、workspace-invalid；另按同一规则外推：hunk-not-found、ambiguous-match、version-mismatch、file-not-found。
- 传输错误码（closed）：invalid-body / unknown-endpoint / method-not-allowed / unknown-approval / internal → HTTP 400/404/405/404/500。
- 信封：`{status:"ok", data?}` | `{status:"error", error:{code,message}}`；**域失败永不抬升为信封失败**（command_run 超时 → 信封 ok、data 内域结果 status:"error"）；裸 204 仅用于空长轮询；message 仅存在于失败侧。
- 文件格式 v1：whitelist.json / candidates.json 统一 `{version:1, workspaces:{<工作区匹配键>: [...]}}`；写入只经 `store.ts`；version≠1 或损坏 → 整档空；无迁移代码、不留旧名别名/兼容 shim。
- 桥管道不变量保持：parseToolCalls 严格解析（无容错兜底）；无调用 `processed:false` 自终止（**不得**重新引入内容去重）；审批 600s 兜底超时；批级执行超时缺省 300_000；候选两钩子（审批回执落地即记、600s 超时 settle 记拒绝）；close 释放不记候选；候选容量帽 200 条 / 30 天；裁决顺序（黑名单 → 未知工具 → 非法参数 → 白名单放行 → pending）；写信任蕴含读；管道失败按未信任（绝不回退词法结果）；执行落点 = 判定落点；目录条目自覆盖（`w/` 匹配 `w`）。
- TS：strict、**严禁 any**、NodeNext ESM 相对导入带 `.js`、exactOptionalPropertyTypes（可选属性用条件展开 `...(x !== undefined ? { k: x } : {})`）。
- TDD：每任务先写失败测试；任务结束 `pnpm test` 全绿（基线 293）+ `pnpm build` 干净；提交信息中文、**不含** Co-Authored-By / Generated 等署名（用户全局规则）。
- 扩展无测试框架：Task 9 靠逐项人工 review；真实 E2E 由用户执行（spec §12.3）。

## 计划裁定（对照 spec 的实现细节，已在探索期定夺）

1. **`approvalTimeoutMs` 进 createBridge 选项**（缺省 600_000）：spec §4 选项表未列，为测试注入所需（旧桥类同款选项）。
2. **`/agent/info` 与 `constraint()` 文案用 realpath 后的原大小写工作区字符串**（展示友好）；匹配键仍一律 win32 小写（`normalizeMatchKey`）。
3. **旧 `normalizeEntryKey` 对非路径工具的潜在 bug 一并修复**：新 `key.normalize` 对 command_run 走命令归一、路径工具走路径归一、**其余（page_fetch/表外）仅 `trim()`**——旧实现对 fetch_page 的 exact JSON 键走了路径归一（会折叠 `//`、mangle URL）。
4. **扩展侧伪码 `bridge-unreachable`**：extension 本地传输失败（网络错误/超时）的呈现用代码，非桥面词表；README 说明。
5. **`createKey` 的 workspace 收 realpath 原大小写**（spec §3.1：workspace 为「已 realpath 规范的绝对路径」）：匹配键输出仍在管道末端经 `normalizeMatchKey`（win32 小写），`execPath` 词法回退基准用原大小写（保执行落点显示与旧 executor 行为一致）。`createPermission` 以 `options.workspace`（非 `workspaceKey`）构造 `createKey`；`workspaceKey` 仅用于分节键与构造注册条目。

## Review Focus（spec 隐含、任务测试未覆盖时最易咬人的五类输入/条件）

1. **realpath 管道失败必须按未信任处置**——玩具目录被删除/权限拒绝时，`key.of` 返回 undefined，裁决必须落 unlisted（弹窗），绝不回退词法结果用于匹配（测试：Task 3 mock realpathFn 抛错；Task 4 未列分支）。
2. **grant 核销只在 `added` 时执行**（⑯ 结构修复）——duplicate/covered/rejected 时 `retired` 必须为 0 且候选档案原样；落盘失败经 logger 报告但内存条目仍生效（测试：Task 5 四状态 + 落盘失败注入）。
3. **写信任蕴含读的方向语义全链一致**（6ac934c 回归）——写条目覆盖同 target 读调用、读条目不覆盖写；加父去子只删方向语义允许的子（测试：Task 1 covers 矩阵 + Task 5 方向回归）。
4. **审批 options 回显校验与旧语义等价**——echo 条目必须 field-equal 某 `allowed=true` 调用的 `options[i]` 成员；echo null/未知/未 allowed 调用的 option 一律 400 且不落盘（测试：Task 8 bridge 用例）。
5. **信封与域结果分层不混**——command_run 超时信封仍 `status:"ok"`；畸形 body → 400 invalid-body 且无 data；裸 204 仅空长轮询（测试：Task 7 ok/fail 形状 + Task 8）。

---

### Task 1: tool 域（schemas / meta / covers / protocol）

**Files:**
- Create: `src/tool/schemas.ts`、`src/tool/protocol.ts`、`src/tool/index.ts`
- Test: `tests/tool-domain.test.ts`

**Interfaces:**
- Consumes: `ToolInfo` 类型（`src/brain/llm.ts`，type-only）；zod。
- Produces（后续全部任务消费）：`namespace tool { names, meta, schemas, infos, covers, protocol }`；`ToolName`（= keyof typeof schemas）、`ToolMeta`、`Scope`（"self"|"subtree"）、`TrustEntry {tool,key,scope}`、`isToolName(name): name is ToolName`。

- [ ] **Step 1: 写失败测试** `tests/tool-domain.test.ts`

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/tool-domain.test.ts`
Expected: FAIL（无法解析 `../src/tool/index.js`）

- [ ] **Step 3: 写 `src/tool/schemas.ts`**

```ts
// 工具知识唯一来源：schema + 描述 + 元数据（协议展示顺序 = names 顺序；硬规 1：编译期穷尽）。
import { z } from "zod";
import type { ToolInfo } from "../brain/llm.js";

export const schemas = {
  file_read: z.object({
    path: z.string().describe("文件路径"),
    start_line: z.number().int().positive().optional().describe("起始行号（从 1 开始，可选切片读取）"),
    line_count: z.number().int().positive().optional().describe("读取行数（可选切片读取）"),
  }),
  file_write: z.object({
    path: z.string().describe("文件路径"),
    content: z.string().describe("完整写入内容"),
  }),
  file_edit: z.object({
    path: z.string().describe("文件路径"),
    base_version: z.string().optional().describe("基准快照版本号（例如 v-a1b2c3d4，用于乐观锁校验）"),
  }),
  file_patch: z.object({
    path: z.string().describe("文件路径"),
    patch: z.string().describe("行级 patch 内容"),
  }),
  dir_list: z.object({ path: z.string().describe("目录路径") }),
  code_search: z.object({
    pattern: z.string().describe("检索正则表达式"),
    dir: z.string().optional().describe("检索目录（默认工作区）"),
  }),
  command_run: z.object({
    command: z.string().describe("待执行命令"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .describe("命令超时毫秒数（可选，默认由任务超时控制）")
      .optional(),
  }),
  page_fetch: z.object({ url: z.string().describe("网页 URL") }),
} as const;

export type ToolName = keyof typeof schemas;

export interface ToolMeta {
  target: "path" | "command" | "url";
  access: "read" | "write";
}

export type Scope = "self" | "subtree";
export interface TrustEntry {
  tool: string;
  key: string;
  scope: Scope;
}

/** 有序数组 = 协议展示顺序（spec §2）。 */
export const names = [
  "file_read",
  "file_write",
  "file_edit",
  "file_patch",
  "dir_list",
  "code_search",
  "command_run",
  "page_fetch",
] as const satisfies readonly ToolName[];

export const meta: Record<ToolName, ToolMeta> = {
  file_read: { target: "path", access: "read" },
  file_write: { target: "path", access: "write" },
  file_edit: { target: "path", access: "write" },
  file_patch: { target: "path", access: "write" },
  dir_list: { target: "path", access: "read" },
  code_search: { target: "path", access: "read" },
  command_run: { target: "command", access: "write" },
  page_fetch: { target: "url", access: "read" },
};

export const descriptions: Record<ToolName, string> = {
  file_read: "读取指定文件的内容（支持 start_line 与 line_count 切片读取，返回带行号与 version_id 的快照）",
  file_write: "全量写入文件内容（自动创建父目录）",
  file_edit: "局部精确代码替换（配合 <::: BEFORE ... <::> AFTER 语法，支持 base_version 快照锁）",
  file_patch: "对文件应用行级补丁",
  dir_list: "列出指定目录的条目",
  code_search: "在目录中检索匹配正则表达式的文件内容",
  command_run: "执行 shell 命令（可指定 timeoutMs 毫秒超时，超时自动终止）",
  page_fetch: "抓取网页并转换为 Markdown",
};

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name);
}

export type { ToolInfo };
```

- [ ] **Step 4: 写 `src/tool/protocol.ts`**

规则正文**逐字复制** `src/brain/knowledge.ts:60-137`，仅做以下字面替换（spec §11：其余一字不动，`DEPENDENCY_BLOCKED` 保留原样）：

- 第 71 行 `tool: read_file` → `tool: file_read`
- 第 77 行 `（write_file 原生无转义 CONTENT 语法）` → `（file_write 原生无转义 CONTENT 语法）`；第 80 行 `tool: write_file` → `tool: file_write`
- 第 87 行 `（edit_file 原生无转义 N+1 流式 Diff 语法）` → `（file_edit 原生无转义 N+1 流式 Diff 语法）`；第 90 行 `tool: edit_file` → `tool: file_edit`
- 第 104 行 `（terminal 原生无转义 COMMAND 语法）` → `（command_run 原生无转义 COMMAND 语法）`；第 107 行 `tool: terminal` → `tool: command_run`
- 第 118 行、第 124 行（PIPELINE 示例内）`tool: terminal` → `tool: command_run`

文件头与导出：

```ts
// 协议文本模板：规则正文只做工具名逐字替换（spec §11——"DEPENDENCY_BLOCKED" 为语义标签，保留原样）。
import { z } from "zod";
import { descriptions, names, schemas } from "./schemas.js";

const PROTOCOL_HEADER =
  "【human-agent 工具协议】你是 human-agent 智能体的大脑，通过调用工具与本地环境交互。";

// ← PROTOCOL_RULES：逐字复制 knowledge.ts:63-137（按上方替换表），保持 .join("\n") 不变
const PROTOCOL_RULES = [ /* ...逐字复制+替换... */ ].join("\n");

/** 序列化工具协议文本（每轮思考完整注入；可靠性与旧行为一致）。 */
export function protocol(): string {
  const toolLines = names.map(
    (name, index) =>
      `${index + 1}. ${name}: ${descriptions[name]} | ${JSON.stringify(z.toJSONSchema(schemas[name]))}`,
  );
  return `${PROTOCOL_HEADER}\n可用工具（名称：用途 | 参数）：\n${toolLines.join("\n")}\n${PROTOCOL_RULES}`;
}
```

- [ ] **Step 5: 写 `src/tool/index.ts`**

```ts
// tool 域组装：工具知识唯一来源的对外面（硬规 5：成员表冻结断言）。
import { z } from "zod";
import type { ToolInfo } from "../brain/llm.js";
import {
  descriptions,
  isToolName,
  meta,
  names,
  schemas,
  type Scope,
  type ToolMeta,
  type ToolName,
  type TrustEntry,
} from "./schemas.js";
import { protocol } from "./protocol.js";

export { descriptions, isToolName, meta, names, schemas };
export type { Scope, ToolMeta, ToolName, TrustEntry };

/** 唯一覆盖判定（spec §2）：工具方向（同名；或同 target 且「条目 access=write 或 调用 access=read」）+ 键方向（self 相等；subtree 前缀 + 自覆盖）。 */
export function covers(entry: TrustEntry, call: { name: string; key: string }): boolean {
  const entryMeta: ToolMeta | undefined = (meta as Record<string, ToolMeta | undefined>)[entry.tool];
  const callMeta: ToolMeta | undefined = (meta as Record<string, ToolMeta | undefined>)[call.name];
  const toolOk =
    entry.tool === call.name ||
    (entryMeta !== undefined &&
      callMeta !== undefined &&
      entryMeta.target === callMeta.target &&
      (entryMeta.access === "write" || callMeta.access === "read"));
  if (!toolOk) return false;
  if (entry.scope === "self") return entry.key === call.key;
  return (
    call.key === entry.key ||
    call.key === entry.key.slice(0, -1) ||
    call.key.startsWith(entry.key)
  );
}

/** 供 infer 的工具列表（name/description/parameters）。 */
export const infos: readonly ToolInfo[] = names.map((name) => ({
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(schemas[name]) as Record<string, unknown>,
}));

export const tool = { names, meta, schemas, infos, covers, protocol } as const;
export type ToolDomain = typeof tool;
```

- [ ] **Step 6: 全量测试 + build + 提交**

Run: `pnpm test && pnpm build`
Expected: 全绿（旧测试不受影响：旧 knowledge.ts 仍在）+ build 干净。

```bash
git add src/tool tests/tool-domain.test.ts
git commit -m "实现：tool 域——schemas/meta/covers/protocol 唯一来源（编译期穷尽 + 快照测试）"
```

---

### Task 2: permission/store.ts（共享容器 v1）

**Files:**
- Create: `src/permission/store.ts`
- Test: `tests/permission-store.test.ts`

**Interfaces:**
- Produces：`Container<T> {version:1, workspaces}`、`emptyContainer<T>()`、`loadContainer<T>(file, parseItem)`、`saveContainer<T>(file, container): boolean`（永不抛出）。

- [ ] **Step 1: 写失败测试** `tests/permission-store.test.ts`

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyContainer, loadContainer, saveContainer, type Container } from "../src/permission/store.js";

interface Item { id: string }
const parseItem = (raw: unknown): Item | null =>
  typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
    ? { id: (raw as { id: string }).id }
    : null;

const dir = (): string => mkdtempSync(join(tmpdir(), "store-"));

describe("permission/store", () => {
  it("roundtrip：save → load 保真", () => {
    const file = join(dir(), "w.json");
    const container: Container<Item> = { version: 1, workspaces: { "/ws": [{ id: "a" }] } };
    expect(saveContainer(file, container)).toBe(true);
    expect(loadContainer(file, parseItem)).toEqual(container);
  });

  it("文件不存在 → 空容器", () => {
    expect(loadContainer(join(dir(), "nope.json"), parseItem)).toEqual(emptyContainer<Item>());
  });

  it("损坏 JSON → 空容器", () => {
    const file = join(dir(), "bad.json");
    writeFileSync(file, "{oops", "utf8");
    expect(loadContainer(file, parseItem)).toEqual(emptyContainer<Item>());
  });

  it("version ≠ 1 → 整档空", () => {
    const file = join(dir(), "v2.json");
    writeFileSync(file, JSON.stringify({ version: 2, workspaces: { "/ws": [{ id: "a" }] } }), "utf8");
    expect(loadContainer(file, parseItem)).toEqual(emptyContainer<Item>());
  });

  it("非数组分节跳过；坏条目经 parseItem 丢弃", () => {
    const file = join(dir(), "mixed.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, workspaces: { "/ws": [{ id: "a" }, { nope: 1 }], "/other": "garbage" } }),
      "utf8",
    );
    expect(loadContainer(file, parseItem)).toEqual({ version: 1, workspaces: { "/ws": [{ id: "a" }] } });
  });

  it("save 失败返回 false 不抛错（目标路径被文件占位）", () => {
    const d = dir();
    const blocker = join(d, "blocker");
    writeFileSync(blocker, "x", "utf8");
    expect(saveContainer(join(blocker, "w.json"), emptyContainer<Item>())).toBe(false);
  });

  it("写盘序列化 = JSON（供人工核 v1 格式）", () => {
    const file = join(dir(), "w.json");
    saveContainer(file, { version: 1, workspaces: { "/ws": [{ id: "a" }] } });
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(1);
    expect(raw["workspaces"]).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm exec vitest run tests/permission-store.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 写 `src/permission/store.ts`**

```ts
// 权限文件共享存储：白名单与候选同一容器（version 1），单一读写/校验模块（硬规 3）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Container<T> {
  version: 1;
  workspaces: Record<string, T[]>;
}

export function emptyContainer<T>(): Container<T> {
  return { version: 1, workspaces: {} };
}

/** 加载：损坏 / version≠1 / 顶层结构不符 → 空容器；非数组分节跳过；条目交 parseItem（null 丢弃）。 */
export function loadContainer<T>(file: string, parseItem: (item: unknown) => T | null): Container<T> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptyContainer<T>();
    const record = parsed as { version?: unknown; workspaces?: unknown };
    if (record.version !== 1) return emptyContainer<T>();
    if (typeof record.workspaces !== "object" || record.workspaces === null || Array.isArray(record.workspaces)) {
      return emptyContainer<T>();
    }
    const workspaces: Record<string, T[]> = {};
    for (const [key, items] of Object.entries(record.workspaces as Record<string, unknown>)) {
      if (!Array.isArray(items)) continue;
      workspaces[key] = items.map(parseItem).filter((item): item is T => item !== null);
    }
    return { version: 1, workspaces };
  } catch {
    return emptyContainer<T>();
  }
}

/** 落盘：失败返回 false，永不抛出（调用方经注入 logger 报告）。 */
export function saveContainer<T>(file: string, container: Container<T>): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(container, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 验证通过** — `pnpm exec vitest run tests/permission-store.test.ts` → PASS
- [ ] **Step 5: 全量测试 + 提交**

```bash
pnpm test && git add src/permission/store.ts tests/permission-store.test.ts
git commit -m "实现：permission/store.ts——v1 共享容器（单一读写/校验，落盘失败不抛错）"
```

---

### Task 3: permission/key.ts（规范匹配键管道 + 条目归一 + optionsFor）

**Files:**
- Create: `src/permission/key.ts`
- Test: `tests/permission-key.test.ts`

**Interfaces:**
- Consumes: `ToolCall`（type-only，`src/brain/llm.js`）；`isToolName/meta/Scope/TrustEntry`（tool 域）。
- Produces：`RealpathFn`、`defaultRealpath`、`normalizeMatchKey(path)`、`KeyService {of, normalize, entryFor, optionsFor, execPath}`、`createKey({workspace, realpathFn?})`。

- [ ] **Step 1: 写失败测试** `tests/permission-key.test.ts`

移植 `tests/workspace-path.test.ts`（11 例）与 `tests/policy.test.ts` 的归一/探针用例（normalizePath 文本 ×3、matchKeyFor 探针 ×10），改为对 `createKey` 的 `of/normalize` 断言，并新增：

```ts
import { describe, expect, it } from "vitest";
import { createKey, normalizeMatchKey, type RealpathFn } from "../src/permission/key.js";
import type { ToolCall } from "../src/brain/llm.js";

// 参照旧 tests/workspace-path.test.ts 的 tmp 目录 + realpath 实测风格建立夹具：
// const wsDir = mkdtempSync(join(tmpdir(), "key-")); const wsReal = realpathSync.native(wsDir);
// createKey 收 realpath 原大小写工作区（裁定 5）；匹配键断言经 normalizeMatchKey（win32 小写）。

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

  it("normalize：目录条目尾 / 保留；command_run 走命令归一", () => {
    const key = createKey({ workspace: wsReal });
    expect(key.normalize({ tool: "file_write", key: "src\\" })).toMatch(/\/$/);
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
```

- [ ] **Step 2: 运行确认失败** — `pnpm exec vitest run tests/permission-key.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 写 `src/permission/key.ts`**

移植来源与改造清单：
- `resolveWorkspacePath` 主体（`src/nose/workspace-path.ts`）→ 内部 `resolvePipeline(input): {execPath, matchKey} | null`（闭包持 `workspace`/`realpathFn`），逐段上溯最深已存在祖先 + realpath + 拼尾段，catch → null。**逐字移植，不改算法**。
- `normalizeMatchKey`（同文件）逐字移植并导出。
- `defaultRealpath = (p) => realpathSync.native(p)`。
- `createKey` 的 `workspace` 参数 = **realpath 原大小写**工作区（裁定 5）；闭包以它为 resolve 基准；匹配键输出一律在管道末端经 `normalizeMatchKey`（win32 小写）；`execPath` 词法回退用同一原大小写基准（`resolvePath(workspace, input)`）。
- `resolvePathSegments` / `normalizePath`（文本归一）/ `normalizeCommand` / `serializeArgs` / `normalizeValue`（`src/nose/policy.ts`）逐字移植（`normalizePath` 改名内部使用）。
- `pathArgOf`：`code_search` → `dir` 非空串否则 `"."`；其余 path 工具（`isToolName && meta.target === "path"`）→ `path` 非空串否则 undefined。
- `of`：`command_run` → `arguments.command` 为非空字符串则 `normalizeCommand`；path 工具 → 管道 matchKey（失败 undefined）；其余 → `serializeArgs(arguments ?? {})`。
- `normalize(entry)`：`command_run` → `normalizeCommand`；path 工具 → 路径归一 + 尾 `/` 保留（移植旧 `normalizeEntryKey` 的 had-trailing 逻辑）；**其余 → `entry.key.trim()`**。
- `entryFor(tool, key, scope)`：`key === ""` → null；`self` → `{tool, key, scope:"self"}`；`subtree`：非 path 工具（含未知名）→ null；`key === "/"` 或 `/^[a-z]:\/$/i` → 降级 self；`dir_list`/`code_search` → `${key}/`；否则 `i = key.lastIndexOf("/")`，`i <= 0 || (i === 2 && key[1] === ":")` → 降级 self，否则 `{tool, key.slice(0,i) + "/", scope:"subtree"}`（移植旧 `dirEntryKey` 语义）。
- `optionsFor(call)`：`of` 为 undefined/"" → `[]`；self 条目 + `entryFor(..., "subtree")` 返回 scope==="subtree" 时追加为第二项；否则 `[self]`。
- `execPath(input)`：管道 execPath，失败回退 `resolvePath(workspace, input)`（移植旧 executor 的 execPathFor 回退，永不为 null）。

骨架（具体函数体按上述清单移植）：

```ts
// 规范匹配键管道与条目键归一（原 workspace-path.ts + policy.ts 归一/匹配族迁入；管道失败按未信任）。
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ToolCall } from "../brain/llm.js";
import { isToolName, meta, type Scope, type TrustEntry } from "../tool/index.js";

export type RealpathFn = (path: string) => string;
export const defaultRealpath: RealpathFn = (path) => realpathSync.native(path);

export function normalizeMatchKey(path: string): string {
  const out = path.replace(/\\/g, "/");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

export interface KeyService {
  of(call: ToolCall): string | undefined;
  normalize(entry: Pick<TrustEntry, "tool" | "key">): string;
  entryFor(tool: string, key: string, scope: Scope): TrustEntry | null;
  optionsFor(call: ToolCall): TrustEntry[];
  execPath(input: string): string;
}

export function createKey(options: { workspace: string; realpathFn?: RealpathFn }): KeyService {
  const workspace = options.workspace;
  const realpathFn = options.realpathFn ?? defaultRealpath;
  // resolvePipeline / normalizePathText / normalizeCommand / serializeArgs / pathArgOf 为模块级纯函数
  // of / normalize / entryFor / optionsFor / execPath 闭包实现（见上方移植清单）
}
```

- [ ] **Step 4: 验证通过** — `pnpm exec vitest run tests/permission-key.test.ts` → PASS
- [ ] **Step 5: 全量测试 + 提交**

```bash
pnpm test && git add src/permission/key.ts tests/permission-key.test.ts
git commit -m "实现：permission/key.ts——匹配键管道/归一/entryFor/optionsFor/execPath 归于一域"
```

---

### Task 4: permission/blacklist.ts + verdict.ts

**Files:**
- Create: `src/permission/blacklist.ts`（模式逐字复制 `src/nose/blacklist.ts`，导出改名 `commandPatterns` / `writePathPatterns`）、`src/permission/verdict.ts`
- Test: `tests/permission-verdict.test.ts`

**Interfaces:**
- Consumes: `KeyService`（Task 3）；`covers/isToolName/meta/TrustEntry`（Task 1）。
- Produces：`PermissionVerdict {status:"allowed"|"blacklist"|"unlisted", key?}`、`createVerdict({key, entries})`、`commandPatterns`、`writePathPatterns`。

- [ ] **Step 1: 写失败测试** `tests/permission-verdict.test.ts`

移植 `tests/policy.test.ts` 的黑名单用例（×4）与白名单匹配/探针用例（×10 探针 + ×7 匹配），构建 `createKey` + 注入 `entries: () => [...]` 的 `createVerdict`：

```ts
import { describe, expect, it } from "vitest";
import { createKey, normalizeMatchKey } from "../src/permission/key.js";
import { createVerdict } from "../src/permission/verdict.js";
import type { TrustEntry } from "../src/tool/index.js";

// 夹具同 Task 3（wsReal）。makeVerdict(entries) = createVerdict({ key: createKey({workspace: wsReal}), entries: () => entries })

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
```

- [ ] **Step 2: 运行确认失败** — FAIL（模块不存在）
- [ ] **Step 3: 写 `src/permission/blacklist.ts`**

逐字复制 `src/nose/blacklist.ts` 的两个数组与注释（含模式本体与 `i`/`\s+` 等全部细节），导出名改为 `commandPatterns` / `writePathPatterns`，文件头注释保留「内置随版本，用户可手改责任自负」。

- [ ] **Step 4: 写 `src/permission/verdict.ts`**

```ts
// 裁决：黑名单（绝对禁止）→ 白名单（工具 covers 统一覆盖判定）→ 未列（键缺失按未信任）。
import type { ToolCall } from "../brain/llm.js";
import { covers, isToolName, meta, type TrustEntry } from "../tool/index.js";
import { commandPatterns, writePathPatterns } from "./blacklist.js";
import type { KeyService } from "./key.js";

export interface PermissionVerdict {
  status: "allowed" | "blacklist" | "unlisted";
  key?: string;
}

export function createVerdict(options: {
  key: KeyService;
  entries: () => readonly TrustEntry[];
}): { decide(call: ToolCall): PermissionVerdict } {
  const { key, entries } = options;
  return {
    decide(call) {
      const matchKey = key.of(call);
      if (matchKey === undefined) return { status: "unlisted" };
      if (commandPatterns.some((pattern) => pattern.test(matchKey))) return { status: "blacklist", key: matchKey };
      if (
        isToolName(call.name) &&
        meta[call.name].target === "path" &&
        meta[call.name].access === "write" &&
        writePathPatterns.some((pattern) => pattern.test(matchKey))
      ) {
        return { status: "blacklist", key: matchKey };
      }
      for (const entry of entries()) {
        if (covers(entry, { name: call.name, key: matchKey })) return { status: "allowed", key: matchKey };
      }
      return { status: "unlisted", key: matchKey };
    },
  };
}
```

- [ ] **Step 5: 验证通过 + 全量 + 提交**

```bash
pnpm exec vitest run tests/permission-verdict.test.ts && pnpm test
git add src/permission/blacklist.ts src/permission/verdict.ts tests/permission-verdict.test.ts
git commit -m "实现：permission 黑名单与裁决（covers 统一判定，写形态黑名单仅写类工具命中）"
```

---

### Task 5: permission/whitelist.ts + candidates.ts（grant 面 ⑯ 结构修复）

**Files:**
- Create: `src/permission/whitelist.ts`、`src/permission/candidates.ts`
- Test: `tests/permission-whitelist.test.ts`、`tests/permission-candidates.test.ts`

**Interfaces:**
- Consumes: `store.ts`（Task 2）、`KeyService`（Task 3）、`covers/isToolName`（Task 1）。
- Produces：`AddResult`、`GrantResult {entry, add, retired}`、`createWhitelist({workspaceKey, file, key, retire, logger})`；`CandidateRecord {tool,key,"deny-count","allow-count","first-seen","last-seen"}`、`createCandidates({workspaceKey, file, logger, now?, maxEntries?, maxAgeDays?})`。

- [ ] **Step 1: 写失败测试** `tests/permission-whitelist.test.ts`（移植 `tests/policy.test.ts` 持久化分区 ×11，含 6ac934c 方向回归）

关键新用例（完整断言）：

```ts
import { describe, expect, it, vi } from "vitest";
// 夹具：tmp 目录 + realpath 实测（同 Task 3）；key = createKey({workspace: wsReal})
// nk(p) = key.normalize({ tool: "file_write", key: p })——store 中的键一律归一态（win32 小写 + 正斜杠），断言用 nk 包裹期望值
// mk = (over) => createWhitelist({ workspaceKey: normalizeMatchKey(wsReal), file: join(tmp, "whitelist.json"), key, retire: over?.retire ?? (() => 0), logger: over?.logger ?? (() => {}) });

describe("permission/whitelist grant", () => {
  it("added：落盘且核销候选（retired = retire 调用返回值）", () => {
    const retire = vi.fn(() => 3);
    const wl = mk({ retire });
    const r = wl.grant({ tool: "file_write", key: join(wsReal, "src/x.ts"), scope: "self" });
    expect(r.add).toEqual({ status: "added" });
    expect(r.retired).toBe(3);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("duplicate / covered / rejected 时 retired = 0 且不核销（⑯）", () => {
    const retire = vi.fn(() => 0);
    const wl = mk({ retire });
    wl.grant({ tool: "file_write", key: `${join(wsReal, "src")}/`, scope: "subtree" });
    retire.mockClear();
    const dup = wl.grant({ tool: "file_write", key: `${join(wsReal, "src")}/`, scope: "subtree" });
    const cov = wl.grant({ tool: "file_read", key: join(wsReal, "src/a.ts"), scope: "self" });
    const rej1 = wl.grant({ tool: "mystery", key: "x", scope: "self" });
    const rej2 = wl.grant({ tool: "file_read", key: "  ", scope: "self" });
    expect(dup.add.status).toBe("duplicate");
    expect(cov.add).toEqual({ status: "covered", by: { tool: "file_write", key: nk(`${join(wsReal, "src")}/`), scope: "subtree" } });
    expect(rej1.add).toEqual({ status: "rejected", reason: "unknown-tool" });
    expect(rej2.add).toEqual({ status: "rejected", reason: "empty-key" });
    expect(retire).not.toHaveBeenCalled();
  });

  it("加父去子方向语义：写条目加父删除被覆盖读写子条目；读条目不得删写子条目（6ac934c 回归）", () => {
    const wl = mk();
    wl.grant({ tool: "file_write", key: join(wsReal, "src/a.ts"), scope: "self" });
    wl.grant({ tool: "file_read", key: join(wsReal, "src/b.ts"), scope: "self" });
    wl.grant({ tool: "file_read", key: `${join(wsReal, "src")}/`, scope: "subtree" }); // 读父：只吃读子
    expect(wl.list().map((e) => `${e.tool}:${e.scope}`)).toContain("file_write:self"); // 写子存活
    expect(wl.list().find((e) => e.tool === "file_read" && e.scope === "self")).toBeUndefined(); // 读子被吃
  });

  it("落盘失败 → logger 报告且内存条目仍生效（added）", () => {
    // file 指向被文件占位的路径（同 store 测试手法）
    const logger = vi.fn();
    const wl = mk({ logger, file: join(blockerFile, "w.json") });
    const r = wl.grant({ tool: "file_write", key: join(wsReal, "a.ts"), scope: "self" });
    expect(r.add.status).toBe("added");
    expect(wl.list()).toHaveLength(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("白名单落盘失败"));
  });
});
```

`tests/permission-candidates.test.ts`（移植 `tests/candidates.test.ts` ×7）：record 聚合/坏键不入档（key "" 或未知工具）/30 天过期剪枝/200 条帽按 last-seen 丢最旧/**dropCoveredBy 只在 covers 命中时删并返回条数**/drop 精确双键对/dropCoveredBy 方向语义（写条目核销读候选）/落盘失败 logger/JSON 字段为 kebab 六字段。

- [ ] **Step 2: 运行确认失败** — FAIL（模块不存在）
- [ ] **Step 3: 写 `src/permission/whitelist.ts`**

```ts
// 白名单：按工作区分节的 TrustEntry 集合；grant = 归一 → 校验 → 去重 → 被覆盖 → 加父去子 → 落盘 → 核销。
import { z } from "zod";
import { covers, isToolName, type TrustEntry } from "../tool/index.js";
import { loadContainer, saveContainer, type Container } from "./store.js";
import type { KeyService } from "./key.js";

const entrySchema = z.strictObject({
  tool: z.string(),
  key: z.string(),
  scope: z.enum(["self", "subtree"]),
});

function parseEntry(item: unknown): TrustEntry | null {
  const parsed = entrySchema.safeParse(item);
  if (!parsed.success || !isToolName(parsed.data.tool)) return null;
  return parsed.data;
}

export type AddResult =
  | { status: "added" }
  | { status: "duplicate" }
  | { status: "covered"; by: TrustEntry }
  | { status: "rejected"; reason: "unknown-tool" | "empty-key" };

export interface GrantResult {
  entry: TrustEntry;
  add: AddResult;
  retired: number;
}

export interface WhitelistService {
  grant(entry: TrustEntry): GrantResult;
  list(): TrustEntry[];
}

export function createWhitelist(options: {
  workspaceKey: string;
  file: string;
  key: KeyService;
  retire: (entry: TrustEntry) => number;
  logger: (message: string) => void;
}): WhitelistService {
  const { workspaceKey, file, key, retire, logger } = options;
  const container: Container<TrustEntry> = loadContainer(file, parseEntry);
  const list = (): TrustEntry[] => [...(container.workspaces[workspaceKey] ?? [])];
  const save = (): void => {
    if (!saveContainer(file, container)) logger(`白名单落盘失败：${file}（内存条目仍生效）`);
  };
  return {
    list,
    grant(entry) {
      const normalized: TrustEntry = { tool: entry.tool, key: key.normalize(entry), scope: entry.scope };
      if (!isToolName(normalized.tool)) {
        return { entry: normalized, add: { status: "rejected", reason: "unknown-tool" }, retired: 0 };
      }
      if (normalized.key === "") {
        return { entry: normalized, add: { status: "rejected", reason: "empty-key" }, retired: 0 };
      }
      const current = list();
      if (current.some((e) => e.tool === normalized.tool && e.scope === normalized.scope && e.key === normalized.key)) {
        return { entry: normalized, add: { status: "duplicate" }, retired: 0 };
      }
      const by = current.find((e) => covers(e, { name: normalized.tool, key: normalized.key }));
      if (by !== undefined) return { entry: normalized, add: { status: "covered", by }, retired: 0 };
      const kept = current.filter((e) => !covers(normalized, { name: e.tool, key: e.key }));
      container.workspaces[workspaceKey] = [...kept, normalized];
      save();
      return { entry: normalized, add: { status: "added" }, retired: retire(normalized) };
    },
  };
}
```

- [ ] **Step 4: 写 `src/permission/candidates.ts`**

工厂化移植 `src/nose/candidates.ts`（聚合/剪枝/帽逻辑逐字保留），字段拼写换 kebab：

```ts
// 信任候选档案：白名单外一切裁决的持久记录（按工作区分节；容量帽 200 条 / 30 天，按 last-seen 丢最旧）。
import { z } from "zod";
import { covers, isToolName, type TrustEntry } from "../tool/index.js";
import { loadContainer, saveContainer, type Container } from "./store.js";

export interface CandidateRecord {
  tool: string;
  key: string;
  "deny-count": number;
  "allow-count": number;
  "first-seen": number;
  "last-seen": number;
}

const recordSchema = z.strictObject({
  tool: z.string(),
  key: z.string(),
  "deny-count": z.number().int().nonnegative(),
  "allow-count": z.number().int().nonnegative(),
  "first-seen": z.number(),
  "last-seen": z.number(),
});

function parseRecord(item: unknown): CandidateRecord | null {
  const parsed = recordSchema.safeParse(item);
  return parsed.success && isToolName(parsed.data.tool) ? parsed.data : null;
}

export interface CandidatesService {
  record(tool: string, key: string, outcome: "allowed" | "denied"): void;
  list(): CandidateRecord[];
  dropCoveredBy(entry: TrustEntry): number;
  drop(items: readonly { tool: string; key: string }[]): number;
}

export function createCandidates(options: {
  workspaceKey: string;
  file: string;
  logger: (message: string) => void;
  now?: () => number;
  maxEntries?: number;
  maxAgeDays?: number;
}): CandidatesService {
  const { workspaceKey, file, logger } = options;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 200;
  const maxAgeDays = options.maxAgeDays ?? 30;
  const container: Container<CandidateRecord> = loadContainer(file, parseRecord);
  // records()/save() 同 whitelist 模式；record 主体逐字移植旧 CandidatesArchive.record
  // （守卫 key==="" || !isToolName → 忽略；命中 (tool,key) 则对应 count++ 与 last-seen 更新；剪枝 30 天 → 帽 200
  //   按 last-seen 丢最旧；save 失败 logger `候选落盘失败：${file}（内存记录仍生效）`）
  // dropCoveredBy：filter(covers(entry, {name: r.tool, key: r.key}))，返回删除条数，删了才 save
  // drop：精确 (tool,key) 对删除，返回条数，删了才 save
  // 实现骨架：
  return {
    record(tool, key, outcome) { /* 移植 */ },
    list() { return [...(container.workspaces[workspaceKey] ?? [])]; },
    dropCoveredBy(entry) { /* 移植 */ return 0; },
    drop(items) { /* 移植 */ return 0; },
  };
}
```

- [ ] **Step 5: 验证通过 + 全量 + 提交**

```bash
pnpm exec vitest run tests/permission-whitelist.test.ts tests/permission-candidates.test.ts && pnpm test
git add src/permission/whitelist.ts src/permission/candidates.ts tests/permission-whitelist.test.ts tests/permission-candidates.test.ts
git commit -m "实现：permission 白名单 grant 面（AddResult/GrantResult，核销只在 added）与候选档案（kebab 字段）"
```

---

### Task 6: permission 门面（createPermission + 模块级 resolve + 快照测试）

**Files:**
- Create: `src/permission/index.ts`
- Test: `tests/permission.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4/5 全部；`homedir`。
- Produces：`Permission` 接口、`createPermission(options)`、模块级 `permission = { workspace: { resolve } }`。

- [ ] **Step 1: 写失败测试** `tests/permission.test.ts`

```ts
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPermission, permission } from "../src/permission/index.js";
import { normalizeMatchKey } from "../src/permission/key.js";

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

  it("硬规 5：Permission 各子命名空间成员快照", () => {
    const p = mkPerm();
    expect(Object.keys(p).sort()).toEqual(["blacklist", "candidates", "key", "verdict", "whitelist", "workspace"]);
    expect(Object.keys(p.key).sort()).toEqual(["entryFor", "execPath", "normalize", "of", "optionsFor"]);
    expect(Object.keys(p.verdict)).toEqual(["decide"]);
    expect(Object.keys(p.whitelist).sort()).toEqual(["grant", "list"]);
    expect(Object.keys(p.blacklist)).toEqual(["list"]);
    expect(Object.keys(p.workspace)).toEqual(["constraint"]);
    expect(Object.keys(p.candidates).sort()).toEqual(["drop", "dropCoveredBy", "list", "record"]);
  });
});
```

（`workspace` 分支断言用实测 `realpathSync.native` 值对比，win32 小写与否以 `resolve` 实现为准——resolve 返回 realpath 原大小写。）

- [ ] **Step 2: 运行确认失败** — FAIL（模块不存在）
- [ ] **Step 3: 写 `src/permission/index.ts`**

```ts
// permission 域门面：构造时绑定工作区与文件；成员不再收 workspace 参数。
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { createKey, normalizeMatchKey, defaultRealpath, type RealpathFn, type KeyService } from "./key.js";
import { createCandidates, type CandidatesService, type CandidateRecord } from "./candidates.js";
import { createWhitelist, type WhitelistService, type GrantResult } from "./whitelist.js";
import { createVerdict, type PermissionVerdict } from "./verdict.js";
import { commandPatterns, writePathPatterns } from "./blacklist.js";

export type { CandidateRecord, GrantResult, KeyService, PermissionVerdict };
export { createKey, normalizeMatchKey, defaultRealpath };

export interface Permission {
  workspace: { constraint(): string };
  key: KeyService;
  verdict: { decide(call: import("../brain/llm.js").ToolCall): PermissionVerdict };
  whitelist: WhitelistService;
  blacklist: { list(): { command: string[]; "write-path": string[] } };
  candidates: CandidatesService;
}

export function createPermission(options: {
  workspace: string;
  whitelistFile?: string;
  candidatesFile?: string;
  realpathFn?: RealpathFn;
  logger?: (message: string) => void;
}): Permission {
  const logger = options.logger ?? ((message: string) => console.error(message));
  const workspaceKey = normalizeMatchKey(options.workspace);
  const whitelistFile = options.whitelistFile ?? join(homedir(), ".human-agent", "whitelist.json");
  const candidatesFile = options.candidatesFile ?? join(homedir(), ".human-agent", "candidates.json");
  const key = createKey({
    workspace: options.workspace, // realpath 原大小写（裁定 5）；匹配键输出仍在管道末端小写化
    ...(options.realpathFn !== undefined ? { realpathFn: options.realpathFn } : {}),
  });
  const candidates = createCandidates({ workspaceKey, file: candidatesFile, logger });
  const whitelist = createWhitelist({
    workspaceKey,
    file: whitelistFile,
    key,
    retire: (entry) => candidates.dropCoveredBy(entry),
    logger,
  });
  const verdict = createVerdict({ key, entries: () => whitelist.list() });
  whitelist.grant({ tool: "file_write", key: `${workspaceKey}/`, scope: "subtree" }); // 构造即注册（幂等）
  return {
    workspace: {
      constraint: () => `你的工作区是 ${options.workspace}，工具调用请保持在界内；界外操作需要用户授权。`,
    },
    key,
    verdict,
    whitelist,
    blacklist: {
      list: () => ({
        command: commandPatterns.map(String),
        "write-path": writePathPatterns.map(String),
      }),
    },
    candidates,
  };
}

/** 模块级成员（构造前使用；鸡生蛋：实例需要先有 workspace）。 */
function resolveWorkspace(
  cliValue: string | undefined,
  envValue: string | undefined,
  cwd: string,
  realpathFn: RealpathFn = defaultRealpath,
): { status: "ok"; workspace: string } | { status: "error"; error: { code: "workspace-invalid"; message: string } } {
  const raw = cliValue ?? envValue ?? cwd;
  let real: string;
  try {
    real = realpathFn(raw);
  } catch {
    return { status: "error", error: { code: "workspace-invalid", message: `工作区不存在或不可访问：${raw}` } };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { status: "error", error: { code: "workspace-invalid", message: `工作区不是目录：${raw}` } };
    }
  } catch {
    return { status: "error", error: { code: "workspace-invalid", message: `工作区不存在或不可访问：${raw}` } };
  }
  return { status: "ok", workspace: real };
}

export const permission = { workspace: { resolve: resolveWorkspace } };
```

（`resolveWorkspace` 的 error 分支文案对齐旧 `resolveStartupWorkspace` 的两条中文消息：不存在/不可访问、不是目录。）

- [ ] **Step 4: 验证通过** — `pnpm exec vitest run tests/permission.test.ts` → PASS
- [ ] **Step 5: 全量测试 + 提交**

```bash
pnpm test && git add src/permission/index.ts tests/permission.test.ts
git commit -m "实现：permission 门面——createPermission（构造绑定+自动注册工作区）与模块级 workspace.resolve"
```

---

### Task 7: ActionResult 判别联合 + 错误码 kebab（旧代码面清扫）

**Files:**
- Modify: `src/types/organ.ts`（ActionResult + ok/fail）、`src/hands/file-writer.ts:106`、`src/brain/gemini-bridge-thinking.ts`（429/432/612/619-621 及全部 fail 码）、`src/hands/terminal.ts`、`src/hands/diff-engine.ts`、`src/eyes/file-reader.ts`、`src/eyes/web-crawler.ts`、`src/brain/reflection.ts`、`src/heart/loop.ts`、`src/heart/executor.ts`
- Test: 全部既有测试（62 处 `success` 断言 + 错误码字符串断言）

**Interfaces:**
- Produces：`ActionResult<T> = {status:"ok"; data?: T} | {status:"error"; error:{code,message,stack?}}`；`ok/fail` 保留名与调用签名。

- [ ] **Step 1: 改 `src/types/organ.ts` 的 ActionResult 与 ok/fail**

```ts
export type ActionResult<T = unknown> =
  | { status: "ok"; data?: T }
  | { status: "error"; error: { code: string; message: string; stack?: string } };

export function ok<T>(data?: T): ActionResult<T> {
  return data === undefined ? { status: "ok" } : { status: "ok", data };
}

export function fail(code: string, message: string, stack?: string): ActionResult<never> {
  return { status: "error", error: stack !== undefined ? { code, message, stack } : { code, message } };
}
```

（调用点签名不变——生产者零改动；`reflection.ts:35` 的 `parsed.success` 是 zod safeParse 属性，**不得**改动。）

- [ ] **Step 2: 更新读取 `.success` 的三处 src 消费点**

- `src/hands/file-writer.ts:106`：`if (!applyRes.success)` → `if (applyRes.status === "error")`
- `src/brain/gemini-bridge-thinking.ts:429`：`return result.success;` → `return result.status === "ok";`（432 同）
- `src/brain/gemini-bridge-thinking.ts:612`：`const status = result.success ? "成功" : "失败";` → `result.status === "ok" ? ...`
- `src/brain/gemini-bridge-thinking.ts:619-621`：改为
  `const code = result.status === "error" ? result.error.code : "unknown";`
  `const reason = result.status === "error" ? result.error.message : JSON.stringify(result);`
  `const status = code === "dependency-blocked" ? "已阻断" : "已拒绝";`（原 `"UNKNOWN"` 兜底随联合消亡）

- [ ] **Step 3: 错误码 kebab 全量替换**

| 旧 | 新 | 位置 |
|---|---|---|
| EXEC_TIMEOUT | exec-timeout | terminal.ts |
| EXEC_ERROR | exec-error | terminal.ts（×2） |
| EMPTY_SEARCH | empty-search | diff-engine.ts |
| HUNK_NOT_FOUND | hunk-not-found | diff-engine.ts |
| AMBIGUOUS_MATCH | ambiguous-match | diff-engine.ts |
| WRITE_ERROR | write-error | file-writer.ts（×3） |
| READ_ERROR | read-error | file-writer.ts（×2）、file-reader.ts（×3） |
| PATCH_NOT_FOUND | patch-not-found | file-writer.ts |
| VERSION_MISMATCH | version-mismatch | file-writer.ts |
| FETCH_ERROR | fetch-error | web-crawler.ts（×2） |
| INVALID_PATTERN | invalid-pattern | file-reader.ts |
| UNKNOWN_TOOL | unknown-tool | executor.ts、reflection.ts |
| BLACKLIST | blacklist | reflection.ts |
| INVALID_ARGS | invalid-args | reflection.ts |
| USER_DENIED | user-denied | loop.ts、gemini-bridge-thinking.ts |
| DEPENDENCY_BLOCKED | dependency-blocked | gemini-bridge-thinking.ts（fail 调用 + 621 比较） |

注意：errno 透传分支（`errnoCode`）不动；`knowledge.ts` 协议文本中的 `DEPENDENCY_BLOCKED` 为语义标签、**本轮不动**（Task 1 已按 spec §11 保留）。

- [ ] **Step 4: 扫尾验证（grep 审计）**

Run: `grep -rn '\.success\|success:' src tests` 与 `grep -rnE '"[A-Z][A-Z_]+"' src tests`
Expected: src 中 SCREAMING 仅剩三类白名单——`knowledge.ts` 协议文本的 `DEPENDENCY_BLOCKED`（spec §11 保留）、HTTP 方法字面量（`GET`/`POST`）、zod 的 `parsed.success`；tests 中仅剩待更新断言与 errno/测试局部码（如 `FILE_NOT_FOUND` → `file-not-found`）。

- [ ] **Step 5: 更新测试断言（12 文件 62 处）**

- `.success` 为 true → `.status` 为 `"ok"`；false → `"error"`（如 `expect(result.status).toBe("error")` 或 `expect(result).toMatchObject({status:"error"})`）
- 硬编码结果字面量（`{success:true,data}` 等）→ 改用 `ok()`/`fail()` 或新字面量
- 全部错误码字符串断言换 kebab（含 `tests/gemini-bridge-thinking.test.ts` 的 `USER_DENIED`/`DEPENDENCY_BLOCKED`/`BLACKLIST` 等）

- [ ] **Step 6: 全量测试 + build + 提交**

Run: `pnpm test && pnpm build`
Expected: 全绿（数量与基线同）/ build 干净。

```bash
git add -u && git add src
git commit -m "重构：ActionResult 判别联合 + 错误码 kebab（success 布尔退役，非法态消失）"
```

---

### Task 8: 原子切换（新面重接 + 删旧 + 新桥 + 测试重写）

> 本任务一次完成源代码切换与测试重写；中间态允许编译红，结束条件 = `pnpm build` 干净 + `pnpm test` 全绿。切换顺序刻意从叶子到根。

**Files:**
- Modify: `src/brain/llm.ts`、`src/brain/reflection.ts`、`src/brain/ollama-thinking.ts`、`src/types/organ.ts`、`src/mouth/ask-user.ts`、`src/heart/executor.ts`、`src/heart/loop.ts`、`src/agent.ts`、`bin/cli.ts`、`src/index.ts`、`src/types/index.ts`
- Create: `src/bridge/envelope.ts`、`src/bridge/index.ts`、`src/bridge/pipeline.ts`
- Delete: `src/brain/knowledge.ts`、`src/brain/thinking.ts`、`src/brain/gemini-bridge-thinking.ts`、`src/nose/policy.ts`、`src/nose/workspace-path.ts`、`src/nose/candidates.ts`、`src/nose/blacklist.ts`（保留 `src/nose/risk-checker.ts`、`src/nose/env-checker.ts`——观察模块，spec 非目标）
- Test: 见 Step 14

**Interfaces:**
- Consumes: `tool` 域（T1）、`permission` 域（T2-6）、判别联合 ActionResult（T7）。
- Produces：`createReflection({permission})`（=BrainInference.reflect 实现）、`executeTool(organs, name, args, signal?, {permission})`、`createBridge(options): {getPort, close}`、`AgentLoopOptions.permission`。

- [ ] **Step 1: `src/brain/llm.ts` 瘦身**

`BrainInference` 仅留 `infer` 与 `reflect`；删除 `addWhitelistEntry` / `workspaceConstraint`（消费方直取 `permission.*`）。`ToolCall/ToolInfo/BrainInferenceResult/BlockedCall/ReflectionVerdict/DiffHunk` 全部保留原样。

- [ ] **Step 2: 重写 `src/brain/reflection.ts`**

```ts
// 反思层（确定性代码）：裁决顺序 = 黑名单 → 未知工具 → 非法参数 → 白名单放行 → pending（spec §3.2）。
import type { ToolCall } from "./llm.js";
import type { BlockedCall, ReflectionVerdict } from "./llm.js";
import { fail } from "../types/index.js";
import { isToolName, tool } from "../tool/index.js";
import type { Permission } from "../permission/index.js";

export function createReflection(options: { permission: Permission }): {
  reflect(calls: readonly ToolCall[]): ReflectionVerdict;
} {
  const { permission } = options;
  return {
    reflect(calls) {
      const allowed: ToolCall[] = [];
      const pending: ToolCall[] = [];
      const blocked: BlockedCall[] = [];
      for (const call of calls) {
        const verdict = permission.verdict.decide(call);
        if (verdict.status === "blacklist") {
          blocked.push({ call, result: fail("blacklist", `黑名单命中：${verdict.key ?? call.name}`) });
          continue;
        }
        if (!isToolName(call.name)) {
          blocked.push({ call, result: fail("unknown-tool", `未知工具：${call.name}`) });
          continue;
        }
        const parsed = tool.schemas[call.name].safeParse(call.arguments ?? {});
        if (!parsed.success) {
          blocked.push({
            call,
            result: fail("invalid-args", `参数校验失败：${parsed.error.issues.map((i) => i.message).join("；")}`),
          });
          continue;
        }
        if (verdict.status === "allowed") {
          allowed.push(call);
          continue;
        }
        pending.push(call);
      }
      return { allowed, pending, blocked };
    },
  };
}
```

（文案与旧 `reflection.ts` 逐字对齐——旧文件在 Task 7 后已是 kebab 码，仅重排为工厂形式；`ReflectionVerdict`/`BlockedCall` 维持在 `llm.ts`。）

- [ ] **Step 3: `src/types/organ.ts` 契约更新**

删除 `WhitelistEntry`；`ApprovalPrompt` / `ApprovalChoice` 改为（`import type { TrustEntry } from "../tool/index.js"`）：

```ts
export interface ApprovalPrompt {
  tool: string;
  key: string;
  options: TrustEntry[];
}

export type ApprovalChoice =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "whitelist"; entry: TrustEntry };
```

- [ ] **Step 4: 重写 `src/mouth/ask-user.ts` 的 `askApproval`**

按 `prompt.options` 渲染（选项数量驱动提示词与分支）：
- 0 项（键缺失）：仅 `[y] 允许 / [n] 拒绝`
- 1 项：追加 `[w] 加入白名单`
- 2 项：追加 `[w] 加入白名单(此路径)` 与 `[d] 加入白名单(此目录)`

选择结果：`allow → {action:"allow"}`；`deny → {action:"deny"}`；`w → {action:"whitelist", entry: prompt.options[0]!}`；`d → {action:"whitelist", entry: prompt.options[1]!}`。无效输入循环追问（沿用旧结构，含 EOF 安全迭代）。面板提示词中体现 `prompt.tool` 与 `prompt.key`。

- [ ] **Step 5: 重写 `src/heart/executor.ts`**

移植旧 `executor.ts` 全部 8 个分支到新工具名，唯一变化：
- 上下文类型 `{ permission: Permission }`（必填第五参）
- 路径类：`organs.eyes/hands` 收到的 path 一律 `context.permission.key.execPath(arg)`（旧 execPathFor 的管道+回退语义已内置于 `key.execPath`）
- `code_search`：`const dir = typeof args.dir === "string" ? args.dir : ".";` 然后 `execPath(dir)`
- 缺 `path` 等必填参数 → `fail("invalid-args", ...)`（与旧守卫一致）
- 缺省分支 → `fail("unknown-tool", ...)`
- 映射表：file_read→`eyes.readFile`、dir_list→`eyes.readDir`、code_search→`eyes.searchCode`、page_fetch→`eyes.fetchPage`；file_write→`hands.writeFile`、file_patch→`hands.applyPatch`、command_run→`hands.executeCommand`（透传 signal 与 timeoutMs）

- [ ] **Step 6: `src/heart/loop.ts` 重接**

- `AgentLoopOptions`：`workspace?: string` 替换为 **`permission: Permission`（必填，与 brain 共持同一实例）**
- 工具列表：infer 传 `tool.infos`（`import { tool } from "../tool/index.js"`；删除 knowledge 导入）
- `#execute`：
  - blocked → 原样 `JSON.stringify(blockedResult)` 进上下文
  - allowed → `executeTool(this.#organs, call.name, call.arguments ?? {}, this.#signal, { permission: this.#permission })`
  - pending → `const prompt: ApprovalPrompt = { tool: call.name, key: this.#permission.key.of(call) ?? "", options: this.#permission.key.optionsFor(call) };` → `mouth.askApproval(prompt)`：
    - deny → `fail("user-denied", ...)`（旧文案）
    - whitelist → `this.#permission.whitelist.grant(choice.entry)` + `output.info(...)`（旧"已加入白名单"文案，取 entry.tool/entry.key），随后执行
    - allow → 执行
- 其余（节拍、/timeout、maxIterations、中断）不动。

- [ ] **Step 7: 重写 `src/brain/ollama-thinking.ts` 为独立类**

```ts
export interface OllamaThinkingOptions {
  permission?: Permission;
  workspace?: string;
  whitelistFile?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}
```

构造：`this.#permission = options.permission ?? createPermission({ workspace: options.workspace ?? process.cwd(), ...(whitelistFile !== undefined ? { whitelistFile } : {}) })`；`this.#reflection = createReflection({ permission: this.#permission })`；`reflect(calls)` 委托 `this.#reflection.reflect(calls)`。infer 主体（/api/chat、tool_calls snake_case、空工具不发 tools、signal 绑定）逐字保留；删除「继承自 BaseThinking」注释与基类。

- [ ] **Step 8: 重写 `src/agent.ts` 组装**

- 构造：`const permission = createPermission({ workspace: options.workspace ?? process.cwd(), ...(options.whitelistFile !== undefined ? { whitelistFile: options.whitelistFile } : {}) });`
- 默认 brain：`new OllamaThinking({ permission })`；loop 收 `permission`（同一实例）
- `run()`：system 注入文本 = `this.#permission.workspace.constraint()`（不再调 brain）
- 导出器官缺省工厂：`export buildDefaultEyes`、`export buildDefaultHands`（现有工厂函数加 export）；删除 `buildDefaultNose` 与 `buildBridgeService`

- [ ] **Step 9: 新建 `src/bridge/envelope.ts`**

```ts
// 统一信封（传输层判定，每响应一封；spec §5.1）。
export type TransportCode = "invalid-body" | "unknown-endpoint" | "method-not-allowed" | "unknown-approval" | "internal";

export interface EnvelopeOk<T> {
  status: "ok";
  data?: T;
}

export interface EnvelopeError {
  status: "error";
  error: { code: TransportCode; message: string };
}

export type Envelope<T = unknown> = EnvelopeOk<T> | EnvelopeError;

export function okEnvelope<T>(data?: T): EnvelopeOk<T> {
  return data === undefined ? { status: "ok" } : { status: "ok", data };
}

export function errorEnvelope(code: TransportCode, message: string): EnvelopeError {
  return { status: "error", error: { code, message } };
}

export const TRANSPORT_STATUS: Record<TransportCode, number> = {
  "invalid-body": 400,
  "unknown-endpoint": 404,
  "method-not-allowed": 405,
  "unknown-approval": 404,
  internal: 500,
};
```

- [ ] **Step 10: 新建 `src/bridge/pipeline.ts`（移植旧桥状态机）**

端口来源：`src/brain/gemini-bridge-thinking.ts`（643 行，Task 7 后已 kebab/联合）。**移植清单（逐条对照旧文件）**：

保留原样：`parseToolCalls`（+ `ASTParser/flattenToolCalls` 导入自 `../brain/ast-parser.js`）；`serializeResultLine/serializeBlockedLine/serializeFeedback`（已指向新形状）；`readJsonBody` 归 `index.ts`；`abortSignalPromise`；`#enqueue`/`#busy` 串行链；`#process`（batchSignal = any([全局 signal, timeout(timeoutMs)])、reflect、pipeline 依赖阻断、batch 独立执行、回填入队）——其中所有 `this.reflect` → `reflection.reflect`、`this.keyFor` → `permission.key.of`、`this.#candidates` → `permission.candidates`、`executeTool(..., { workspace })` → `{ permission }`。

`createPipeline` 选项：`{ permission, reflection, eyes, hands, timeoutMs, approvalTimeoutMs, signal?, logger }`——`signal` 缺省 `new AbortController().signal`（永不中断）；spec §4 的全局中断由此进入 `#process` 的 batchSignal。

替换（新面）：

```ts
export interface TaskMessage { type: "message"; message: string; }
export interface TaskApproval { type: "approval"; id: number; calls: ToolCall[]; options: TrustEntry[][]; }
export type TaskItem = TaskMessage | TaskApproval;

export interface Pipeline {
  takeTask(): Promise<TaskItem | null>;                 // 挂起 ~25s 后 null（204）
  submitReply(body: unknown): { ok: true; processed: boolean } | { ok: false; message: string };
  submitApproval(body: unknown): Promise<
    { ok: true } | { ok: false; code: "unknown-approval" | "invalid-body"; message: string }
  >;
  candidates(): CandidateRecord[];
  grant(items: unknown, scope: unknown): { ok: true; grants: GrantResult[] } | { ok: false; message: string };
  dismiss(items: unknown): { ok: true; dropped: number } | { ok: false; message: string };
  protocolText(): string;                                // constraint + "\n\n" + tool.protocol()
  close(): void;                                         // 移植旧 close：释放长轮询/清定时器/settle 挂起审批不记候选
}
```

关键实现：

- **审批下发**：payload `{ type:"approval", id, calls, options: calls.map((c) => permission.key.optionsFor(c)) }`；registry 存 `{calls, options, resolve, timer}`；600s（注入值）到点 → 逐调用记 denied（`key = permission.key.of(call)`，undefined/"" 跳过）→ settle `{allowed: calls.map(() => false), whitelist: [], timedOut: true}`。
- **`submitApproval`**：
  1. 结构校验：`id` 数字、`allowed` boolean[]、`whitelist` 缺省或数组 → 否则 `{ok:false, code:"invalid-body", message:"…"}`
  2. id 不在 registry（或已 settle）→ `{ok:false, code:"unknown-approval", message:"审批不存在或已过期"}`
  3. `allowed.length !== calls.length` → invalid-body
  4. 回显校验：每个 whitelist 条目（zod `{tool:string, key:string, scope:"self"|"subtree"}` 结构）必须 field-equal 某 `allowed[i]===true` 调用的 `options[i]` 成员（`entryEquals` 三字段比较），否则 invalid-body（**不落盘**）
  5. 记候选：逐调用 `outcome = allowed[i] ? "allowed" : "denied"`（旧语义：审批回执落地即记）
  6. 逐条目 `permission.whitelist.grant(entry)`（核销在 grant 内部，⑯）；
  7. settle `{allowed, whitelist: entries}`；`{ok:true}`
- **`grant(items, scope)`**（原 `/whitelist` 端点，**替换**旧 `#validateWhitelistAdd`/`#entryCorresponds`——候选对应性校验取消，spec §5.2 校验表为准）：
  `items` 非空数组 + `scope ∈ {self,subtree}`；逐项：`{tool,key}` 字符串结构 → `isToolName` → 非空键 → `scope==="subtree"` 且 `meta[tool].target !== "path"` → 任一非法即 `{ok:false, message: \`items[i] …\`}`（整批不落盘）；全部合法 → `entryFor(tool,key,scope)` 物化（根级降级 self 属合法）→ `grants = entries.map(grant)` → `{ok:true, grants}`。
- **`candidates()`**：`permission.candidates.list().filter((r) => !permission.whitelist.list().some((e) => covers(e, { name: r.tool, key: r.key })))`。
- **`dismiss(items)`**：items 数组、每项 `{tool,key}` 字符串 → 否则 invalid；`dropped = permission.candidates.drop(...)`。
- **`submitReply`**：逐字移植旧校验（`reply` 为 string 且 ≤ 200_000 字符）→ `parseToolCalls` → 无调用 `{ok:true, processed:false}`（**不得重新引入 lastContent 去重**）→ 有调用入队 `{ok:true, processed:true}`。
- **`takeTask`**：出箱即返（message 项包 `{type:"message", message}`）；空则注册 waiter，~25_000ms 后 resolve null；close 释放 waiter（resolve null）。

- [ ] **Step 11: 新建 `src/bridge/index.ts`（createBridge + 路由）**

```ts
// bridge 域：createBridge 组合 permission/reflection/执行器并绑定 127.0.0.1。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPermission, type Permission } from "../permission/index.js";
import { createReflection } from "../brain/reflection.js";
import { buildDefaultEyes, buildDefaultHands } from "../agent.js";
import type { EyesContract, HandsContract } from "../types/index.js";
import { errorEnvelope, okEnvelope, TRANSPORT_STATUS, type Envelope, type TransportCode } from "./envelope.js";
import { createPipeline } from "./pipeline.js";

export interface BridgeOptions {
  workspace: string;
  port?: number;                   // 缺省 8765
  signal?: AbortSignal;
  timeoutMs?: number;              // 批级执行超时，缺省 300_000
  logger?: (text: string) => void;
  whitelistFile?: string;
  candidatesFile?: string;
  eyes?: EyesContract;
  hands?: HandsContract;
  approvalTimeoutMs?: number;      // 审批兜底超时，缺省 600_000（测试注入）
}

export interface BridgeService {
  getPort(): Promise<number>;
  close(): void;
}

const ROUTES: Record<string, readonly string[]> = {
  "/task": ["GET"],
  "/task/reply": ["POST"],
  "/task/approval": ["POST"],
  "/permission/whitelist": ["POST"],
  "/permission/candidates": ["GET"],
  "/permission/candidates/dismiss": ["POST"],
  "/agent/protocol": ["GET"],
  "/agent/info": ["GET"],
};

export function createBridge(options: BridgeOptions): BridgeService {
  const logger = options.logger ?? ((text: string) => console.error(text));
  const permission = createPermission({
    workspace: options.workspace,
    ...(options.whitelistFile !== undefined ? { whitelistFile: options.whitelistFile } : {}),
    ...(options.candidatesFile !== undefined ? { candidatesFile: options.candidatesFile } : {}),
    logger,
  });
  const reflection = createReflection({ permission });
  const pipeline = createPipeline({
    permission,
    reflection,
    eyes: options.eyes ?? buildDefaultEyes(),
    hands: options.hands ?? buildDefaultHands(),
    timeoutMs: options.timeoutMs ?? 300_000,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 600_000,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    logger,
  });
  const server = createServer((req, res) => { void handle(req, res, pipeline, options.workspace); });
  server.listen(options.port ?? 8765, "127.0.0.1");
  return {
    getPort: () => new Promise<number>((resolve, reject) => {
      if (server.listening) { resolve(portOf(server)); return; }
      server.once("listening", () => resolve(portOf(server)));
      server.once("error", reject);
    }),
    close: () => { pipeline.close(); server.close(); server.closeAllConnections(); },
  };
}

function portOf(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  pipeline: ReturnType<typeof createPipeline>,
  workspace: string,
): Promise<void> {
  const send = (status: number, envelope: Envelope): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(envelope));
  };
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const methods = ROUTES[pathname];
  if (methods === undefined) { send(404, errorEnvelope("unknown-endpoint", `未知端点：${pathname}`)); return; }
  const method = req.method ?? "";
  if (!methods.includes(method)) { send(405, errorEnvelope("method-not-allowed", `方法不允许：${method} ${pathname}`)); return; }
  let body: unknown = undefined;
  if (method === "POST") {
    try { body = await readJsonBody(req); }
    catch { send(400, errorEnvelope("invalid-body", "请求体不是合法 JSON")); return; }
  }
  try {
    if (pathname === "/task") {
      const item = await pipeline.takeTask();
      if (item === null) { res.writeHead(204); res.end(); return; }
      send(200, okEnvelope(item)); return;
    }
    if (pathname === "/agent/protocol") { send(200, okEnvelope({ protocol: pipeline.protocolText() })); return; }
    if (pathname === "/agent/info") { send(200, okEnvelope({ workspace })); return; }
    if (pathname === "/permission/candidates") { send(200, okEnvelope({ candidates: pipeline.candidates() })); return; }
    if (pathname === "/task/reply") {
      const result = pipeline.submitReply(body);
      if (!result.ok) { send(400, errorEnvelope("invalid-body", result.message)); return; }
      send(200, okEnvelope({ processed: result.processed })); return;
    }
    if (pathname === "/task/approval") {
      const result = await pipeline.submitApproval(body);
      if (!result.ok) { send(TRANSPORT_STATUS[result.code], errorEnvelope(result.code, result.message)); return; }
      send(200, okEnvelope()); return;
    }
    if (pathname === "/permission/whitelist") {
      const record = (body ?? {}) as { items?: unknown; scope?: unknown };
      const result = pipeline.grant(record.items, record.scope);
      if (!result.ok) { send(400, errorEnvelope("invalid-body", result.message)); return; }
      send(200, okEnvelope({ grants: result.grants })); return;
    }
    if (pathname === "/permission/candidates/dismiss") {
      const record = (body ?? {}) as { items?: unknown };
      const result = pipeline.dismiss(record.items);
      if (!result.ok) { send(400, errorEnvelope("invalid-body", result.message)); return; }
      send(200, okEnvelope({ dropped: result.dropped })); return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(500, errorEnvelope("internal", `服务器内部错误：${message}`));
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // 逐字移植旧桥 readJsonBody
}
```

- [ ] **Step 12: `bin/cli.ts` 重接**

- 工作区决议：`const resolved = permission.workspace.resolve(cliOpts.workspace, process.env.HUMAN_AGENT_WORKSPACE, process.cwd());` → error 打印 `resolved.error.message` exit 1
- 桥模式分支：`GEMINI_BRIDGE_PORT !== undefined` → `const parsed = Number.parseInt(env, 10); const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 8765;` → `createBridge({ workspace: resolved.workspace, port, signal, logger })`（signal/中断级联沿用旧 cli 结构）→ 打印监听地址（`getPort()`）→ SIGINT/SIGTERM → `close()` → exit 130；`getPort()` 失败友好报错 exit 1
- REPL 分支：`new HumanAgent({ workspace: resolved.workspace, ...其余沿用 })`

- [ ] **Step 13: 导出与删除**

- `src/types/index.ts`：移除 `WhitelistEntry`，增加 `export type { TrustEntry, Scope } from "../tool/index.js";`
- `src/index.ts`：保持 `ok/fail` + 类型出口（委托 types/index）
- 删除：`src/brain/knowledge.ts`、`src/brain/thinking.ts`、`src/brain/gemini-bridge-thinking.ts`、`src/nose/policy.ts`、`src/nose/workspace-path.ts`、`src/nose/candidates.ts`、`src/nose/blacklist.ts`

- [ ] **Step 14: 测试重写（helpers + 6 重写 + 6 删除 + 桥新建）**

- `tests/helpers.ts`：`ScriptedBrain` 仅实现 `{infer, reflect}`（删 addWhitelistEntry/workspaceConstraint；reflect 默认全 allowed）；`buildStubMouth.askApproval` 返回 `{action:"allow"}`；其余不动
- 删：`tests/knowledge.test.ts`、`tests/workspace-path.test.ts`、`tests/policy.test.ts`、`tests/candidates.test.ts`、`tests/thinking.test.ts`、`tests/gemini-bridge-thinking.test.ts`（覆盖面已在 T1/T3/T4/T5/T6 新测试文件中；BaseThinking 与旧桥用例由新桥测试取代）
- 重写 `tests/reflection.test.ts`：`createReflection({ permission })`（tmp whitelist）；六项顺序与拦截码断言
- 重写 `tests/executor.test.ts`：新工具名 + `{permission}` 上下文 + execPath 断言
- 重写 `tests/loop.test.ts`：26 用例逐条移植——构造改 `{permission}`（tmp whitelistFile）；「edit_file kind=path」改 `file_edit`（prompt.options 两粒度）；「read-dir 审批目录语义」改 `dir_list`（optionsFor 第二项 subtree = 自身 + `/`）；白名单动作断言 `permission.whitelist.list()`；上下文消息断言换新工具名与新结果形状
- 重写 `tests/ollama-thinking.test.ts`：`new OllamaThinking({ workspace: wsReal, whitelistFile })`；reflect 委托；infer 工具列表断言改用 `tool.infos`
- 重写 `tests/agent.test.ts`：`HumanAgent({ workspace: wsReal, whitelistFile, brain: scripted, ... })`；run() 首条 system 断言 = `permission.workspace.constraint()` 文案；删除 buildBridgeService 相关用例
- 重写 `tests/ask-user.test.ts` 的 askApproval 组：prompt `{tool,key,options}` 三形态（0/1/2 项）与选择结果
- 新建 `tests/bridge.test.ts`：逐条移植旧 `tests/gemini-bridge-thinking.test.ts` 全部用例（parseToolCalls ×7 + 桥 ×35+），harness 改造：
  - `makeBridge` → `createBridge({ workspace: wsReal, port: 0, whitelistFile, candidatesFile, approvalTimeoutMs?, signal?, eyes, hands, timeoutMs?, logger })`
  - `seedWhitelist` 写 v1 格式：`{version:1, workspaces:{[normalizeMatchKey(wsReal)]: entries}}`
  - `getMessage`：GET `/task` → 204 视 null；200 取 `json.data`
  - `postApproval` → POST `/task/approval`；`postReply` → POST `/task/reply`（断言 `data.processed`）
  - `toolCall` 辅助：CONTENT 特判 `file_write`、COMMAND 特判 `command_run`、patch 特判 `file_patch`
  - 新增用例（12 条以上）：所有端点信封形状；`POST /task/reply` 畸形 JSON → 400 invalid-body；GET 打 POST 端点 → 405 method-not-allowed；未知路径 → 404 unknown-endpoint；审批 id 无效 → 404 unknown-approval；allowed 长度不符 → 400；**回显非 options 成员 → 400**；**回显 allowed=false 调用之 option → 400**；合法回显 → 200 + whitelist.json v1 落盘 + 候选核销；审批载荷 options 正确（两粒度路径 / 单粒度命令 / 键缺失 `[]`）；`/permission/whitelist` grants 形状 + 原子 400（含空批）+ retired；`/permission/candidates` 滤除已覆盖；dismiss `{dropped}`；`/agent/protocol` 与 `/agent/info` 信封；空长轮询裸 204
  - 域失败不抬升信封：注入极小 `timeoutMs` 触发批级执行超时 → 结果消息为「工具执行超时」（域错误），`GET /task` 取回信封仍 200 ok
  - 硬规 5 补充：`Object.keys(bridge).sort() === ["close","getPort"]`

- [ ] **Step 15: build + 全量测试**

Run: `pnpm build && pnpm test`
Expected: build 干净（strict、无 any）；测试全绿。任何残留旧名/旧码引用就地清除（`grep -rn "knowledge\|BaseThinking\|buildBridgeService\|WhitelistEntry\|matchKeyFor\|addWhitelistEntry" src tests`）。

- [ ] **Step 16: 提交（3 个提交）**

```bash
git add src tests
git commit -m "实现：原子切换——tool/permission 域接管、新 face 重接（reflection/executor/loop/agent/cli）、删除旧模块"
git add src/bridge tests/bridge.test.ts
git commit -m "实现：bridge 域——createBridge + 统一信封路由 + 管线（审批载荷 options 预构造）"
git add -u
git commit -m "测试：按新面重写（helpers/reflection/executor/loop/ollama/agent/ask-user + bridge 用例）"
```

---

### Task 9: 扩展切换（端点 + options 渲染 + 面板 + README）

**Files:**
- Modify: `extensions/gemini-bridge/background.js`、`extensions/gemini-bridge/content.js`、`extensions/gemini-bridge/manifest.json`、`extensions/gemini-bridge/README.md`

**Interfaces:**
- Consumes: 新 wire（T8）：`{status:"ok", data}` / `{status:"error", error:{code,message}}`；审批载荷 `options`；候选载荷 `{items, scope}` 与响应 `{grants}`/`{dropped}`。

- [ ] **Step 1: background.js 八路中转改造**

路径替换：`/task`、`/task/reply`、`/task/approval`、`/permission/whitelist`、`/permission/candidates`、`/permission/candidates/dismiss`、`/agent/protocol`、`/agent/info`。约定（统一收口）：
- 成功 → 信封原样透传 content.js
- `GET /task` 30s 超时或 204 → `{status:"ok", data:null}`（空轮询）
- 网络错误/超时（其余端点）→ `{status:"error", error:{code:"bridge-unreachable", message:"桥未连接或请求超时"}}`（扩展本地伪码，README 说明）

- [ ] **Step 2: content.js 零手抄改造**

- **删除**：工具名镜像集（约 51-58 行 WRITE/READ/PATH/DIR_TARGET_TOOLS/isPathToolName）、载荷键近似归一（deepNorm/resolveSegments/normalizeKey/buildEntry，约 947-1018 行）、buildCandidateEntry 与 approximateDirKey——扩展不再含任何工具名语义、键归一、条目构造
- **审批弹窗**：按 `task.options[i]` 渲染白名单按钮——2 项 → `[白名单(此路径)]` `[白名单(此目录)]`；1 项 → `[白名单]`；0 项 → 无按钮。点击 = `decisions[i]=true` 且 `whitelistUnits[i] = options[i][k]` **原样回显**。倒计时到点/全部拒绝清空 whitelist 数组（全部允许不清）。回执 `{type:"approve", id, allowed, whitelist}`（whitelist 为选中条目数组）
- **approvalHint** 改类别无关文案（按钮数量驱动，禁止出现工具名）
- **候选面板**：粒度选择器 wire 值改 `self` / `subtree`（UI 文案「此路径/此目录」不变）；「入库所选」发 `{type:"whitelist-add", items:[{tool,key}…], scope}`；响应 `data.grants` 汇总入日志（added/duplicate/covered/rejected 计数）；400 → `error.message` 直接显示；「清除所选」发 `{items}` 并显示 `data.dropped`
- **信封消费**：所有响应先看 `status`；`"error"` → 日志 `error.message`；`bridge-unreachable` → 「桥未连接（重试中）」状态；审批 404 → 显示服务端 message（删除本地「审批请求已过期…」文案）
- 工作区行：`data.workspace`；协议注入：`data.protocol`
- 三档策略代答机制不变（默认拒绝/默认允许仍自动 fill `allowed`，whitelist 空）

- [ ] **Step 3: manifest.json 版本 → `0.4.0`**

- [ ] **Step 4: README.md 同步**

端点全表（8 个新路径 + 信封说明）；审批载荷 `options` 与零手抄说明；候选载荷 `{items, scope}` 与 `grants`；whitelist.json 新格式 `{version:1, workspaces}` 与 TrustEntry `{tool,key,scope}` 说明；权限模型「写信任蕴含读」措辞校对；排查表更新（`GET /permission/candidates → 404` 行、`/agent/protocol`、扩展本地 `bridge-unreachable`）；面板设置表同步（候选粒度、日志汇总）。

- [ ] **Step 5: 人工 review（硬规 2 的替代验证）**

Run: `grep -nE "read_file|write_file|edit_file|apply_patch|read_dir|search_code|fetch_page|terminal|WRITE_TOOL|READ_TOOL|PATH_TOOL" extensions/gemini-bridge/content.js extensions/gemini-bridge/background.js`
Expected: 无命中（工具名与镜像集清零；`terminal` 除外需人工确认无 UI 语义残留）。

- [ ] **Step 6: 提交**

```bash
git add extensions/gemini-bridge
git commit -m "扩展：端点/载荷切换——审批 options 渲染、候选 items+scope、零手抄（manifest v0.4.0 + README）"
```

---

### Task 10: CLAUDE.md 词根表与阶段七记录 + 最终验收

**Files:**
- Modify: `CLAUDE.md`
- Test: 无（文档 + 全量回归）

**Interfaces:** 无新代码接口。

- [ ] **Step 1: CLAUDE.md 增加「API 词根表」章节（硬规 4）**

落笔内容：TS 域根 `tool` / `permission` / `bridge`；wire 根 `task` / `permission` / `agent`；词形规则（判别词唯一 `status`、值词 kebab、工具名 snake、JSON 结构键 kebab、errno 透传）；旧→新工具名对照表（8 组）；自有错误码表 + 传输错误码表；硬规 5 条指针（指向 spec §8）；「新增标识符必须归入既有词根或显式修改词根表」。

- [ ] **Step 2: CLAUDE.md 阶段七记录 + 现行结构校对**

- 新增「阶段七（API 重设计）」条目：三域三根、统一信封、工具栏 `src/tool/`、权限域 `src/permission/`（含 store/key/verdict/whitelist/candidates/blacklist 布局）、桥域 `src/bridge/`（createBridge/pipeline/envelope）、ActionResult 判别联合、文件 v1 无迁移、扩展零手抄
- 校对**现行结构**章节（历史阶段条目保持原样不动）：架构核心（大脑条目改指 tool 域；鼻子条目改述 permission 域 + 保留观察模块；心脏 executor context `{permission}`；组装入口 `bridge.createBridge`、器官工厂导出）；关键契约 ActionResult 代码块改判别联合；命令与依赖段落的路径引用
- 新增「词根表 → 命名修改流程」一句话（改动词根须显式更新本章节与 spec）

- [ ] **Step 3: 最终验收（spec §12）**

Run: `pnpm test && pnpm build`
Expected: 全绿、干净。核对清单：
1. 硬规 5 快照测试存在（tool-domain/permission/bridge 三处）
2. `grep -rn "success" src` 仅剩 zod safeParse；`grep -rn "SCREAMING_SNAKE" 无残留`
3. content.js 人工 review（Task 9 Step 5 已做，复核日志）
4. 词根表在 CLAUDE.md；README 与端点表一致
5. 桥 E2E 手动步骤整理给用户（spec §12.3）：`GEMINI_BRIDGE_PORT=8765 pnpm dev` → curl `GET /agent/protocol`、`GET /agent/info`、`GET /task`（~25s → 204）；扩展 v0.4.0：先目录授权（subtree）再同树文件授权（self），whitelist.json v1 两条均在；相对穿越命中黑名单；界内写入静默；候选入库核销；三档逐一验证

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md
git commit -m "文档：CLAUDE.md 词根表（硬规 4）+ 阶段七记录 + 现行结构校对"
```

---

## 依赖与顺序说明

- Task 1-6 相互独立、可并行（1 → 3/4/5/6 的导入依赖；2 → 5；3 → 4/5/6）；期间旧模块原样存活，全量测试始终绿。
- **Task 7 必须先于 Task 8**：翻转后旧桥/旧 loop 仅少数消费点改动（已列明），Task 8 移植到的新代码一次即为终态（判别联合 + kebab），避免切换后再扫一遍。
- Task 8 是唯一允许中间态编译红的任务（原子切换不可再分：旧桥 imports 全部共享模块，任何部分删除都使其编译断裂）。
- Task 9 依赖 Task 8 的 wire 终态；Task 10 收尾。
