import { ExecaError, execa } from "execa";
import { fail, ok, type ActionResult } from "../types/index.js";

export interface TerminalOptions {
  /** 命令工作目录（钉到工作区；缺省继承进程 CWD）。 */
  cwd?: string;
}

export class Terminal {
  readonly #cwd: string | undefined;

  constructor(options: TerminalOptions = {}) {
    this.#cwd = options.cwd;
  }

  async executeCommand(
    command: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ActionResult<string>> {
    try {
      const { stdout, stderr } = await execa({
        shell: true,
        encoding: "utf8",
        ...(this.#cwd !== undefined ? { cwd: this.#cwd } : {}),
        ...(signal !== undefined ? { cancelSignal: signal } : {}),
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      })`${command}`;
      return ok(stdout || stderr || "Command executed with no output.");
    } catch (err) {
      if (err instanceof ExecaError) {
        if (err.timedOut) {
          return fail(
            "exec-timeout",
            `命令执行超时（${timeoutMs}ms）: ${err.shortMessage}`,
          );
        }
        return fail(
          "exec-error",
          err.shortMessage,
          err.stderr || err.stdout || undefined,
        );
      }
      return fail(
        "exec-error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
