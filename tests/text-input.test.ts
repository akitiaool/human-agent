import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TextInput } from "../src/ears/text-input.js";

function inputFrom(text: string): Readable {
  return new Readable({
    read() {
      this.push(text);
      this.push(null);
    },
  });
}

describe("TextInput", () => {
  it("prompt 返回用户输入并去除首尾空白", async () => {
    const input = new TextInput({ input: inputFrom("  hello world  \n") });
    expect(await input.prompt("请输入：")).toBe("hello world");
  });

  it("prompt 空输入返回空字符串", async () => {
    const input = new TextInput({ input: inputFrom("\n") });
    expect(await input.prompt("请输入：")).toBe("");
  });

  it("prompt 把问题写入输出流", async () => {
    const { Writable } = await import("node:stream");
    class FakeWritable extends Writable {
      public output = "";
      override _write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        this.output += String(chunk);
        callback();
      }
    }
    const stream = new FakeWritable();
    const input = new TextInput({ input: inputFrom("ok\n"), output: stream });
    await input.prompt("你叫什么名字？");
    expect(stream.output).toBe("你叫什么名字？");
  });
});
