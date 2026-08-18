export class InterruptController {
  #controller: AbortController;

  constructor() {
    this.#controller = new AbortController();
  }

  getSignal(): AbortSignal {
    return this.#controller.signal;
  }

  isAborted(): boolean {
    return this.#controller.signal.aborted;
  }

  abort(): void {
    this.#controller.abort();
  }

  reset(): void {
    this.#controller = new AbortController();
  }
}
