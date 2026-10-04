import type { AnalysisJobResult, DocumentInfoResult } from "@aae/protocol";
import { type CanvasHTMLAttributes, useEffect, useRef, useState } from "react";
import { analyse } from "@/kernel/analysis-queue";
import type { KernelClient } from "@/kernel/client";
import type { SpectralSettings } from "@/lib/analysis-settings";

const TILE_WIDTH = 128;
const CACHE_BYTES = 8 * 1024 * 1024;
const caches = new WeakMap<KernelClient, Map<string, AnalysisJobResult>>();
function tileCache(client: KernelClient) {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  return cache;
}
function storeTile(cache: Map<string, AnalysisJobResult>, key: string, tile: AnalysisJobResult) {
  cache.delete(key);
  cache.set(key, tile);
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.data?.byteLength ?? 0;
  while (bytes > CACHE_BYTES || cache.size > 128) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    bytes -= cache.get(oldest)?.data?.byteLength ?? 0;
    cache.delete(oldest);
  }
}

export function SpectrogramCanvas({
  client,
  info,
  channel,
  viewport,
  width,
  height,
  settings,
  paused,
  colorMap = "inferno",
  minDB = -100,
  maxDB = 0,
  stateId,
  ...events
}: {
  client?: KernelClient;
  info: DocumentInfoResult;
  channel: number;
  viewport: { start: number; end: number };
  width: number;
  height: number;
  settings: SpectralSettings;
  paused: boolean;
  colorMap?: string;
  minDB?: number;
  maxDB?: number;
  stateId?: string;
} & CanvasHTMLAttributes<HTMLCanvasElement>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<{
    completed: number;
    total: number;
    painted?: number;
    error?: string;
  }>({
    completed: 0,
    total: 0,
    error: undefined as string | undefined,
  });
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context || paused) return;
    context.clearRect(0, 0, width, height);
    if (!client || !info.frames) return;
    const controller = new AbortController();
    let active = true;
    const actualWidth = Math.max(1, Math.floor(width)),
      actualHeight = Math.min(512, Math.max(1, Math.floor(height)));
    context.clearRect(0, 0, actualWidth, actualHeight);
    const span = viewport.end - viewport.start;
    if (!Number.isFinite(span) || span <= 0 || viewport.end <= 0 || viewport.start >= info.frames) {
      setStatus({ completed: 0, total: 0, painted: 0 });
      return;
    }
    const firstColumn = Math.max(0, Math.floor((-viewport.start * actualWidth) / span));
    const lastColumn = Math.min(
      actualWidth,
      Math.ceil(((info.frames - viewport.start) * actualWidth) / span),
    );
    const total = Math.ceil(actualWidth / TILE_WIDTH);
    setStatus({ completed: 0, total, error: undefined });
    const cache = tileCache(client);
    void (async () => {
      for (let tile = 0; tile < total; tile++) {
        if (!active) return;
        const x = Math.max(tile * TILE_WIDTH, firstColumn),
          right = Math.min((tile + 1) * TILE_WIDTH, actualWidth, lastColumn),
          tileWidth = right - x;
        if (tileWidth <= 0) {
          setStatus((previous) => ({ ...previous, completed: tile + 1 }));
          continue;
        }
        const start = Math.max(
            0,
            Math.min(info.frames, Math.floor(viewport.start + (span * x) / actualWidth)),
          ),
          end = Math.max(
            0,
            Math.min(info.frames, Math.ceil(viewport.start + (span * right) / actualWidth)),
          );
        // A cursor means whole-document analysis to the kernel; blank pixels must never request it.
        if (end <= start) continue;
        const params = {
          documentId: info.documentId,
          start,
          end,
          channelMask: 1 << channel,
          channel,
          kind: "spectrogram" as const,
          ...settings,
          width: tileWidth,
          height: actualHeight,
          minDB,
          maxDB,
          colorMap,
        };
        const key = JSON.stringify({ ...params, stateId });
        let result = cache.get(key);
        if (result) {
          cache.delete(key);
          cache.set(key, result);
        } else {
          result = await analyse(client, params, controller.signal, (progress) => {
            if (!active || !progress.data) return;
            context.putImageData(
              new ImageData(new Uint8ClampedArray(progress.data), tileWidth, actualHeight),
              x,
              0,
            );
            setStatus({
              completed: tile,
              total,
              painted: x + (progress.completedColumns ?? 0),
              error: undefined,
            });
          });
          if (active) storeTile(cache, key, result);
        }
        if (!active) return;
        if (
          !result.data ||
          result.width !== tileWidth ||
          result.height !== actualHeight ||
          result.data.byteLength !== tileWidth * actualHeight * 4
        )
          throw new Error("Invalid spectrogram tile");
        context.putImageData(
          new ImageData(new Uint8ClampedArray(result.data), tileWidth, actualHeight),
          x,
          0,
        );
        setStatus({ completed: tile + 1, total, painted: x + tileWidth, error: undefined });
      }
    })().catch((error: unknown) => {
      if (active)
        setStatus((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : String(error),
        }));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    client,
    info.documentId,
    info.frames,
    channel,
    viewport.start,
    viewport.end,
    width,
    height,
    settings,
    paused,
    colorMap,
    minDB,
    maxDB,
    stateId,
  ]);
  return (
    <div className="relative" style={{ height }}>
      <canvas
        {...events}
        ref={canvas}
        width={Math.max(1, Math.floor(width))}
        height={Math.min(512, Math.max(1, Math.floor(height)))}
        role="img"
        aria-label={`Channel ${channel + 1} spectrogram`}
        data-testid={`spectrogram-canvas-${channel}`}
        data-completed-tiles={status.completed}
        data-total-tiles={status.total}
        data-painted-columns={status.painted ?? 0}
        data-start-frame={viewport.start}
        data-end-frame={viewport.end}
        data-history-state={stateId}
        className="block h-full w-full touch-none"
      />
      {status.error ? (
        <p role="alert" className="absolute inset-x-2 bottom-1 text-xs">
          {status.error}
        </p>
      ) : (
        <span
          role="status"
          className="pointer-events-none absolute bottom-1 right-2 rounded bg-background/80 px-1 text-[10px]"
        >
          {paused ? "Analysis paused" : `Spectrogram ${status.completed}/${status.total} tiles`} ·{" "}
          {info.sampleRate / 2} Hz–0 Hz · {minDB} to {maxDB} dBFS
        </span>
      )}
    </div>
  );
}
