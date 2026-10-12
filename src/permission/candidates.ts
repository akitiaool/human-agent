// 信任候选档案：白名单外一切裁决的持久记录（按工作区分节；容量帽 200 条 / 30 天，按 last-seen 丢最旧）。
// 工厂化移植原 src/nose/candidates.ts（聚合/剪枝/帽逻辑行为逐字保留）；字段拼写 kebab、时间戳为 ms 纪元。
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
  // 分节惰性建立（移植旧 #section）：记录变更一律落到 container 持有的数组。
  const records = (): CandidateRecord[] => {
    const existing = container.workspaces[workspaceKey];
    if (existing !== undefined) return existing;
    const fresh: CandidateRecord[] = [];
    container.workspaces[workspaceKey] = fresh;
    return fresh;
  };
  const save = (): void => {
    if (!saveContainer(file, container)) logger(`候选落盘失败：${file}（内存记录仍生效）`);
  };
  // 剪枝（移植旧 #prune）：30 天过期清理 → 超帽按 last-seen 丢最旧。
  const prune = (): void => {
    const cutoff = now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let kept = records().filter((r) => r["last-seen"] >= cutoff);
    if (kept.length > maxEntries) {
      kept = [...kept].sort((a, b) => a["last-seen"] - b["last-seen"]).slice(kept.length - maxEntries); // 保留 last-seen 最新的 maxEntries 条
    }
    container.workspaces[workspaceKey] = kept;
  };
  return {
    // 裁决入档（移植旧 record）：同 (tool, key) 聚合计数 + 更新 last-seen；坏键（空 / 未知工具）忽略。
    record(tool, key, outcome) {
      if (key === "" || !isToolName(tool)) return;
      const timestamp = now();
      const list = records();
      const found = list.find((r) => r.tool === tool && r.key === key);
      if (found !== undefined) {
        if (outcome === "allowed") found["allow-count"] += 1;
        else found["deny-count"] += 1;
        found["last-seen"] = timestamp;
      } else {
        list.push({
          tool,
          key,
          "deny-count": outcome === "denied" ? 1 : 0,
          "allow-count": outcome === "allowed" ? 1 : 0,
          "first-seen": timestamp,
          "last-seen": timestamp,
        });
      }
      prune();
      save();
    },
    list() {
      return [...(container.workspaces[workspaceKey] ?? [])];
    },
    // 入库核销（移植旧 removeCovered）：条目覆盖的候选移除，返回删除条数，删了才落盘。
    dropCoveredBy(entry) {
      const list = records();
      const kept = list.filter((r) => !covers(entry, { name: r.tool, key: r.key }));
      if (kept.length === list.length) return 0;
      container.workspaces[workspaceKey] = kept;
      save();
      return list.length - kept.length;
    },
    // 清除所选（移植旧 remove）：按 (tool, key) 精确移除，返回删除条数，删了才落盘。
    drop(items) {
      const current = records();
      const kept = current.filter((r) => !items.some((i) => i.tool === r.tool && i.key === r.key));
      if (kept.length === current.length) return 0;
      container.workspaces[workspaceKey] = kept;
      save();
      return current.length - kept.length;
    },
  };
}
