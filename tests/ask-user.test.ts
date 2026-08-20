import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AskUser } from "../src/mouth/ask-user.js";
import type { ApprovalPrompt, ApprovalChoice } from "../src/types/index.js";

function inputFrom(text: string): Readable {
  return new Readable({
    read() {
      this.push(text);
      this.push(null);
    },
  });
}

describe("AskUser", () => {
  it("输入 y 返回 true", async () => {
    const ask = new AskUser({ input: inputFrom("y\n") });
    expect(await ask.confirm("删除文件？")).toBe(true);
  });

  it("输入 Y 和 yes 都返回 true", async () => {
    const ask1 = new AskUser({ input: inputFrom("Y\n") });
    expect(await ask1.confirm("q")).toBe(true);
    const ask2 = new AskUser({ input: inputFrom("yes\n") });
    expect(await ask2.confirm("q")).toBe(true);
  });

  it("输入 n 返回 false", async () => {
    const ask = new AskUser({ input: inputFrom("n\n") });
    expect(await ask.confirm("删除文件？")).toBe(false);
  });

  it("输入 N 和 no 都返回 false", async () => {
    const ask1 = new AskUser({ input: inputFrom("N\n") });
    expect(await ask1.confirm("q")).toBe(false);
    const ask2 = new AskUser({ input: inputFrom("no\n") });
    expect(await ask2.confirm("q")).toBe(false);
  });

  it("直接回车使用默认值 Y 返回 true", async () => {
    const ask = new AskUser({ input: inputFrom("\n") });
    expect(await ask.confirm("删除文件？")).toBe(true);
  });

  it("无效输入会继续追问直到得到有效答案", async () => {
    const input = new PassThrough();
    const ask = new AskUser({ input });
    const promise = ask.confirm("删除文件？");
    input.write("maybe\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.write("y\n");
    input.end();
    expect(await promise).toBe(true);
  });

  it("确认文案包含 [Y/n] 提示", async () => {
    const output = new PassThrough();
    const collected: string[] = [];
    output.on("data", (chunk: Buffer) => collected.push(chunk.toString()));
    const ask = new AskUser({ input: inputFrom("y\n"), output });
    await ask.confirm("真的要删除吗");
    expect(collected.join("")).toContain("真的要删除吗");
    expect(collected.join("")).toContain("[Y/n]");
  });
});

describe("askApproval 三选", () => {
  it("y → allow", async () => {
    const ask = new AskUser({ input: inputFrom("y\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls -la", kind: "exact" });
    expect(choice).toEqual({ action: "allow" });
  });
  it("n → deny", async () => {
    const ask = new AskUser({ input: inputFrom("n\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls -la", kind: "exact" });
    expect(choice).toEqual({ action: "deny" });
  });
  it("w → whitelist（exact 条目）", async () => {
    const ask = new AskUser({ input: inputFrom("w\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls -la", kind: "exact" });
    expect(choice).toEqual({ action: "whitelist", entry: { tool: "terminal", key: "ls -la", kind: "exact" } });
  });
  it("写类：w → 此路径；d → 此目录", async () => {
    const ask1 = new AskUser({ input: inputFrom("w\n") });
    const pathChoice = await ask1.askApproval({ tool: "write_file", key: "src/utils.ts", kind: "path" });
    expect(pathChoice).toEqual({
      action: "whitelist",
      entry: { tool: "write_file", key: "src/utils.ts", kind: "path" },
    });
    const ask2 = new AskUser({ input: inputFrom("d\n") });
    const dirChoice = await ask2.askApproval({ tool: "write_file", key: "src/utils.ts", kind: "path" });
    expect(dirChoice).toEqual({
      action: "whitelist",
      entry: { tool: "write_file", key: "src/", kind: "path" },
    });
  });
  it("非法输入循环追问（x 后 y 生效）", async () => {
    const ask = new AskUser({ input: inputFrom("x\ny\n") });
    const choice = await ask.askApproval({ tool: "terminal", key: "ls", kind: "exact" });
    expect(choice).toEqual({ action: "allow" });
  });
});
