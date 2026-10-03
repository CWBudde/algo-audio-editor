import type { ProcessJobResult } from "@aae/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import {
  cancelExtractionWindow,
  openExtractedChannel,
  prepareExtractionWindow,
} from "./extraction-window";

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  close = vi.fn();
  postMessage = vi.fn(() =>
    queueMicrotask(() => this.onmessage?.({ data: { ok: true } } as MessageEvent)),
  );
}
let ports: Port[];
let child: {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};
let token: string;
const job = { documentId: "doc-1", jobId: "process-1" } as ProcessJobResult;

beforeEach(() => {
  vi.useFakeTimers();
  ports = [];
  child = { closed: false, close: vi.fn(), postMessage: vi.fn() };
  vi.spyOn(window, "open").mockImplementation((url) => {
    token = new URL(String(url)).searchParams.get("extract") ?? "";
    return child as unknown as Window;
  });
  vi.stubGlobal(
    "MessageChannel",
    class {
      port1 = new Port();
      port2 = new Port();
      constructor() {
        ports.push(this.port1, this.port2);
      }
    },
  );
});
afterEach(() => {
  cancelExtractionWindow();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function ready(origin = window.location.origin, suppliedToken = token) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: child as unknown as Window,
      origin,
      data: { type: "aae.extraction.ready", token: suppliedToken },
    }),
  );
}

it("reports blocked windows before requesting or exporting audio", () => {
  vi.mocked(window.open).mockReturnValue(null);
  expect(() => prepareExtractionWindow()).toThrow("blocked");
  expect(ports).toHaveLength(0);
});

it("requires matching source, origin and token before transferring exact binary output", async () => {
  prepareExtractionWindow();
  const bytes = new ArrayBuffer(8);
  const client = {
    call: vi.fn().mockResolvedValue({ data: bytes, dataBytes: 8, channels: 1, frames: 2 }),
  };
  const completing = openExtractedChannel(client as unknown as KernelClient, job);
  ready("https://unrelated.example");
  ready(window.location.origin, "wrong-token");
  await Promise.resolve();
  expect(client.call).not.toHaveBeenCalled();
  ready();
  await vi.runAllTicks();
  await completing;
  expect(client.call).toHaveBeenCalledWith("process.exportCandidate", {
    documentId: "doc-1",
    jobId: "process-1",
  });
  expect(ports[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ data: bytes }), [
    bytes,
  ]);
  expect(ports[0].close).toHaveBeenCalled();
  cancelExtractionWindow();
  expect(child.close).not.toHaveBeenCalled();
});

it("a closed reserved window rejects without exporting the source", async () => {
  prepareExtractionWindow();
  const client = { call: vi.fn() };
  const completing = openExtractedChannel(client as unknown as KernelClient, job);
  const rejected = expect(completing).rejects.toThrow("closed");
  child.closed = true;
  await vi.advanceTimersByTimeAsync(250);
  await rejected;
  expect(client.call).not.toHaveBeenCalled();
});

it("cancellation releases the connection and closes only its pending window", async () => {
  prepareExtractionWindow();
  ready();
  cancelExtractionWindow();
  await Promise.resolve();
  expect(child.close).toHaveBeenCalledOnce();
  expect(ports[0].close).toHaveBeenCalledOnce();
});

it("cancellation after connection immediately rejects import and ignores late acknowledgements", async () => {
  prepareExtractionWindow();
  ready();
  ports[0].postMessage.mockImplementation(() => {});
  const client = { call: vi.fn().mockResolvedValue({ data: new ArrayBuffer(8), dataBytes: 8 }) };
  const completing = openExtractedChannel(client as unknown as KernelClient, job);
  await vi.advanceTimersByTimeAsync(0);
  expect(ports[0].postMessage).toHaveBeenCalledOnce();
  const lateAck = ports[0].onmessage;
  const rejected = expect(completing).rejects.toThrow("cancelled");
  cancelExtractionWindow();
  lateAck?.({ data: { ok: true } } as MessageEvent);
  await rejected;
  expect(ports[0].onmessage).toBeNull();
  expect(ports[0].onmessageerror).toBeNull();
  expect(ports[0].close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("a synchronous sample transfer failure clears every timer and port handler", async () => {
  prepareExtractionWindow();
  ready();
  ports[0].postMessage.mockImplementation(() => {
    throw new Error("DataCloneError");
  });
  const client = { call: vi.fn().mockResolvedValue({ data: new ArrayBuffer(8), dataBytes: 8 }) };
  await expect(openExtractedChannel(client as unknown as KernelClient, job)).rejects.toThrow(
    "DataCloneError",
  );
  expect(vi.getTimerCount()).toBe(0);
  expect(ports[0].onmessage).toBeNull();
  expect(ports[0].onmessageerror).toBeNull();
  expect(ports[0].close).toHaveBeenCalledOnce();
});

it("failed connection transfer closes both channel ports and rejects before exporting", async () => {
  prepareExtractionWindow();
  child.postMessage.mockImplementation(() => {
    throw new Error("Connection failed");
  });
  const client = { call: vi.fn() };
  const completing = openExtractedChannel(client as unknown as KernelClient, job);
  const rejected = expect(completing).rejects.toThrow("Connection failed");
  ready();
  await rejected;
  expect(client.call).not.toHaveBeenCalled();
  expect(ports[0].close).toHaveBeenCalledOnce();
  expect(ports[1].close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("an import acknowledgement timeout releases the polling interval and handlers", async () => {
  prepareExtractionWindow();
  ready();
  ports[0].postMessage.mockImplementation(() => {});
  const client = { call: vi.fn().mockResolvedValue({ data: new ArrayBuffer(8), dataBytes: 8 }) };
  const completing = openExtractedChannel(client as unknown as KernelClient, job);
  const rejected = expect(completing).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  expect(ports[0].onmessage).toBeNull();
  expect(ports[0].onmessageerror).toBeNull();
  expect(ports[0].close).toHaveBeenCalledOnce();
});
