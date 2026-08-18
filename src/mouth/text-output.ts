import chalk from "chalk";
import type { ChalkInstance } from "chalk";
import type { Writable } from "node:stream";

export interface TextOutputOptions {
  stdout?: Writable;
  intervalMs?: number;
  chalk?: ChalkInstance;
}

export class TextOutput {
  readonly #stdout: Writable;
  readonly #intervalMs: number;
  readonly #chalk: ChalkInstance;

  constructor(options: TextOutputOptions = {}) {
    this.#stdout = options.stdout ?? process.stdout;
    this.#intervalMs = options.intervalMs ?? 15;
    this.#chalk = options.chalk ?? chalk;
  }

  async speak(text: string): Promise<void> {
    const chars = [...text];
    if (chars.length === 0) return;
    this.#stdout.write(chars[0]!);
    for (const char of chars.slice(1)) {
      await new Promise((resolve) => setTimeout(resolve, this.#intervalMs));
      this.#stdout.write(char);
    }
  }

  info(message: string): void {
    this.#stdout.write(this.#chalk.blue(message) + "\n");
  }

  success(message: string): void {
    this.#stdout.write(this.#chalk.green(message) + "\n");
  }

  warn(message: string): void {
    this.#stdout.write(this.#chalk.yellow(message) + "\n");
  }

  error(message: string): void {
    this.#stdout.write(this.#chalk.red(message) + "\n");
  }

  printDiff(diff: string): void {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+")) {
        this.#stdout.write(this.#chalk.green(line) + "\n");
      } else if (line.startsWith("-")) {
        this.#stdout.write(this.#chalk.red(line) + "\n");
      } else {
        this.#stdout.write(line + "\n");
      }
    }
  }
}
