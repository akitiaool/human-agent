// 移植注：原 tests/policy.test.ts「PermissionPolicy 持久化与清理」12 例 → createWhitelist.grant/list
// （适配：terminal→command_run、write_file→file_write、read_file→file_read、read_dir→dir_list；
//  条目 {tool,key,kind}→{tool,key,scope}（kind:"path"→scope:"subtree"、kind:"exact"→scope:"self"）；
//  addEntry 布尔 → GrantResult.add 判别联合；entries()→list()；平面 JSON → v1 容器格式）。
// 另含 4 个 grant 面新用例（AddResult 四状态 + ⑯ 核销只在 added + 落盘失败 logger）。
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createKey, normalizeMatchKey } from "../src/permission/key.js";
import { createWhitelist } from "../src/permission/whitelist.js";
import type { TrustEntry } from "../src/tool/index.js";

// 夹具：tmp 目录 + realpath 实测（同 Task 3）；key 绑定 wsReal；store 中的键一律归一态
// （win32 小写 + 正斜杠），断言用 nk 包裹期望值。
const tmp = mkdtempSync(join(tmpdir(), "wl-"));
const wsDir = mkdtempSync(join(tmpdir(), "wl-ws-"));
const wsReal = realpathSync.native(wsDir);
const wsKey = normalizeMatchKey(wsReal);
const file = join(tmp, "whitelist.json");
const key = createKey({ workspace: wsReal });
const nk = (p: string): string => key.normalize({ tool: "file_write", key: p });

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
});
beforeEach(() => rmSync(file, { force: true }));

interface MkOverrides {
  retire?: (entry: TrustEntry) => number;
  logger?: (message: string) => void;
  file?: string;
}

const mk = (over?: MkOverrides) =>
  createWhitelist({
    workspaceKey: wsKey,
    file: over?.file ?? file,
    key,
    retire: over?.retire ?? (() => 0),
    logger: over?.logger ?? (() => {}),
  });

describe("permission/whitelist grant", () => {
  it("added：落盘且核销候选（retired = retire 调用返回值）", () => {
    const retire = vi.fn(() => 3);
    const wl = mk({ retire });
    const r = wl.grant({ tool: "file_write", key: join(wsReal, "src/x.ts"), scope: "self" });
    expect(r.add).toEqual({ status: "added" });
    expect(r.retired).toBe(3);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("duplicate / covered / rejected 时 retired = 0 且不核销（⑯）", () => {
    const retire = vi.fn(() => 0);
    const wl = mk({ retire });
    wl.grant({ tool: "file_write", key: `${join(wsReal, "src")}/`, scope: "subtree" });
    retire.mockClear();
    const dup = wl.grant({ tool: "file_write", key: `${join(wsReal, "src")}/`, scope: "subtree" });
    const cov = wl.grant({ tool: "file_read", key: join(wsReal, "src/a.ts"), scope: "self" });
    const rej1 = wl.grant({ tool: "mystery", key: "x", scope: "self" });
    const rej2 = wl.grant({ tool: "file_read", key: "  ", scope: "self" });
    expect(dup.add.status).toBe("duplicate");
    expect(cov.add).toEqual({ status: "covered", by: { tool: "file_write", key: nk(`${join(wsReal, "src")}/`), scope: "subtree" } });
    expect(rej1.add).toEqual({ status: "rejected", reason: "unknown-tool" });
    expect(rej2.add).toEqual({ status: "rejected", reason: "empty-key" });
    expect(retire).not.toHaveBeenCalled();
  });

  it("加父去子方向语义：写条目加父删除被覆盖读写子条目；读条目不得删写子条目（6ac934c 回归）", () => {
    const wl = mk();
    wl.grant({ tool: "file_write", key: join(wsReal, "src/a.ts"), scope: "self" });
    wl.grant({ tool: "file_read", key: join(wsReal, "src/b.ts"), scope: "self" });
    wl.grant({ tool: "file_read", key: `${join(wsReal, "src")}/`, scope: "subtree" }); // 读父：只吃读子
    expect(wl.list()).toEqual([
      { tool: "file_write", key: nk(join(wsReal, "src/a.ts")), scope: "self" },    // 写子存活
      { tool: "file_read", key: nk(`${join(wsReal, "src")}/`), scope: "subtree" }, // 读父入库，读子被吃
    ]);
  });

  it("落盘失败 → logger 报告且内存条目仍生效（added）", () => {
    // file 指向被文件占位的路径（同 store 测试手法）
    const blockerFile = join(tmp, "blocker");
    writeFileSync(blockerFile, "x", "utf8");
    const logger = vi.fn();
    const wl = mk({ logger, file: join(blockerFile, "w.json") });
    const r = wl.grant({ tool: "file_write", key: join(wsReal, "a.ts"), scope: "self" });
    expect(r.add.status).toBe("added");
    expect(wl.list()).toHaveLength(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("白名单落盘失败"));
  });
});

describe("permission/whitelist revoke", () => {
  it("命中：移除并持久化（重构造后仍不在）", () => {
    const wl = mk();
    wl.grant({ tool: "command_run", key: "git status", scope: "self" });
    wl.grant({ tool: "file_write", key: join(wsReal, "src/a.ts"), scope: "self" });
    expect(wl.revoke({ tool: "command_run", key: "git status", scope: "self" })).toBe(true);
    expect(wl.list()).toEqual([{ tool: "file_write", key: nk(join(wsReal, "src/a.ts")), scope: "self" }]);
    expect(mk().list()).toEqual([{ tool: "file_write", key: nk(join(wsReal, "src/a.ts")), scope: "self" }]);
  });

  it("三字段精确匹配：任一字段不同即不删（scope/key 分例）", () => {
    const wl = mk();
    wl.grant({ tool: "command_run", key: "git status", scope: "self" });
    expect(wl.revoke({ tool: "command_run", key: "git status", scope: "subtree" })).toBe(false);
    expect(wl.revoke({ tool: "command_run", key: "git status --short", scope: "self" })).toBe(false);
    expect(wl.list()).toEqual([{ tool: "command_run", key: "git status", scope: "self" }]);
    expect(wl.revoke({ tool: "command_run", key: "git status", scope: "self" })).toBe(true);
    expect(wl.list()).toEqual([]);
  });

  it("不存在：返回 false 且不落盘（文件保持未创建）", () => {
    const wl = mk();
    expect(wl.revoke({ tool: "command_run", key: "nope", scope: "self" })).toBe(false);
    expect(wl.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});

describe("白名单持久化与清理（移植 policy 持久化分区 ×12）", () => {
  it("grant 落盘；重新构造可加载", () => {
    const w1 = mk();
    expect(w1.grant({ tool: "command_run", key: "git status", scope: "self" }).add).toEqual({ status: "added" });
    const w2 = mk();
    expect(w2.list()).toEqual([{ tool: "command_run", key: "git status", scope: "self" }]);
  });

  it("按工作区分节：不同 workspaceKey 互不可见", () => {
    const a = mk();
    a.grant({ tool: "command_run", key: "ls -la", scope: "self" });
    const otherKey = normalizeMatchKey(join(wsReal, "other-ws"));
    const b = createWhitelist({ workspaceKey: otherKey, file, key, retire: () => 0, logger: () => {} });
    expect(b.list()).toEqual([]);
    b.grant({ tool: "command_run", key: "pwd", scope: "self" });
    expect(b.list()).toEqual([{ tool: "command_run", key: "pwd", scope: "self" }]);
    expect(a.list()).toEqual([{ tool: "command_run", key: "ls -la", scope: "self" }]); // a 分节不受影响
  });

  it("加父去子：新增目录条目删除被覆盖子条目（含自覆盖：目录条目清掉同键文件条目）", () => {
    const base = `${wsKey}/src`;
    const wl = mk();
    wl.grant({ tool: "file_write", key: `${base}/utils.ts`, scope: "self" });
    wl.grant({ tool: "file_write", key: base, scope: "self" });
    expect(wl.grant({ tool: "file_write", key: `${base}/`, scope: "subtree" }).add).toEqual({ status: "added" });
    expect(wl.list()).toEqual([{ tool: "file_write", key: `${base}/`, scope: "subtree" }]);
  });

  it("加子被父盖：已有父目录则 covered（不重复入库）", () => {
    const base = `${wsKey}/src`;
    const wl = mk();
    wl.grant({ tool: "file_write", key: `${base}/`, scope: "subtree" });
    expect(wl.grant({ tool: "file_write", key: `${base}/utils.ts`, scope: "self" }).add).toEqual({
      status: "covered",
      by: { tool: "file_write", key: `${base}/`, scope: "subtree" },
    });
    expect(wl.list()).toEqual([{ tool: "file_write", key: `${base}/`, scope: "subtree" }]);
  });

  it("方向盲区修复：读目录条目不得吞掉写子条目（写审批照常入库）", () => {
    const base = `${wsKey}/src`;
    const wl = mk();
    wl.grant({ tool: "dir_list", key: `${base}/`, scope: "subtree" });
    expect(wl.grant({ tool: "file_write", key: `${base}/a.ts`, scope: "self" }).add).toEqual({ status: "added" });
    expect(wl.list()).toEqual([
      { tool: "dir_list", key: `${base}/`, scope: "subtree" },
      { tool: "file_write", key: `${base}/a.ts`, scope: "self" },
    ]);
  });

  it("方向盲区修复：读目录条目不得删除既有写子条目（用户配置不静默丢失）", () => {
    const base = `${wsKey}/src`;
    const wl = mk();
    wl.grant({ tool: "file_write", key: `${base}/a.ts`, scope: "self" });
    expect(wl.grant({ tool: "dir_list", key: `${base}/`, scope: "subtree" }).add).toEqual({ status: "added" });
    expect(wl.list()).toEqual([
      { tool: "file_write", key: `${base}/a.ts`, scope: "self" },
      { tool: "dir_list", key: `${base}/`, scope: "subtree" },
    ]);
  });

  it("方向逻辑回归钉：写目录条目照旧删除被覆盖的读子条目（写信任蕴含读）", () => {
    const base = `${wsKey}/src`;
    const wl = mk();
    wl.grant({ tool: "file_read", key: `${base}/a.ts`, scope: "self" });
    expect(wl.grant({ tool: "file_write", key: `${base}/`, scope: "subtree" }).add).toEqual({ status: "added" });
    expect(wl.list()).toEqual([{ tool: "file_write", key: `${base}/`, scope: "subtree" }]);
  });

  it("精确重复条目跳过；命令条目按归一后去重", () => {
    const wl = mk();
    wl.grant({ tool: "command_run", key: "git status", scope: "self" });
    expect(wl.grant({ tool: "command_run", key: "git  status", scope: "self" }).add.status).toBe("duplicate");
    expect(wl.list()).toHaveLength(1);
  });

  it("文件不存在降级为空白名单（不崩溃）", () => {
    const wl = mk({ file: join(tmp, "missing.json") });
    expect(wl.list()).toEqual([]);
    expect(wl.grant({ tool: "command_run", key: "ls", scope: "self" }).add.status).toBe("added");
  });

  it("工作区条目（ensureWorkspace 等价）：写类子树条目 + 幂等", () => {
    const wl = mk();
    expect(wl.grant({ tool: "file_write", key: `${wsKey}/`, scope: "subtree" }).add).toEqual({ status: "added" });
    expect(wl.list()).toEqual([{ tool: "file_write", key: `${wsKey}/`, scope: "subtree" }]);
    expect(wl.grant({ tool: "file_write", key: `${wsKey}/`, scope: "subtree" }).add.status).toBe("duplicate");
    expect(wl.list()).toHaveLength(1);
  });

  it("内容损坏（非 JSON）降级为空白名单", () => {
    const bad = join(tmp, "corrupt.json");
    writeFileSync(bad, "{ not json", "utf8");
    expect(mk({ file: bad }).list()).toEqual([]);
  });

  it("垃圾条目（缺 key/非法 scope/未知工具/非数组分节）被过滤，list 不崩溃", () => {
    const bad = join(tmp, "junk.json");
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        workspaces: {
          [wsKey]: [
            { tool: "file_write" },
            { tool: "command_run", key: "ls", scope: "self" },
            { tool: "file_write", key: "x" },
            { tool: "command_run", key: "rm", scope: "weird" },
            { tool: "mystery", key: "q", scope: "self" },
          ],
          "/ws2": "not-array",
        },
      }),
      "utf8",
    );
    const wl = mk({ file: bad });
    expect(wl.list()).toEqual([{ tool: "command_run", key: "ls", scope: "self" }]);
    expect(wl.grant({ tool: "command_run", key: "pwd", scope: "self" }).add).toEqual({ status: "added" });
  });
});
