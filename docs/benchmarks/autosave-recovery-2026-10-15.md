# Autosave and crash recovery, 2026-10-15

Phase 18's acceptance: after a killed tab or Electron process, edits older than 5 s survive, and
recovering a one-hour stereo document takes ≤10 s. This records the local evidence for the first
implementation (`feat/phase-18-autosave`, kernel ABI 21).

**Setup:** Apple M5 Pro (arm64), 48 GiB, macOS 27.0.1, Playwright 1.63.0 with its bundled
Chromium headless shell (build 1243), Bun 1.4.2, production build served by `vite preview`.

## One-hour recovery

`just test-autosave-hour FIXTURE` on the fixture from `just flac-hour-fixture` (48 kHz stereo,
172,800,000 frames per channel). The fixture decodes to 4,096-frame FLAC blocks, about 84,400 of
them, the worst case for the number of autosave records. The spec opens the file in a persistent
profile, mutes 4,800 frames through the UI, waits for the status bar's autosave of that edit, kills
the browser with `Browser.crash`, starts it again on the same profile and clicks Recover.

| Run | Open to painted | Open to autosaved | Edit to autosaved | Recover to document | Recover to painted |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 15.0 s | 18.4 s | 3.0 s | 2.93 s | 2.94 s |
| 2 | 15.5 s | 18.7 s | 2.8 s | 2.88 s | 2.89 s |
| 3 | 15.0 s | 17.6 s | 2.3 s | 2.91 s | 2.92 s |

Median recovery, until both channels and the overview are painted: **2.92 s** (gate: ≤10 s). The
prefill of about 1.4 GB runs while the file is still being drawn and finishes about 3 s after the
document is painted; the edit made right after opening was on disk 2.3–3.0 s later, including the
rest of that prefill.

## Kill and recover

`e2e/autosave.spec.ts` (browser) and `apps/desktop/e2e/autosave.spec.ts` (Electron) edit the
8-frame stereo fixture, add a marker, wait 5 s and kill the process without unload handlers:

- `Browser.crash` on a persistent Chromium profile: the relaunched editor offers the session and
  recovers samples (`doc.readPCM`), the marker and the unsaved state exactly. After an edit to the
  recovered document, a second crash recovers the newer state from the adopted session.
- `Page.crash` of one tab: the next tab in the same browser recovers it.
- SIGKILL of the Electron main process: the relaunch on the same `userData` recovers it, and the
  window title marks unsaved changes.
- Not offered: the session of a window that is still open, a clean document, and a tab closed
  normally. Discard needs a second confirmation.

Browser suite 5/5, 15/15 with `--repeat-each 3`; Electron 1/1.

## Limits

Measured on one laptop with a synthetic, highly compressible FLAC; the open time is dominated by
FLAC decoding and painting, not by autosave. The Phase 16 reference laptop is not recorded yet.
Hosted CI runs the functional suites, not the one-hour timing. Installed Windows and macOS builds,
other browsers and nearly full disks were not tested.
