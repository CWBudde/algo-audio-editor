import type { EffectDescriptor, ProcessJobResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import {
  loadEffectPresets,
  removeEffectIR,
  restoreEffectIR,
  saveEffectPresets,
  storeEffectIR,
} from "@/lib/effect-presets";
import { useEffects } from "./use-effects";

vi.mock("@/lib/effect-presets", async (original) => ({
  ...(await original<typeof import("@/lib/effect-presets")>()),
  loadEffectPresets: vi.fn(),
  restoreEffectIR: vi.fn(),
  saveEffectPresets: vi.fn(),
  storeEffectIR: vi.fn(),
  removeEffectIR: vi.fn(),
}));
const info = {
  documentId: "doc-1",
  name: "sound.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 48000,
  bitDepth: 32,
  float: true,
};
const selection = { start: 20, end: 80, channelMask: 2 };
const gain: EffectDescriptor = {
  id: "gain",
  name: "Gain",
  category: "Utility",
  channelMode: "mono",
  view: "generic",
  parameters: [
    {
      id: "gainDB",
      label: "Gain",
      type: "number",
      unit: "dB",
      min: -60,
      max: 24,
      default: 0,
      scale: "dB",
      step: 0.1,
    },
  ],
  presets: [{ id: "quiet", name: "Quiet", num: { gainDB: -6 }, str: {} }],
};
const convolution: EffectDescriptor = {
  ...gain,
  id: "reverb-conv",
  name: "Convolution",
  parameters: [{ ...gain.parameters[0], id: "irIndex", min: -1, max: 10000, default: -1 }],
  presets: [],
};
const job = {
  documentId: info.documentId,
  jobId: "job-1",
  operation: "effects",
  state: "ready",
  peak: 0.5,
  nonFinite: false,
} as ProcessJobResult;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  let locked = false;
  const call = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "effects.list") return { effects: [gain, convolution] };
    if (method === "effects.preview.start" || method === "effects.preview.update")
      return {
        documentId: info.documentId,
        ...selection,
        ...(params as object),
        previewId: "preview-1",
      };
    if (method === "effects.apply") return job;
    if (method === "process.commit")
      return { changed: true, document: { ...info, documentId: "doc-2" } };
    if (method === "effects.preview.meters")
      return {
        inputPeak: [0.5, 0.5],
        outputPeak: [0.25, 0.25],
        inputRms: [0.3, 0.3],
        outputRms: [0.15, 0.15],
      };
    return { stopped: true, removed: true };
  });
  const loadImpulseResponse = vi
    .fn()
    .mockResolvedValue({ irId: 7, name: "room.wav", sampleRate: 48000, channels: 1, frames: 10 });
  const runProcess = vi.fn().mockResolvedValue(job);
  const client = { call, loadImpulseResponse, runProcess } as unknown as KernelClient;
  const options = {
    client,
    info,
    busy: false,
    withOperation: vi.fn(async (work: () => Promise<void>) => {
      if (locked) throw new Error("in progress");
      locked = true;
      try {
        await work();
      } finally {
        locked = false;
      }
    }),
    beforeEdit: vi.fn().mockResolvedValue(undefined),
    preparePreview: vi.fn().mockResolvedValue(undefined),
    playPreview: vi.fn().mockResolvedValue(undefined),
    stopPreview: vi.fn().mockResolvedValue(undefined),
    onEdited: vi.fn(),
    onRecorded: vi.fn(),
    onError: vi.fn(),
  };
  const ui = renderHook((props) => useEffects(props), { initialProps: options });
  await act(async () => Promise.resolve());
  await act(async () => ui.result.current.open(selection, "gain"));
  return { ...ui, options, call, runProcess, loadImpulseResponse, locked: () => locked };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadEffectPresets).mockResolvedValue([]);
  vi.mocked(saveEffectPresets).mockResolvedValue(undefined);
  vi.mocked(storeEffectIR).mockResolvedValue(undefined);
  vi.mocked(removeEffectIR).mockResolvedValue(undefined);
  vi.mocked(restoreEffectIR).mockResolvedValue(new ArrayBuffer(8));
});
afterEach(cleanup);
it("holds the document fence through private live preview, serializes latest controls and leaves source untouched on cancel", async () => {
  const f = await fixture();
  expect(f.locked()).toBe(true);
  expect(f.options.beforeEdit).toHaveBeenCalledOnce();
  await act(async () => f.result.current.preview());
  expect(f.result.current.view?.previewing).toBe(true);
  expect(f.options.playPreview).toHaveBeenCalledWith(
    info,
    expect.objectContaining({ previewId: "preview-1" }),
  );
  const waiting = deferred<unknown>();
  f.call.mockImplementationOnce(() => waiting.promise);
  act(() => f.result.current.change({ wet: 0.25 }));
  act(() => f.result.current.change({ wet: 0.5, bypass: true }));
  await act(async () =>
    waiting.resolve({
      documentId: info.documentId,
      ...selection,
      previewId: "preview-1",
      wet: 0.25,
      bypass: false,
    }),
  );
  expect(f.call).toHaveBeenLastCalledWith(
    "effects.preview.update",
    expect.objectContaining({ wet: 0.5, bypass: true }),
  );
  await act(async () => f.result.current.cancel());
  expect(f.result.current.view).toBeUndefined();
  expect(f.locked()).toBe(false);
  expect(f.options.onEdited).not.toHaveBeenCalled();
  expect(f.options.onRecorded).not.toHaveBeenCalled();
  expect(f.call.mock.calls.some(([method]) => method === "process.commit")).toBe(false);
});
it("applies the ordered rack exactly once using the selected channels and one authoritative history reply", async () => {
  const f = await fixture();
  const first = f.result.current.view?.rack[0];
  if (!first) throw new Error("rack missing");
  act(() =>
    f.result.current.change({
      rack: [
        { ...first, id: "first", params: { gainDB: -6 } },
        { ...first, id: "second", params: { gainDB: 3 } },
      ],
      wet: 0.75,
    }),
  );
  await act(async () => f.result.current.apply());
  const params = f.call.mock.calls.find(([method]) => method === "effects.apply")?.[1] as {
    graph: { connections: unknown[] };
    channelMask: number;
  };
  expect(params.channelMask).toBe(2);
  expect(params.graph.connections).toEqual([
    { from: "_input", to: "first" },
    { from: "first", to: "second" },
    { from: "second", to: "_output" },
  ]);
  expect(f.call.mock.calls.filter(([method]) => method === "process.commit")).toHaveLength(1);
  expect(f.options.onEdited).toHaveBeenCalledOnce();
  expect(f.options.onRecorded).toHaveBeenCalledOnce();
  expect(f.result.current.view).toBeUndefined();
  expect(f.locked()).toBe(false);
});
it("discards a failed offline job before retry and keeps errors inside the dialog", async () => {
  const f = await fixture();
  const original = f.call.getMockImplementation();
  if (!original) throw new Error("mock missing");
  f.call.mockImplementation(async (method, params) =>
    method === "effects.apply" ? { ...job, state: "running" } : original(method, params),
  );
  f.runProcess.mockRejectedValueOnce(new Error("render failed"));
  await act(async () => f.result.current.apply());
  expect(f.call).toHaveBeenCalledWith("process.cancel", {
    documentId: info.documentId,
    jobId: job.jobId,
  });
  expect(f.result.current.view).toMatchObject({ phase: "idle", error: "render failed" });
  expect(f.options.onEdited).not.toHaveBeenCalled();
  expect(f.options.onRecorded).not.toHaveBeenCalled();
  await act(async () => f.result.current.apply());
  expect(f.options.onEdited).toHaveBeenCalledOnce();
  expect(f.options.onRecorded).toHaveBeenCalledOnce();
});
it("invalidates clipping acknowledgement when the rack changes", async () => {
  const f = await fixture();
  const original = f.call.getMockImplementation();
  if (!original) throw new Error("mock missing");
  f.call.mockImplementation(async (method, params) =>
    method === "effects.apply" ? { ...job, peak: 2 } : original(method, params),
  );
  await act(async () => f.result.current.apply());
  expect(f.result.current.view?.phase).toBe("ready");
  expect(f.options.onEdited).not.toHaveBeenCalled();
  expect(f.options.onRecorded).not.toHaveBeenCalled();
  act(() => f.result.current.change({ wet: 0.5 }));
  expect(f.result.current.view?.phase).toBe("idle");
  await act(async () => f.result.current.apply());
  expect(f.options.onEdited).not.toHaveBeenCalled();
  expect(f.options.onRecorded).not.toHaveBeenCalled();
  await act(async () => f.result.current.cancel());
});
it("refetches rate-dependent descriptors and uses the old audio callbacks during replacement cleanup", async () => {
  const f = await fixture();
  await act(async () => f.result.current.preview());
  const replacementStop = vi.fn().mockResolvedValue(undefined);
  const newClient = { ...f.options.client } as KernelClient;
  f.rerender({
    ...f.options,
    client: newClient,
    info: { ...info, documentId: "doc-new", sampleRate: 8000 },
    stopPreview: replacementStop,
  });
  await act(async () => Promise.resolve());
  expect(f.call).toHaveBeenCalledWith("effects.list", { sampleRate: 8000 });
  expect(f.options.stopPreview).toHaveBeenCalled();
  expect(replacementStop).not.toHaveBeenCalled();
  expect(f.locked()).toBe(false);
});
it("validates IR in the kernel before storing bytes and removes the owned id when persistence fails", async () => {
  const f = await fixture();
  const base = f.result.current.view?.rack[0];
  if (!base) throw new Error("rack missing");
  act(() =>
    f.result.current.change({ rack: [{ ...base, type: "reverb-conv", params: { irIndex: -1 } }] }),
  );
  const file = { name: "room.wav", arrayBuffer: async () => new ArrayBuffer(16) } as File;
  f.loadImpulseResponse.mockRejectedValueOnce(new Error("not WAV"));
  await act(async () => f.result.current.loadIR(base.id, file));
  expect(storeEffectIR).not.toHaveBeenCalled();
  vi.mocked(storeEffectIR).mockRejectedValueOnce(new Error("disk full"));
  await act(async () => f.result.current.loadIR(base.id, file));
  expect(f.call).toHaveBeenCalledWith("effects.ir.remove", {
    documentId: info.documentId,
    irId: 7,
  });
  expect(f.result.current.view?.error).toBe("disk full");
  expect(removeEffectIR).toHaveBeenCalledWith(expect.any(String));
  await act(async () => f.result.current.cancel());
});
it("stores binary IR references, remaps restored resources and releases every kernel asset after closing", async () => {
  const f = await fixture();
  const base = f.result.current.view?.rack[0];
  if (!base) throw new Error("rack missing");
  act(() =>
    f.result.current.change({ rack: [{ ...base, type: "reverb-conv", params: { irIndex: -1 } }] }),
  );
  await act(async () =>
    f.result.current.loadIR(base.id, {
      name: "room.wav",
      arrayBuffer: async () => new ArrayBuffer(16),
    } as File),
  );
  await act(async () => f.result.current.savePreset("Room"));
  const saved = vi.mocked(saveEffectPresets).mock.calls[0][0][0];
  expect(saved.rack[0].irAssetId).toBeTruthy();
  expect(saved.rack[0].params.irIndex).toBeUndefined();
  f.loadImpulseResponse.mockResolvedValueOnce({ irId: 11, name: "room.wav" });
  await act(async () => f.result.current.loadPreset(saved.id));
  expect(restoreEffectIR).toHaveBeenCalledWith(saved.rack[0].irAssetId);
  expect(f.result.current.view?.rack[0].params.irIndex).toBe(11);
  await act(async () => f.result.current.cancel());
  expect(f.call).toHaveBeenCalledWith("effects.ir.remove", {
    documentId: info.documentId,
    irId: 7,
  });
  expect(f.call).toHaveBeenCalledWith("effects.ir.remove", {
    documentId: info.documentId,
    irId: 11,
  });
});
it("disables concurrent preset mutations so overlapping saves cannot overwrite the collection", async () => {
  const f = await fixture();
  const pending = deferred<void>();
  vi.mocked(saveEffectPresets).mockReturnValueOnce(pending.promise);
  let saving: Promise<void> | undefined;
  act(() => {
    saving = f.result.current.savePreset("First");
  });
  act(() => {
    void f.result.current.savePreset("Second");
    void f.result.current.deletePreset("anything");
  });
  expect(saveEffectPresets).toHaveBeenCalledOnce();
  await act(async () => {
    pending.resolve();
    await saving;
  });
  expect(f.result.current.presets.map((preset) => preset.name)).toEqual(["First"]);
  await act(async () => f.result.current.cancel());
});

it("removes unsaved impulse files on cancel but retains files referenced by saved presets", async () => {
  const f = await fixture();
  const base = f.result.current.view?.rack[0];
  if (!base) throw new Error("rack missing");
  act(() =>
    f.result.current.change({ rack: [{ ...base, type: "reverb-conv", params: { irIndex: -1 } }] }),
  );
  await act(async () =>
    f.result.current.loadIR(base.id, {
      name: "room.wav",
      arrayBuffer: async () => new ArrayBuffer(16),
    } as File),
  );
  const asset = f.result.current.view?.rack[0].irAssetId;
  await act(async () => f.result.current.cancel());
  expect(removeEffectIR).toHaveBeenCalledWith(asset);
});

it("retains a newly persisted impulse when unmount waits for an in-flight preset save", async () => {
  const f = await fixture();
  const base = f.result.current.view?.rack[0];
  if (!base) throw new Error("rack missing");
  act(() =>
    f.result.current.change({ rack: [{ ...base, type: "reverb-conv", params: { irIndex: -1 } }] }),
  );
  await act(async () =>
    f.result.current.loadIR(base.id, {
      name: "room.wav",
      arrayBuffer: async () => new ArrayBuffer(16),
    } as File),
  );
  const pending = deferred<void>();
  vi.mocked(saveEffectPresets).mockReturnValueOnce(pending.promise);
  let saving: Promise<void> | undefined;
  act(() => {
    saving = f.result.current.savePreset("Room");
  });
  f.unmount();
  await act(async () => {
    pending.resolve();
    await saving;
  });
  expect(removeEffectIR).not.toHaveBeenCalled();
  expect(f.locked()).toBe(false);
  expect(f.call).toHaveBeenCalledWith("effects.ir.remove", {
    documentId: info.documentId,
    irId: 7,
  });
});

it("collects deleted preset impulses only after their final saved or active reference disappears", async () => {
  const asset = "8ad1bde7-4bd4-4f48-bda8-2d14149dbbb7";
  const preset = {
    id: "room",
    name: "Room",
    rack: [{ id: "saved", type: "reverb-conv", params: {}, irAssetId: asset }],
    wet: 1,
    bypass: false,
  };
  vi.mocked(loadEffectPresets).mockResolvedValue([preset, { ...preset, id: "shared" }]);
  const f = await fixture();
  await act(async () => f.result.current.deletePreset("room"));
  expect(removeEffectIR).not.toHaveBeenCalled();
  await act(async () => f.result.current.loadPreset("shared"));
  await act(async () => f.result.current.deletePreset("shared"));
  expect(removeEffectIR).not.toHaveBeenCalled();
  await act(async () => f.result.current.cancel());
  expect(removeEffectIR).toHaveBeenCalledExactlyOnceWith(asset);
});

it("immediately removes the last preset impulse when the active rack does not use it", async () => {
  const asset = "8ad1bde7-4bd4-4f48-bda8-2d14149dbbb7";
  vi.mocked(loadEffectPresets).mockResolvedValue([
    {
      id: "room",
      name: "Room",
      rack: [{ id: "saved", type: "reverb-conv", params: {}, irAssetId: asset }],
      wet: 1,
      bypass: false,
    },
  ]);
  const f = await fixture();
  await act(async () => f.result.current.deletePreset("room"));
  expect(removeEffectIR).toHaveBeenCalledExactlyOnceWith(asset);
  await act(async () => f.result.current.cancel());
  expect(removeEffectIR).toHaveBeenCalledOnce();
});

it("defers unreferenced convolution cleanup during live preview and releases it after stopping", async () => {
  const f = await fixture();
  const base = f.result.current.view?.rack[0];
  if (!base) throw new Error("rack missing");
  act(() =>
    f.result.current.change({ rack: [{ ...base, type: "reverb-conv", params: { irIndex: -1 } }] }),
  );
  await act(async () =>
    f.result.current.loadIR(base.id, {
      name: "room.wav",
      arrayBuffer: async () => new ArrayBuffer(16),
    } as File),
  );
  await act(async () => f.result.current.preview());
  await act(async () => f.result.current.change({ rack: [{ ...base, id: "replacement" }] }));
  expect(f.call.mock.calls.some(([method]) => method === "effects.ir.remove")).toBe(false);
  expect(f.result.current.view?.error).toBeUndefined();
  await act(async () => f.result.current.stopPreview());
  expect(f.call).toHaveBeenCalledWith("effects.ir.remove", {
    documentId: info.documentId,
    irId: 7,
  });
  await act(async () => f.result.current.cancel());
});
