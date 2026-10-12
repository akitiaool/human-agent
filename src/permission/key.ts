// 规范匹配键管道与条目键归一（原 workspace-path.ts + policy.ts 归一/匹配族迁入；管道失败按未信任）。
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import type { ToolCall } from "../brain/llm.js";
import { isToolName, meta, type Scope, type TrustEntry } from "../tool/index.js";

export type RealpathFn = (path: string) => string;
export const defaultRealpath: RealpathFn = (path) => realpathSync.native(path);

/** 匹配键归一：反斜杠转正斜杠；win32 小写。 */
export function normalizeMatchKey(path: string): string {
  const out = path.replace(/\\/g, "/");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** 段级解析（逐字移植 policy.ts）：折叠 . 与 ..（盘符根/根之上不可越）。条目归一兜底用。 */
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

/** 路径条目文本归一（逐字移植 policy.ts 的 normalizePath，模块内部使用）：空白折叠 + 反斜杠转正斜杠 + 段级解析；win32 小写。 */
function normalizePathText(input: string): string {
  const out = input.trim().replace(/\s+/g, " ").replace(/\\/g, "/").replace(/\/+/g, "/");
  const resolved = resolvePathSegments(out);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 命令归一（逐字移植 policy.ts）：空白折叠 + 反斜杠转正斜杠。 */
function normalizeCommand(input: string): string {
  return input.trim().replace(/\s+/g, " ").replace(/\\/g, "/");
}

/** 深层空白归一（逐字移植 policy.ts）。 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeCommand(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeValue(v)]));
  }
  return value;
}

/** 其余工具（page_fetch 等非路径类）：排序参数 JSON（深层空白归一；逐字移植 policy.ts）。 */
function serializeArgs(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) sorted[key] = normalizeValue(args[key]);
  return JSON.stringify(sorted);
}

/** 是否路径工具（target === "path"）。 */
function isPathToolName(name: string): boolean {
  return isToolName(name) && meta[name].target === "path";
}

/** 路径类调用的目标参数（移植 policy.ts pathTargetOf）：code_search 取 dir（缺省 "." = 工作区根）；其余 path 工具取 path（非空串否则 undefined）。 */
function pathArgOf(call: ToolCall): string | undefined {
  const args: Record<string, unknown> = call.arguments ?? {};
  if (call.name === "code_search") {
    const raw = args.dir;
    return typeof raw === "string" && raw.trim() !== "" ? raw : ".";
  }
  if (isPathToolName(call.name)) {
    const raw = args.path;
    return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
  }
  return undefined;
}

export interface KeyService {
  /** 规范匹配键：command_run → 命令归一；路径类 → 管道 matchKey（失败/参数缺失 undefined）；其余 → 排序参数 JSON。 */
  of(call: ToolCall): string | undefined;
  /** 唯一条目键归一：command_run → 命令归一；路径类 → 路径归一（目录条目尾 "/" 保留）；其余 → trim。 */
  normalize(entry: Pick<TrustEntry, "tool" | "key">): string;
  /** 构造信任条目；非法（空键 / 非路径类 + subtree）→ null；根级 subtree → 降级 self。 */
  entryFor(tool: string, key: string, scope: Scope): TrustEntry | null;
  /** 该调用合法选项集（审批载荷预构造用；顺序即展示顺序）。 */
  optionsFor(call: ToolCall): TrustEntry[];
  /** 执行落点：管道 execPath 优先；失败回退词法绝对化（永不为 null）。 */
  execPath(input: string): string;
}

/** 构造绑定工作区（realpath 原大小写——裁定 5）与 realpath 注入的匹配键服务。 */
export function createKey(options: { workspace: string; realpathFn?: RealpathFn }): KeyService {
  const workspace = options.workspace;
  const realpathFn = options.realpathFn ?? defaultRealpath;

  /**
   * 规范匹配键管道（逐字移植 resolveWorkspacePath 主体）：词法绝对化（工作区基准）→
   * realpath 深度归实（逐段上溯最深已存在祖先，realpath 后拼回尾段）→ 管道末端经 normalizeMatchKey。
   * 全链失败返回 null（调用方按未信任处置，绝不回退词法结果用于匹配）。
   */
  function resolvePipeline(input: string): { execPath: string; matchKey: string } | null {
    const lexical = resolvePath(workspace, input);
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

  function of(call: ToolCall): string | undefined {
    const args: Record<string, unknown> = call.arguments ?? {};
    if (call.name === "command_run") {
      const raw = args.command;
      return typeof raw === "string" && raw.trim() !== "" ? normalizeCommand(raw) : undefined;
    }
    if (isPathToolName(call.name)) {
      const target = pathArgOf(call);
      if (target === undefined) return undefined;
      return resolvePipeline(target)?.matchKey;
    }
    return serializeArgs(args);
  }

  function normalize(entry: Pick<TrustEntry, "tool" | "key">): string {
    if (entry.tool === "command_run") return normalizeCommand(entry.key);
    if (isPathToolName(entry.tool)) {
      // 移植旧 normalizeEntryKey 的 had-trailing 逻辑：目录条目尾 "/" 保留（normalizePathText 会丢尾斜杠）。
      const hadTrailing = /[/\\]$/.test(entry.key.trim());
      const normalized = normalizePathText(entry.key);
      if (!hadTrailing || normalized === "" || normalized.endsWith("/")) return normalized;
      return `${normalized}/`;
    }
    return entry.key.trim(); // 非路径非命令（URL 等）仅 trim——修旧 normalizeEntryKey 的 mangle 缺陷
  }

  function entryFor(tool: string, key: string, scope: Scope): TrustEntry | null {
    if (key === "") return null;
    if (scope === "self") return { tool, key, scope: "self" };
    if (!isPathToolName(tool)) return null; // 非路径类（含未知名）无子树粒度
    if (key === "/" || /^[a-z]:\/$/i.test(key)) return { tool, key, scope: "self" }; // 根级/盘符根降级
    if (tool === "dir_list" || tool === "code_search") return { tool, key: `${key}/`, scope: "subtree" }; // 读目录类 = 目标自身 + /
    const i = key.lastIndexOf("/");
    if (i <= 0 || (i === 2 && key[1] === ":")) return { tool, key, scope: "self" }; // 根下/盘符根下单文件降级
    return { tool, key: `${key.slice(0, i)}/`, scope: "subtree" }; // 其余 = 父目录 + /
  }

  function optionsFor(call: ToolCall): TrustEntry[] {
    const matchKey = of(call);
    if (matchKey === undefined || matchKey === "") return [];
    const self: TrustEntry = { tool: call.name, key: matchKey, scope: "self" };
    const subtree = entryFor(call.name, matchKey, "subtree");
    return subtree !== null && subtree.scope === "subtree" ? [self, subtree] : [self];
  }

  function execPath(input: string): string {
    const resolved = resolvePipeline(input);
    return resolved !== null ? resolved.execPath : resolvePath(workspace, input);
  }

  return { of, normalize, entryFor, optionsFor, execPath };
}
