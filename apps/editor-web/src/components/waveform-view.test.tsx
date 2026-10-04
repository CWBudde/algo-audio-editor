import type {
  DocumentInfoResult,
  PeaksGetParams,
  SelectionRange,
  SelectionResult,
  SelectionSnapParams,
  TimelineResult,
} from "@aae/protocol";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectionOptions } from "@/hooks/use-selection";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import { EDITOR_THEME_PROPERTIES } from "@/lib/editor-theme";
import { WaveformView, type WaveformViewHandle } from "./waveform-view";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "stereo.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 48000,
  bitDepth: 16,
  float: false,
};

class PeakWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  selection: SelectionResult;
  timeline: TimelineResult;
  zeroFrame?: number;
  deferSnaps = false;
  deferPeaks = false;
  pendingPeaks: (() => void)[] = [];
  resolvePeaks() {
    for (const reply of this.pendingPeaks.splice(0)) reply();
  }
  pendingSnaps: Extract<WorkerRequest, { op: "call" }>[] = [];
  calls(method: string) {
    return this.sent.filter(
      (request): request is Extract<WorkerRequest, { op: "call" }> =>
        request.op === "call" && request.method === method,
    );
  }
  get peaks() {
    return this.calls("peaks.get");
  }
  resolveSnaps(frame = this.zeroFrame, found = frame !== undefined) {
    for (const request of this.pendingSnaps.splice(0)) {
      const params = request.params as SelectionSnapParams;
      this.listener?.({
        data: {
          kind: "reply",
          id: request.id,
          ok: true,
          result: { documentId: params.documentId, frame: frame ?? params.frame, found },
        },
      } as MessageEvent<WorkerReply>);
    }
  }
  rejectSnaps() {
    for (const request of this.pendingSnaps.splice(0)) {
      this.listener?.({
        data: { kind: "reply", id: request.id, ok: false, error: "snap rejected" },
      } as MessageEvent<WorkerReply>);
    }
  }
  constructor(documentInfo = info) {
    this.selection = {
      documentId: documentInfo.documentId,
      start: 0,
      end: 0,
      channelMask: (1 << documentInfo.channels) - 1,
    };
    this.timeline = { documentId: documentInfo.documentId, markers: [], regions: [] };
  }
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  postMessage(request: WorkerRequest) {
    this.sent.push(request);
    if (request.op !== "call") return;
    if (request.method !== "peaks.get") {
      const params = request.params as SelectionResult & {
        id: number;
        frame: number;
        name: string;
        color: string;
        selection?: SelectionRange;
      };
      let result: unknown;
      switch (request.method) {
        case "selection.set":
          this.selection = params;
          result = params;
          break;
        case "selection.get":
          result = { ...this.selection, documentId: params.documentId };
          break;
        case "selection.snap":
          if (this.deferSnaps) {
            this.pendingSnaps.push(request);
            return;
          }
          result = {
            documentId: params.documentId,
            frame: this.zeroFrame ?? params.frame,
            found: this.zeroFrame !== undefined,
          };
          break;
        case "markers.add":
          this.timeline.markers.push({
            id: 1,
            frame: params.frame,
            name: params.name || "Marker 1",
            color: params.color,
          });
          result = { ...this.timeline };
          break;
        case "regions.add":
          this.timeline.regions.push({
            id: 2,
            start: params.start,
            end: params.end,
            name: params.name || "Region 2",
            color: params.color,
          });
          result = { ...this.timeline };
          break;
        case "markers.update":
          this.timeline.markers = this.timeline.markers.map((marker) =>
            marker.id === params.id
              ? { ...marker, frame: params.frame, name: params.name, color: params.color }
              : marker,
          );
          result = { ...this.timeline };
          break;
        case "regions.update":
          this.timeline.regions = this.timeline.regions.map((region) =>
            region.id === params.id
              ? {
                  ...region,
                  start: params.start,
                  end: params.end,
                  name: params.name,
                  color: params.color,
                }
              : region,
          );
          result = { ...this.timeline };
          break;
        case "markers.remove":
          this.timeline.markers = this.timeline.markers.filter((marker) => marker.id !== params.id);
          result = { ...this.timeline };
          break;
        case "regions.remove":
          this.timeline.regions = this.timeline.regions.filter((region) => region.id !== params.id);
          result = { ...this.timeline };
          break;
        default:
          result = { ...this.timeline, documentId: params.documentId };
      }
      if (/^(markers|regions)\.(add|update|remove)$/.test(request.method)) {
        if (params.selection)
          this.selection = { documentId: params.documentId, ...params.selection };
        result = {
          ...this.timeline,
          changed: true,
          history: {
            documentId: params.documentId,
            currentStateId: "state-2",
            savedStateId: "state-1",
            dirty: true,
            canUndo: true,
            canRedo: false,
            entries: [
              { stateId: "state-1", label: "Opened" },
              { stateId: "state-2", label: "Timeline" },
            ],
            maxEntries: 100,
            maxBytes: 1000000,
            retainedBytes: 0,
          },
        };
      }
      queueMicrotask(() =>
        this.listener?.({
          data: { kind: "reply", id: request.id, ok: true, result },
        } as MessageEvent<WorkerReply>),
      );
      return;
    }
    const params = request.params as PeaksGetParams;
    const span = params.endFrame - params.startFrame;
    const exact = params.buckets === span;
    const count = exact ? span : 1;
    const data = new ArrayBuffer(24 * count);
    const values = new Float32Array(data, 0, 3 * count);
    const counts = new Uint32Array(data, 12 * count, count);
    const starts = new Float64Array(data, 16 * count, count);
    for (let index = 0; index < count; index++) {
      const value = (params.startFrame + index) % 2 === 0 ? -0.75 : 0.5;
      values.set(exact ? [value, value, Math.abs(value)] : [-0.75, 0.75, 0.25], index * 3);
      counts[index] = exact ? 1 : span;
      starts[index] = params.startFrame + (exact ? index : 0);
    }
    const reply = () =>
      this.listener?.({
        data: {
          kind: "reply",
          id: request.id,
          ok: true,
          result: {
            count,
            framesPerBucket: exact ? 1 : span,
            dataBytes: data.byteLength,
            data,
          },
        },
      } as MessageEvent<WorkerReply>);
    if (this.deferPeaks) this.pendingPeaks.push(reply);
    else queueMicrotask(reply);
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
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
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
let rootStyle: string | null;
const testPalette = Object.fromEntries(
  Object.keys(EDITOR_THEME_PROPERTIES).map((key, index) => [
    key,
    `#${(0x123400 + index).toString(16)}`,
  ]),
);

beforeEach(() => {
  rootStyle = document.documentElement.getAttribute("style");
  for (const [key, property] of Object.entries(EDITOR_THEME_PROPERTIES)) {
    document.documentElement.style.setProperty(property, testPalette[key]);
  }
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
    const canvas = this instanceof HTMLCanvasElement || this.dataset.testid === "waveform-track";
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
  if (rootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", rootStyle);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mounted(
  documentInfo = info,
  options: {
    selection?: Partial<SelectionResult>;
    timeline?: Partial<TimelineResult>;
    onSeek?: (frame: number) => void;
    timelineOptions?: SelectionOptions;
    onExportTimeline?: (format: "csv" | "labels") => void;
    playing?: boolean;
    onCommandStateChange?: (ready: boolean) => void;
    commands?: readonly ResolvedCommand[];
    onExecute?: (id: CommandId) => void;
  } = {},
) {
  const worker = new PeakWorker(documentInfo);
  worker.selection = { ...worker.selection, ...options.selection };
  worker.timeline = { ...worker.timeline, ...options.timeline };
  const client = new KernelClient(worker);
  const handle = createRef<WaveformViewHandle>();
  return {
    ...render(
      <WaveformView
        client={client}
        info={documentInfo}
        ref={handle}
        onSeek={options.onSeek}
        timelineOptions={options.timelineOptions}
        onExportTimeline={options.onExportTimeline}
        playing={options.playing}
        onCommandStateChange={options.onCommandStateChange}
        commands={options.commands}
        onExecute={options.onExecute}
      />,
    ),
    worker,
    client,
    handle,
  };
}

function range(view: HTMLElement) {
  return [Number(view.dataset.startFrame), Number(view.dataset.endFrame)];
}

function selectionState(view: HTMLElement) {
  return {
    start: Number(view.dataset.selectionStart),
    end: Number(view.dataset.selectionEnd),
    channelMask: Number(view.dataset.channelMask),
  };
}

function frameX(frame: number, documentInfo = info) {
  return 56 + ((tracksWidth - 56) * frame) / documentInfo.frames;
}

function dragRange(
  canvas: HTMLElement,
  start: number,
  end: number,
  options: {
    pointerId?: number;
    shiftKey?: boolean;
    documentInfo?: DocumentInfoResult;
  } = {},
) {
  const pointerId = options.pointerId ?? 1;
  const documentInfo = options.documentInfo ?? info;
  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId,
    shiftKey: options.shiftKey,
    clientX: frameX(start, documentInfo),
  });
  fireEvent.pointerMove(canvas, { pointerId, clientX: frameX(end, documentInfo) });
  fireEvent.pointerUp(canvas, { pointerId, clientX: frameX(end, documentInfo) });
}

async function flushReplies() {
  await act(async () => {});
}

async function painted(getByTestId: (id: string) => HTMLElement, channel = 0) {
  await waitFor(() =>
    expect(getByTestId(`waveform-channel-${channel}`).dataset.rendered).toBe("true"),
  );
}

describe("WaveformView", () => {
  it("keeps view, snapping and annotation options disclosed behind accessible icon bands", () => {
    const { getByTestId, getByRole, getByLabelText } = mounted();
    for (const id of ["view-settings", "snap-settings", "annotation-settings", "timeline-panel"])
      expect((getByTestId(id) as HTMLDetailsElement).open).toBe(false);
    for (const name of [
      "Zoom in",
      "Zoom out",
      "Zoom to fit",
      "Zoom to selection",
      "Add marker",
      "Add region",
    ])
      expect(getByRole("button", { name }).querySelector("svg")).not.toBeNull();
    const snapping = getByTestId("snap-settings");
    fireEvent.click(snapping.querySelector("summary") as HTMLElement);
    fireEvent.click(getByLabelText("Zero crossings"));
    expect(snapping.getAttribute("data-active")).toBe("true");
    expect(snapping.querySelector("summary")?.textContent).toContain("active");
  });

  it("routes zoom icons through the shared command registry with shortcut tooltips", () => {
    const execute = vi.fn();
    const command: ResolvedCommand = {
      id: "view.zoom-in",
      label: "Zoom In",
      menu: "View",
      enabled: true,
      shortcutLabel: "Ctrl++",
      ariaShortcut: "Control+=",
    };
    const { getByRole, getByTestId, rerender, client } = mounted(info, {
      commands: [command],
      onExecute: execute,
    });
    const zoom = getByRole("button", { name: "Zoom in" });
    expect(zoom.title).toBe("Zoom in (Ctrl++)");
    expect(zoom.getAttribute("aria-keyshortcuts")).toBe("Control+=");
    fireEvent.click(zoom);
    expect(execute).toHaveBeenCalledExactlyOnceWith("view.zoom-in");
    expect(range(getByTestId("waveform-view"))).toEqual([0, info.frames]);
    rerender(
      <WaveformView
        client={client}
        info={info}
        commands={[{ ...command, enabled: false }]}
        onExecute={execute}
      />,
    );
    fireEvent.click(zoom);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("draws exact samples with CSS palette roles and changes geometry without another RPC", async () => {
    const smallInfo = { ...info, frames: 4 };
    const { getByTestId, getByLabelText, worker } = mounted(smallInfo);
    await painted(getByTestId, 1);
    const canvas = getByTestId("waveform-channel-0") as HTMLCanvasElement;
    const drawing = contexts.get(canvas);
    expect(canvas.dataset.displayMode).toBe("linear");
    expect([canvas.dataset.sampleStart, canvas.dataset.sampleEnd]).toEqual(["0", "4"]);
    expect(drawing?.arc).toHaveBeenCalledTimes(4);
    expect(drawing?.strokeStyle).toBe(testPalette.waveformPeak);
    expect(drawing?.fillStyle).toBe(testPalette.waveformSample);
    expect(drawing?.lineTo.mock.calls).toEqual([
      [186, 40],
      [372, 140],
      [558, 40],
    ]);
    expect(getByTestId("waveform-overview").dataset.displayMode).toBe("envelope");
    const requests = worker.peaks.map((request) => request.params as PeaksGetParams);
    expect(
      requests.filter((params) => params.buckets === 4).map((params) => params.channel),
    ).toEqual([0, 1]);
    const before = worker.sent.length;
    drawing?.lineTo.mockClear();
    fireEvent.change(getByLabelText("Sample display"), { target: { value: "steps" } });
    await painted(getByTestId);
    expect(canvas.dataset.displayMode).toBe("steps");
    expect(drawing?.lineTo.mock.calls).toEqual([
      [186, 140],
      [186, 40],
      [372, 40],
      [372, 140],
      [558, 140],
      [558, 40],
      [744, 40],
    ]);
    expect(worker.sent).toHaveLength(before);
  });

  it.each([1, 2])("uses strict CSS sample spacing regardless of DPR %s", async (dpr) => {
    vi.stubGlobal("devicePixelRatio", dpr);
    tracksWidth = 60;
    const { getByTestId, worker } = mounted({ ...info, frames: 4 });
    await painted(getByTestId, 1);
    expect(getByTestId("waveform-channel-0").dataset.displayMode).toBe("envelope");
    expect(getByTestId("waveform-channel-1").dataset.displayMode).toBe("envelope");
    tracksWidth = 61;
    act(() =>
      observers
        .filter((observer) => !observer.disconnected)
        .forEach((observer) => {
          observer.callback();
        }),
    );
    await waitFor(() =>
      expect(getByTestId("waveform-channel-1").dataset.displayMode).toBe("linear"),
    );
    await painted(getByTestId, 1);
    const canvas = getByTestId("waveform-channel-1") as HTMLCanvasElement;
    expect(canvas.width).toBe(5 * dpr);
    expect(contexts.get(canvas)?.arc).toHaveBeenCalledTimes(4);
    expect(
      worker.peaks.some(
        (request) =>
          (request.params as PeaksGetParams).channel === 1 &&
          (request.params as PeaksGetParams).buckets === 4,
      ),
    ).toBe(true);
    expect(getByTestId("waveform-overview").dataset.displayMode).toBe("envelope");
  });

  it("uses theme roles for envelope and DOM overlays while retaining marker colors", async () => {
    const { getByTestId, container } = mounted(info, {
      selection: { start: 100, end: 200 },
      timeline: { markers: [{ id: 1, frame: 100, name: "Cue", color: "#ff0000" }] },
    });
    await painted(getByTestId, 1);
    const drawing = contexts.get(getByTestId("waveform-channel-1") as HTMLCanvasElement);
    expect(drawing?.fillStyle).toBe(testPalette.waveformRms);
    expect(getByTestId("waveform-overview-viewport").className).toContain("bg-selection-fill");
    expect(container.querySelectorAll(".border-selection").length).toBeGreaterThan(1);
    expect(container.querySelectorAll(".border-playhead").length).toBe(3);
    expect(getByTestId("timeline-marker-1").style.borderColor).toBe("rgb(255, 0, 0)");
  });

  it("publishes command readiness when a preview commits identical coordinates", async () => {
    const onCommandStateChange = vi.fn();
    const { getByTestId, handle } = mounted(info, {
      selection: { start: 12000, end: 24000, channelMask: 2 },
      onCommandStateChange,
    });
    await painted(getByTestId);
    expect(onCommandStateChange).toHaveBeenLastCalledWith(true);
    const canvas = getByTestId("waveform-channel-0");
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 92, clientX: frameX(12000) });
    fireEvent.pointerMove(canvas, { pointerId: 92, clientX: frameX(24000) });
    const preview = selectionState(getByTestId("waveform-view"));
    expect(preview).toEqual({ start: 12000, end: 24000, channelMask: 2 });
    expect(onCommandStateChange).toHaveBeenLastCalledWith(false);
    expect(handle.current?.selectionState()).toBeUndefined();
    fireEvent.pointerUp(canvas, { pointerId: 92, clientX: frameX(24000) });
    await flushReplies();
    expect(selectionState(getByTestId("waveform-view"))).toEqual(preview);
    expect(onCommandStateChange).toHaveBeenLastCalledWith(true);
    expect(handle.current?.selectionState()).toMatchObject(preview);
  });

  it("selects the full document imperatively while preserving the selected channel subset", async () => {
    const onSeek = vi.fn();
    const { getByTestId, handle, worker } = mounted(info, {
      selection: { start: 12000, end: 24000, channelMask: 2 },
      onSeek,
    });
    await painted(getByTestId);
    act(() => handle.current?.selectAll());
    await flushReplies();
    expect(handle.current?.selectionState()).toMatchObject({
      start: 0,
      end: info.frames,
      channelMask: 2,
    });
    expect(worker.selection).toMatchObject({ start: 0, end: info.frames, channelMask: 2 });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("adds anchors imperatively with the current name, color, and completed selection", async () => {
    const { getByTestId, getByLabelText, handle, worker } = mounted(info, {
      selection: { start: 12000, end: 24000, channelMask: 2 },
    });
    await painted(getByTestId);
    fireEvent.change(getByLabelText("Marker or region name"), { target: { value: "Cue name" } });
    fireEvent.change(getByLabelText("Marker or region color"), { target: { value: "#112233" } });
    act(() => handle.current?.addMarker());
    await flushReplies();
    const markerRequest = worker.sent.find(
      (request) => request.op === "call" && request.method === "markers.add",
    );
    expect(markerRequest?.op === "call" ? markerRequest.params : undefined).toMatchObject({
      frame: 12000,
      name: "Cue name",
      color: "#112233",
      selection: { start: 12000, end: 24000, channelMask: 2 },
    });
    fireEvent.change(getByLabelText("Marker or region name"), { target: { value: "Region name" } });
    fireEvent.change(getByLabelText("Marker or region color"), { target: { value: "#334455" } });
    act(() => handle.current?.addRegion());
    await flushReplies();
    const regionRequest = worker.sent.find(
      (request) => request.op === "call" && request.method === "regions.add",
    );
    expect(regionRequest?.op === "call" ? regionRequest.params : undefined).toMatchObject({
      start: 12000,
      end: 24000,
      name: "Region name",
      color: "#334455",
      selection: { start: 12000, end: 24000, channelMask: 2 },
    });
  });

  it("blocks imperative commands during a drag or delayed snap and allows them after cancellation", async () => {
    const { getByTestId, getByLabelText, handle, worker } = mounted(info, {
      selection: { start: 12000, end: 24000 },
    });
    await painted(getByTestId);
    const canvas = getByTestId("waveform-channel-0");
    const commands = () => {
      handle.current?.selectAll();
      handle.current?.addMarker();
      handle.current?.addRegion();
    };
    const before = worker.sent.length;
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 91, clientX: frameX(6000) });
    act(commands);
    expect(worker.sent.length).toBe(before);
    fireEvent.pointerCancel(canvas, { pointerId: 91 });
    worker.deferSnaps = true;
    fireEvent.click(getByLabelText("Zero crossings"));
    dragRange(canvas, 6000, 30000);
    const afterSnap = worker.sent.length;
    act(commands);
    expect(worker.sent.length).toBe(afterSnap);
    await act(async () => worker.rejectSnaps());
    act(() => handle.current?.addMarker());
    await flushReplies();
    expect(
      worker.sent.some((request) => request.op === "call" && request.method === "markers.add"),
    ).toBe(true);
  });

  it("blocks imperative mutations while busy or without a client and rejects collapsed regions", async () => {
    const { getByTestId, handle, worker, client, rerender } = mounted(info, {
      timelineOptions: { busy: true },
    });
    await painted(getByTestId);
    const commands = () => {
      handle.current?.selectAll();
      handle.current?.addMarker();
      handle.current?.addRegion();
    };
    act(commands);
    await flushReplies();
    expect(
      worker.sent.some(
        (request) =>
          request.op === "call" &&
          /^(selection\.set|markers\.add|regions\.add)$/.test(request.method),
      ),
    ).toBe(false);
    rerender(<WaveformView client={undefined} info={info} ref={handle} />);
    act(commands);
    expect(handle.current?.selectionState()).toMatchObject({ start: 0, end: 0 });
    rerender(<WaveformView client={client} info={info} ref={handle} />);
    await flushReplies();
    act(() => handle.current?.addRegion());
    await flushReplies();
    expect(
      worker.sent.some((request) => request.op === "call" && request.method === "regions.add"),
    ).toBe(false);
  });

  it("exposes only completed selections to edit commands, including deferred zero snaps", async () => {
    const { getByTestId, getByLabelText, handle, worker } = mounted(info, {
      selection: { start: 12000, end: 24000 },
    });
    await painted(getByTestId);
    expect(handle.current?.selectionState()).toMatchObject({
      start: 12000,
      end: 24000,
      channelMask: 3,
    });
    const canvas = getByTestId("waveform-channel-0");
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: frameX(6000) });
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: frameX(30000) });
    expect(handle.current?.selectionState()).toBeUndefined();
    fireEvent.pointerCancel(canvas, { pointerId: 7 });
    expect(handle.current?.selectionState()).toMatchObject({
      start: 12000,
      end: 24000,
      channelMask: 3,
    });
    worker.deferSnaps = true;
    fireEvent.click(getByLabelText("Zero crossings"));
    dragRange(canvas, 6000, 30000);
    expect(handle.current?.selectionState()).toBeUndefined();
    await act(async () => worker.rejectSnaps());
    expect(handle.current?.selectionState()).toMatchObject({
      start: 12000,
      end: 24000,
      channelMask: 3,
    });
    handle.current?.clearSelection(48000);
    await flushReplies();
    expect(handle.current?.selectionState()).toMatchObject({
      start: 48000,
      end: 48000,
      channelMask: 3,
    });
  });
  it.each([
    { frame: 6000, start: 6000, end: 24000 },
    { frame: 30000, start: 12000, end: 30000 },
    { frame: 18000, start: 12000, end: 18000 },
  ])("extends the nearest edge with Shift-click at $frame", async ({ frame, start, end }) => {
    const onSeek = vi.fn();
    const { getByTestId, worker } = mounted(info, {
      selection: { start: 12000, end: 24000, channelMask: 2 },
      onSeek,
    });
    await painted(getByTestId);
    dragRange(getByTestId("waveform-channel-0"), frame, frame, { shiftKey: true });
    expect(selectionState(getByTestId("waveform-view"))).toEqual({ start, end, channelMask: 2 });
    expect(onSeek).toHaveBeenLastCalledWith(start);
    await flushReplies();
    expect(worker.selection).toMatchObject({ start, end, channelMask: 2 });
  });

  it("normalizes reverse drags and preserves the fixed edge when dragged across it", async () => {
    const { getByTestId, worker } = mounted();
    await painted(getByTestId);
    dragRange(getByTestId("waveform-channel-0"), 24000, 12000);
    await flushReplies();
    expect(selectionState(getByTestId("waveform-view"))).toEqual({
      start: 12000,
      end: 24000,
      channelMask: 3,
    });
    const edge = getByTestId("selection-start-edge-0");
    fireEvent.pointerDown(edge, { button: 0, pointerId: 4, clientX: frameX(12000) + 2 });
    fireEvent.pointerMove(edge, { pointerId: 4, clientX: frameX(30000) + 2 });
    fireEvent.pointerUp(edge, { pointerId: 4, clientX: frameX(30000) + 2 });
    await flushReplies();
    expect(worker.selection).toMatchObject({ start: 24000, end: 30000, channelMask: 3 });
  });

  it.each(["start", "end"] as const)(
    "does not move the %s boundary edge on a stationary grab",
    async (edge) => {
      const { getByTestId, worker } = mounted(info, { selection: { start: 0, end: info.frames } });
      await painted(getByTestId);
      const handle = getByTestId(`selection-${edge}-edge-0`);
      const x = edge === "start" ? 56 + 4 : tracksWidth - 4;
      fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: x });
      expect(selectionState(getByTestId("waveform-view"))).toEqual({
        start: 0,
        end: info.frames,
        channelMask: 3,
      });
      fireEvent.pointerUp(handle, { pointerId: 3, clientX: x });
      await flushReplies();
      expect(worker.selection).toMatchObject({ start: 0, end: info.frames });
    },
  );

  it("changes selected channels and subset overlays without seeking playback", async () => {
    const onSeek = vi.fn();
    const { getByTestId, queryByTestId, getByRole, getByLabelText, worker } = mounted(info, {
      selection: { start: 12000, end: 24000 },
      onSeek,
    });
    await painted(getByTestId);
    fireEvent.click(getByRole("button", { name: /^Left$/ }));
    expect(getByTestId("waveform-selection")).toBeTruthy();
    expect(queryByTestId("waveform-selection-1")).toBeNull();
    expect((getByLabelText("Channel 1 selected") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: /^Right$/ }));
    expect(queryByTestId("waveform-selection")).toBeNull();
    expect(getByTestId("waveform-selection-1")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /^All$/ }));
    expect(getByTestId("waveform-selection")).toBeTruthy();
    expect(getByTestId("waveform-selection-1")).toBeTruthy();
    expect(onSeek).not.toHaveBeenCalled();
    await flushReplies();
    expect(worker.selection).toMatchObject({ start: 12000, end: 24000, channelMask: 3 });
  });

  it("creates a named region and double-clicks the smallest overlapping region", async () => {
    const onSeek = vi.fn();
    const { getByTestId, getByLabelText, getByRole, worker, handle } = mounted(info, {
      selection: { start: 12000, end: 24000, channelMask: 1 },
      timeline: { regions: [{ id: 10, start: 0, end: 36000, name: "Outer", color: "#a78bfa" }] },
      onSeek,
    });
    await painted(getByTestId);
    fireEvent.change(getByLabelText("Marker or region name"), { target: { value: "Verse" } });
    fireEvent.click(getByRole("button", { name: /^Add region$/ }));
    await flushReplies();
    expect(worker.calls("regions.add")[0].params).toEqual({
      documentId: info.documentId,
      start: 12000,
      end: 24000,
      name: "Verse",
      color: "#a78bfa",
      selection: { start: 12000, end: 24000, channelMask: 1 },
    });
    expect(getByTestId("timeline-region-2")).toBeTruthy();
    act(() => handle.current?.clearSelection(0));
    fireEvent.doubleClick(getByTestId("waveform-channel-0"), { clientX: frameX(18000) });
    expect(selectionState(getByTestId("waveform-view"))).toEqual({
      start: 12000,
      end: 24000,
      channelMask: 1,
    });
    expect(onSeek).toHaveBeenLastCalledWith(12000);
  });

  it("double-clicks the interval between markers when no region contains the frame", async () => {
    const { getByTestId } = mounted(info, {
      timeline: {
        markers: [
          { id: 1, frame: 12000, name: "Start", color: "#a78bfa" },
          { id: 2, frame: 24000, name: "End", color: "#a78bfa" },
        ],
      },
    });
    await painted(getByTestId);
    fireEvent.doubleClick(getByTestId("waveform-channel-0"), { clientX: frameX(18000) });
    expect(selectionState(getByTestId("waveform-view"))).toEqual({
      start: 12000,
      end: 24000,
      channelMask: 3,
    });
  });

  it("snaps endpoints to marker and region boundaries without sample RPCs", async () => {
    const { getByTestId, getByLabelText, worker } = mounted(info, {
      timeline: {
        markers: [{ id: 1, frame: 12000, name: "Cue", color: "#a78bfa" }],
        regions: [{ id: 2, start: 18000, end: 24000, name: "Verse", color: "#a78bfa" }],
      },
    });
    await painted(getByTestId);
    fireEvent.click(getByLabelText("Markers / regions"));
    dragRange(getByTestId("waveform-channel-0"), 11900, 23900);
    expect(selectionState(getByTestId("waveform-view"))).toEqual({
      start: 12000,
      end: 24000,
      channelMask: 3,
    });
    expect(worker.calls("selection.snap")).toHaveLength(0);
  });

  it("snaps to visible ruler ticks only within the pixel threshold", async () => {
    const { getByTestId, getByLabelText } = mounted();
    await painted(getByTestId);
    fireEvent.click(getByLabelText("Ruler ticks"));
    dragRange(getByTestId("waveform-channel-0"), 9700, 18800);
    expect(selectionState(getByTestId("waveform-view"))).toEqual({
      start: 9600,
      end: 18800,
      channelMask: 3,
    });
  });

  it("uses bounded zero-crossing RPCs with the selected mask on long files", async () => {
    const longInfo = { ...info, sampleRate: 384000, frames: 100_000_000 };
    const { getByTestId, getByLabelText, worker } = mounted(longInfo, {
      selection: { channelMask: 2 },
    });
    await painted(getByTestId);
    worker.zeroFrame = 50_000_100;
    fireEvent.click(getByLabelText("Zero crossings"));
    dragRange(getByTestId("waveform-channel-0"), 50_000_000, 50_000_000, {
      documentInfo: longInfo,
    });
    await flushReplies();
    const calls = worker.calls("selection.snap");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const params = call.params as SelectionSnapParams;
      expect(params).toEqual({
        documentId: info.documentId,
        frame: 50_000_000,
        radius: 7680,
        channelMask: 2,
      });
      expect(params.radius).toBeLessThanOrEqual(8192);
    }
    expect(selectionState(getByTestId("waveform-view"))).toEqual({
      start: 50_000_100,
      end: 50_000_100,
      channelMask: 2,
    });
  });

  it("preserves the committed range and displays an error when zero analysis fails", async () => {
    const onSeek = vi.fn();
    const { getByTestId, getByLabelText, getByRole, worker } = mounted(info, {
      selection: { start: 12000, end: 24000 },
      onSeek,
    });
    await painted(getByTestId);
    worker.deferSnaps = true;
    fireEvent.click(getByLabelText("Zero crossings"));
    dragRange(getByTestId("waveform-channel-0"), 6000, 30000);
    await act(async () => worker.rejectSnaps());
    await flushReplies();
    expect(selectionState(getByTestId("waveform-view"))).toEqual({
      start: 12000,
      end: 24000,
      channelMask: 3,
    });
    expect(getByRole("alert").textContent).toBe("snap rejected");
    expect(worker.calls("selection.set")).toHaveLength(0);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it.each(["numeric", "channels", "document", "client", "busy"] as const)(
    "drops delayed zero-snap finalization after a newer %s action",
    async (action) => {
      const onSeek = vi.fn();
      const { getByTestId, getByLabelText, getByRole, worker, client, rerender, handle } = mounted(
        info,
        { onSeek },
      );
      await painted(getByTestId);
      worker.deferSnaps = true;
      fireEvent.click(getByLabelText("Zero crossings"));
      dragRange(getByTestId("waveform-channel-0"), 12000, 24000);
      expect(worker.pendingSnaps).toHaveLength(2);
      if (action === "numeric") {
        fireEvent.change(getByLabelText("Time format"), { target: { value: "samples" } });
        fireEvent.change(getByLabelText("Selection end"), { target: { value: "30000" } });
        fireEvent.keyDown(getByLabelText("Selection end"), { key: "Enter" });
      } else if (action === "channels") {
        fireEvent.click(getByRole("button", { name: /^Right$/ }));
      } else if (action === "document") {
        rerender(
          <WaveformView
            client={client}
            info={{ ...info, documentId: "doc-2" }}
            ref={handle}
            onSeek={onSeek}
          />,
        );
      } else if (action === "client") {
        rerender(
          <WaveformView
            client={new KernelClient(new PeakWorker())}
            info={info}
            ref={handle}
            onSeek={onSeek}
          />,
        );
      } else {
        rerender(
          <WaveformView client={client} info={info} ref={handle} onSeek={onSeek} disabled />,
        );
      }
      await flushReplies();
      const before = selectionState(getByTestId("waveform-view"));
      const seeks = onSeek.mock.calls.length;
      const writes = worker.calls("selection.set").length;
      await act(async () => worker.resolveSnaps(12050));
      expect(selectionState(getByTestId("waveform-view"))).toEqual(before);
      expect(onSeek).toHaveBeenCalledTimes(seeks);
      expect(worker.calls("selection.set")).toHaveLength(writes);
    },
  );

  it.each(["cancel", "lostCapture"] as const)(
    "rolls back only the matching pointer on %s and ignores later completion",
    async (ending) => {
      const onSeek = vi.fn();
      const { getByTestId, worker } = mounted(info, {
        selection: { start: 12000, end: 24000 },
        onSeek,
      });
      await painted(getByTestId);
      const canvas = getByTestId("waveform-channel-0");
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: frameX(6000) });
      fireEvent.pointerMove(canvas, { pointerId: 7, clientX: frameX(30000) });
      const finish = ending === "cancel" ? fireEvent.pointerCancel : fireEvent.lostPointerCapture;
      finish(canvas, { pointerId: 8 });
      expect(selectionState(getByTestId("waveform-view"))).toEqual({
        start: 6000,
        end: 30000,
        channelMask: 3,
      });
      finish(canvas, { pointerId: 7 });
      expect(selectionState(getByTestId("waveform-view"))).toEqual({
        start: 12000,
        end: 24000,
        channelMask: 3,
      });
      fireEvent.pointerMove(canvas, { pointerId: 7, clientX: frameX(36000) });
      fireEvent.pointerUp(canvas, { pointerId: 7, clientX: frameX(36000) });
      expect(worker.calls("selection.set")).toHaveLength(0);
      expect(onSeek).not.toHaveBeenCalled();
    },
  );

  it("paints RAF cursor positions immediately and refreshes the clock on unrelated React commits", async () => {
    const { getByTestId, handle, rerender, client, worker } = mounted();
    await painted(getByTestId, 1);
    const requests = worker.peaks.length;
    // The position prop intentionally remains zero: no React state update is
    // needed to paint the current shared-clock position at an animation frame.
    handle.current?.updatePlayback(24000);
    expect(getByTestId("play-cursor-0").style.left).toBe("372px");
    expect(getByTestId("play-cursor-1").dataset.frame).toBe("24000");
    rerender(<WaveformView client={client} info={info} position={0} readPosition={() => 36000} />);
    expect(getByTestId("play-cursor-0").style.left).toBe("558px");
    expect(getByTestId("play-cursor-overview").dataset.frame).toBe("36000");
    expect(worker.peaks.length).toBe(requests);
  });
  it("draws the consumed-frame cursor in every channel without fetching new peaks", async () => {
    const { getByTestId, rerender, client, worker } = mounted();
    await painted(getByTestId, 1);
    const requests = worker.peaks.length;
    rerender(<WaveformView client={client} info={info} position={24000} playing />);
    expect(getByTestId("play-cursor-0").style.left).toBe("372px");
    expect(getByTestId("play-cursor-1").dataset.frame).toBe("24000");
    expect(getByTestId("play-cursor-overview").style.left).toBe("372px");
    expect(worker.peaks.length).toBe(requests);
  });

  it("seeks at completed pointer ranges but not cancelled drags", () => {
    const onSeek = vi.fn();
    const { getByTestId, rerender, client, handle } = mounted();
    rerender(<WaveformView client={client} info={info} onSeek={onSeek} ref={handle} />);
    const canvas = getByTestId("waveform-channel-0");
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 56 + 300 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 56 + 100 });
    expect(onSeek).toHaveBeenCalledWith(6452);
    expect(handle.current?.selection()).toEqual({ start: 6452, end: 19355 });
    act(() => handle.current?.clearSelection());
    expect(handle.current?.selection()).toBeUndefined();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 56 + 100 });
    fireEvent.pointerCancel(canvas, { pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 56 + 400 });
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("pages or continuously follows playback and leaves manual views alone when stopped", () => {
    const { getByTestId, rerender, client, handle } = mounted();
    act(() => handle.current?.zoomIn());
    rerender(<WaveformView client={client} info={info} position={37000} playing follow="page" />);
    expect(range(getByTestId("waveform-view"))).toEqual([24000, 48000]);
    rerender(
      <WaveformView client={client} info={info} position={18000} playing follow="continuous" />,
    );
    expect(range(getByTestId("waveform-view"))).toEqual([6000, 30000]);
    rerender(<WaveformView client={client} info={info} position={0} follow="continuous" />);
    expect(range(getByTestId("waveform-view"))).toEqual([6000, 30000]);
    rerender(<WaveformView client={client} info={info} position={0} playing follow="off" />);
    expect(range(getByTestId("waveform-view"))).toEqual([6000, 30000]);
  });
  it("draws kernel peaks independently in every channel and the full-file overview", async () => {
    const { getByTestId, worker } = mounted();
    await painted(getByTestId, 1);
    await waitFor(() => expect(getByTestId("waveform-overview").dataset.rendered).toBe("true"));
    const requests = worker.peaks
      .filter((request) => request.op === "call")
      .map((request) => (request.params as PeaksGetParams).channel);
    expect(requests.sort()).toEqual([0, 1]);
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

  it("reuses the overview peaks when zooming back to fit without a duplicate first-lane query", async () => {
    const { getByTestId, worker, handle } = mounted();
    await painted(getByTestId, 1);
    await waitFor(() => expect(getByTestId("waveform-overview").dataset.rendered).toBe("true"));
    expect(worker.peaks).toHaveLength(2);
    act(() => handle.current?.zoomIn());
    await painted(getByTestId, 1);
    expect(worker.peaks).toHaveLength(4);
    act(() => handle.current?.zoomFit());
    await painted(getByTestId, 1);
    // Channel 1 requests its fitted range; channel 0 shares the overview's
    // existing zero-copy views instead of recomputing the full-file summary.
    expect(worker.peaks).toHaveLength(5);
    const fullFirstLane = worker.peaks.filter(
      (request) =>
        request.op === "call" &&
        (request.params as PeaksGetParams).channel === 0 &&
        (request.params as PeaksGetParams).startFrame === 0 &&
        (request.params as PeaksGetParams).endFrame === info.frames,
    );
    expect(fullFirstLane).toHaveLength(1);
  });

  it("invalidates shared fitted and overview peaks when an identical document is reopened", async () => {
    const { getByTestId, worker, client, handle, rerender } = mounted();
    await painted(getByTestId, 1);
    await waitFor(() => expect(getByTestId("waveform-overview").dataset.rendered).toBe("true"));
    expect(worker.peaks).toHaveLength(2);
    rerender(<WaveformView client={client} info={{ ...info }} ref={handle} />);
    expect(getByTestId("waveform-channel-0").dataset.rendered).toBe("false");
    expect(getByTestId("waveform-overview").dataset.rendered).toBe("false");
    await painted(getByTestId, 1);
    await waitFor(() => expect(getByTestId("waveform-overview").dataset.rendered).toBe("true"));
    expect(worker.peaks).toHaveLength(4);
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

  it("zooms to the committed frame range and restores it after pointer cancellation", () => {
    const { getByTestId, getByRole } = mounted();
    const canvas = getByTestId("waveform-channel-0");
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 56 + 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 56 + 300 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 56 + 300 });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 56 + 400 });
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

  it("adds/renames/recolors/removes metadata without resetting playing cursor, peaks or viewport", async () => {
    const onTimelineChanged = vi.fn();
    const onSeek = vi.fn();
    const { getByTestId, getByLabelText, getByRole, container, worker } = mounted(info, {
      playing: true,
      onSeek,
      timelineOptions: { onTimelineChanged },
      selection: { start: 12000, end: 24000, channelMask: 2 },
    });
    await painted(getByTestId);
    fireEvent.click(getByRole("button", { name: "Zoom in" }));
    await flushReplies();
    await waitFor(() => expect(worker.peaks).toHaveLength(4));
    const beforeRange = range(getByTestId("waveform-view"));
    const beforePeaks = worker.peaks.length;
    fireEvent.change(getByLabelText("Marker or region name"), { target: { value: "Cue" } });
    fireEvent.change(getByLabelText("Marker or region color"), { target: { value: "#123456" } });
    fireEvent.click(getByRole("button", { name: /^Add marker$/ }));
    await flushReplies();
    expect(getByTestId("timeline-marker-1").style.borderColor).toBe("rgb(18, 52, 86)");
    expect(worker.calls("markers.add")[0].params).toEqual({
      documentId: "doc-1",
      frame: 12000,
      name: "Cue",
      color: "#123456",
      selection: { start: 12000, end: 24000, channelMask: 2 },
    });
    const details = container.querySelector('[data-testid="timeline-panel"]') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
    fireEvent.change(getByLabelText("Timeline name"), { target: { value: "Renamed" } });
    fireEvent.change(getByLabelText("Timeline color"), { target: { value: "#abcdef" } });
    fireEvent.click(getByRole("button", { name: "Save marker" }));
    await flushReplies();
    expect(getByTestId("timeline-marker-1").textContent).toBe("Renamed");
    expect(getByTestId("timeline-marker-1").style.color).toBe("rgb(171, 205, 239)");
    fireEvent.click(getByRole("button", { name: "Delete marker Renamed" }));
    await flushReplies();
    expect(onTimelineChanged).toHaveBeenCalledTimes(3);
    expect(onTimelineChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        documentId: "doc-1",
        changed: true,
        history: expect.objectContaining({ dirty: true }),
      }),
      "doc-1",
    );
    expect(range(getByTestId("waveform-view"))).toEqual(beforeRange);
    expect(worker.peaks).toHaveLength(beforePeaks);
    expect(worker.calls("selection.set")).toHaveLength(0);
    expect(worker.calls("transport.stop")).toHaveLength(0);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("jumps from the management list via committed selection/seek and delegates export without JS serialization", async () => {
    const onSeek = vi.fn();
    const onExportTimeline = vi.fn();
    const onTimelineChanged = vi.fn();
    const { getByRole, getByTestId, container, worker } = mounted(info, {
      onSeek,
      onExportTimeline,
      timelineOptions: { onTimelineChanged },
      selection: { channelMask: 2 },
      timeline: { regions: [{ id: 9, start: 12000, end: 24000, name: "Verse", color: "#ff0000" }] },
    });
    await painted(getByTestId);
    expect(getByTestId("timeline-region-9").style.backgroundColor).toBe("rgba(255, 0, 0, 0.5)");
    const details = container.querySelector('[data-testid="timeline-panel"]') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    fireEvent.click(getByRole("button", { name: "Jump to region Verse" }));
    await flushReplies();
    expect(worker.selection).toMatchObject({ start: 12000, end: 24000, channelMask: 2 });
    expect(onSeek).toHaveBeenCalledWith(12000);
    expect(onTimelineChanged).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "Export CSV" }));
    fireEvent.click(getByRole("button", { name: "Export labels" }));
    expect(onExportTimeline.mock.calls).toEqual([["csv"], ["labels"]]);
    expect(worker.calls("timeline.export")).toHaveLength(0);
  });

  it("refuses add and management actions during pointer and delayed snap previews", async () => {
    const { getByRole, getByTestId, getByLabelText, container, worker } = mounted(info, {
      timeline: { markers: [{ id: 1, frame: 12000, name: "Cue", color: "#a78bfa" }] },
    });
    await painted(getByTestId);
    const details = container.querySelector('[data-testid="timeline-panel"]') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    fireEvent.click(getByLabelText("Zero crossings"));
    worker.deferSnaps = true;
    const canvas = getByTestId("waveform-channel-0");
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: frameX(12000) });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: frameX(18000) });
    for (const name of [
      "Add marker",
      "Add region",
      "Delete marker Cue",
      "Edit marker Cue",
      "Jump to marker Cue",
    ]) {
      expect((getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(getByRole("button", { name }));
    }
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: frameX(18000) });
    expect((getByRole("button", { name: "Add marker" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Delete marker Cue" }));
    expect(worker.calls("markers.add")).toHaveLength(0);
    expect(worker.calls("markers.remove")).toHaveLength(0);
    await act(async () => worker.resolveSnaps(18000));
    await flushReplies();
    expect((getByRole("button", { name: "Add marker" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("handles an empty document without asking the kernel for peaks", () => {
    const { getByTestId, getByRole, getByText, worker } = mounted({ ...info, frames: 0 });
    expect(range(getByTestId("waveform-view"))).toEqual([0, 0]);
    expect((getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("No audio frames in this document.")).toBeTruthy();
    expect(worker.peaks).toHaveLength(0);
  });
});

it("keeps the previous painted waveform while a fitted lane transitions to delayed zoom peaks", async () => {
  const s = mounted();
  await waitFor(() =>
    expect(s.getByTestId("waveform-channel-0").getAttribute("data-rendered")).toBe("true"),
  );
  const canvas = s.getByTestId("waveform-channel-0") as HTMLCanvasElement;
  const drawing = contexts.get(canvas);
  drawing?.fillRect.mockClear();
  drawing?.clearRect.mockClear();
  s.worker.deferPeaks = true;
  fireEvent.click(s.getByRole("button", { name: "Zoom in" }));
  await waitFor(() => expect(s.worker.pendingPeaks.length).toBeGreaterThan(0));
  expect(canvas.getAttribute("aria-busy")).toBe("true");
  expect(canvas.getAttribute("data-rendered")).toBe("false");
  expect(drawing?.fillRect).not.toHaveBeenCalled();
  expect(drawing?.clearRect).not.toHaveBeenCalled();
  await act(async () => s.worker.resolvePeaks());
  expect(canvas.getAttribute("data-rendered")).toBe("true");
  expect(drawing?.fillRect).toHaveBeenCalled();
});
