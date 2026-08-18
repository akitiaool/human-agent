import { describe, expect, it } from "vitest";
import { Terminal } from "../src/hands/terminal.js";

describe("Terminal", () => {
  const terminal = new Terminal();

  it("成功执行命令并返回输出", async () => {
    const result = await terminal.executeCommand("echo hello-terminal");
    expect(result.success).toBe(true);
    expect(result.data).toContain("hello-terminal");
  });

  it("命令以非 0 退出码结束返回失败结果而非抛错", async () => {
    const result = await terminal.executeCommand("exit 3");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
  });

  it("不存在的命令返回失败结果", async () => {
    const result = await terminal.executeCommand("definitely-not-a-command-xyz");
    expect(result.success).toBe(false);
  });

  it("无输出的命令返回提示文案", async () => {
    const result = await terminal.executeCommand("cd .");
    expect(result.success).toBe(true);
    expect(result.data).toBe("Command executed with no output.");
  });

  it("超出 timeoutMs 的命令被终止并返回 EXEC_TIMEOUT", async () => {
    const result = await terminal.executeCommand(
      'node -e "setTimeout(() => {}, 3000)"',
      undefined,
      500,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("EXEC_TIMEOUT");
  });
});
