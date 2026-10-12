import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fail, ok, type ActionResult, type ReadFileResult } from "../types/index.js";
import { computeVersionId } from "../hands/diff-engine.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

function errnoCode(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ?? fallback;
  }
  return fallback;
}

function errnoMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class FileReader {
  async readFile(
    path: string,
    options?: { startLine?: number | undefined; lineCount?: number | undefined },
  ): Promise<ActionResult<ReadFileResult>> {
    try {
      const raw = await readFile(path, "utf-8");
      const versionId = computeVersionId(raw);
      const lines = raw.split("\n");
      const totalLines = lines.length;

      if (options?.startLine !== undefined || options?.lineCount !== undefined) {
        const start = Math.max(1, options?.startLine ?? 1);
        const count = Math.max(1, options?.lineCount ?? totalLines);
        const end = Math.min(totalLines, start + count - 1);
        const slice = lines.slice(start - 1, end);

        // 带行号格式化，便于大模型精确定位
        const padLen = String(end).length;
        const numbered = slice
          .map((line, idx) => `${String(start + idx).padStart(padLen, " ")} | ${line}`)
          .join("\n");

        return ok({
          content: numbered,
          versionId,
          totalLines,
          startLine: start,
          endLine: end,
        });
      }

      return ok({
        content: raw,
        versionId,
        totalLines,
      });
    } catch (err) {
      return fail(errnoCode(err, "read-error"), errnoMessage(err));
    }
  }

  async readDir(path: string): Promise<ActionResult<string[]>> {
    try {
      return ok((await readdir(path)).sort());
    } catch (err) {
      return fail(errnoCode(err, "read-error"), errnoMessage(err));
    }
  }

  async searchCode(
    pattern: string,
    dir: string = process.cwd(),
  ): Promise<ActionResult<string[]>> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return fail("invalid-pattern", `非法正则表达式: ${pattern}`);
    }
    const matches: string[] = [];
    try {
      await this.#walk(dir, dir, regex, matches);
      return ok(matches);
    } catch (err) {
      return fail(errnoCode(err, "read-error"), errnoMessage(err));
    }
  }

  async #walk(
    dir: string,
    root: string,
    pattern: RegExp,
    matches: string[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await this.#walk(fullPath, root, pattern, matches);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath, "utf-8").catch(() => "");
        if (pattern.test(content)) {
          matches.push(relative(root, fullPath));
        }
      }
    }
  }
}
