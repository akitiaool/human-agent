import { ExecaError, execa } from "execa";
import { fail, ok, type ActionResult } from "../types/index.js";

export class Terminal {
  async executeCommand(
    command: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ActionResult<string>> {
    try {
      const { stdout, stderr } = await execa({
        shell: true,
        encoding: "utf8",
        ...(signal !== undefined ? { cancelSignal: signal } : {}),
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      })`${command}`;
      return ok(stdout || stderr || "Command executed with no output.");
    } catch (err) {
      if (err instanceof ExecaError) {
        if (err.timedOut) {
          return fail(
            "EXEC_TIMEOUT",
            `命令执行超时（${timeoutMs}ms）: ${err.shortMessage}`,
          );
        }
        return fail(
          "EXEC_ERROR",
          err.shortMessage,
          err.stderr || err.stdout || undefined,
        );
      }
      return fail(
        "EXEC_ERROR",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
