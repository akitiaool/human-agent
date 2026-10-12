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
