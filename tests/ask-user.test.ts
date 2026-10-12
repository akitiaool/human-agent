import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AskUser } from "../src/mouth/ask-user.js";
import type { TrustEntry } from "../src/tool/index.js";

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

describe("askApproval（options 驱动三形态：0/1/2 项）", () => {
  const cmdOption: TrustEntry = { tool: "command_run", key: "ls -la", scope: "self" };
  const pathOptions: TrustEntry[] = [
    { tool: "file_write", key: "c:/ws/src/a.ts", scope: "self" },
    { tool: "file_write", key: "c:/ws/src/", scope: "subtree" },
  ];

  it("0 项（键缺失）：仅允许/拒绝，y → allow、n → deny", async () => {
    const ask1 = new AskUser({ input: inputFrom("y\n") });
    expect(await ask1.askApproval({ tool: "file_read", key: "", options: [] })).toEqual({ action: "allow" });
    const ask2 = new AskUser({ input: inputFrom("n\n") });
    expect(await ask2.askApproval({ tool: "file_read", key: "", options: [] })).toEqual({ action: "deny" });
  });

  it("0 项：w 不可用 → 循环追问（w 后 n 生效）", async () => {
    const ask = new AskUser({ input: inputFrom("w\nn\n") });
    const choice = await ask.askApproval({ tool: "file_read", key: "", options: [] });
    expect(choice).toEqual({ action: "deny" });
  });

  it("1 项（命令类）：w → 唯一选项（原样回显 entry）", async () => {
    const ask = new AskUser({ input: inputFrom("w\n") });
    const choice = await ask.askApproval({ tool: "command_run", key: "ls -la", options: [cmdOption] });
    expect(choice).toEqual({ action: "whitelist", entry: cmdOption });
  });

  it("1 项：y/n 仍可用", async () => {
    const ask1 = new AskUser({ input: inputFrom("y\n") });
    expect(await ask1.askApproval({ tool: "command_run", key: "ls -la", options: [cmdOption] })).toEqual({
      action: "allow",
    });
    const ask2 = new AskUser({ input: inputFrom("n\n") });
    expect(await ask2.askApproval({ tool: "command_run", key: "ls -la", options: [cmdOption] })).toEqual({
      action: "deny",
    });
  });

  it("2 项（路径类）：w → 此路径（options[0]）；d → 此目录（options[1]）", async () => {
    const ask1 = new AskUser({ input: inputFrom("w\n") });
    expect(await ask1.askApproval({ tool: "file_write", key: "c:/ws/src/a.ts", options: pathOptions })).toEqual({
      action: "whitelist",
      entry: pathOptions[0],
    });
    const ask2 = new AskUser({ input: inputFrom("d\n") });
    expect(await ask2.askApproval({ tool: "file_write", key: "c:/ws/src/a.ts", options: pathOptions })).toEqual({
      action: "whitelist",
      entry: pathOptions[1],
    });
  });

  it("非法输入循环追问（x 后 y 生效）", async () => {
    const ask = new AskUser({ input: inputFrom("x\ny\n") });
    const choice = await ask.askApproval({ tool: "command_run", key: "ls", options: [cmdOption] });
    expect(choice).toEqual({ action: "allow" });
  });
});
