import { describe, expect, it } from "vitest";
import { InterruptController } from "../src/heart/interrupt.js";

describe("InterruptController", () => {
  it("初始状态未中断", () => {
    const controller = new InterruptController();
    expect(controller.isAborted()).toBe(false);
    expect(controller.getSignal().aborted).toBe(false);
  });

  it("abort() 后信号处于中断状态并通知监听器", () => {
    const controller = new InterruptController();
    let notified = 0;
    controller.getSignal().addEventListener("abort", () => notified++);
    controller.abort();
    expect(controller.isAborted()).toBe(true);
    expect(controller.getSignal().aborted).toBe(true);
    expect(notified).toBe(1);
  });

  it("reset() 后恢复未中断状态", () => {
    const controller = new InterruptController();
    const oldSignal = controller.getSignal();
    controller.abort();
    controller.reset();
    expect(controller.isAborted()).toBe(false);
    expect(controller.getSignal()).not.toBe(oldSignal);
  });
});
