# Historical spectrogram playback evidence — 2026-10-04–05

Extracted on 2026-10-05 from
[the roadmap at `1095644`](https://github.com/cwbudde/algo-audio-editor/blob/1095644/PLAN.md#spectrogram-playback-gate).
These are separate reported local runs, not a single continuously passing gate.
Phase 5 was committed as
[`893c184`](https://github.com/cwbudde/algo-audio-editor/commit/893c184),
Phase 8 as [`fb0de8d`](https://github.com/cwbudde/algo-audio-editor/commit/fb0de8d),
and the later R.5 implementation/evidence as
[`4cdacb1`](https://github.com/cwbudde/algo-audio-editor/commit/4cdacb1) /
[`98b4431`](https://github.com/cwbudde/algo-audio-editor/commit/98b4431).

| Run | Reported result | Interpretation |
| --- | --- | --- |
| Phase 5, 2026-10-04 | 17.562 s, 1,209 painted columns, zero underruns | Isolated local pass |
| Phase 8, 2026-10-04 | 1,025 dropped samples | Isolated local failure |
| Unchanged `9cf7988` / algo-dsp v0.9.0 baseline | 6,914 dropped samples | Failure also observed before restoration changes |
| R.5, 2026-10-05 | 4,240.255 ms, 1,209 painted columns, zero underruns | Later local pass after bounded analysis scheduling |

The latest pass does not establish the cause of the historical pass/fail
variance. Phase 15 still requires discrepancy profiling and acceptance with
the original limits. No underrun or timing assertion was relaxed.

## Preserved run narratives

- [ ] Reconcile the initially passing Phase 5 measurement with the later Phase 8/baseline failures, profile the cause and rerun the original gate without relaxing timing or underrun limits.

  R.5 (2026-10-05) batches analysis under a 2 ms soft deadline. The unchanged serial production-browser gate now passes: 1,209 painted columns, partial progress, **4,240.255 ms**, live meters and **0 underruns**. The reproducible evidence is in [R.5 benchmarks](r5-2026-10-05.md); historical discrepancy profiling and broader performance acceptance remain open.

**Historical Phase 5 result:** Isolated production playback acceptance passes: the full **28,800,000-frame, ten-minute stereo** file progressively paints both channel spectrograms, observes **1209 painted columns**, and completes the measured tile-render window in **17.562 s** with live meters, advancing playback and **zero underruns** before/during/after. `spectrogram-playback.spec.ts` uses a temporary WAV path to retain the full fixture despite Playwright's 50 MB in-memory upload limit. The six existing timing gates also pass unchanged: five effect updates **40.227 / 42.228 / 44.832 / 38.453 / 47.553 ms**, and the cursor's 20 readings have maximum **7 frames** error, all with zero underruns. Timing uses the same muted Chromium output-clock estimate documented in Phase 4; meters deliberately show rendered output ahead of the device.

**Playback timing:** six of seven existing gates pass, including the isolated effects reruns (audible changes <50 ms, zero underruns). The ten-minute spectrogram gate reports underruns on this machine in both Phase 8 (1025 dropped samples on the isolated rerun) and an unchanged production build of `9cf7988` / `algo-dsp v0.9.0` (6914). This pre-existing gate remains unresolved; no timing threshold is relaxed.

## Gate and reproduction

`apps/editor-web/e2e/spectrogram-playback.spec.ts` imports an actual ten-minute,
48 kHz stereo WAV via a temporary path, avoiding Playwright's 50 MB in-memory
upload limit. It requires both channel canvases, partial progress, >128 painted
columns, completion within 120 s, advancing playback, visible live meters,
and zero underruns throughout and after rendering. Timing uses the muted
Chromium output-clock estimate; external DAC/speaker latency is unmeasured.
This hardware gate is opt-in and excluded from ordinary CI:

```sh
just e2e-timing
```

That recipe runs the functional prerequisites and then the serial hardware
suite. Run with other CPU-heavy jobs idle. [R.5's report](r5-2026-10-05.md)
retains scheduler limits and later evidence; its 2 ms deadline is soft, and
individual runtime/GC/copy units can exceed it.
