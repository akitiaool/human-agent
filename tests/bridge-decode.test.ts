import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { haDecodeGenerateContent } from "../extensions/gemini-bridge/decode.js";
import { ASTParser } from "../src/brain/ast-parser.js";

const plainRaw = readFileSync(new URL("../probe-samples/generatecontent-plain-reply.txt", import.meta.url), "utf8");
const toolRaw = readFileSync(new URL("../probe-samples/generatecontent-tool-call-reply.txt", import.meta.url), "utf8");

describe("haDecodeGenerateContent：普通回复样本", () => {
  it("解码成功：515 字符 / 15 deltas / 2 thoughts / 以「你好！」开头且无 { 头", () => {
    const d = haDecodeGenerateContent(plainRaw);
    expect(d).not.toBeNull();
    expect(d?.answer.length).toBe(515);
    expect(d?.deltaCount).toBe(15);
    expect(d?.thoughtCount).toBe(2);
    expect(d?.answer.startsWith("你好！")).toBe(true);
    expect(d?.answer.startsWith("{")).toBe(false);
  });
});

describe("haDecodeGenerateContent：工具调用回复样本", () => {
  it("解码成功：1215 字符 / 24 deltas / 5 thoughts / { 起 } 止 / 两对围栏逐字节在", () => {
    const d = haDecodeGenerateContent(toolRaw);
    expect(d).not.toBeNull();
    expect(d?.answer.length).toBe(1215);
    expect(d?.deltaCount).toBe(24);
    expect(d?.thoughtCount).toBe(5);
    expect(d?.answer.startsWith("{")).toBe(true);
    expect(d?.answer.endsWith("}")).toBe(true);
    expect(d?.answer.includes("<::: TOOL_CALL[1]")).toBe(true);
    expect(d?.answer.includes(":::> TOOL_CALL[1]")).toBe(true);
    // ```js 与 ```bash 两对围栏 = 4 个反引号序列
    expect(d?.answer.split("```").length - 1).toBe(4);
    expect(d?.answer.includes("```js")).toBe(true);
    expect(d?.answer.includes("```bash")).toBe(true);
  });
});

describe("贯通：网络原文 → 解码 → 无转义 AST 解析", () => {
  it("工具调用样本：toolTree 1 个 write_file，content 内嵌围栏原文、于 CONTENT 闭合符前终止", () => {
    const d = haDecodeGenerateContent(toolRaw);
    if (d === null) throw new Error("工具调用样本解码失败");
    const inf = new ASTParser().parseToInference(d.answer);
    if (inf === null) throw new Error("AST 解析失败");
    expect(inf.toolTree.length).toBe(1);
    expect(inf.toolCalls.length).toBe(1);
    const call = inf.toolCalls[0];
    expect(call?.name).toBe("write_file");
    expect(call?.arguments.path).toBe("docs/example.md");
    const content = call?.arguments.content;
    expect(typeof content).toBe("string");
    expect((content as string).includes("```js")).toBe(true);
    expect((content as string).includes("```bash")).toBe(true);
    expect((content as string).includes(":::>")).toBe(false); // 标记未漏进内容：于终结符前终止
  });
});

describe("健壮性：失败一律 null（响亮停滞，不做猜测性修补）", () => {
  it("非 JSON → null", () => {
    expect(haDecodeGenerateContent("这不是 JSON")).toBeNull();
  });

  it("合法 JSON 但无文本 part → null", () => {
    expect(haDecodeGenerateContent("{}")).toBeNull();
    expect(haDecodeGenerateContent("[]")).toBeNull();
  });

  it("空文本 part → null", () => {
    expect(haDecodeGenerateContent(JSON.stringify([[null, ""]]))).toBeNull();
  });

  it("仅 thought part → null", () => {
    // 长度 13 且 index 12 === 1 = thought
    const thought = [null, "思考内容", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(haDecodeGenerateContent(JSON.stringify([thought]))).toBeNull();
  });
});
