import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface TextInputOptions {
  input?: Readable;
  output?: Writable;
}

interface Waiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}

/** 单个实例只创建一个 readline 接口；空闲期间到达的行会排队，避免丢失（设计文档 §3.3）。 */
export class TextInput {
  readonly #rl: Interface;
  readonly #output: Writable;
  readonly #queue: string[] = [];
  #waiters: Waiter[] = [];
  #inputEnded = false;

  constructor(options: TextInputOptions = {}) {
    const input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#rl = createInterface({ input, output: this.#output });
    this.#rl.on("line", (line) => {
      const trimmed = line.trim();
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter.resolve(trimmed);
      else this.#queue.push(trimmed);
    });
    this.#rl.on("close", () => {
      this.#inputEnded = true;
      const error = new Error("输入流已结束");
      for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    });
  }

  async prompt(question: string): Promise<string> {
    this.#output.write(question);
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    if (this.#inputEnded) throw new Error("输入流已结束");
    return await new Promise<string>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /** 释放输入流监听（CLI 结束后调用，否则交互式终端会阻止进程退出）。 */
  close(): void {
    this.#rl.close();
  }
}
