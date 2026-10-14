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
  revoke(entry: TrustEntry): boolean;
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
    revoke(entry) {
      // 精确匹配存储形态（调用方持有 list() 原样条目）；不归一，避免幽灵删除
      const current = list();
      const next = current.filter(
        (e) => !(e.tool === entry.tool && e.scope === entry.scope && e.key === entry.key),
      );
      if (next.length === current.length) return false;
      container.workspaces[workspaceKey] = next;
      save();
      return true;
    },
  };
}
