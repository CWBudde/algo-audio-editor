import { describe, expect, it, vi } from "vitest";
import { createTaskYield } from "./task-yield";

function fixture() {
  const port1 = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    start: vi.fn(),
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  const port2 = { ...port1, postMessage: vi.fn(), close: vi.fn() };
  const channel = { port1, port2 };
  return {
    ...channel,
    scheduler: createTaskYield(() => channel),
    deliver: () => port1.onmessage?.({} as MessageEvent),
  };
}

describe("worker task yield", () => {
  it("does not resolve in a microtask and releases exactly one waiter per message task", async () => {
    const { scheduler, deliver, port1, port2 } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const a = scheduler.yieldTask().then(first);
    const b = scheduler.yieldTask().then(second);
    expect(port1.start).toHaveBeenCalledOnce();
    expect(port2.postMessage).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    deliver();
    await a;
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    deliver();
    await b;
    expect(second).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("cleans up both ports and rejects pending/future yields on disposal", async () => {
    const { scheduler, port1, port2 } = fixture();
    const pending = scheduler.yieldTask();
    scheduler.dispose();
    scheduler.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await expect(scheduler.yieldTask()).rejects.toThrow("disposed");
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port2.close).toHaveBeenCalledOnce();
    expect(port1.onmessage).toBeNull();
  });

  it("removes only a failed post's waiter and preserves previous queued tasks", async () => {
    const { scheduler, port2, deliver } = fixture();
    const first = scheduler.yieldTask();
    port2.postMessage.mockImplementationOnce(() => {
      throw new Error("port closed");
    });
    await expect(scheduler.yieldTask()).rejects.toThrow("port closed");
    deliver();
    await first;
    scheduler.dispose();
  });
});
