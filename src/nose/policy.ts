// 权限裁决模块：黑名单（绝对禁止）+ 白名单（用户信任）统一匹配。
// 只做文本匹配，不做命令分类/路径分析；白名单条目跨写类工具生效。
import type { ToolCall } from "../brain/llm.js";
import type { WhitelistEntry } from "../types/index.js";
import { BLACKLIST_PATTERNS } from "./blacklist.js";

export type Classification = "blacklist" | "whitelist" | "unlisted";

const WRITE_TOOLS = new Set(["write_file", "apply_patch"]);

/** 归一化：空白折叠 + 反斜杠转正斜杠；win32 额外小写（路径键用）。 */
export function normalizePath(input: string): string {
  const out = input.trim().replace(/\s+/g, " ").replace(/\\/g, "/").replace(/\/+/g, "/");
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
