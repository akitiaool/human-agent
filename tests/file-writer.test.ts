import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileWriter } from "../src/hands/file-writer.js";
import { computeVersionId } from "../src/hands/diff-engine.js";

describe("FileWriter", () => {
  let dir: string;
  const writer = new FileWriter();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-writer-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("写入文件成功", async () => {
    const file = join(dir, "new.txt");
    const result = await writer.writeFile(file, "content");
    expect(result.success).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("content");
  });

  it("写入时自动创建缺失的父目录", async () => {
    const file = join(dir, "deep", "nested", "new.txt");
    const result = await writer.writeFile(file, "nested");
    expect(result.success).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("nested");
  });

  it("写入非法路径返回失败结果而非抛错", async () => {
    const blocker = join(dir, "blocker.txt");
    await writeFile(blocker, "a file");
    const result = await writer.writeFile(join(blocker, "x.txt"), "x");
    expect(result.success).toBe(false);
  });

  it("applyPatch 用 - 删除目标行", async () => {
    const file = join(dir, "delete.txt");
    await writeFile(file, "keep\nremove\nkeep2\n");
    const result = await writer.applyPatch(file, "- remove\n");
    expect(result.success).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("keep\nkeep2\n");
  });

  it("applyPatch 用 - + 替换目标行", async () => {
    const file = join(dir, "replace.txt");
    await writeFile(file, "line1\nline2\nline3\n");
    const result = await writer.applyPatch(file, "- line2\n+ line2-modified\n");
    expect(result.success).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("line1\nline2-modified\nline3\n");
  });

  it("applyPatch 用 + 插入新行", async () => {
    const file = join(dir, "insert.txt");
    await writeFile(file, "first\nlast\n");
    const result = await writer.applyPatch(file, "+ middle\n");
    expect(result.success).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("middle\nfirst\nlast\n");
  });

  it("applyPatch 匹配不到删除目标时返回失败", async () => {
    const file = join(dir, "nomatch.txt");
    await writeFile(file, "aaa\n");
    const result = await writer.applyPatch(file, "- zzz\n");
    expect(result.success).toBe(false);
    expect(await readFile(file, "utf-8")).toBe("aaa\n");
  });

  it("applyPatch 目标文件不存在时返回失败", async () => {
    const result = await writer.applyPatch(join(dir, "missing.txt"), "- x\n");
    expect(result.success).toBe(false);
  });

  it("editFile 校验 base_version 成功并原子替换多个 Hunk", async () => {
    const file = join(dir, "edit-test.txt");
    const initial = "function a() { return 1; }\nfunction b() { return 2; }";
    await writeFile(file, initial, "utf-8");
    const v1 = computeVersionId(initial);

    const result = await writer.editFile(
      file,
      [
        { search: "return 1;", replace: "return 10;" },
        { search: "return 2;", replace: "return 20;" },
      ],
      v1,
    );

    expect(result.success).toBe(true);
    expect(result.data?.hunksApplied).toBe(2);
    expect(result.data?.newVersionId).toMatch(/^v-[a-f0-9]{8}$/);
    expect(await readFile(file, "utf-8")).toBe("function a() { return 10; }\nfunction b() { return 20; }");
  });

  it("editFile 在 base_version 不匹配时拒绝修改并返回 VERSION_MISMATCH", async () => {
    const file = join(dir, "mismatch.txt");
    await writeFile(file, "hello", "utf-8");
    const result = await writer.editFile(file, [{ search: "hello", replace: "world" }], "v-wrong");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VERSION_MISMATCH");
    expect(await readFile(file, "utf-8")).toBe("hello");
  });
});
