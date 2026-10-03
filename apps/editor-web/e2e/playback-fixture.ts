/** Deliberately distinct PCM channels, created only as a test fixture. */
export function playbackWAV(frames = 144000, sampleRate = 48000, channels = 2): Buffer {
  const wav = Buffer.alloc(44 + frames * channels * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      wav.writeInt16LE(channel % 2 === 0 ? 16384 : -8192, 44 + (frame * channels + channel) * 2);
    }
  }
  return wav;
}
