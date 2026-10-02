import type { DocumentInfoResult, PeaksGetParams } from "@aae/protocol";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { WaveformView, type WaveformViewHandle } from "./waveform-view";

const info: DocumentInfoResult = {
  name: "stereo.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 48000,
  bitDepth: 16,
  float: false,
};

class PeakWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  postMessage(request: WorkerRequest) {
    this.sent.push(request);
    if (request.op !== "call") return;
    const params = request.params as PeaksGetParams;
    const data = new ArrayBuffer(24);
    new Float32Array(data, 0, 3).set([-0.75, 0.75, 0.25]);
    new Uint32Array(data, 12, 1)[0] = params.endFrame - params.startFrame;
    new Float64Array(data, 16, 1)[0] = params.startFrame;
    queueMicrotask(() =>
      this.listener?.({
        data: {
          kind: "reply",
          id: request.id,
          ok: true,
          result: {
            count: 1,
            framesPerBucket: params.endFrame - params.startFrame,
            dataBytes: 24,
            data,
          },
        },
      } as MessageEvent<WorkerReply>),
    );
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }
  terminate() {}
}

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, options: MouseEventInit & { pointerId?: number } = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
  }
}

function context() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    stroke: vi.fn(),
    restore: vi.fn(),
  };
}

let hostWidth = 800;
let tracksWidth = 800;
const contexts = new Map<HTMLCanvasElement, ReturnType<typeof context>>();
const observers: {
  callback: () => void;
  disconnected: boolean;
  disconnect: () => void;
}[] = [];
const mediaListeners = new Set<() => void>();
let matchMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hostWidth = 800;
  tracksWidth = 800;
  contexts.clear();
  observers.length = 0;
  mediaListeners.clear();
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly record: (typeof observers)[number];
      constructor(callback: () => void) {
        this.record = { callback, disconnected: false, disconnect: vi.fn() };
        observers.push(this.record);
      }
      observe() {}
      disconnect() {
        this.record.disconnected = true;
        this.record.disconnect();
      }
    },
  );
  matchMedia = vi.fn((media: string) => ({
    media,
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const canvas = this instanceof HTMLCanvasElement;
    const width = canvas ? Number.parseFloat(this.style.width) || tracksWidth - 56 : hostWidth;
    const left = canvas ? 56 : 0;
    return {
      x: left,
      y: 0,
      left,
      top: 0,
      right: left + width,
      bottom: 160,
      width,
      height: 160,
      toJSON: () => ({}),
    };
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === "waveform-scrollbar" ? tracksWidth - 56 : tracksWidth;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === "waveform-scrollbar"
      ? Number.parseFloat((this.firstElementChild as HTMLElement).style.width)
      : tracksWidth;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let result = contexts.get(this);
    if (!result) {
      result = context();
      contexts.set(this, result);
    }
    return result as unknown as CanvasRenderingContext2D;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mounted(documentInfo = info) {
  const worker = new PeakWorker();
  const client = new KernelClient(worker);
  const handle = createRef<WaveformViewHandle>();
  return {
    ...render(<WaveformView client={client} info={documentInfo} ref={handle} />),
    worker,
    client,
    handle,
  };
}

function range(view: HTMLElement) {
  return [Number(view.dataset.startFrame), Number(view.dataset.endFrame)];
}

async function painted(getByTestId: (id: string) => HTMLElement, channel = 0) {
  await waitFor(() =>
    expect(getByTestId(`waveform-channel-${channel}`).dataset.rendered).toBe("true"),
  );
}

describe("WaveformView", () => {
  it("draws kernel peaks independently in every channel and the full-file overview", async () => {
    const { getByTestId, worker } = mounted();
    await painted(getByTestId, 1);
    await waitFor(() => expect(getByTestId("waveform-overview").dataset.rendered).toBe("true"));
    expect(getByTestId("document-details").textContent).toBe(
      "48000 Hz · 2 channels · 48000 frames · 1.000 s · 16-bit PCM",
    );
    const requests = worker.sent
      .filter((request) => request.op === "call")
      .map((request) => (request.params as PeaksGetParams).channel);
    expect(requests.sort()).toEqual([0, 0, 1]);
    const canvas = getByTestId("waveform-channel-0") as HTMLCanvasElement;
    expect(canvas.width).toBe(744);
    expect(contexts.get(canvas)?.fillRect).toHaveBeenCalled();
  });

  it("redraws on CSS resize and DPR change even when CSS width stays fixed", async () => {
    const { getByTestId, unmount } = mounted();
    await painted(getByTestId);
    const canvas = getByTestId("waveform-channel-0") as HTMLCanvasElement;
    hostWidth = tracksWidth = 1000;
    act(() =>
      observers
        .filter((observer) => !observer.disconnected)
        .forEach((observer) => {
          observer.callback();
        }),
    );
    await waitFor(() => expect(canvas.width).toBe(944));
    vi.stubGlobal("devicePixelRatio", 2);
    act(() => {
      for (const listener of Array.from(mediaListeners)) listener();
    });
    await waitFor(() => expect(canvas.width).toBe(1888));
    expect(canvas.style.width).toBe("944px");
    expect(canvas.height).toBe(320);
    expect(contexts.get(canvas)?.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(matchMedia).toHaveBeenCalledWith("(resolution: 2dppx)");
    unmount();
    expect(mediaListeners.size).toBe(0);
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
  });

  it("uses the actual eight-channel scroll area width for every canvas and ruler", async () => {
    hostWidth = 315;
    tracksWidth = 300;
    const { getByTestId } = mounted({ ...info, channels: 8 });
    await painted(getByTestId, 7);
    for (let channel = 0; channel < 8; channel++)
      expect((getByTestId(`waveform-channel-${channel}`) as HTMLCanvasElement).width).toBe(244);
    expect((getByTestId("waveform-overview") as HTMLCanvasElement).width).toBe(244);
    expect(getByTestId("waveform-time-ruler").parentElement?.style.width).toBe("300px");
    expect(getByTestId("waveform-scrollbar").parentElement?.style.width).toBe("300px");
  });

  it("exposes zoom controls and resets viewport on an identical-format document reopen", async () => {
    const { getByTestId, getByRole, rerender, client, handle } = mounted();
    const view = getByTestId("waveform-view");
    fireEvent.click(getByRole("button", { name: "Zoom in" }));
    expect(range(view)).toEqual([12000, 36000]);
    act(() => handle.current?.zoomOut());
    expect(range(view)).toEqual([0, 48000]);
    act(() => handle.current?.zoomIn());
    rerender(<WaveformView client={client} info={{ ...info }} ref={handle} />);
    expect(range(view)).toEqual([0, 48000]);
    await painted(getByTestId);
  });

  it("anchors Ctrl-wheel zoom at the cursor and pans with horizontal or Shift-wheel", () => {
    const { getByTestId } = mounted();
    const canvas = getByTestId("waveform-channel-0");
    const zoom = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      clientX: 56 + 744 / 4,
      deltaY: -Math.log(2) / 0.003,
    });
    act(() => canvas.dispatchEvent(zoom));
    expect(zoom.defaultPrevented).toBe(true);
    expect(range(getByTestId("waveform-view"))).toEqual([6000, 30000]);
    fireEvent.wheel(canvas, { deltaX: 744 / 4 });
    expect(range(getByTestId("waveform-view"))).toEqual([12000, 36000]);
    fireEvent.wheel(canvas, { shiftKey: true, deltaY: 744 / 4 });
    expect(range(getByTestId("waveform-view"))).toEqual([18000, 42000]);
    const vertical = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    act(() => canvas.dispatchEvent(vertical));
    expect(vertical.defaultPrevented).toBe(false);
  });

  it("zooms to the dragged frame range and stops selecting after pointer cancellation", () => {
    const { getByTestId, getByRole } = mounted();
    const canvas = getByTestId("waveform-channel-0");
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 56 + 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 56 + 300 });
    fireEvent.pointerCancel(canvas, { pointerId: 1 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 56 + 650 });
    expect(getByTestId("waveform-selection")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Zoom to selection" }));
    expect(range(getByTestId("waveform-view"))).toEqual([6452, 19355]);
    fireEvent.click(getByRole("button", { name: "Zoom to fit" }));
    expect(range(getByTestId("waveform-view"))).toEqual([0, 48000]);
  });

  it("pans through the overview and stops dragging after capture is lost", () => {
    const { getByTestId, getByRole } = mounted();
    fireEvent.click(getByRole("button", { name: "Zoom in" }));
    const rectangle = getByTestId("waveform-overview-viewport");
    fireEvent.pointerDown(rectangle, { button: 0, pointerId: 2, clientX: 350 });
    fireEvent.pointerMove(rectangle, { pointerId: 2, clientX: 450 });
    const dragged = range(getByTestId("waveform-view"));
    expect(dragged[0]).toBeGreaterThan(12000);
    fireEvent.lostPointerCapture(rectangle, { pointerId: 2 });
    fireEvent.pointerMove(rectangle, { pointerId: 2, clientX: 700 });
    expect(range(getByTestId("waveform-view"))).toEqual(dragged);
    fireEvent.keyDown(rectangle, { key: "Home" });
    expect(range(getByTestId("waveform-view"))).toEqual([0, 24000]);
  });

  it("maps native horizontal scroll to frames without enlarging any canvas", () => {
    const { getByTestId, handle } = mounted({ ...info, frames: 100_000_000 });
    for (let count = 0; count < 20; count++) act(() => handle.current?.zoomIn());
    const scrollbar = getByTestId("waveform-scrollbar");
    const extent = Number.parseFloat((scrollbar.firstElementChild as HTMLElement).style.width);
    expect(extent).toBe(1_000_000);
    const before = range(getByTestId("waveform-view"));
    scrollbar.scrollLeft = (extent - 744) / 4;
    fireEvent.scroll(scrollbar);
    const after = range(getByTestId("waveform-view"));
    expect(after[0]).toBeLessThan(before[0]);
    expect(after[1] - after[0]).toBe(before[1] - before[0]);
    expect((getByTestId("waveform-channel-0") as HTMLCanvasElement).width).toBe(744);
  });

  it("changes time and amplitude ruler labels without processing samples", () => {
    const { getByTestId, getByLabelText } = mounted();
    fireEvent.change(getByLabelText("Time format"), { target: { value: "hms" } });
    expect(getByTestId("waveform-time-ruler").textContent).toContain("0:00:");
    fireEvent.change(getByLabelText("Amplitude scale"), { target: { value: "db" } });
    expect(getByTestId("waveform-amplitude-ruler-0").textContent).toContain("-6");
    expect(getByTestId("waveform-amplitude-ruler-0").textContent).toContain("−∞");
  });

  it("handles an empty document without asking the kernel for peaks", () => {
    const { getByTestId, getByRole, getByText, worker } = mounted({ ...info, frames: 0 });
    expect(range(getByTestId("waveform-view"))).toEqual([0, 0]);
    expect((getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("No audio frames in this document.")).toBeTruthy();
    expect(worker.sent).toHaveLength(0);
    expect(getByTestId("document-name").textContent).toBe("stereo.wav");
  });
});
