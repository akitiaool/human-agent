import { describe, expect, it } from "vitest";
import { applyHunks, computeVersionId, extractDiffHunks } from "../src/hands/diff-engine.js";

describe("diff-engine", () => {
  it("computeVersionId 为内容生成 v- 开头的短哈希", () => {
    const v1 = computeVersionId("hello world");
    const v2 = computeVersionId("hello world");
    const v3 = computeVersionId("different");
    expect(v1).toMatch(/^v-[a-f0-9]{8}$/);
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
  });

  it("extractDiffHunks 正确提取单个和多个 Hunk", () => {
    const text = [
      "<::: BEFORE",
      "const a = 1;",
      ":::> AFTER",
      "const a = 2;",
      "<::: END",
      "<::: BEFORE",
      "function b() {}",
      ":::> AFTER",
      "function b(x: number) {}",
      "<::: END",
    ].join("\n");
    const hunks = extractDiffHunks(text);
    expect(hunks).toEqual([
      { search: "const a = 1;", replace: "const a = 2;" },
      { search: "function b() {}", replace: "function b(x: number) {}" },
    ]);
  });

  it("applyHunks 成功替换单个 Hunk", () => {
    const original = "line 1\nline 2\nline 3";
    const hunks = [{ search: "line 2", replace: "line two" }];
    const result = applyHunks(original, hunks);
    expect(result.status).toBe("ok");
    expect(result.data).toBe("line 1\nline two\nline 3");
  });

  it("applyHunks 成功按序替换多个 Hunk", () => {
    const original = "const x = 1;\nconst y = 2;";
    const hunks = [
      { search: "const x = 1;", replace: "const x = 10;" },
      { search: "const y = 2;", replace: "const y = 20;" },
    ];
    const result = applyHunks(original, hunks);
    expect(result.status).toBe("ok");
    expect(result.data).toBe("const x = 10;\nconst y = 20;");
  });

  it("applyHunks 在未找到匹配时返回 hunk-not-found 且不修改", () => {
    const original = "const x = 1;";
    const hunks = [{ search: "const not_found = 2;", replace: "new" }];
    const result = applyHunks(original, hunks);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("hunk-not-found");
  });

  it("applyHunks 在出现多处歧义时返回 ambiguous-match 且完整回滚", () => {
    const original = "const x = 1;\nconst x = 1;";
    const hunks = [{ search: "const x = 1;", replace: "const x = 2;" }];
    const result = applyHunks(original, hunks);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("ambiguous-match");
  });

  it("applyHunks 支持 CRLF 换行符并在返回时保留 CRLF 格式", () => {
    const original = "line 1\r\nline 2\r\nline 3";
    const hunks = [{ search: "line 2", replace: "line 2 (modified)" }];
    const result = applyHunks(original, hunks);
    expect(result.status).toBe("ok");
    expect(result.data).toBe("line 1\r\nline 2 (modified)\r\nline 3");
  });
});
