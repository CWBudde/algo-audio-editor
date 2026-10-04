import type {
  AnalysisJobResult,
  AnalysisSpectrumResult,
  DocumentInfoResult,
  SelectionRange,
} from "@aae/protocol";
import { useEffect, useId, useState } from "react";
import { analyse } from "@/kernel/analysis-queue";
import type { KernelClient } from "@/kernel/client";
import type { SpectralSettings } from "@/lib/analysis-settings";
import { AnalysisControls } from "./analysis-controls";

export function SpectrumPanel({
  client,
  info,
  selection,
  settings,
  onSettings,
  playing,
  paused,
  onClose,
  stateId,
}: {
  client: KernelClient;
  info: DocumentInfoResult;
  selection: SelectionRange;
  settings: SpectralSettings;
  onSettings(change: Partial<SpectralSettings>): void;
  playing: boolean;
  paused: boolean;
  onClose(): void;
  stateId?: string;
}) {
  const id = useId();
  const [source, setSource] = useState<"selection" | "playback">("selection");
  const [result, setResult] = useState<AnalysisJobResult | AnalysisSpectrumResult>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  useEffect(() => {
    // History identity invalidates same-length edits even when selection is unchanged.
    void stateId;
    setResult(undefined);
    setError(undefined);
    setWorking(false);
    if (paused || !info.frames) return;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setWorking(true);
      try {
        const next =
          source === "playback"
            ? await client.runSpectrum({ source: "playback", ...settings }, controller.signal)
            : await analyse(
                client,
                {
                  documentId: info.documentId,
                  start: selection.start,
                  end: selection.end,
                  channelMask: selection.channelMask,
                  kind: "spectrum",
                  ...settings,
                },
                controller.signal,
              );
        if (active) setResult(next);
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) {
          setWorking(false);
          if (source === "playback" && playing) timer = setTimeout(() => void read(), 150);
        }
      }
    };
    if (source === "selection" || playing) void read();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    client,
    info.documentId,
    info.frames,
    selection.start,
    selection.end,
    selection.channelMask,
    settings,
    source,
    playing,
    paused,
    stateId,
  ]);
  const paths: { channel: number; path: string }[] = [];
  if (result?.data && result.bins) {
    const values = new Float64Array(result.data);
    const count = Array.isArray(result.channels) ? result.channels.length : result.channels;
    for (let channel = 0; channel < count; channel++) {
      let path = "";
      for (let bin = 1; bin < result.bins; bin++) {
        const offset = (channel * result.bins + bin) * 2,
          hz = values[offset],
          db = values[offset + 1];
        if (hz <= 0 || !Number.isFinite(db)) continue;
        const x = (Math.log2(Math.max(20, hz) / 20) / Math.log2(result.sampleRate / 2 / 20)) * 600;
        const y = 160 - Math.max(0, Math.min(1, (db + 120) / 120)) * 160;
        path += `${path ? " L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
      }
      paths.push({
        channel: Array.isArray(result.channels) ? result.channels[channel] : channel,
        path,
      });
    }
  }
  return (
    <section aria-label="Spectrum analyzer" className="border-t p-3">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="mr-auto text-sm font-medium">Spectrum analyzer</h2>
        <div className="text-xs">
          <label htmlFor={`${id}-source`}>Source</label>
          <select
            id={`${id}-source`}
            value={source}
            onChange={(e) => setSource(e.target.value as "selection" | "playback")}
            className="ml-2 rounded border bg-background p-1"
          >
            <option value="selection">Selection / whole document at cursor</option>
            <option value="playback">Live output</option>
          </select>
        </div>
        <button type="button" onClick={onClose}>
          Close spectrum
        </button>
      </div>
      <AnalysisControls settings={settings} onChange={onSettings} disabled={paused} />
      {error && <p role="alert">{error}</p>}
      <p role="status" className="mt-1 text-xs">
        {paused
          ? "Paused while a dialog is open"
          : working
            ? "Analysing spectrum…"
            : source === "playback" && !playing
              ? "Play audio for live spectrum"
              : "Kernel-computed frequency spectrum (dBFS)"}
      </p>
      {result && (
        <p className="mt-1 text-xs">
          Channels:{" "}
          {Array.isArray(result.channels)
            ? result.channels.map((channel) => channel + 1).join(", ")
            : Array.from({ length: result.channels }, (_, channel) => channel + 1).join(", ")}
        </p>
      )}
      <svg
        role="img"
        aria-label="Frequency spectrum"
        viewBox="0 0 600 180"
        className="mt-2 h-40 w-full rounded border"
      >
        <text x="5" y="12" fontSize="10" fill="currentColor">
          0 dBFS
        </text>
        <text x="5" y="157" fontSize="10" fill="currentColor">
          −120 dBFS
        </text>
        <text x="5" y="175" fontSize="10" fill="currentColor">
          20 Hz
        </text>
        <text x="555" y="175" fontSize="10" fill="currentColor">
          {(result?.sampleRate ?? info.sampleRate) / 2} Hz
        </text>
        {paths.map(({ path, channel }) => (
          <path
            key={channel}
            data-testid="spectrum-path"
            d={path}
            fill="none"
            stroke={channel % 2 ? "#f59e0b" : "#22c55e"}
            strokeWidth="1.5"
          />
        ))}
      </svg>
    </section>
  );
}
