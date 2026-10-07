import { useEffect, useId, useRef, useState } from "react";

const HEIGHT = 320;
const LEFT = 48;
const TOP = 24;
const BOTTOM = HEIGHT - 40;
const MIN_DB = -96;
const MAX_DB = 24;
const formatHz = (hz: number) =>
  hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : String(Math.round(hz));

export function FilterResponseGraph({
  name,
  points,
  sampleRate,
}: {
  name: string;
  points: [number, number][];
  sampleRate: number;
}) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number>();
  useEffect(() => {
    const element = svg.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const minHz = points[0]?.[0] ?? 20;
  const maxHz = points.at(-1)?.[0] ?? Math.min(20000, sampleRate * 0.49);
  const right = width - 20;
  const x = (hz: number) =>
    LEFT + ((right - LEFT) * Math.log(hz / minHz)) / Math.log(maxHz / minHz);
  const y = (db: number) => TOP + ((BOTTOM - TOP) * (MAX_DB - db)) / (MAX_DB - MIN_DB);
  const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
    .filter((hz) => hz >= minHz && hz < maxHz)
    .concat(maxHz)
    .filter(
      (hz, index, all) =>
        hz === maxHz || (x(maxHz) - x(hz) > 32 && (index === 0 || x(hz) - x(all[index - 1]) > 32)),
    );
  const selected =
    hover === undefined
      ? undefined
      : points.reduce<[number, number] | undefined>(
          (best, point) =>
            !best || Math.abs(Math.log(point[0] / hover)) < Math.abs(Math.log(best[0] / hover))
              ? point
              : best,
          undefined,
        );
  return (
    <div className="min-w-0 space-y-1">
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="effect-graph h-80 w-full select-none border"
        role="img"
        aria-label={`${name} response curve`}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - box.left) * width) / box.width;
          setHover(
            px >= LEFT && px <= right
              ? minHz * (maxHz / minHz) ** ((px - LEFT) / (right - LEFT))
              : undefined,
          );
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <title>{name} frequency response computed by the audio kernel</title>
        <defs>
          <clipPath id={`${id}-plot`}>
            <rect x={LEFT} y={TOP} width={right - LEFT} height={BOTTOM - TOP} />
          </clipPath>
        </defs>
        {[10, 100, 1000, 10000]
          .flatMap((decade) => Array.from({ length: 9 }, (_, index) => (index + 1) * decade))
          .filter((hz) => hz >= minHz && hz <= maxHz)
          .map((hz) => (
            <line
              key={hz}
              x1={x(hz)}
              x2={x(hz)}
              y1={TOP}
              y2={BOTTOM}
              stroke="currentColor"
              opacity={[100, 1000, 10000].includes(hz) ? 0.24 : 0.08}
            />
          ))}
        {Array.from({ length: (MAX_DB - MIN_DB) / 6 + 1 }, (_, index) => MIN_DB + index * 6).map(
          (db) => (
            <g key={db}>
              <line
                x1={LEFT}
                x2={right}
                y1={y(db)}
                y2={y(db)}
                stroke="currentColor"
                opacity={db === 0 ? 0.4 : db % 12 === 0 ? 0.14 : 0.06}
              />
              {db % 12 === 0 && (
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
          ),
        )}
        {ticks.map((hz) => (
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
          Level (dB)
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
          d={points.map(([hz, db], index) => `${index ? "L" : "M"}${x(hz)},${y(db)}`).join(" ")}
          clipPath={`url(#${id}-plot)`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-waveform-peak"
        />
        {selected && (
          <line
            x1={x(selected[0])}
            x2={x(selected[0])}
            y1={TOP}
            y2={BOTTOM}
            stroke="currentColor"
            opacity="0.35"
          />
        )}
      </svg>
      <p className="text-xs text-muted-foreground tabular-nums">
        {selected
          ? `${Math.round(selected[0])} Hz · ${selected[1].toFixed(1)} dB`
          : "Logarithmic frequency · Level in dB · Hover to read the response"}
      </p>
    </div>
  );
}
