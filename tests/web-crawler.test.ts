import { describe, expect, it, vi } from "vitest";
import { WebCrawler } from "../src/eyes/web-crawler.js";

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function makeCrawler(fetchImpl: typeof fetch) {
  return new WebCrawler({ fetchImpl });
}

describe("WebCrawler", () => {
  it("抓取 HTML 并转换为 Markdown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      htmlResponse('<html><body><h1>标题</h1><p>正文 <a href="https://example.com">链接</a></p></body></html>'),
    );
    const crawler = makeCrawler(fetchImpl);
    const result = await crawler.fetchPageAsMarkdown("https://example.com/page");
    expect(result.success).toBe(true);
    expect(String(result.data)).toContain("# 标题");
    expect(String(result.data)).toContain("[链接](https://example.com)");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://example.com/page");
  });

  it("非 200 响应返回 FETCH_ERROR", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("Not Found", 404));
    const crawler = makeCrawler(fetchImpl);
    const result = await crawler.fetchPageAsMarkdown("https://example.com/missing");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FETCH_ERROR");
    expect(result.error?.message).toContain("404");
  });

  it("网络异常包装为失败结果而不是抛错", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const crawler = makeCrawler(fetchImpl);
    const result = await crawler.fetchPageAsMarkdown("https://example.com");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FETCH_ERROR");
    expect(result.error?.message).toContain("ECONNREFUSED");
  });

  it("空页面返回空 Markdown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("<html><body></body></html>"));
    const crawler = makeCrawler(fetchImpl);
    const result = await crawler.fetchPageAsMarkdown("https://example.com/empty");
    expect(result.success).toBe(true);
    expect(String(result.data).trim()).toBe("");
  });
});
