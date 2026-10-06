import type {
  AnalysisJobResult,
  AnalysisSpectrumResult,
  DocumentInfoResult,
  SelectionRange,
} from "@aae/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { analyse } from "@/kernel/analysis-queue";
import type { KernelClient } from "@/kernel/client";
import type { SpectralSettings } from "@/lib/analysis-settings";
import { AnalysisControls } from "./analysis-controls";

const PLOT = { left: 44, top: 12, bottom: 158 };
const FREQUENCY_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const CHANNEL_COLORS = ["text-primary", "text-waveform-peak", "text-playhead", "text-foreground"];
function channelStyle(channel: number) {
  return {
    color: CHANNEL_COLORS[channel % CHANNEL_COLORS.length],
    dash: channel < 4 ? undefined : "5 3",
  };
}
function frequencyLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

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
  const plot = useRef<SVGSVGElement>(null);
  const [plotWidth, setPlotWidth] = useState(640);
  const [source, setSource] = useState<"selection" | "playback">("selection");
  const [result, setResult] = useState<AnalysisJobResult | AnalysisSpectrumResult>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  useLayoutEffect(() => {
    const element = plot.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth || element.getBoundingClientRect().width;
      if (Number.isFinite(width) && width > 0) setPlotWidth(Math.max(480, width));
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
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
  const maximumHz = (result?.sampleRate ?? info.sampleRate) / 2;
  const plotRight = plotWidth - 18;
  const frequencyX = (hz: number) =>
    PLOT.left +
    (Math.log2(Math.max(20, hz) / 20) / Math.log2(maximumHz / 20)) * (plotRight - PLOT.left);
  const levelY = (db: number) =>
    PLOT.bottom - Math.max(0, Math.min(1, (db + 120) / 120)) * (PLOT.bottom - PLOT.top);
  const frequencyTicks = [
    ...FREQUENCY_TICKS.filter(
      (hz) => hz < maximumHz && (hz === 20 || plotRight - frequencyX(hz) > 42),
    ),
    maximumHz,
  ];
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
        if (hz <= 0 || !Number.isFinite(hz) || !Number.isFinite(db)) continue;
        const x = frequencyX(hz);
        const y = levelY(db);
        path += `${path ? " L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
      }
      paths.push({
        channel: Array.isArray(result.channels) ? result.channels[channel] : channel,
        path,
      });
    }
  }
  return (
    <section
      aria-label="Spectrum analyzer"
      className="analysis-panel min-h-0 min-w-0 overflow-auto bg-card p-3"
    >
      <div className="analysis-panel-header mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xs font-semibold">Spectrum analyzer</h2>
        <div className="min-w-0 text-[11px]">
          <label className="text-muted-foreground" htmlFor={`${id}-source`}>
            Source
          </label>
          <select
            id={`${id}-source`}
            value={source}
            onChange={(e) => setSource(e.target.value as "selection" | "playback")}
            className="studio-field ml-2 h-7 max-w-full border px-2 py-1"
          >
            <option value="selection">Selection / whole document at cursor</option>
            <option value="playback">Live output</option>
          </select>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="studio-button h-7 border px-2 py-1 text-[11px]"
        >
          Close spectrum
        </button>
      </div>
      <AnalysisControls settings={settings} onChange={onSettings} disabled={paused} />
      {error && <p role="alert">{error}</p>}
      <p role="status" className="mt-2 text-[10px] text-muted-foreground">
        {paused
          ? "Paused while a dialog is open"
          : working
            ? "Analysing spectrum…"
            : source === "playback" && !playing
              ? "Play audio for live spectrum"
              : "Kernel-computed frequency spectrum (dBFS)"}
      </p>
      {result && (
        <ul
          aria-label="Spectrum channels"
          className="analysis-channel-legend mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px]"
        >
          {paths.map(({ channel }) => {
            const style = channelStyle(channel);
            return (
              <li key={channel} className="flex items-center gap-1.5">
                <svg aria-hidden="true" viewBox="0 0 20 6" className={`h-1.5 w-5 ${style.color}`}>
                  <line
                    x1="0"
                    y1="3"
                    x2="20"
                    y2="3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={style.dash}
                  />
                </svg>
                Channel {channel + 1}
              </li>
            );
          })}
        </ul>
      )}
      <svg
        ref={plot}
        role="img"
        aria-label="Frequency spectrum"
        viewBox={`0 0 ${plotWidth} 192`}
        className="analysis-spectrum-plot effect-graph mt-2 h-48 min-w-[30rem] w-full border text-muted-foreground"
      >
        <defs>
          <clipPath id={`${id}-plot`}>
            <rect
              x={PLOT.left}
              y={PLOT.top}
              width={plotRight - PLOT.left}
              height={PLOT.bottom - PLOT.top}
            />
          </clipPath>
        </defs>
        {[0, -30, -60, -90, -120].map((db) => (
          <g key={db}>
            <line
              x1={PLOT.left}
              y1={levelY(db)}
              x2={plotRight}
              y2={levelY(db)}
              stroke="currentColor"
              className={db === -120 ? "text-waveform-center" : "text-waveform-grid"}
            />
            <text
              x={PLOT.left - 7}
              y={levelY(db) + 3}
              textAnchor="end"
              fontSize="11"
              fill="currentColor"
            >
              {db === 0 ? "0" : `−${-db}`}
            </text>
          </g>
        ))}
        {frequencyTicks.map((hz, index) => (
          <g key={hz}>
            <line
              x1={frequencyX(hz)}
              y1={PLOT.top}
              x2={frequencyX(hz)}
              y2={PLOT.bottom}
              stroke="currentColor"
              className="text-waveform-grid"
            />
            <text
              x={frequencyX(hz)}
              y="173"
              textAnchor={
                index === 0 ? "start" : index === frequencyTicks.length - 1 ? "end" : "middle"
              }
              fontSize="11"
              fill="currentColor"
            >
              {frequencyLabel(hz)}
            </text>
          </g>
        ))}
        <text x="4" y="10" fontSize="10" fill="currentColor">
          dBFS
        </text>
        <text x={plotRight} y="187" textAnchor="end" fontSize="10" fill="currentColor">
          Hz
        </text>
        {paths.map(({ path, channel }) => (
          <path
            key={channel}
            data-testid="spectrum-path"
            d={path}
            fill="none"
            stroke="currentColor"
            className={channelStyle(channel).color}
            strokeDasharray={channelStyle(channel).dash}
            strokeWidth="1.5"
            clipPath={`url(#${id}-plot)`}
          />
        ))}
      </svg>
    </section>
  );
}
