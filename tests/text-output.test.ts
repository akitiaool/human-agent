import { Writable } from "node:stream";
import { Chalk } from "chalk";
import { describe, expect, it } from "vitest";
import { TextOutput } from "../src/mouth/text-output.js";

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

const colorChalk = new Chalk({ level: 3 });

describe("TextOutput", () => {
  it("speak 逐字输出完整文本", async () => {
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, intervalMs: 0, chalk: colorChalk });
    await output.speak("hello 世界");
    expect(stream.output).toBe("hello 世界");
  });

  it("speak 按间隔分次写出而非一次性写出", async () => {
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, intervalMs: 50, chalk: colorChalk });
    const promise = output.speak("abc");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stream.output).toBe("ab");
    await promise;
    expect(stream.output).toBe("abc");
  });

  it("info 输出蓝色前缀", () => {
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, chalk: colorChalk });
    output.info("hello info");
    expect(stream.output).toBe(colorChalk.blue("hello info") + "\n");
  });

  it("success 输出绿色", () => {
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, chalk: colorChalk });
    output.success("hello success");
    expect(stream.output).toBe(colorChalk.green("hello success") + "\n");
  });

  it("warn 输出黄色", () => {
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, chalk: colorChalk });
    output.warn("hello warn");
    expect(stream.output).toBe(colorChalk.yellow("hello warn") + "\n");
  });

  it("error 输出红色", () => {
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, chalk: colorChalk });
    output.error("hello error");
    expect(stream.output).toBe(colorChalk.red("hello error") + "\n");
  });

  it("printDiff 新增行绿色、删除行红色、上下文原样", () => {
    const stream = new FakeWritable();
    const output = new TextOutput({ stdout: stream, chalk: colorChalk });
    output.printDiff("+ added\n- removed\ncontext");
    expect(stream.output).toBe(
      colorChalk.green("+ added") + "\n" + colorChalk.red("- removed") + "\n" + "context\n",
    );
  });
});
