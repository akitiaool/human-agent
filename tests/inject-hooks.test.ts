import { describe, expect, it } from "vitest";
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
    openedUrl: unknown = null;
    sent = false;
    open(_method: unknown, url: unknown): void {
      this.openedUrl = url;
    }
    send(): void {
      this.sent = true;
    }
    addEventListener(type: string, fn: () => void): void {
      (this.listeners[type] ??= []).push(fn);
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
