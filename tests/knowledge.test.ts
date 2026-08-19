import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemas, serializeToolProtocol, TOOLS } from "../src/brain/knowledge.js";

describe("brain/knowledge", () => {
  it("知识库包含 7 个工具且名称齐全", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "read_file",
      "read_dir",
      "search_code",
      "write_file",
      "apply_patch",
      "terminal",
      "fetch_page",
    ]);
  });

  it("每个工具的 JSON Schema parameters 均为 object 形态", () => {
    for (const tool of TOOLS) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.properties).toBeTypeOf("object");
    }
  });

  it("TOOLS 的 parameters 与 zod 派生的 JSON Schema 一致", () => {
    for (const tool of TOOLS) {
      const name = tool.name as keyof typeof schemas;
      expect(tool.parameters).toEqual(z.toJSONSchema(schemas[name]));
    }
  });

  it("read_file 的 schema 要求 path 为字符串", () => {
    const jsonSchema = z.toJSONSchema(schemas.read_file) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(jsonSchema.properties.path).toEqual({ type: "string" });
    expect(jsonSchema.required).toEqual(["path"]);
  });

  it("terminal 的 timeoutMs 可选（required 仅含 command）", () => {
    const jsonSchema = z.toJSONSchema(schemas.terminal) as { required?: string[] };
    expect(jsonSchema.required).toEqual(["command"]);
  });

  it("serializeToolProtocol 输出协议头、全部工具与调用规则", () => {
    const protocol = serializeToolProtocol();
    expect(protocol).toContain("【human-agent 工具协议】");
    expect(protocol).toContain("read_file");
    expect(protocol).toContain("fetch_page");
    expect(protocol).toContain("一次只调用一个工具");
    expect(protocol).toContain("```tool_call");
  });
});
