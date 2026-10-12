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
      // 选项数量驱动提示词与分支：0 项（键缺失）→ 仅允许/拒绝；1 项 → 追加 [w]；2 项 → 追加 [w]/[d]。
      const hasOne = prompt.options.length >= 1;
      const hasTwo = prompt.options.length >= 2;
      const suffix = hasTwo
        ? "  [w] 加入白名单(此路径)  [d] 加入白名单(此目录)"
        : hasOne
          ? "  [w] 加入白名单"
          : "";
      // 用异步迭代器而非 rl.question：输入流 EOF 时接口即关闭，
      // 缓冲的后续行只能经迭代器取出（多行管道输入依赖此行为）。
      const lines = rl[Symbol.asyncIterator]();
      for (;;) {
        this.#output?.write(`${prompt.tool} ${prompt.key}\n[y] 允许  [n] 拒绝${suffix} → `);
        const { value, done } = await lines.next();
        if (done) throw new Error("askApproval 输入耗尽，无法获得人工裁决");
        const answer = value.trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") return { action: "allow" };
        if (answer === "n" || answer === "no") return { action: "deny" };
        if (answer === "w" && hasOne) return { action: "whitelist", entry: prompt.options[0]! };
        if (answer === "d" && hasTwo) return { action: "whitelist", entry: prompt.options[1]! };
        this.#output?.write(`请输入 y / n${hasOne ? " / w" : ""}${hasTwo ? " / d" : ""}。\n`);
      }
    } finally {
      rl.close();
    }
  }
}
