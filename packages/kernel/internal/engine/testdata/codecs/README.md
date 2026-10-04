# Codec fixtures

Generated test signal (4097 frames, stereo, 44100 Hz, signed 16-bit): channel c uses round(20000 * sin((frame + 8*c) * 2*pi*440/44100)). The generated audio is dedicated to the public domain (CC0); no third-party audio is included.

Fixtures were encoded independently with FFmpeg 6.1.1-3ubuntu5:

```sh
ffmpeg -i tone.wav -c:a flac tone.flac
ffmpeg -i tone.wav -c:a pcm_s16be tone.aiff
ffmpeg -i tone.wav -c:a pcm_s16le -f aiff tone.aifc
ffmpeg -i tone.wav -c:a libmp3lame tone.mp3
ffmpeg -i tone.wav -c:a libvorbis tone.ogg
ffmpeg -i tone.wav -c:a libopus tone.opus
ffmpeg -i tone.wav -c:a aac tone.m4a
ffmpeg -i tone.m4a -map 0:a:0 -c:a copy -f adts tone.aac
ffmpeg -i tone.wav -ar 96000 -c:a aac tone-96k.m4a
```

FLAC/AIFF/AIFC sowt must import with exactly the WAV samples; MP3 and browser codecs are lossy. MP3 import trims Xing/LAME delay and padding; the stereo and mono fixtures must retain exactly the original frame count. Tests do not require identity with the uncompressed source.

`tone.aac` contains the same AAC packets as `tone.m4a` in ADTS framing. The lossy-export browser regression substitutes these packets only at the AudioEncoder boundary when validating M4A muxing on Linux, where AAC encoding is unavailable; it compares the actual browser-decoded M4A with independently framed ADTS. This does not claim native AAC encoder acceptance on Linux.

R.3 mono fixtures and independently trimmed MP3 reference PCM (FFmpeg 6.1.1):

```sh
ffmpeg -i tone.wav -ac 1 -c:a libmp3lame tone-mono.mp3
ffmpeg -i tone.wav -ac 1 -ar 22050 -c:a libmp3lame tone-mono-22k.mp3
ffmpeg -i tone.wav -ac 1 -c:a libmp3lame -q:a 2 tone-mono-vbr.mp3
lame --silent -p tone.wav tone-crc.mp3
ffmpeg -i tone.mp3 -f s16le tone-mp3.s16le
ffmpeg -i tone-mono.mp3 -f s16le tone-mono-mp3.s16le
```

The PCM reference checks sample alignment and decoder rounding (within two PCM16
codes), including both endpoints. The 22.05 kHz mono fixture exercises MPEG-2.
The generated signal and all these derived fixtures retain the CC0 dedication.

`tone-mono-long.mp3` encodes 129701 mono frames at 44100 Hz with the same
440 Hz CC0 signal formula. Its reference PCM probes were decoded by FFmpeg
and embedded in `TestMP3GaplessTrimAcrossStorageBlocks`; they cover the lead-in,
64 Ki-frame storage seams and tail padding that crosses two decoded blocks.
