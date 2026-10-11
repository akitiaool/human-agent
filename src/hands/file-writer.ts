import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fail, ok, type ActionResult, type EditFileResult } from "../types/index.js";
import type { DiffHunk } from "../brain/llm.js";
import { applyHunks, computeVersionId } from "./diff-engine.js";

function errnoCode(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    return (err as NodeJS.ErrnoException).code ?? fallback;
  }
  return fallback;
}

function errnoMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class FileWriter {
  async writeFile(path: string, content: string): Promise<ActionResult<void>> {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return ok(undefined);
    } catch (err) {
      return fail(errnoCode(err, "WRITE_ERROR"), errnoMessage(err));
    }
  }

  /**
   * 行级补丁格式：`- 目标行` 删除首个匹配行，`+ 新行` 在当前位置插入，其余行视为上下文忽略。
   */
  async applyPatch(path: string, patch: string): Promise<ActionResult<void>> {
    let current: string;
    try {
      current = await readFile(path, "utf-8");
    } catch (err) {
      return fail(errnoCode(err, "READ_ERROR"), errnoMessage(err));
    }

    const ops = patch
      .split("\n")
      .filter((line) => line.startsWith("-") || line.startsWith("+"))
      .map((line) => line.slice(0, 1) + line.slice(1).replace(/^ /, ""));
    const out: string[] = [];
    let opIndex = 0;

    for (const line of current.split("\n")) {
      while (opIndex < ops.length && ops[opIndex]!.startsWith("+")) {
        out.push(ops[opIndex]!.slice(1));
        opIndex++;
      }
      if (opIndex < ops.length && ops[opIndex]!.startsWith("-")) {
        if (line.trim() === ops[opIndex]!.slice(1).trim()) {
          opIndex++;
          continue;
        }
      }
      out.push(line);
    }
    while (opIndex < ops.length && ops[opIndex]!.startsWith("+")) {
      out.push(ops[opIndex]!.slice(1));
      opIndex++;
    }
    if (opIndex < ops.length) {
      return fail(
        "PATCH_NOT_FOUND",
        `未匹配到要删除的行: "${ops[opIndex]!.slice(1)}"`,
      );
    }

    const newContent = out.join("\n");
    if (newContent !== current) {
      try {
        await writeFile(path, newContent, "utf-8");
      } catch (err) {
        return fail(errnoCode(err, "WRITE_ERROR"), errnoMessage(err));
      }
    }
    return ok(undefined);
  }

  /**
   * 局部代码精确替换：具备快照版本校验（baseVersion 乐观锁）与原子多 Hunk 应用。
   */
  async editFile(
    path: string,
    hunks: readonly DiffHunk[],
    baseVersion?: string,
  ): Promise<ActionResult<EditFileResult>> {
    let current: string;
    try {
      current = await readFile(path, "utf-8");
    } catch (err) {
      return fail(errnoCode(err, "READ_ERROR"), errnoMessage(err));
    }

    const currentVersion = computeVersionId(current);
    if (baseVersion !== undefined && baseVersion !== currentVersion) {
      return fail(
        "VERSION_MISMATCH",
        `文件版本不匹配：声明的 base_version 为 ${baseVersion}，但磁盘当前版本为 ${currentVersion}。请重新读取该文件。`,
      );
    }

    const applyRes = applyHunks(current, hunks);
    if (!applyRes.success) {
      return fail(applyRes.error!.code, applyRes.error!.message);
    }

    const newContent = applyRes.data!;
    if (newContent !== current) {
      try {
        await writeFile(path, newContent, "utf-8");
      } catch (err) {
        return fail(errnoCode(err, "WRITE_ERROR"), errnoMessage(err));
      }
    }

    const newVersionId = computeVersionId(newContent);
    return ok({
      path,
      newVersionId,
      hunksApplied: hunks.length,
    });
  }
}
