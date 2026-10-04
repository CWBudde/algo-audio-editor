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
ffmpeg -i tone.wav -ar 96000 -c:a aac tone-96k.m4a
```

FLAC/AIFF/AIFC sowt must import with exactly the WAV samples; MP3 and browser codecs are lossy and may include encoder delay/padding. Tests do not require lossy sample identity.
