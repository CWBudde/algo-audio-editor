import { desktopBridge } from "@/platform";

export interface RackEffect {
  id: string;
  type: string;
  params: Record<string, number | string | boolean>;
  bypassed?: boolean;
  irName?: string;
  irAssetId?: string;
}
export interface EffectPreset {
  id: string;
  name: string;
  rack: RackEffect[];
  wet: number;
  bypass: boolean;
}
interface Collection {
  version: 1;
  presets: EffectPreset[];
}
const FILE = "effect-presets.json";
const MAX_BYTES = 1024 * 1024;
export function parseEffectPresets(data: string | null): EffectPreset[] {
  if (!data) return [];
  if (data.length > MAX_BYTES) throw new Error("Preset collection exceeds size limit");
  const parsed: unknown = JSON.parse(data);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("presets" in parsed) ||
    !Array.isArray(parsed.presets) ||
    parsed.presets.length > 1000
  )
    throw new Error("Invalid preset collection");
  for (const preset of parsed.presets) {
    if (
      !preset ||
      typeof preset.id !== "string" ||
      typeof preset.name !== "string" ||
      !preset.name.trim() ||
      !Array.isArray(preset.rack) ||
      preset.rack.length > 32 ||
      !Number.isFinite(preset.wet) ||
      preset.wet < 0 ||
      preset.wet > 1 ||
      typeof preset.bypass !== "boolean"
    )
      throw new Error("Invalid effect preset");
    for (const node of preset.rack) {
      if (
        !node ||
        typeof node.id !== "string" ||
        typeof node.type !== "string" ||
        !node.params ||
        typeof node.params !== "object" ||
        Array.isArray(node.params) ||
        Object.values(node.params).some(
          (value) =>
            !["number", "string", "boolean"].includes(typeof value) ||
            (typeof value === "number" && !Number.isFinite(value)),
        )
      )
        throw new Error("Invalid effect preset node");
    }
  }
  return parsed.presets as EffectPreset[];
}
export async function loadEffectPresets(): Promise<EffectPreset[]> {
  const desktop = desktopBridge();
  if (desktop?.loadEffectPresets) return parseEffectPresets(await desktop.loadEffectPresets());
  const directory = await navigator.storage.getDirectory();
  try {
    const handle = await directory.getFileHandle(FILE);
    return parseEffectPresets(await (await handle.getFile()).text());
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return [];
    throw error;
  }
}
let writes: Promise<void> = Promise.resolve();
export function saveEffectPresets(presets: EffectPreset[]): Promise<void> {
  const collection: Collection = { version: 1, presets };
  const data = JSON.stringify(collection);
  parseEffectPresets(data);
  const save = async () => {
    const desktop = desktopBridge();
    if (desktop?.saveEffectPresets) {
      await desktop.saveEffectPresets(data);
      return;
    }
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(FILE, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  };
  const pending = writes.then(save);
  writes = pending.catch(() => {});
  return pending;
}

function assetName(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid impulse resource id");
  return `effect-ir-${id}.wav`;
}
export async function storeEffectIR(id: string, data: ArrayBuffer): Promise<void> {
  assetName(id);
  if (data.byteLength > 128 * 1024 * 1024) throw new Error("Impulse file exceeds size limit");
  const desktop = desktopBridge();
  if (desktop?.saveEffectIR) {
    await desktop.saveEffectIR(id, data);
    return;
  }
  const directory = await navigator.storage.getDirectory();
  const file = await directory.getFileHandle(assetName(id), { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}
export async function restoreEffectIR(id: string): Promise<ArrayBuffer> {
  assetName(id);
  const desktop = desktopBridge();
  if (desktop?.loadEffectIR) return desktop.loadEffectIR(id);
  const directory = await navigator.storage.getDirectory();
  const file = await (await directory.getFileHandle(assetName(id))).getFile();
  if (file.size > 128 * 1024 * 1024) throw new Error("Impulse file exceeds size limit");
  return file.arrayBuffer();
}
export function persistentPreset(preset: EffectPreset): EffectPreset {
  return {
    ...preset,
    rack: preset.rack.map((node) => {
      const params = { ...node.params };
      if (node.type === "reverb-conv") delete params.irIndex;
      return { ...node, params };
    }),
  };
}

export async function removeEffectIR(id: string): Promise<void> {
  const name = assetName(id);
  const desktop = desktopBridge();
  if (desktop?.deleteEffectIR) {
    await desktop.deleteEffectIR(id);
    return;
  }
  const directory = await navigator.storage.getDirectory();
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
}
