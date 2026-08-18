import TurndownService from "turndown";
import { fail, ok, type ActionResult } from "../types/index.js";

export interface WebCrawlerOptions {
  fetchImpl?: typeof fetch;
}

/** 眼睛的网页抓取实现：HTML → Clean Markdown，失败包装为 ActionResult（设计文档 §3.3）。 */
export class WebCrawler {
  readonly #fetchImpl: typeof fetch;
  readonly #turndown: TurndownService;

  constructor(options: WebCrawlerOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  }

  async fetchPageAsMarkdown(url: string): Promise<ActionResult<string>> {
    try {
      const response = await this.#fetchImpl(url, {
        headers: { "User-Agent": "human-agent/0.1.0" },
      });
      if (!response.ok) {
        return fail("FETCH_ERROR", `HTTP ${response.status} ${response.statusText}`);
      }
      const html = await response.text();
      return ok(this.#turndown.turndown(html));
    } catch (err) {
      return fail(
        "FETCH_ERROR",
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
