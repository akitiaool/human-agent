import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileReader } from "../src/eyes/file-reader.js";

describe("FileReader", () => {
  let dir: string;
  const reader = new FileReader();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-reader-"));
    await writeFile(join(dir, "a.txt"), "hello world");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.txt"), "hello code");
    await mkdir(join(dir, "sub", "node_modules"));
    await writeFile(join(dir, "sub", "node_modules", "c.txt"), "hello code");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("读取存在的文件成功", async () => {
    const result = await reader.readFile(join(dir, "a.txt"));
    expect(result.success).toBe(true);
    expect(result.data).toBe("hello world");
  });

  it("读取不存在的文件返回失败结果而非抛错", async () => {
    const result = await reader.readFile(join(dir, "missing.txt"));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("ENOENT");
  });

  it("列出目录内容", async () => {
    const result = await reader.readDir(dir);
    expect(result.success).toBe(true);
    expect(result.data).toContain("a.txt");
    expect(result.data).toContain("sub");
  });

  it("列出不存在的目录返回失败结果", async () => {
    const result = await reader.readDir(join(dir, "nope"));
    expect(result.success).toBe(false);
  });

  it("检索包含关键词的文件并跳过 node_modules", async () => {
    const result = await reader.searchCode("hello code", dir);
    expect(result.success).toBe(true);
    expect(result.data).toContain(join("sub", "b.txt"));
    expect(result.data).not.toContain(join("sub", "node_modules", "c.txt"));
  });

  it("检索无匹配时返回空数组", async () => {
    const result = await reader.searchCode("zzz-not-found", dir);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("非法正则返回失败结果", async () => {
    const result = await reader.searchCode("([", dir);
    expect(result.success).toBe(false);
  });
});
