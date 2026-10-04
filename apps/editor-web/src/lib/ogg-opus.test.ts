import { expect, it } from "vitest";
import { OggOpusMuxer } from "./ogg-opus";

function opusHead(channels = 2, skip = 312) {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  const view = new DataView(head.buffer);
  view.setUint16(10, skip, true);
  view.setUint32(12, 48000, true);
  return head;
}
function pages(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const result = [];
  for (let offset = 0; offset < bytes.length; ) {
    const segments = bytes[offset + 26];
    const laces = bytes.slice(offset + 27, offset + 27 + segments);
    const length = 27 + segments + laces.reduce((a, b) => a + b, 0);
    const page = bytes.slice(offset, offset + length),
      view = new DataView(page.buffer);
    expect(new TextDecoder().decode(page.subarray(0, 4))).toBe("OggS");
    const checksum = view.getUint32(22, true);
    view.setUint32(22, 0, true);
    // Independent bit-by-bit polynomial division, rather than the writer's signed shifts.
    let crc = 0;
    for (const byte of page) {
      crc = (crc ^ (byte * 2 ** 24)) >>> 0;
      for (let i = 0; i < 8; i++) crc = ((crc * 2) ^ (crc >= 2 ** 31 ? 0x04c11db7 : 0)) >>> 0;
    }
    expect(checksum).toBe(crc);
    result.push({
      flags: page[5],
      granule: Number(view.getBigUint64(6, true)),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      laces,
      packet: page.slice(27 + segments),
    });
    offset += length;
  }
  return result;
}
it("writes CRCs, header pages, exact 255-byte lacing and a trimmed final granule", () => {
  const muxer = new OggOpusMuxer(2, 123);
  muxer.add(new Uint8Array(255).fill(3), 20000, opusHead());
  muxer.add(new Uint8Array([4]), 20000);
  const result = pages(muxer.finish(1000, 48000));
  expect(result.map((p) => p.sequence)).toEqual([0, 1, 2, 3]);
  expect(result.every((p) => p.serial === 123)).toBe(true);
  expect(result.map((p) => p.flags)).toEqual([2, 0, 0, 4]);
  expect(result.map((p) => p.granule)).toEqual([0, 0, 960, 1312]);
  expect(Array.from(result[2].laces)).toEqual([255, 0]);
  expect(result[2].packet).toEqual(new Uint8Array(255).fill(3));
});
it("keeps low-rate input duration in the mandatory 48 kHz granule clock", () => {
  const muxer = new OggOpusMuxer(1, 1);
  muxer.add(new Uint8Array([1]), 20000, opusHead(1));
  expect(pages(muxer.finish(100, 16000)).at(-1)?.granule).toBe(612);
});
it("rejects missing/unsupported headers, invalid packets and incomplete encoder output", () => {
  expect(() => new OggOpusMuxer(2, 1).add(new Uint8Array([1]), 20000)).toThrow(/header/);
  const header = opusHead();
  header[18] = 1;
  expect(() => new OggOpusMuxer(2, 1).add(new Uint8Array([1]), 20000, header)).toThrow(/header/);
  const muxer = new OggOpusMuxer(2, 1);
  expect(() => muxer.add(new Uint8Array([1]), 0, opusHead())).toThrow(/duration/);
  muxer.add(new Uint8Array([1]), 20000);
  expect(() => muxer.finish(960, 48000)).toThrow(/incomplete/);
  const oversized = new OggOpusMuxer(2, 1);
  oversized.add(new Uint8Array(65025), 20000, opusHead());
  expect(() => oversized.finish(1, 48000)).toThrow(/page limit/);
});
