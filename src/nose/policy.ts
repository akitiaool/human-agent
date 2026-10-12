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
  if (isPathTool(call.name)) {
    const target = pathTargetOf(call);
    if (target === undefined) return undefined;
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
  const hadTrailing = /[/\\]$/.test(entry.key.trim());
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
    if (
      normalized.kind === "path" &&
      current.some((e) => e.kind === "path" && covers(e.key, normalized.key) && toolMatches(e.tool, normalized.tool))
    ) {
      return false; // 子被父盖：跳过（仅当既有条目按方向语义确能覆盖新调用——读条目盖不住写）
    }
    const kept =
      normalized.kind === "path"
        ? current.filter(
            (e) => !(e.kind === "path" && covers(normalized.key, e.key) && toolMatches(normalized.tool, e.tool)),
          ) // 加父去子：仅删除按方向语义确被新条目覆盖的子条目（写信任蕴含读）
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
