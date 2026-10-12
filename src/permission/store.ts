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
