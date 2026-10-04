# Restoration and advanced editing

All processing runs in the Go kernel, using the official `algo-dsp v0.10.0`
release. Every operation uses the existing private preview, cancellation and
single-edit Apply workflow. Undo restores the original samples and annotations.

## Spectral editing

Choose View → Spectrogram or Split waveform / spectrogram, then select Rectangle
or Lasso in the **Spectrogram selection** control. Drag within a channel to select
time and frequency. Escape or **Clear spectral selection** clears it. The selection
also has Restore menu and command-palette actions:

- **Attenuate** lowers selected spectral content by the entered dB amount.
- **Remove** suppresses selected spectral bins.
- **Heal** interpolates short damage using intact audio on both sides, then
  reconstructs the selected frequency content through inverse STFT.

Rectangle dialogs allow exact lower/upper frequency bounds, including 0 Hz and
Nyquist for full-band click repair. Lasso preserves its polygon. Frequency/time
resolution follows the selected FFT size. Healing supports gaps up to 256 samples
and needs at least two intact samples on either side; zoom into the damage before
drawing. Longer or edge gaps cannot use Heal. Shapes are channel-specific and
are discarded when the document changes. Drawing never changes audio itself.

## Noise reduction

1. Select representative noise-only audio, usually 0.5–2 seconds, including every
   channel to be processed. At least 1024 samples are needed for the default FFT.
2. Choose **Restore → Capture noise profile**.
3. Select the target audio, or leave a cursor to process the whole document.
4. Choose **Restore → Noise reduction**, preview, then Apply.

The profile retains the source identity and range; mean spectral powers are
captured in a bounded analysis phase before target processing. The default is
Wiener filtering with maximum reduction 24 dB and smoothed gains. Spectral
subtraction and a spectral gate are also available. Capture again after an edit,
undo/redo, document import or kernel replacement; stale profiles cannot be used.

## Clicks, clips, hum and duration

**Restore → Remove clicks and pops** detects short local outliers and interpolates
them. Sensitivity defaults to 8; maximum repair length defaults to 64 samples
and is limited to 256. Intentional transients can resemble damage, so preview the
result. **Repair clipped audio** interpolates bounded interior saturation runs at
the entered linear clipping threshold. Long runs and runs without intact context
stay unchanged. Repair can recover peaks above the current clipping level.

**Remove mains hum** uses a notch comb at 50 or 60 Hz. Defaults are eight harmonics
and Q 30; both are configurable. **Process → Time stretch** changes duration while
retaining pitch. A multiplier of 1.25 makes the selected audio 25% longer. All
channels move together with shared WSOLA alignment. Markers and regions inside
the selection scale with its duration; later anchors shift by the duration change.
Ratio 1 is an exact no-op. The supported ratio is 0.25–4.

## Validation and limits

Native and actual V8/WASM tests cover all operations, private candidates,
cancellation, source/selection guards, untouched channels, exact undo, bounded
storage and annotation timing. Production Chromium and Electron tests exercise
drawing, dialogs, preview, focus and actual exported samples.

On the deterministic reference fixture, default noise reduction measures
**22.65 dB** after float32 storage, exceeding the ≥15 dB requirement. Upstream
fixtures also bound residual 50 ms power variation and isolated spectral peaks as
musical-noise proxies, and check wanted-tone retention. Spectral healing of the
reference click has RMS residual below **−80 dBFS**. These are reproducible
numerical checks. Perceptual inaudibility and musical-noise acceptance still need
listening review; the tests do not claim transparency on arbitrary material.

Algorithm lineage, intentional changes from the legacy Delphi FFT effects and
public API documentation are in the [upstream restoration notes](../../algo-dsp/docs/restoration.md).
