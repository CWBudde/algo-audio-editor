# Audio codecs

Phase 6.1 and the lossless portion of Phase 6.2 are implemented. All file bytes and PCM cross the worker/kernel boundary as transferred ArrayBuffers. Decoding and encoding for the portable formats run in Go; browser fallback only decodes and copies planar samples into the kernel.

| Format | Import | Export | Notes |
| --- | --- | --- | --- |
| WAV | Go, cwbudde/wav v0.1.3 | Go | Existing integer 8/16/24/32 and float 32/64 support; WAV timeline annotations retained. |
| FLAC | Go, cwbudde/flac v0.1.0 | Go, integer 8/16/24 | Input may use 4–32 bits; the editor stores float32, so full 32-bit integer precision is not retained. Export rejects empty documents. |
| AIFF/AIFC | Go, cwbudde/aiff v0.1.0 | Go, AIFF integer 8/16/24/32 | Signed PCM AIFF; uncompressed AIFC NONE/twos/sowt. Compressed/floating AIFC is rejected. |
| MP3 | Go, hajimehoshi/go-mp3 v0.3.4 | Pending | MPEG Layer III, decoded 16-bit stereo; mono input is duplicated by the decoder. Encoder delay/padding is retained. The upstream decoder can treat truncated final frames as EOF. |
| Ogg Vorbis / Ogg Opus | Browser decodeAudioData | Pending | Availability and decoded padding depend on the browser (Chromium returns 128 fewer frames for the short Vorbis fixture). Vorbis keeps its header rate; Opus decodes at 48 kHz. |
| M4A/AAC | Browser decodeAudioData | Pending | ISO BMFF AAC DecoderSpecificInfo (including a 96 kHz regression), ALAC sample entries and ADTS AAC headers supply the context rate. Codec availability depends on the browser/OS. |

Format routing uses magic bytes, including a validated leading ID3 tag, not filename extensions. Known Go containers never retry through browser decoding after a structural failure. Browser codecs decode using an OfflineAudioContext at the container rate; this avoids decodeAudioData's default resampling. The fallback recognizes the supported container headers; other containers fail with a visible error. It does not provide a general demuxer or WebCodecs export.

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

Metadata editing, lossy encoding/muxing, project files, autosave and application-owned recent-file persistence remain unfinished Phase 6 work.
