import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApprovalChoice, ApprovalPrompt } from "../types/index.js";

export interface AskUserOptions {
  input?: Readable;
  output?: Writable;
}

export class AskUser {
  readonly #input: Readable;
  readonly #output: Writable | undefined;

  constructor(options: AskUserOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output;
  }

  async confirm(message: string): Promise<boolean> {
    const rl = createInterface({ input: this.#input, output: this.#output });
    try {
      for (;;) {
        const answer = (await rl.question(`${message} [Y/n] `)).trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
        this.#output?.write("请输入 y 或 n。\n");
      }
    } finally {
      rl.close();
    }
  }

  async askApproval(prompt: ApprovalPrompt): Promise<ApprovalChoice> {
    const rl = createInterface({ input: this.#input, output: this.#output });
    try {
      const isPath = prompt.kind === "path";
      // 用异步迭代器而非 rl.question：输入流 EOF 时接口即关闭，
      // 缓冲的后续行只能经迭代器取出（多行管道输入依赖此行为）。
      const lines = rl[Symbol.asyncIterator]();
      for (;;) {
        const suffix = isPath ? "  [d] 白名单(此目录)" : "";
        this.#output?.write(
          `${prompt.tool} ${prompt.key}\n[y] 允许  [n] 拒绝  [w] 加入白名单${suffix} → `,
        );
        const { value, done } = await lines.next();
        if (done) throw new Error("askApproval 输入耗尽，无法获得人工裁决");
        const answer = value.trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") return { action: "allow" };
        if (answer === "n" || answer === "no") return { action: "deny" };
        if (answer === "w") {
          return { action: "whitelist", entry: { tool: prompt.tool, key: prompt.key, kind: prompt.kind } };
        }
        if (answer === "d" && isPath) {
          const i = prompt.key.lastIndexOf("/");
          // 根级/盘符根：dir 条目=全部绝对路径/整盘超授权，降级为文件条目（与 buildWhitelistEntry 一致）
          if (i <= 0 || (i === 2 && prompt.key[1] === ":")) {
            return {
              action: "whitelist",
              entry: { tool: prompt.tool, key: prompt.key, kind: "path" },
            };
          }
          return {
            action: "whitelist",
            entry: { tool: prompt.tool, key: `${prompt.key.slice(0, i)}/`, kind: "path" },
          };
        }
        this.#output?.write(`请输入 y / n / w${isPath ? " / d" : ""}。\n`);
      }
    } finally {
      rl.close();
    }
  }
}
