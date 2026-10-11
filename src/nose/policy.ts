// 权限裁决模块：黑名单（绝对禁止）+ 白名单（用户信任）统一匹配。
// 只做文本匹配，不做命令分类/路径分析；白名单条目跨写类工具生效。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolCall } from "../brain/llm.js";
import type { WhitelistEntry } from "../types/index.js";
import { BLACKLIST_PATTERNS } from "./blacklist.js";

export type Classification = "blacklist" | "whitelist" | "unlisted";

const WRITE_TOOLS = new Set(["write_file", "apply_patch", "edit_file"]);

/** 段级解析：折叠 . 与 ..（盘符根/根之上不可越）——防 c:/ws/../../windows 穿越绕过黑名单锚定/工作区边界。 */
function resolvePathSegments(p: string): string {
  const isAbs = p.startsWith("/");
  const isDrive = /^[a-z]:\//i.test(p);
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length > (isDrive ? 1 : 0)) out.pop(); // 盘符根/根之上不可越
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
      const i = path.lastIndexOf("/");
      // 无父目录（相对根级）或父目录为盘符根：dir 条目=全部绝对路径/整盘超授权，降级为文件条目
      if (i <= 0 || (i === 2 && path[1] === ":")) {
        return { tool: call.name, key: path, kind: "path" };
      }
      return { tool: call.name, key: `${path.slice(0, i)}/`, kind: "path" };
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
    // 损坏/不存在 → 空白名单（默认模式全弹窗、自动模式黑名单外全放行，不崩溃）
  }
  return {};
}
