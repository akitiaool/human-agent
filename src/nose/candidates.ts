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
