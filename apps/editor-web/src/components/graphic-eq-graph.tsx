import type { EffectDescriptor } from "@aae/protocol";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import type { RackEffect } from "@/lib/effect-presets";

const HEIGHT = 224;
const LEFT = 48;
const TOP = 24;
const BOTTOM = 184;
const MIN_HZ = 20;
const MAX_DB = 24;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const formatHz = (hz: number) => (hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : `${hz}`);

/** Frequency is logarithmic; dB already expresses logarithmic amplitude. All response data is kernel-owned. */
export function GraphicEQGraph({
  descriptor,
  node,
  points,
  sampleRate,
  disabled,
  onChange,
}: {
  descriptor: EffectDescriptor;
  node: RackEffect;
  points: [number, number][];
  sampleRate: number;
  disabled: boolean;
  onChange(params: RackEffect["params"]): void;
}) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointer: number; parameter: string } | undefined>(undefined);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const right = width - 20;
  const maxHz = Math.min(20000, sampleRate * 0.49);
  const x = (hz: number) =>
    LEFT + ((right - LEFT) * Math.log(hz / MIN_HZ)) / Math.log(maxHz / MIN_HZ);
  const y = (db: number) => TOP + ((BOTTOM - TOP) * (MAX_DB - db)) / (2 * MAX_DB);
  const bands = descriptor.parameters
    .filter((parameter) => /^gain\d+DB$/.test(parameter.id))
    .map((parameter) => ({
      parameter,
      hz: Number(/([\d.]+)\s*Hz/i.exec(parameter.label)?.[1]),
    }))
    .filter(({ hz }) => Number.isFinite(hz) && hz > 0);
  const path = points.map(([hz, db], index) => `${index ? "L" : "M"}${x(hz)},${y(db)}`).join(" ");
  const coordinate = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const px = ((event.clientX - box.left) * width) / box.width;
    const py = ((event.clientY - box.top) * HEIGHT) / box.height;
    return { px, py };
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (disabled || active?.pointer !== event.pointerId) return;
    const point = coordinate(event);
    const parameter = bands.find(({ parameter }) => parameter.id === active.parameter)?.parameter;
    if (!point || !parameter) return;
    const db = MAX_DB - (2 * MAX_DB * (point.py - TOP)) / (BOTTOM - TOP);
    onChange({ ...node.params, [parameter.id]: clamp(db, parameter.min, parameter.max) });
  };
  const stop = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const labelTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
    .filter((hz) => hz < maxHz)
    .concat(maxHz)
    .filter(
      (hz, index, ticks) =>
        hz === maxHz ||
        (x(maxHz) - x(hz) > 32 && (index === 0 || x(hz) - x(ticks[index - 1]) > 32)),
    );
  return (
    <div className="min-w-0 space-y-1">
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="effect-graph h-56 w-full touch-none select-none border"
        role="img"
        aria-label={`${descriptor.name} response curve`}
        aria-describedby={`${id}-help`}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || drag.current) return;
          const point = coordinate(event);
          if (!point || point.px < LEFT || point.px > right || point.py < TOP || point.py > BOTTOM)
            return;
          const nearest = bands.reduce<(typeof bands)[number] | undefined>(
            (best, band) =>
              !best || Math.abs(x(band.hz) - point.px) < Math.abs(x(best.hz) - point.px)
                ? band
                : best,
            undefined,
          );
          if (!nearest) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, parameter: nearest.parameter.id };
          move(event);
        }}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
      >
        <title>{descriptor.name} response computed by the audio kernel</title>
        <defs>
          <clipPath id={`${id}-plot`}>
            <rect x={LEFT} y={TOP} width={right - LEFT} height={BOTTOM - TOP} />
          </clipPath>
        </defs>
        {[10, 100, 1000, 10000]
          .flatMap((decade) => Array.from({ length: 9 }, (_, index) => (index + 1) * decade))
          .filter((hz) => hz >= MIN_HZ && hz < maxHz)
          .concat(maxHz)
          .map((hz) => (
            <line
              key={hz}
              data-frequency={hz}
              x1={x(hz)}
              x2={x(hz)}
              y1={TOP}
              y2={BOTTOM}
              stroke="currentColor"
              opacity={[100, 1000, 10000].includes(hz) ? 0.24 : 0.08}
            />
          ))}
        {Array.from({ length: 17 }, (_, index) => index * 3 - MAX_DB).map((db) => (
          <g key={db}>
            <line
              x1={LEFT}
              x2={right}
              y1={y(db)}
              y2={y(db)}
              stroke="currentColor"
              opacity={db === 0 ? 0.4 : db % 6 === 0 ? 0.14 : 0.06}
            />
            {db % 6 === 0 && (
              <text
                x={LEFT - 8}
                y={y(db) + 4}
                textAnchor="end"
                fontSize="11"
                fill="currentColor"
                className="text-muted-foreground"
              >
                {db > 0 ? `+${db}` : db}
              </text>
            )}
          </g>
        ))}
        {labelTicks.map((hz) => (
          <text
            key={hz}
            x={x(hz)}
            y={BOTTOM + 17}
            textAnchor="middle"
            fontSize="11"
            fill="currentColor"
            className="text-muted-foreground"
          >
            {formatHz(hz)}
          </text>
        ))}
        <text x={LEFT} y={14} fontSize="11" fill="currentColor" className="text-muted-foreground">
          Gain (dB)
        </text>
        <text
          x={right}
          y={HEIGHT - 6}
          textAnchor="end"
          fontSize="11"
          fill="currentColor"
          className="text-muted-foreground"
        >
          Frequency (Hz)
        </text>
        <path
          data-testid="effect-response-path"
          d={path}
          clipPath={`url(#${id}-plot)`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-waveform-peak"
        />
      </svg>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Drag the graph to adjust the nearest band · Logarithmic frequency · Gain in dB
      </p>
    </div>
  );
}
