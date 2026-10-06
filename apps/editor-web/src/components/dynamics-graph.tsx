import type { EffectDescriptor } from "@aae/protocol";
import { type PointerEvent, useId, useRef, useState } from "react";
import type { RackEffect } from "@/lib/effect-presets";

const WIDTH = 640;
const HEIGHT = 320;
const LEFT = 64;
const RIGHT = 620;
const TOP = 28;
const BOTTOM = 264;
const MIN_INPUT = -80;
const MAX_INPUT = 0;
const MIN_OUTPUT = -80;
const MAX_OUTPUT = 24;
const formatDB = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
const x = (db: number) => LEFT + ((db - MIN_INPUT) * (RIGHT - LEFT)) / (MAX_INPUT - MIN_INPUT);
const y = (db: number) => TOP + ((MAX_OUTPUT - db) * (BOTTOM - TOP)) / (MAX_OUTPUT - MIN_OUTPUT);

/** Draw and inspect the kernel's gain-computer samples; no dynamics model lives in the UI. */
export function DynamicsGraph({
  descriptor,
  node,
  points,
  disabled,
}: {
  descriptor: EffectDescriptor;
  node: RackEffect;
  points: [number, number][];
  disabled: boolean;
}) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [input, setInput] = useState(-12);
  const nearest = points.reduce(
    (best, point, index) =>
      Math.abs(point[0] - input) < Math.abs(points[best][0] - input) ? index : best,
    0,
  );
  const selected = points[nearest];
  const value = (name: string) =>
    Number(
      node.params[name] ??
        descriptor.parameters.find((parameter) => parameter.id === name)?.default,
    );
  const threshold = value("thresholdDB");
  const knee = value("kneeDB");
  const path = points
    .map(([db, output], index) => `${index ? "L" : "M"}${x(db)},${y(output)}`)
    .join(" ");
  const inspect = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || !points.length) return;
    const box = svg.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return;
    const px = ((event.clientX - box.left) * WIDTH) / box.width;
    const py = ((event.clientY - box.top) * HEIGHT) / box.height;
    if (px < LEFT || px > RIGHT || py < TOP || py > BOTTOM) return;
    setInput(MIN_INPUT + ((px - LEFT) * (MAX_INPUT - MIN_INPUT)) / (RIGHT - LEFT));
  };
  return (
    <div className="space-y-2">
      <svg
        ref={svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="effect-graph w-full select-none border"
        role="img"
        aria-label={`${descriptor.name} response curve`}
        aria-describedby={`${id}-help ${id}-readout`}
        onPointerMove={inspect}
        onPointerDown={inspect}
      >
        <title>{descriptor.name} input/output transfer curve</title>
        <defs>
          <clipPath id={`${id}-plot`}>
            <rect x={LEFT} y={TOP} width={RIGHT - LEFT} height={BOTTOM - TOP} />
          </clipPath>
        </defs>
        {[-80, -60, -40, -20, 0].map((db) => (
          <g key={`input-${db}`}>
            <line x1={x(db)} x2={x(db)} y1={TOP} y2={BOTTOM} stroke="currentColor" opacity="0.12" />
            <text
              x={x(db)}
              y={BOTTOM + 18}
              textAnchor="middle"
              fontSize="11"
              fill="currentColor"
              className="text-muted-foreground"
            >
              {db}
            </text>
          </g>
        ))}
        {[-80, -60, -40, -20, 0, 24].map((db) => (
          <g key={`output-${db}`}>
            <line
              x1={LEFT}
              x2={RIGHT}
              y1={y(db)}
              y2={y(db)}
              stroke="currentColor"
              opacity={db === 0 ? 0.3 : 0.12}
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
        <text x={LEFT} y="16" fontSize="11" fill="currentColor" className="text-muted-foreground">
          Output (dB)
        </text>
        <text
          x={RIGHT}
          y={HEIGHT - 8}
          textAnchor="end"
          fontSize="11"
          fill="currentColor"
          className="text-muted-foreground"
        >
          Input (dB)
        </text>
        <g clipPath={`url(#${id}-plot)`}>
          {Number.isFinite(threshold) && Number.isFinite(knee) && knee > 0 && (
            <rect
              data-testid="dynamics-knee"
              x={x(threshold - knee / 2)}
              y={TOP}
              width={x(threshold + knee / 2) - x(threshold - knee / 2)}
              height={BOTTOM - TOP}
              fill="currentColor"
              className="text-warning"
              opacity="0.08"
            />
          )}
          <path
            data-testid="dynamics-unity"
            d={`M${x(MIN_INPUT)},${y(MIN_INPUT)} L${x(MAX_INPUT)},${y(MAX_INPUT)}`}
            fill="none"
            stroke="currentColor"
            className="text-muted-foreground"
            strokeDasharray="5 5"
          />
          {Number.isFinite(threshold) && (
            <line
              data-testid="dynamics-threshold"
              x1={x(threshold)}
              x2={x(threshold)}
              y1={TOP}
              y2={BOTTOM}
              stroke="currentColor"
              className="text-warning"
              strokeDasharray="3 4"
            />
          )}
          <path
            data-testid="effect-response-path"
            d={path}
            fill="none"
            stroke="currentColor"
            className="text-primary"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {selected && (
            <g className="text-primary">
              <line
                x1={x(selected[0])}
                x2={x(selected[0])}
                y1={TOP}
                y2={BOTTOM}
                stroke="currentColor"
                opacity="0.4"
              />
              <line
                x1={LEFT}
                x2={RIGHT}
                y1={y(selected[1])}
                y2={y(selected[1])}
                stroke="currentColor"
                opacity="0.4"
              />
              <circle cx={x(selected[0])} cy={y(selected[1])} r="4" fill="currentColor" />
            </g>
          )}
        </g>
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="text-primary">Transfer curve</span>
        <span>Dashed: unity (1:1)</span>
        {Number.isFinite(threshold) && (
          <span className="text-warning">
            Threshold {formatDB(threshold)}
            {Number.isFinite(knee) && knee > 0 ? ` · Knee ${formatDB(knee)}` : ""}
          </span>
        )}
      </div>
      <output
        id={`${id}-readout`}
        className="studio-readout block rounded border border-border/60 bg-background/50 px-2 py-1.5 text-xs tabular-nums"
        aria-live="polite"
      >
        {selected
          ? `Input ${formatDB(selected[0])} → Output ${formatDB(selected[1])} · Gain change ${formatDB(selected[1] - selected[0])}`
          : "Loading transfer curve…"}
      </output>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <label htmlFor={`${id}-input`}>Read input level</label>
        <input
          id={`${id}-input`}
          className="min-w-0 flex-1 accent-primary"
          type="range"
          min={0}
          max={Math.max(0, points.length - 1)}
          step={1}
          value={nearest}
          disabled={disabled || !selected}
          aria-valuetext={
            selected ? `${formatDB(selected[0])} input, ${formatDB(selected[1])} output` : undefined
          }
          onChange={(event) => {
            const point = points[Number(event.target.value)];
            if (point) setInput(point[0]);
          }}
        />
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Move over the plot or use the input level slider to read a curve point. −80–0 dB input /
        −80–24 dB output; values outside the output axis remain in the readout. The steady-state
        curve includes makeup gain; attack, release and lookahead affect timing during playback.
      </p>
    </div>
  );
}
