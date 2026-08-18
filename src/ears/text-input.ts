import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface TextInputOptions {
  input?: Readable;
  output?: Writable;
}

export class TextInput {
  readonly #input: Readable;
  readonly #output: Writable | undefined;

  constructor(options: TextInputOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output;
  }

  async prompt(question: string): Promise<string> {
    const rl = createInterface({ input: this.#input, output: this.#output });
    try {
      const answer = await rl.question(question);
      return answer.trim();
    } finally {
      rl.close();
    }
  }
}
