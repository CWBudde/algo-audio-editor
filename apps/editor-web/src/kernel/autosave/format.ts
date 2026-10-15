/**
 * Binary layouts shared with packages/kernel/internal/engine/autosave.go. All
 * values are little-endian. A record is u32 id, u32 frames, frames × float32;
 * the store writes the kernel's records to disk unchanged.
 */

export const RECORD_HEADER_BYTES = 8;
const MAX_BLOCK_FRAMES = 65536;

export interface RecordEntry {
  id: number;
  /** Byte offset of the record within its buffer or segment. */
  offset: number;
  /** Whole record size, header included. */
  bytes: number;
}

export interface Delta {
  freed: number[];
  /** Per-channel block IDs; present only on a complete delta. */
  layout?: number[][];
  /** The delta's concatenated records, a view into its buffer. */
  records: Uint8Array;
  entries: RecordEntry[];
}

/** Rejects any delta whose sections do not exactly fill the buffer. */
export function parseDelta(data: ArrayBuffer, blocks: number): Delta {
  const view = new DataView(data);
  let offset = 0;
  const next = () => {
    if (offset + 4 > data.byteLength) throw new Error("autosave delta is truncated");
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const freed = Array.from({ length: next() }, next);
  const channels = next();
  const layout =
    channels === 0
      ? undefined
      : Array.from({ length: channels }, () => Array.from({ length: next() }, next));
  if (next() !== blocks) throw new Error("autosave delta record count does not match");
  const records = new Uint8Array(data, offset);
  const entries: RecordEntry[] = [];
  const consumed = scanRecords(records, (entry) => entries.push(entry));
  if (consumed !== records.byteLength || entries.length !== blocks)
    throw new Error("autosave delta records are malformed");
  return { freed, layout, records, entries };
}

/**
 * Visits each whole record at the start of `bytes` and returns the bytes they
 * span. A trailing partial record is left for the caller's next read.
 */
export function scanRecords(bytes: Uint8Array, visit: (entry: RecordEntry) => void): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + RECORD_HEADER_BYTES <= bytes.byteLength) {
    const id = view.getUint32(offset, true);
    const frames = view.getUint32(offset + 4, true);
    if (id === 0 || frames === 0 || frames > MAX_BLOCK_FRAMES)
      throw new Error("autosave record header is invalid");
    const size = RECORD_HEADER_BYTES + frames * 4;
    if (offset + size > bytes.byteLength) break;
    visit({ id, offset, bytes: size });
    offset += size;
  }
  return offset;
}

/** The recovery.finish input: u32 channels, then per channel u32 n and n IDs. */
export function encodeLayout(layout: number[][]): ArrayBuffer {
  const words = 1 + layout.reduce((sum, channel) => sum + 1 + channel.length, 0);
  const view = new DataView(new ArrayBuffer(words * 4));
  let offset = 0;
  const put = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  put(layout.length);
  for (const channel of layout) {
    put(channel.length);
    for (const id of channel) put(id);
  }
  return view.buffer;
}
