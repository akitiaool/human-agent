import { PassThrough, Readable, Writable } from "node:stream";
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

const silent = new Writable({
  write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback();
  },
});

describe("TextInput", () => {
  it("prompt 返回用户输入并去除首尾空白", async () => {
    const input = new TextInput({ input: inputFrom("  hello world  \n"), output: silent });
    expect(await input.prompt("请输入：")).toBe("hello world");
  });

  it("prompt 空输入返回空字符串", async () => {
    const input = new TextInput({ input: inputFrom("\n"), output: silent });
    expect(await input.prompt("请输入：")).toBe("");
  });

  it("连续 prompt 复用同一输入流，第二次提问不挂起", async () => {
    const input = new PassThrough();
    const ears = new TextInput({ input, output: silent });
    const first = ears.prompt("> ");
    input.write("第一行\n");
    expect(await first).toBe("第一行");
    const second = ears.prompt("> ");
    input.write("第二行\n");
    expect(await second).toBe("第二行");
    input.end();
  }, 2000);

  it("空闲期间到达的输入行会排队，下次提问时返回", async () => {
    const input = new PassThrough();
    const ears = new TextInput({ input, output: silent });
    input.write("第一行\n");
    input.write("第二行\n");
    expect(await ears.prompt("> ")).toBe("第一行");
    expect(await ears.prompt("> ")).toBe("第二行");
    input.end();
  }, 2000);

  it("输入流结束后，已排队的行仍可被读取，队列清空后再报错", async () => {
    const input = new PassThrough();
    const ears = new TextInput({ input, output: silent });
    input.write("第一行\n");
    input.write("第二行\n");
    input.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await ears.prompt("> ")).toBe("第一行");
    expect(await ears.prompt("> ")).toBe("第二行");
    await expect(ears.prompt("> ")).rejects.toThrow();
  });

  it("close 后不再监听输入，再次提问报错", async () => {
    const input = new PassThrough();
    const ears = new TextInput({ input, output: silent });
    ears.close();
    await expect(ears.prompt("> ")).rejects.toThrow();
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
