import { describe, expect, it } from "vitest";
import { ASTParser, NodeType } from "../src/brain/ast-parser.js";

describe("ASTParser 下推自动机状态机解析器", () => {
  const parser = new ASTParser();

  it("纯文本不产生 AST 节点（零歧义规则）", () => {
    const text = "这是一条普通对话消息，没有任何容器。";
    expect(parser.parse(text)).toBeNull();
    expect(parser.parseToInference(text)).toBeNull();
  });

  it("外层带有自然语言说明文本时，判定为普通对话返回 null", () => {
    const text = [
      "我先帮你读取文件：",
      "{",
      "<::: TOOL_CALL[r1]",
      "tool: read_file",
      "path: package.json",
      ":::> TOOL_CALL[r1]",
      "}",
    ].join("\n");
    expect(parser.parse(text)).toBeNull();
    expect(parser.parseToInference(text)).toBeNull();
  });

  it("解析标准单工具调用（read_file 带切片参数）", () => {
    const text = [
      "{",
      "<::: TOOL_CALL[r1]",
      "tool: read_file",
      "path: package.json",
      "start_line: 1",
      "line_count: 10",
      ":::> TOOL_CALL[r1]",
      "}",
    ].join("\n");
    const res = parser.parseToInference(text);
    expect(res).not.toBeNull();
    expect(res?.toolCalls).toHaveLength(1);
    expect(res?.toolCalls?.[0]).toEqual({
      name: "read_file",
      arguments: {
        path: "package.json",
        start_line: 1,
        line_count: 10,
      },
    });
  });

  it("解析全量写文件（write_file 原生 CONTENT 块，内含各种特殊字符与三反引号）", () => {
    const rawContent = "# 标题\n```tool_call\nfake\n```\n<::: TOOL_CALL[fake]\n:::> TOOL_CALL[fake]";
    const text = [
      "{",
      "<::: TOOL_CALL[w1]",
      "tool: write_file",
      "path: doc.md",
      "<::: CONTENT",
      rawContent,
      ":::> CONTENT",
      ":::> TOOL_CALL[w1]",
      "}",
    ].join("\n");
    const res = parser.parseToInference(text);
    expect(res).not.toBeNull();
    expect(res?.toolCalls?.[0]?.name).toBe("write_file");
    expect(res?.toolCalls?.[0]?.arguments.content).toBe(rawContent);
  });

  it("解析 edit_file 原生 N+1 流式多 Hunk 连续 Diff", () => {
    const text = [
      "{",
      "<::: TOOL_CALL[e1]",
      "tool: edit_file",
      "path: src/foo.ts",
      "base_version: v-123",
      "<::: BEFORE[1]",
      "const a = 1;",
      "<::> AFTER[1]",
      "const a = 2;",
      "<::> BEFORE[2]",
      "const b = 10;",
      "<::> AFTER[2]",
      "const b = 20;",
      ":::> AFTER[2]",
      ":::> TOOL_CALL[e1]",
      "}",
    ].join("\n");
    const res = parser.parseToInference(text);
    expect(res).not.toBeNull();
    expect(res?.toolCalls?.[0]?.name).toBe("edit_file");
    expect(res?.toolCalls?.[0]?.arguments).toEqual({
      path: "src/foo.ts",
      base_version: "v-123",
      hunks: [
        { search: "const a = 1;", replace: "const a = 2;" },
        { search: "const b = 10;", replace: "const b = 20;" },
      ],
    });
  });

  it("解析 PIPELINE 嵌套 BATCH 复合树状结构", () => {
    const text = [
      "{",
      "<::: PIPELINE[p1]",
      "  <::: TOOL_CALL[step1]",
      "  tool: terminal",
      "  <::: COMMAND",
      "  pnpm build",
      "  :::> COMMAND",
      "  :::> TOOL_CALL[step1]",
      "  <::: BATCH[b1]",
      "    <::: TOOL_CALL[test1]",
      "    tool: terminal",
      "    <::: COMMAND",
      "    pnpm test tests/a.test.ts",
      "    :::> COMMAND",
      "    :::> TOOL_CALL[test1]",
      "  :::> BATCH[b1]",
      ":::> PIPELINE[p1]",
      "}",
    ].join("\n");
    const res = parser.parseToInference(text);
    expect(res).not.toBeNull();
    expect(res?.toolCalls).toHaveLength(2);
    expect(res?.toolTree).toHaveLength(1);
    expect((res?.toolTree?.[0] as { mode?: string })?.mode).toBe("pipeline");
  });
});