import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyContainer, loadContainer, saveContainer, type Container } from "../src/permission/store.js";

interface Item { id: string }
const parseItem = (raw: unknown): Item | null =>
  typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
    ? { id: (raw as { id: string }).id }
    : null;

const dir = (): string => mkdtempSync(join(tmpdir(), "store-"));

describe("permission/store", () => {
  it("roundtrip：save → load 保真", () => {
    const file = join(dir(), "w.json");
    const container: Container<Item> = { version: 1, workspaces: { "/ws": [{ id: "a" }] } };
    expect(saveContainer(file, container)).toBe(true);
    expect(loadContainer(file, parseItem)).toEqual(container);
  });

  it("文件不存在 → 空容器", () => {
    expect(loadContainer(join(dir(), "nope.json"), parseItem)).toEqual(emptyContainer<Item>());
  });

  it("损坏 JSON → 空容器", () => {
    const file = join(dir(), "bad.json");
    writeFileSync(file, "{oops", "utf8");
    expect(loadContainer(file, parseItem)).toEqual(emptyContainer<Item>());
  });

  it("version ≠ 1 → 整档空", () => {
    const file = join(dir(), "v2.json");
    writeFileSync(file, JSON.stringify({ version: 2, workspaces: { "/ws": [{ id: "a" }] } }), "utf8");
    expect(loadContainer(file, parseItem)).toEqual(emptyContainer<Item>());
  });

  it("非数组分节跳过；坏条目经 parseItem 丢弃", () => {
    const file = join(dir(), "mixed.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, workspaces: { "/ws": [{ id: "a" }, { nope: 1 }], "/other": "garbage" } }),
      "utf8",
    );
    expect(loadContainer(file, parseItem)).toEqual({ version: 1, workspaces: { "/ws": [{ id: "a" }] } });
  });

  it("workspaces 为 null / 数组 → 整档空", () => {
    const nullWs = join(dir(), "null-ws.json");
    writeFileSync(nullWs, JSON.stringify({ version: 1, workspaces: null }), "utf8");
    expect(loadContainer(nullWs, parseItem)).toEqual(emptyContainer<Item>());
    const arrWs = join(dir(), "arr-ws.json");
    writeFileSync(arrWs, JSON.stringify({ version: 1, workspaces: [] }), "utf8");
    expect(loadContainer(arrWs, parseItem)).toEqual(emptyContainer<Item>());
  });

  it("save 失败返回 false 不抛错（目标路径被文件占位）", () => {
    const d = dir();
    const blocker = join(d, "blocker");
    writeFileSync(blocker, "x", "utf8");
    expect(saveContainer(join(blocker, "w.json"), emptyContainer<Item>())).toBe(false);
  });

  it("写盘序列化 = JSON（供人工核 v1 格式）", () => {
    const file = join(dir(), "w.json");
    saveContainer(file, { version: 1, workspaces: { "/ws": [{ id: "a" }] } });
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(1);
    expect(raw["workspaces"]).toBeDefined();
  });

  it("原子落盘 pin：覆盖旧文件成功、无 .tmp 残留", () => {
    const file = join(dir(), "w.json");
    saveContainer(file, { version: 1, workspaces: { "/ws": [{ id: "a" }] } });
    expect(saveContainer(file, { version: 1, workspaces: { "/ws": [{ id: "b" }] } })).toBe(true);
    expect(loadContainer(file, parseItem)).toEqual({ version: 1, workspaces: { "/ws": [{ id: "b" }] } });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
