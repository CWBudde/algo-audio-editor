# Audio codecs

Phase 6.1 and Phase 6.2 are implemented with the platform and format limits below. All file bytes and PCM cross the worker/kernel boundary as transferred ArrayBuffers. Decoding and encoding for the portable formats run in Go; browser fallback decodes into the kernel, and WebCodecs encodes bounded PCM copies returned by the kernel.

| Format | Import | Export | Notes |
| --- | --- | --- | --- |
| WAV | Go, cwbudde/wav v0.1.3 | Go | Existing integer 8/16/24/32 and float 32/64 support; WAV timeline annotations retained. |
| FLAC | Go, cwbudde/flac v0.1.0 | Go, integer 8/16/24 | Input may use 4–32 bits; the editor stores float32, so full 32-bit integer precision is not retained. Export rejects empty documents. |
| AIFF/AIFC | Go, cwbudde/aiff v0.1.0 | Go, AIFF integer 8/16/24/32 | Signed PCM AIFF; uncompressed AIFC NONE/twos/sowt. Compressed/floating AIFC is rejected. |
| MP3 | Go, hajimehoshi/go-mp3 v0.3.4 | Pending | MPEG Layer III, decoded 16-bit stereo; mono input is duplicated by the decoder. Encoder delay/padding is retained. The upstream decoder can treat truncated final frames as EOF. |
| Ogg Vorbis / Ogg Opus | Browser decodeAudioData | WebCodecs Opus, mono/stereo at 48 kHz | Availability and decoded padding depend on the browser (Chromium returns 128 fewer frames for the short Vorbis fixture). Vorbis keeps its header rate; Opus decodes at 48 kHz. |
| M4A/AAC | Browser decodeAudioData | WebCodecs AAC-LC in M4A where available | ISO BMFF AAC DecoderSpecificInfo (including a 96 kHz regression), ALAC sample entries and ADTS AAC headers supply the context rate. Codec availability depends on the browser/OS. |

Format routing uses magic bytes, including a validated leading ID3 tag, not filename extensions. Known Go containers never retry through browser decoding after a structural failure. Browser codecs decode using an OfflineAudioContext at the container rate; this avoids decodeAudioData's default resampling. The fallback recognizes the supported container headers; other containers fail with a visible error. It does not provide a general demuxer.

The float32 document model retains exact integer PCM through 24 bits; 32-bit integer imports may lose low bits. FLAC imports verify frame CRCs, declared length and a nonzero STREAMINFO decoded MD5.

Imports stage complete immutable blocks and history before replacing the current document. Failed imports keep the old document and history. Native file capabilities remain scoped to the selected path and renderer, and successful imports alone acknowledge OS recents. Encoded input has a 1 GiB UI/desktop limit. Additional Go codec imports and browser PCM transfer have a 512 MiB decoded sample budget; the browser decoder itself owns its temporary allocations. Paging and long-file work remain Phase 10.

Save defaults to the detected FLAC/AIFF source container, otherwise WAV. Lossy inputs are saved as new WAV files. Export offers a whole document or selection/channel subset, bit depth and the existing kernel dither/noise shaping. FLAC is limited to 24-bit export while the encoder and float32 storage are evaluated for 32-bit output. General tags/pictures/unknown chunks are not mapped yet. FLAC/AIFF export rejects any included markers or regions rather than dropping them; use WAV to retain annotations. Export keeps the source save point; Save acknowledges it only after a successful destination write. Audio Save is not an editor project format.

## Upstream decisions

The archived [go-audio/aiff](https://github.com/go-audio/aiff) has an unsigned 8-bit decode path and permissive chunk traversal; mfw had format-specific workarounds. [cwbudde/aiff](https://github.com/cwbudde/aiff) preserves that project's history, Apache-2.0 license and legacy API, and adds bounded signed PCMReader/PCMWriter APIs, structural validation, SSND offsets/alignment and exact frame counts. Native, 386, WASM, independent-container and malformed-input/fuzz tests accompany v0.1.0.

[mewkiz/flac v1.0.14](https://github.com/mewkiz/flac) remains a usable decoder but its encoder recorded a short final block as the STREAMINFO minimum, producing files rejected by its own decoder. [cwbudde/flac](https://github.com/cwbudde/flac) preserves its history and Unlicense, fixes minimum/maximum bounds according to [RFC 9639 section 8.2](https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2), and replaces diagnostic-only untagged dependencies with standard errors. The editor consumes official fork v0.1.0. The Unlicense requires a decision in the pre-release license audit because the current roadmap's bundled-code allowlist names MIT/BSD/Apache.

The archived MP3 decoder is sufficient for the initial import path; no MP3 fork or encoder repository was created. Its limitations above are retained explicitly. `mfw/pkg/file` informed the adapters without importing its filesystem/application abstraction into the WASM kernel. No codec algorithms were copied into the editor and no local module replacements or pseudo-versions are used.

## Validation

`testdata/codecs` contains independently encoded FFmpeg fixtures derived from a generated CC0 test signal. Go tests check FLAC/AIFF equality with the WAV PCM, 8/16/24-bit signed edge samples, mono/stereo/six-channel export, a one-sample final FLAC block, import atomicity, malformed input, decoded-length limits and browser PCM replacement. `just fuzz-codecs` exercises the additional Go importers. Native and actual V8/WASM tests use the same tagged dependencies.

Frontend tests verify magic/ID3 routing, original rates, binary planar ownership, failed/stale browser imports, output extensions and FLAC format limits. `codecs.spec.ts` imports FLAC/AIFF/MP3/Vorbis/Opus/AAC through the production UI and exports/reopens lossless copies. Desktop tests cover the actual launch/open/save path and existing capability/dirty-close guards.

Metadata editing, project files, autosave and application-owned recent-file persistence remain unfinished Phase 6 work.

## Lossy export

Export offers Ogg Opus and M4A AAC-LC, with 64, 96, 128, 192 and 256 kbps choices. Both are mono/stereo only, with browser/OS availability checked for the actual sample rate, channel count and bitrate. A selected channel subset is packed in ascending physical order. Unavailable choices are disabled and rechecked when range or bitrate changes. Lossy export makes a copy; it does not acknowledge a save or modify source audio, selection, metadata or history. Markers/regions are omitted with an explanation in the dialog. Save continues to use a lossless container.

Opus export requires a 48 kHz document. Use **Process → Resample…** in the Go kernel for other input rates. Raw WebCodecs packets at 48 kHz carry the encoder's OpusHead; our narrow single-stream Ogg writer preserves pre-skip, writes CRCs and trims the last granule to the exact source duration, including a one-frame document. It supports mapping family 0 (mono/stereo), zero header gain and packets that fit one page. Chromium rejects the optional WebCodecs `ogg` format; its raw low-rate Opus header also writes native-rate `OPUS_GET_LOOKAHEAD` directly into pre-skip. The 16 kHz acceptance experiment produced shifted audio despite a correct frame count, so that rate is not advertised. See [Chromium's encoder source](https://github.com/chromium/chromium/blob/main/media/audio/audio_opus_encoder.cc) and the required [48 kHz granule/pre-skip clock](https://www.rfc-editor.org/rfc/rfc7845.html#section-4.2).

M4A uses raw AAC-LC packets plus the encoder's AudioSpecificConfig, muxed by exact dependency `mp4-muxer 5.2.2` (MIT), loaded only for AAC export. This upstream is archived/deprecated in favor of Mediabunny; its successor uses MPL-2.0, outside the current roadmap's bundled-code allowlist. The pinned muxer is an explicit maintenance limitation, covered by independent AAC container/decoder regressions. No source is vendored. AAC delay/padding is retained rather than claiming gapless/sample-exact duration. Native AAC encoder availability/quality on supported Windows/macOS browsers remains to be verified; Linux Chromium and Electron have no AAC encoder and show the format as unavailable. [WebCodecs](https://www.w3.org/TR/webcodecs/) does not require any particular codec.

`doc.readPCM` (ABI 17) returns at most 8192 frames as planar little-endian float32, checks document/history identity, validates channel/range bounds and rejects nonfinite selected samples. It copies the stored source without effects or resampling. The frontend transfers each page into AudioData, closes it after encode, limits outstanding encoder requests, times out stalled encoding and closes the encoder on cancellation/error. It checks the history again before returning a file. Encoded output has a 128 MiB budget and is assembled in memory; export is not a Phase 10 streaming large-file implementation. Cancellation discards the copy before writing; destination writes retain the existing fenced, atomic desktop flow.

Validation includes native/WASM PCM pages across block boundaries and sparse channels, exact signed-zero bits, invalid ranges, stale history and nonfinite rejection; unit tests for capability races, binary ownership, cancellation, callback failures and budgets; actual browser Opus duration/quality/reimport checks; and native Opus disk output. M4A's independently named Linux regression replaces only AudioEncoder with the FFmpeg fixture packets, then compares real browser-decoded output against ADTS. It establishes muxing correctness, not a working Linux AAC encoder.
