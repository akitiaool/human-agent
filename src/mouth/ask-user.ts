import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

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
}
