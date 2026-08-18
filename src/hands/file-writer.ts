import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fail, ok, type ActionResult } from "../types/index.js";

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
}
