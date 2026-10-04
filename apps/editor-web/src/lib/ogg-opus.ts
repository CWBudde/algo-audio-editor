/** Minimal single-stream Ogg framing (RFC 3533 / RFC 7845), no audio processing. */
export const MAX_LOSSY_BYTES = 128 * 1024 * 1024;

export class OggOpusMuxer {
  private pages: Uint8Array<ArrayBuffer>[] = [];
  private sequence = 0;
  private bytes = 0;
  private granule = 0;
  private preSkip = 0;
  private pending?: Uint8Array<ArrayBuffer>;
  private started = false;

  private channels: number;
  private serial: number;
  private pendingFrames = 0;

  constructor(channels: number, serial: number) {
    this.channels = channels;
    this.serial = serial;
  }

  add(packet: Uint8Array<ArrayBuffer>, duration: number, description?: Uint8Array) {
    if (!this.started) {
      if (
        description?.length !== 19 ||
        new TextDecoder().decode(description.subarray(0, 8)) !== "OpusHead" ||
        description[8] !== 1 ||
        description[9] !== this.channels ||
        description[18] !== 0 ||
        description[16] !== 0 ||
        description[17] !== 0
      )
        throw new Error("The Opus encoder did not provide a supported mono/stereo header.");
      this.preSkip = new DataView(description.buffer, description.byteOffset).getUint16(10, true);
      this.page(description, 0, 2);
      const vendor = new TextEncoder().encode("algo-audio-editor");
      const tags = new Uint8Array(16 + vendor.length);
      tags.set(new TextEncoder().encode("OpusTags"));
      new DataView(tags.buffer).setUint32(8, vendor.length, true);
      tags.set(vendor, 12);
      this.page(tags, 0, 0);
      this.started = true;
    }
    const frames = Math.round((duration * 48000) / 1_000_000);
    if (!Number.isSafeInteger(frames) || frames < 120 || frames > 5760 || frames % 120)
      throw new Error("Invalid Opus packet duration.");
    if (this.pending) this.page(this.pending, this.granule, 0);
    this.granule += frames;
    this.pending = packet;
    this.pendingFrames = frames;
  }

  finish(frames: number, sampleRate: number): ArrayBuffer {
    const end = this.preSkip + Math.round((frames * 48000) / sampleRate);
    if (!this.pending || end > this.granule || end < this.granule - this.pendingFrames)
      throw new Error("The Opus encoder returned incomplete audio.");
    this.page(this.pending, end, 4);
    this.pending = undefined;
    const output = new Uint8Array(this.bytes);
    let offset = 0;
    for (const page of this.pages) {
      output.set(page, offset);
      offset += page.length;
    }
    this.pages = [];
    return output.buffer;
  }

  private page(packet: Uint8Array, granule: number, flags: number) {
    // A zero-length terminal lace is required for multiples of 255.
    const segments = Math.floor(packet.length / 255) + 1;
    if (segments > 255) throw new Error("Opus packet exceeds the Ogg page limit.");
    const size = 27 + segments + packet.length;
    if (this.bytes + size > MAX_LOSSY_BYTES)
      throw new Error("Lossy export exceeds the 128 MiB limit.");
    const page = new Uint8Array(size);
    page.set(new TextEncoder().encode("OggS"));
    page[5] = flags;
    const view = new DataView(page.buffer);
    view.setBigUint64(6, BigInt(granule), true);
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.sequence++, true);
    page[26] = segments;
    page.fill(255, 27, 27 + segments - 1);
    page[27 + segments - 1] = packet.length % 255;
    page.set(packet, 27 + segments);
    let crc = 0;
    for (const byte of page) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
    }
    view.setUint32(22, crc >>> 0, true);
    this.pages.push(page);
    this.bytes += size;
  }
}
