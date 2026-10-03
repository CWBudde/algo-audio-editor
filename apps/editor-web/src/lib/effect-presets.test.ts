import { afterEach, expect, it, vi } from "vitest";
import {
  loadEffectPresets,
  parseEffectPresets,
  persistentPreset,
  restoreEffectIR,
  saveEffectPresets,
  storeEffectIR,
} from "./effect-presets";

const preset = {
  id: "preset-1",
  name: "Room",
  rack: [
    {
      id: "fx-1",
      type: "reverb-conv",
      params: { irIndex: 42, wet: 0.5 },
      irName: "room.wav",
      irAssetId: "11111111-1111-1111-1111-111111111111",
    },
  ],
  wet: 1,
  bypass: false,
};
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.aaeDesktop;
});
it("persists stable IR asset references and removes process-local indices", () => {
  const stored = persistentPreset(preset);
  expect(stored.rack[0].params).toEqual({ wet: 0.5 });
  expect(stored.rack[0].irAssetId).toBe(preset.rack[0].irAssetId);
  expect(preset.rack[0].params.irIndex).toBe(42);
  expect(parseEffectPresets(JSON.stringify({ version: 1, presets: [stored] }))).toEqual([stored]);
});
it.each(["{}", '{"version":2,"presets":[]}', '{"version":1,"presets":[{"id":"bad"}]}'])(
  "rejects malformed collections: %s",
  (value) => expect(() => parseEffectPresets(value)).toThrow(),
);
it("uses OPFS file writes and preserves binary asset bytes separately from preset JSON", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockResolvedValue(undefined);
  const getFileHandle = vi.fn().mockResolvedValue({
    createWritable: async () => ({ write, close, abort }),
    getFile: async () => ({
      text: async () => JSON.stringify({ version: 1, presets: [preset] }),
      size: 4,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }),
  });
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getFileHandle }) } });
  await saveEffectPresets([preset]);
  expect(write).toHaveBeenCalledWith(JSON.stringify({ version: 1, presets: [preset] }));
  expect(close).toHaveBeenCalledOnce();
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  await storeEffectIR(preset.rack[0].irAssetId, bytes);
  expect(write).toHaveBeenLastCalledWith(bytes);
  expect(await restoreEffectIR(preset.rack[0].irAssetId)).toEqual(bytes);
  expect(await loadEffectPresets()).toEqual([preset]);
  expect(getFileHandle).toHaveBeenCalledWith(`effect-ir-${preset.rack[0].irAssetId}.wav`, {
    create: true,
  });
});
it("routes desktop storage through the narrow bridge and rejects resource path traversal before IPC", async () => {
  const load = vi.fn().mockResolvedValue(null);
  const save = vi.fn().mockResolvedValue(undefined);
  const loadIR = vi.fn().mockResolvedValue(new ArrayBuffer(8));
  const saveIR = vi.fn().mockResolvedValue(undefined);
  window.aaeDesktop = {
    platform: "linux",
    versions: { electron: "test", chrome: "test", node: "test" },
    loadEffectPresets: load,
    saveEffectPresets: save,
    loadEffectIR: loadIR,
    saveEffectIR: saveIR,
  };
  expect(await loadEffectPresets()).toEqual([]);
  await saveEffectPresets([preset]);
  expect(save).toHaveBeenCalledWith(JSON.stringify({ version: 1, presets: [preset] }));
  await expect(restoreEffectIR("../../escape")).rejects.toThrow("resource id");
  expect(loadIR).not.toHaveBeenCalled();
  const bytes = new ArrayBuffer(8);
  await storeEffectIR(preset.rack[0].irAssetId, bytes);
  expect(saveIR).toHaveBeenCalledWith(preset.rack[0].irAssetId, bytes);
});
