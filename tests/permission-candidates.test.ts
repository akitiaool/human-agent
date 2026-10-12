// 移植注：原 tests/candidates.test.ts 7 例 → createCandidates 工厂。
// （适配：terminal→command_run、write_file→file_write、read_file→file_read、read_dir→dir_list；
//  字段 denied→"deny-count"、allowed→"allow-count"、firstSeen→"first-seen"、lastSeen→"last-seen"（ms 纪元 number）；
//  now 注入由 Date 改 () => number；removeCovered→dropCoveredBy、remove→drop 并返回删除条数；
//  平面 JSON → v1 容器格式。）
// 另含新用例：坏键不入档（key "" 或未知工具）/dropCoveredBy 方向语义（写核销读、读不核销写）/
// 落盘失败 logger/JSON 字段为 kebab 六字段。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCandidates } from "../src/permission/candidates.js";

const tmp = mkdtempSync(join(tmpdir(), "cand-"));
const file = join(tmp, "candidates.json");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(file, { force: true }));

const WS = "/ws";

interface CandOverrides {
  now?: () => number;
  maxEntries?: number;
  maxAgeDays?: number;
  logger?: (message: string) => void;
  file?: string;
}

const mk = (over?: CandOverrides) =>
  createCandidates({
    workspaceKey: WS,
    file: over?.file ?? file,
    logger: over?.logger ?? (() => {}),
    ...(over?.now !== undefined ? { now: over.now } : {}),
    ...(over?.maxEntries !== undefined ? { maxEntries: over.maxEntries } : {}),
    ...(over?.maxAgeDays !== undefined ? { maxAgeDays: over.maxAgeDays } : {}),
  });

describe("permission/candidates", () => {
  it("聚合：同 (tool,key) 计数累加，first-seen 保持 / last-seen 更新", () => {
    let t = 0;
    const now = (): number => 1_700_000_000_000 + (t += 1000);
    const a = mk({ now });
    a.record("file_write", "c:/ws/a.ts", "denied");
    a.record("file_write", "c:/ws/a.ts", "denied");
    a.record("file_write", "c:/ws/a.ts", "allowed");
    const list = a.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: "file_write", key: "c:/ws/a.ts", "deny-count": 2, "allow-count": 1 });
    expect(list[0]!["first-seen"]).not.toBe(list[0]!["last-seen"]);
  });

  it("持久化 + 重载（按工作区分节，v1 容器）", () => {
    const a = mk();
    a.record("command_run", "ls -la", "denied");
    expect(mk().list()).toHaveLength(1);
    const other = createCandidates({ workspaceKey: "/other", file, logger: () => {} });
    expect(other.list()).toHaveLength(0);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; workspaces: Record<string, unknown[]> };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.workspaces)).toContain(WS);
  });

  it("容量帽：超 200 按 last-seen 丢最旧", () => {
    let t = 0;
    const now = (): number => 1_700_000_000_000 + (t += 1000);
    const a = mk({ now, maxEntries: 200 });
    for (let i = 0; i < 205; i++) a.record("command_run", `cmd-${String(i).padStart(3, "0")}`, "denied");
    const list = a.list();
    expect(list).toHaveLength(200);
    expect(list.some((r) => r.key === "cmd-000")).toBe(false);
    expect(list.some((r) => r.key === "cmd-204")).toBe(true);
  });

  it("容量帽：超 30 天按 last-seen 清理", () => {
    const day = 24 * 60 * 60 * 1000;
    const base = 1_700_000_000_000;
    let t = 0;
    const a = mk({ now: () => base + (t += 1000) });
    a.record("command_run", "old-cmd", "denied");
    t = 31 * day; // 模拟 31 天后
    a.record("command_run", "new-cmd", "denied");
    const keys = a.list().map((r) => r.key);
    expect(keys).toContain("new-cmd");
    expect(keys).not.toContain("old-cmd");
  });

  it("dropCoveredBy：条目覆盖的候选核销（前缀 + 目录自覆盖 w/ 匹配 w），返回删除条数", () => {
    const a = mk();
    a.record("file_read", "c:/ws/src/a.ts", "denied");
    a.record("dir_list", "c:/ws/src", "denied");
    a.record("command_run", "ls", "denied");
    expect(a.dropCoveredBy({ tool: "file_write", key: "c:/ws/src/", scope: "subtree" })).toBe(2);
    expect(a.list().map((r) => `${r.tool}:${r.key}`)).toEqual(["command_run:ls"]);
    expect(a.dropCoveredBy({ tool: "file_write", key: "c:/ws/src/", scope: "subtree" })).toBe(0); // 无命中不删
  });

  it("drop：按 (tool,key) 精确双键对清除，返回条数", () => {
    const a = mk();
    a.record("command_run", "ls", "denied");
    a.record("file_read", "ls", "denied"); // 同键异工具：不受 command_run 的 drop 影响
    a.record("command_run", "pwd", "denied");
    expect(a.drop([{ tool: "command_run", key: "ls" }])).toBe(1);
    expect(a.list().map((r) => `${r.tool}:${r.key}`)).toEqual(["file_read:ls", "command_run:pwd"]);
    expect(a.drop([{ tool: "command_run", key: "ls" }])).toBe(0); // 已删 → 0
    expect(a.drop([{ tool: "file_read", key: "ls" }, { tool: "command_run", key: "pwd" }])).toBe(2);
    expect(a.list()).toEqual([]);
  });

  it("坏键不入档：key 空串 / 未知工具被忽略（不落盘不崩溃）", () => {
    const a = mk();
    a.record("file_write", "", "denied");
    a.record("mystery", "x", "denied");
    expect(a.list()).toEqual([]);
    a.record("file_write", "ok.ts", "denied");
    expect(a.list().map((r) => r.key)).toEqual(["ok.ts"]);
  });

  it("dropCoveredBy 方向语义：写条目核销读候选；读条目不核销写候选（6ac934c 方向）", () => {
    const a = mk();
    a.record("file_write", "c:/ws/other/b.ts", "denied"); // 写候选
    a.record("file_read", "c:/ws/src/a.ts", "denied"); // 读候选
    // 读条目（精确同键于写候选）不核销写候选——读不得吃写
    expect(a.dropCoveredBy({ tool: "file_read", key: "c:/ws/other/b.ts", scope: "self" })).toBe(0);
    expect(a.list()).toHaveLength(2);
    // 写条目（读候选所在目录子树）核销读候选——写信任蕴含读
    expect(a.dropCoveredBy({ tool: "file_write", key: "c:/ws/src/", scope: "subtree" })).toBe(1);
    expect(a.list().map((r) => `${r.tool}:${r.key}`)).toEqual(["file_write:c:/ws/other/b.ts"]);
  });

  it("落盘失败 → logger 报告且内存记录仍生效（不抛错）", () => {
    const blocker = join(tmp, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const logger = vi.fn();
    const a = mk({ file: join(blocker, "candidates.json"), logger });
    a.record("command_run", "ls", "denied");
    expect(a.list()).toHaveLength(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("候选落盘失败"));
  });

  it("JSON 字段为 kebab 六字段（原始文件键名断言）", () => {
    const a = mk();
    a.record("command_run", "ls", "allowed");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { workspaces: Record<string, Record<string, unknown>[]> };
    const rec = raw.workspaces[WS]?.[0];
    expect(rec).toBeDefined();
    expect(Object.keys(rec ?? {}).sort()).toEqual(["allow-count", "deny-count", "first-seen", "key", "last-seen", "tool"]);
    expect(rec?.["deny-count"]).toBe(0);
    expect(rec?.["allow-count"]).toBe(1);
    expect(typeof rec?.["first-seen"]).toBe("number");
    expect(typeof rec?.["last-seen"]).toBe("number");
  });

  it("损坏/不存在降级空白；垃圾记录过滤不崩溃", () => {
    writeFileSync(file, "{ not json", "utf8");
    expect(mk().list()).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        workspaces: {
          [WS]: [
            { tool: "x" },
            { tool: "command_run", key: "ls", "deny-count": 1, "allow-count": 0, "first-seen": 1, "last-seen": 1 },
            { tool: "mystery", key: "q", "deny-count": 1, "allow-count": 0, "first-seen": 1, "last-seen": 1 },
            { tool: "command_run", key: "rm", "deny-count": -1, "allow-count": 0, "first-seen": 1, "last-seen": 1 },
          ],
        },
      }),
      "utf8",
    );
    expect(mk().list()).toHaveLength(1);
  });
});
