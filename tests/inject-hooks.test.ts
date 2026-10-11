import { describe, expect, it, vi } from "vitest";
import { installCaptureHooks } from "../extensions/gemini-bridge/inject.js";

const MARKER = "gemini-bridge-capture";
const HIT_URL =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
const MISS_URL = "https://aistudio.google.com/u/0/prompts";

type Posted = Record<string, unknown>;

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeFakeXHRClass() {
  return class FakeXHR {
    listeners: Record<string, Array<() => void>> = {};
    responseText = "";
    responseType = "";
    readyState = 0;
    status = 0;
    openedUrl: unknown = null;
    sent = false;
    aborted = false;
    open(_method: unknown, url: unknown): void {
      this.openedUrl = url;
    }
    send(): void {
      this.sent = true;
    }
    abort(): void {
      this.aborted = true;
    }
    addEventListener(type: string, fn: () => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    fireReadyState(n: number): void {
      this.readyState = n;
      for (const fn of this.listeners.readystatechange ?? []) fn();
    }
    fireLoadEnd(): void {
      for (const fn of this.listeners.loadend ?? []) fn();
    }
  };
}

class FakeWindow {
  posted: Posted[] = [];
  messageListeners: Array<(ev: { source: unknown; data: unknown }) => void> = [];
  XMLHttpRequest = makeFakeXHRClass();
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  constructor(fetchImpl?: (input: unknown, init?: unknown) => Promise<unknown>) {
    this.fetch = fetchImpl ?? (() => Promise.resolve({}));
  }
  postMessage(msg: Posted, _origin: string): void {
    this.posted.push(msg);
  }
  addEventListener(type: string, fn: (ev: { source: unknown; data: unknown }) => void): void {
    if (type === "message") this.messageListeners.push(fn);
  }
  dispatchMessage(ev: { source: unknown; data: unknown }): void {
    for (const fn of this.messageListeners) fn(ev);
  }
}

describe("installCaptureHooks：握手", () => {
  it("安装即发 hello", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    expect(win.posted).toContainEqual({ __ha: MARKER, v: 1, kind: "hello" });
  });

  it("同窗 ping → 补答 hello；异窗 / 非 ping / 无关消息一律忽略", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const before = win.posted.length;
    win.dispatchMessage({ source: win, data: { __ha: MARKER, v: 1, kind: "ping" } });
    expect(win.posted.length).toBe(before + 1);
    expect(win.posted[win.posted.length - 1]).toEqual({ __ha: MARKER, v: 1, kind: "hello" });
    win.dispatchMessage({ source: {}, data: { __ha: MARKER, v: 1, kind: "ping" } }); // 异窗
    win.dispatchMessage({ source: win, data: { __ha: MARKER, v: 1, kind: "done" } }); // 非 ping
    win.dispatchMessage({ source: win, data: { hello: "world" } }); // 无关
    expect(win.posted.length).toBe(before + 1);
  });

  it("重复安装不重复 hook（hello 也只发一次）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    installCaptureHooks(win);
    expect(win.posted.filter((m) => m.kind === "hello").length).toBe(1);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseText = '{"sample":true}';
    xhr.fireLoadEnd();
    expect(win.posted.filter((m) => m.kind === "start").length).toBe(1);
    expect(win.posted.filter((m) => m.kind === "done").length).toBe(1);
  });
});

describe("installCaptureHooks：XHR 主通道", () => {
  it("非命中 URL 完全透明：无消息、行为不变", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("GET", MISS_URL);
    xhr.send();
    xhr.fireLoadEnd();
    expect(win.posted.filter((m) => m.kind !== "hello")).toEqual([]);
    expect(xhr.sent).toBe(true);
    expect(xhr.openedUrl).toBe(MISS_URL);
  });

  it("命中 URL：start（urlTail）→ loadend 全量原文 done（reqId 配对）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    const start = win.posted.find((m) => m.kind === "start");
    expect(start).toBeTruthy();
    expect(start?.urlTail).toBe(HIT_URL.slice(-80));
    xhr.responseText = '{"sample":true}';
    xhr.fireLoadEnd();
    const done = win.posted.find((m) => m.kind === "done");
    expect(done).toBeTruthy();
    expect(done?.raw).toBe('{"sample":true}');
    expect(done?.reqId).toBe(start?.reqId);
  });

  it("responseType 非 text：发 error 诊断（无 done）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseType = "arraybuffer";
    xhr.fireLoadEnd();
    const err = win.posted.find((m) => m.kind === "error");
    expect(err).toBeTruthy();
    expect(String(err?.reason)).toContain("arraybuffer");
    expect(win.posted.some((m) => m.kind === "done")).toBe(false);
  });

  it("loadend 兜底：原文未构成完整 JSON → 发 error（done 只承载完整 JSON）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseText = '[[null,"text"';
    xhr.fireLoadEnd();
    const err = win.posted.find((m) => m.kind === "error");
    expect(err).toBeTruthy();
    expect(String(err?.reason)).toContain("原文非完整 JSON");
    expect(win.posted.some((m) => m.kind === "done")).toBe(false);
  });
});

describe("installCaptureHooks：快照兜底（对象被静默重置前的原文抢占）", () => {
  it("readyState 3 且 responseText 已是完整 JSON：不等 loadend 即发 done", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseText = '[[null,"text"]]';
    xhr.fireReadyState(3);
    const done = win.posted.find((m) => m.kind === "done");
    expect(done).toBeTruthy();
    expect(done?.raw).toBe('[[null,"text"]]');
    expect(done?.reqId).toBe(win.posted.find((m) => m.kind === "start")?.reqId);
  });

  it("残片不发；补全后快照发 done，随后 loadend 到达不重复", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseText = '[[null,"text"'; // 未完整
    xhr.fireReadyState(3);
    expect(win.posted.filter((m) => m.kind === "done")).toEqual([]);
    xhr.responseText = '[[null,"text"]]'; // 补全
    xhr.fireReadyState(3);
    expect(win.posted.filter((m) => m.kind === "done").length).toBe(1);
    xhr.fireLoadEnd(); // 对象后续正常走完也不重复发
    expect(win.posted.filter((m) => m.kind === "done").length).toBe(1);
  });

  it("readyState 归零（静默重置）不再产出任何 done/error（坐实事件被吞）", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseText = '[[null,"text"';
    xhr.fireReadyState(3);
    xhr.responseText = "";
    xhr.fireReadyState(0); // 重置：无 loadend、无其它事件
    expect(win.posted.some((m) => m.kind === "done")).toBe(false);
    expect(win.posted.some((m) => m.kind === "error")).toBe(false);
  });

  it("abort() 拦截：页面完成瞬间 abort 时原文完整 → 先取证发 done，再放行原 abort", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const win = new FakeWindow();
      installCaptureHooks(win);
      const xhr = new win.XMLHttpRequest();
      xhr.open("POST", HIT_URL);
      xhr.send();
      xhr.responseText = '[[null,"text","done"]]';
      xhr.readyState = 4;
      xhr.abort();
      expect(xhr.aborted).toBe(true); // 原 abort 仍被放行（不干扰页面）
      const done = win.posted.find((m) => m.kind === "done");
      expect(done?.raw).toBe('[[null,"text","done"]]');
      expect(done?.reqId).toBe(win.posted.find((m) => m.kind === "start")?.reqId);
      expect(win.posted.some((m) => m.kind === "error")).toBe(false);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("abort() 在原文到手前"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("abort() 拦截：原文未完整（流中被打断）→ 不发 done，响亮告警", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const win = new FakeWindow();
      installCaptureHooks(win);
      const xhr = new win.XMLHttpRequest();
      xhr.open("POST", HIT_URL);
      xhr.send();
      xhr.responseText = '[[null,"text"';
      xhr.readyState = 3;
      xhr.abort();
      expect(win.posted.filter((m) => m.kind === "done")).toEqual([]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("abort() 在原文到手前被调用"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("同一 XHR 对象复用发第二个请求：取证标志按请求复位，第二轮照常捕获", () => {
    const win = new FakeWindow();
    installCaptureHooks(win);
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", HIT_URL);
    xhr.send();
    xhr.responseText = '[[null,"a"]]';
    xhr.readyState = 4;
    xhr.abort(); // 第一轮：abort 拦截取证
    expect(win.posted.filter((m) => m.kind === "done").length).toBe(1);
    xhr.open("POST", HIT_URL); // 复用同一实例发第二轮
    xhr.send();
    xhr.responseText = '[[null,"b"]]';
    xhr.fireReadyState(3);
    const dones = win.posted.filter((m) => m.kind === "done");
    expect(dones.length).toBe(2);
    expect(dones[1]?.raw).toBe('[[null,"b"]]');
  });
});

describe("installCaptureHooks：fetch 薄兜底", () => {
  it("非命中完全透明：原响应原样返回、无消息", async () => {
    const response = { marker: "orig" };
    const win = new FakeWindow(() => Promise.resolve(response));
    installCaptureHooks(win);
    const got = await win.fetch(MISS_URL);
    await tick();
    expect(got).toBe(response);
    expect(win.posted.filter((m) => m.kind !== "hello")).toEqual([]);
  });

  it("命中（字符串 URL）：start → clone().text() 后 done 全量原文；调用方仍拿到原响应", async () => {
    const raw = '{"fetch":true}';
    const response = { clone: () => ({ text: () => Promise.resolve(raw) }) };
    const win = new FakeWindow(() => Promise.resolve(response));
    installCaptureHooks(win);
    const got = await win.fetch(HIT_URL);
    await tick();
    expect(got).toBe(response);
    const start = win.posted.find((m) => m.kind === "start");
    const done = win.posted.find((m) => m.kind === "done");
    expect(start).toBeTruthy();
    expect(done?.raw).toBe(raw);
    expect(done?.reqId).toBe(start?.reqId);
  });

  it("命中（Request 形态输入）：按 input.url 判定", async () => {
    const raw = '{"req":true}';
    const response = { clone: () => ({ text: () => Promise.resolve(raw) }) };
    const win = new FakeWindow(() => Promise.resolve(response));
    installCaptureHooks(win);
    await win.fetch({ url: HIT_URL });
    await tick();
    expect(win.posted.some((m) => m.kind === "done" && m.raw === raw)).toBe(true);
  });
});
