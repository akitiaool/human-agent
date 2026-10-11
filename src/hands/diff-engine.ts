import { createHash } from "node:crypto";
import { fail, ok, type ActionResult } from "../types/index.js";
import type { DiffHunk } from "../brain/llm.js";

export const HUNK_REGEX = /<::: BEFORE\r?\n([\s\S]*?)\r?\n:::> AFTER\r?\n([\s\S]*?)\r?\n<::: END/g;

/** 计算文件内容唯一快照版本 ID（例如 v-a1b2c3d4）。 */
export function computeVersionId(content: string): string {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return `v-${hash.slice(0, 8)}`;
}

/** 从包含 <::: BEFORE ... :::> AFTER ... <::: END 的文本中提取所有 DiffHunk。 */
export function extractDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const match of diffText.matchAll(HUNK_REGEX)) {
    hunks.push({
      search: match[1]!,
      replace: match[2]!,
    });
  }
  return hunks;
}

function normalizeCrlf(str: string): string {
  return str.replace(/\r\n/g, "\n");
}

/**
 * 原子性应用一组 Hunk 补丁。
 * 具备换行符容错与唯一性检测。如果任何一个 hunk 匹配失败或存在多处歧义，则完整回滚。
 */
export function applyHunks(originalContent: string, hunks: readonly DiffHunk[]): ActionResult<string> {
  if (hunks.length === 0) {
    return ok(originalContent);
  }

  const isCrlf = originalContent.includes("\r\n");
  let content = normalizeCrlf(originalContent);

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!;
    const search = normalizeCrlf(hunk.search);
    const replace = normalizeCrlf(hunk.replace);

    if (search === "") {
      return fail("EMPTY_SEARCH", `第 ${i + 1} 个 Diff 块的 search 内容不能为空`);
    }

    const firstIndex = content.indexOf(search);
    if (firstIndex === -1) {
      return fail(
        "HUNK_NOT_FOUND",
        `第 ${i + 1} 个 Diff 块在目标文件中未找到匹配代码：\n${truncateSnippet(search, 120)}`,
      );
    }

    const secondIndex = content.indexOf(search, firstIndex + search.length);
    if (secondIndex !== -1) {
      return fail(
        "AMBIGUOUS_MATCH",
        `第 ${i + 1} 个 Diff 块在目标文件中匹配到多处，请增加上下文行以唯一定位`,
      );
    }

    content = content.slice(0, firstIndex) + replace + content.slice(firstIndex + search.length);
  }

  const finalContent = isCrlf ? content.replace(/\n/g, "\r\n") : content;
  return ok(finalContent);
}

function truncateSnippet(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
