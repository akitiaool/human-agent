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
