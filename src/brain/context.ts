export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; name: string; content: string };

/** 无 tokenizer 时的近似估算：约 4 字符 ≈ 1 token。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ConversationContextOptions {
  maxTokens: number;
}

export class ConversationContext {
  readonly #maxTokens: number;
  #messages: Message[] = [];

  constructor(options: ConversationContextOptions) {
    this.#maxTokens = options.maxTokens;
  }

  add(message: Message): void {
    this.#messages.push(message);
    this.trimToBudget();
  }

  getAll(): readonly Message[] {
    return this.#messages;
  }

  clear(): void {
    this.#messages = [];
  }

  /** 超预算时从最旧的非 system 消息开始裁剪；system 永不裁剪。 */
  trimToBudget(): void {
    while (this.#totalTokens() > this.#maxTokens) {
      const index = this.#messages.findIndex((message) => message.role !== "system");
      if (index === -1) break;
      this.#messages.splice(index, 1);
    }
  }

  #totalTokens(): number {
    return this.#messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  }
}
