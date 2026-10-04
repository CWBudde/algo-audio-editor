import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import { type PointerEvent, useId, useRef, useState } from "react";
import type { RackEffect } from "@/lib/effect-presets";

const WIDTH = 640;
const HEIGHT = 280;
const LEFT = 52;
const RIGHT = 620;
const TOP = 20;
const BOTTOM = 230;
const COLORS = [
  "#fb923c",
  "#facc15",
  "#a3e635",
  "#2dd4bf",
  "#38bdf8",
  "#a78bfa",
  "#e879f9",
  "#fb7185",
];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const formatHz = (hz: number) =>
  hz >= 1000 ? `${Number((hz / 1000).toFixed(2))}k` : `${Math.round(hz)}`;

/** Only plot coordinates and controls live here; the Go kernel supplies every response point. */
export function ParametricEQGraph({
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
  const drag = useRef<{ band: number; pointer: number } | undefined>(undefined);
  const [selected, setSelected] = useState(1);
  const maxHz = Math.min(20000, sampleRate * 0.49);
  const bandCount = clamp(Math.trunc(Number(node.params.bands) || 1), 1, 8);
  const bands = Array.from({ length: bandCount }, (_, index) => index + 1);
  const parameter = (band: number, suffix: string) =>
    descriptor.parameters.find((p) => p.id === `band${band}${suffix}`);
  const value = (band: number, suffix: string) =>
    Number(node.params[`band${band}${suffix}`] ?? parameter(band, suffix)?.default);
  const x = (hz: number) =>
    LEFT + ((RIGHT - LEFT) * Math.log(clamp(hz, 20, maxHz) / 20)) / Math.log(maxHz / 20);
  const y = (db: number) => TOP + ((BOTTOM - TOP) * (24 - clamp(db, -24, 24))) / 48;
  const path = points.map(([hz, db], index) => `${index ? "L" : "M"}${x(hz)},${y(db)}`).join(" ");
  const update = (changes: [EffectParameterDescriptor | undefined, number][]) => {
    if (disabled) return;
    const params = { ...node.params };
    for (const [field, next] of changes) {
      if (field && Number.isFinite(next)) params[field.id] = clamp(next, field.min, field.max);
    }
    onChange(params);
  };
  const position = (event: PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return;
    const px = ((event.clientX - box.left) * WIDTH) / box.width;
    const py = ((event.clientY - box.top) * HEIGHT) / box.height;
    return {
      px,
      py,
      hz: 20 * (maxHz / 20) ** clamp((px - LEFT) / (RIGHT - LEFT), 0, 1),
      db: 24 - 48 * clamp((py - TOP) / (BOTTOM - TOP), 0, 1),
    };
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId || active.band > bandCount) return;
    const point = position(event);
    if (point)
      update([
        [parameter(active.band, "FreqHz"), point.hz],
        [parameter(active.band, "GainDB"), point.db],
      ]);
  };
  const stop = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const activeBand = Math.min(selected, bandCount);
  return (
    <div className="space-y-2">
      {/* biome-ignore lint/a11y/useSemanticElements: SVG groups the response image and independently focusable band handles. */}
      <svg
        ref={svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full touch-none select-none rounded border bg-background"
        role="group"
        aria-label="Parametric EQ frequency graph"
        aria-describedby={`${id}-help`}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || drag.current) return;
          const point = position(event);
          if (!point || point.px < LEFT || point.px > RIGHT || point.py < TOP || point.py > BOTTOM)
            return;
          const handle =
            event.target instanceof Element ? event.target.closest("[data-eq-band]") : null;
          const band = handle
            ? Number(handle.getAttribute("data-eq-band"))
            : bands.reduce(
                (best, band) =>
                  Math.abs(Math.log(value(band, "FreqHz") / point.hz)) <
                  Math.abs(Math.log(value(best, "FreqHz") / point.hz))
                    ? band
                    : best,
                1,
              );
          setSelected(band);
          drag.current = { band, pointer: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
          handle?.querySelector<SVGElement>("[role=slider]")?.focus();
          move(event);
        }}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
      >
        {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: This SVG group contains only the noninteractive response drawing; sliders are siblings. */}
        <g role="img" aria-label={`${descriptor.name} response curve`}>
          <title>{descriptor.name} frequency response</title>
          <rect width={WIDTH} height={HEIGHT} fill="transparent" pointerEvents="none" />
          <defs>
            <clipPath id={`${id}-plot`}>
              <rect x={LEFT} y={TOP} width={RIGHT - LEFT} height={BOTTOM - TOP} />
            </clipPath>
          </defs>
          {[
            20, 30, 40, 50, 60, 80, 100, 200, 300, 400, 500, 600, 800, 1000, 2000, 3000, 4000, 5000,
            6000, 8000, 10000, 20000,
          ]
            .filter((hz) => hz <= maxHz)
            .map((hz) => (
              <line
                key={hz}
                x1={x(hz)}
                x2={x(hz)}
                y1={TOP}
                y2={BOTTOM}
                stroke="currentColor"
                opacity={[100, 1000, 10000].includes(hz) ? 0.2 : 0.08}
              />
            ))}
          {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
            <g key={db}>
              <line
                x1={LEFT}
                x2={RIGHT}
                y1={y(db)}
                y2={y(db)}
                stroke="currentColor"
                opacity={db === 0 ? 0.35 : 0.1}
              />
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
            </g>
          ))}
          {[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, maxHz]
            .filter(
              (hz, index, ticks) =>
                hz <= maxHz &&
                ticks.indexOf(hz) === index &&
                (hz === maxHz || x(maxHz) - x(hz) > 30),
            )
            .map((hz) => (
              <text
                key={hz}
                x={x(hz)}
                y={BOTTOM + 18}
                textAnchor="middle"
                fontSize="11"
                fill="currentColor"
                className="text-muted-foreground"
              >
                {formatHz(hz)}
              </text>
            ))}
          <text x={LEFT} y={12} fontSize="11" fill="currentColor" className="text-muted-foreground">
            Gain (dB)
          </text>
          <text
            x={RIGHT}
            y={HEIGHT - 8}
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
            className="text-primary"
            stroke="currentColor"
            strokeWidth="2.5"
          />
        </g>
        {bands.map((band) => {
          const hz = value(band, "FreqHz");
          const gain = value(band, "GainDB");
          const q = value(band, "Q");
          if (![hz, gain, q].every(Number.isFinite)) return null;
          return (
            <g key={band} data-eq-band={band}>
              <circle
                cx={x(hz)}
                cy={y(gain)}
                r="12"
                fill={COLORS[band - 1]}
                stroke={activeBand === band ? "currentColor" : "transparent"}
                strokeWidth="2"
                className="cursor-grab focus:stroke-foreground focus:stroke-[3px] focus:outline-none"
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label={`EQ band ${band}`}
                aria-disabled={disabled}
                aria-valuemin={-24}
                aria-valuemax={24}
                aria-valuenow={gain}
                aria-valuetext={`${Math.round(hz)} Hz, ${gain.toFixed(1)} dB, Q ${q.toFixed(2)}`}
                aria-describedby={`${id}-help`}
                onFocus={() => setSelected(band)}
                onKeyDown={(event) => {
                  if (disabled) return;
                  const fine = event.shiftKey;
                  let changes: [EffectParameterDescriptor | undefined, number][];
                  switch (event.key) {
                    case "ArrowLeft":
                    case "ArrowRight":
                      changes = [
                        [
                          parameter(band, "FreqHz"),
                          hz * 2 ** ((event.key === "ArrowLeft" ? -1 : 1) / (fine ? 48 : 12)),
                        ],
                      ];
                      break;
                    case "ArrowUp":
                    case "ArrowDown":
                      changes = [
                        [
                          parameter(band, "GainDB"),
                          gain + (event.key === "ArrowUp" ? 1 : -1) * (fine ? 0.1 : 0.5),
                        ],
                      ];
                      break;
                    case "+":
                    case "=":
                    case "-":
                      changes = [[parameter(band, "Q"), q * (event.key === "-" ? 1 / 1.1 : 1.1)]];
                      break;
                    case "Home":
                      changes = [[parameter(band, "GainDB"), 0]];
                      break;
                    default:
                      return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  update(changes);
                }}
              />
              <text
                x={x(hz)}
                y={y(gain) + 4}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="#171717"
                pointerEvents="none"
              >
                {band}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="text-sm" aria-live="polite">
        <span style={{ color: COLORS[activeBand - 1] }}>Band {activeBand}</span> ·{" "}
        {formatHz(value(activeBand, "FreqHz"))} Hz · {value(activeBand, "GainDB").toFixed(1)} dB · Q{" "}
        {value(activeBand, "Q").toFixed(2)}
      </p>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Drag a band to change frequency and gain. Arrow keys adjust the focused band; Shift makes
        smaller steps. +/− adjusts Q; Home resets gain.
      </p>
    </div>
  );
}
