import { describe, expect, it } from "vitest";
import { parseTimeout } from "../src/heart/loop.js";

describe("parseTimeout", () => {
  it("纯数字按毫秒解析", () => {
    expect(parseTimeout("900")).toBe(900);
  });

  it("支持 s / m / h 单位", () => {
    expect(parseTimeout("30s")).toBe(30_000);
    expect(parseTimeout("5m")).toBe(300_000);
    expect(parseTimeout("1h")).toBe(3_600_000);
  });

  it("0 或 off 表示禁用超时", () => {
    expect(parseTimeout("0")).toBe(0);
    expect(parseTimeout("off")).toBe(0);
  });

  it("非法输入返回 null", () => {
    expect(parseTimeout("abc")).toBeNull();
    expect(parseTimeout("-5")).toBeNull();
    expect(parseTimeout("5x")).toBeNull();
    expect(parseTimeout("5.5m")).toBeNull();
    expect(parseTimeout("")).toBeNull();
  });
});
