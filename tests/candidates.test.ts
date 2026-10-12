import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CandidatesArchive } from "../src/nose/candidates.js";

const dir = mkdtempSync(join(tmpdir(), "cand-test-"));
const file = join(dir, "candidates.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(file, { force: true }));

const WS = "/ws";

describe("CandidatesArchive", () => {
  it("聚合：同 (tool,key) 计数累加，firstSeen 保持 / lastSeen 更新", () => {
    let t = 0;
    const now = () => new Date(1_700_000_000_000 + (t += 1000));
    const a = new CandidatesArchive({ workspace: WS, file, now });
    a.record("write_file", "c:/ws/a.ts", "denied");
    a.record("write_file", "c:/ws/a.ts", "denied");
    a.record("write_file", "c:/ws/a.ts", "allowed");
    const list = a.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: "write_file", key: "c:/ws/a.ts", denied: 2, allowed: 1 });
    expect(list[0]!.firstSeen).not.toBe(list[0]!.lastSeen);
  });

  it("持久化 + 重载（按工作区分节，镜像 whitelist.json）", () => {
    const a = new CandidatesArchive({ workspace: WS, file });
    a.record("terminal", "ls -la", "denied");
    expect(new CandidatesArchive({ workspace: WS, file }).list()).toHaveLength(1);
    expect(new CandidatesArchive({ workspace: "/other", file }).list()).toHaveLength(0);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[]>;
    expect(Object.keys(raw)).toContain(WS);
  });

  it("容量帽：超 200 按 lastSeen 丢最旧", () => {
    let t = 0;
    const now = () => new Date(1_700_000_000_000 + (t += 1000));
    const a = new CandidatesArchive({ workspace: WS, file, now, maxEntries: 200 });
    for (let i = 0; i < 205; i++) a.record("terminal", `cmd-${String(i).padStart(3, "0")}`, "denied");
    const list = a.list();
    expect(list).toHaveLength(200);
    expect(list.some((r) => r.key === "cmd-000")).toBe(false);
    expect(list.some((r) => r.key === "cmd-204")).toBe(true);
  });

  it("容量帽：超 30 天按 lastSeen 清理", () => {
    const day = 24 * 60 * 60 * 1000;
    const base = 1_700_000_000_000;
    let t = 0;
    const a = new CandidatesArchive({ workspace: WS, file, now: () => new Date(base + (t += 1000)) });
    a.record("terminal", "old-cmd", "denied");
    t = 31 * day; // 模拟 31 天后
    a.record("terminal", "new-cmd", "denied");
    const keys = a.list().map((r) => r.key);
    expect(keys).toContain("new-cmd");
    expect(keys).not.toContain("old-cmd");
  });

  it("removeCovered：条目覆盖的候选核销（前缀 + 目录自覆盖 w/ 匹配 w）", () => {
    const a = new CandidatesArchive({ workspace: WS, file });
    a.record("read_file", "c:/ws/src/a.ts", "denied");
    a.record("read_dir", "c:/ws/src", "denied");
    a.record("terminal", "ls", "denied");
    a.removeCovered({ tool: "write_file", key: "c:/ws/src/", kind: "path" });
    expect(a.list().map((r) => `${r.tool}:${r.key}`)).toEqual(["terminal:ls"]);
  });

  it("remove：按 (tool,key) 精确清除", () => {
    const a = new CandidatesArchive({ workspace: WS, file });
    a.record("terminal", "ls", "denied");
    a.record("terminal", "pwd", "denied");
    a.remove([{ tool: "terminal", key: "ls" }]);
    expect(a.list().map((r) => r.key)).toEqual(["pwd"]);
  });

  it("损坏/不存在降级空白；垃圾记录过滤不崩溃", () => {
    writeFileSync(file, "{ not json", "utf8");
    expect(new CandidatesArchive({ workspace: WS, file }).list()).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        [WS]: [
          { tool: "x" },
          {
            tool: "terminal",
            key: "ls",
            denied: 1,
            allowed: 0,
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    expect(new CandidatesArchive({ workspace: WS, file }).list()).toHaveLength(1);
  });
});
