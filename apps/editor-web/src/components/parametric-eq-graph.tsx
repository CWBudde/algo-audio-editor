import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import { Menu } from "@base-ui/react/menu";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import type { RackEffect } from "@/lib/effect-presets";

const LEFT = 52;
const TOP = 20;
// Band colors identify physical EQ bands; selected controls use the interaction role.
export const EQ_BAND_COLORS = [
  "var(--editor-band-1)",
  "var(--editor-band-2)",
  "var(--editor-band-3)",
  "var(--editor-band-4)",
  "var(--editor-band-5)",
  "var(--editor-band-6)",
  "var(--editor-band-7)",
  "var(--editor-band-8)",
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
  const HEIGHT = descriptor.id === "dyn-eq" ? 160 : 220;
  const BOTTOM = HEIGHT - 50;
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const wheelHandler = useRef<((event: WheelEvent) => void) | undefined>(undefined);
  const drag = useRef<{ band: number; pointer: number } | undefined>(undefined);
  const [selected, setSelected] = useState(1);
  const [menu, setMenu] = useState<{ band: number; anchor: SVGElement }>();
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
  const bandCount = clamp(Math.trunc(Number(node.params.bands) || 1), 1, 8);
  useEffect(() => {
    if (menu && (disabled || menu.band > bandCount)) setMenu(undefined);
  }, [menu, disabled, bandCount]);
  const bands = Array.from({ length: bandCount }, (_, index) => index + 1);
  const parameter = (band: number, suffix: string) =>
    descriptor.parameters.find((p) => p.id === `band${band}${suffix}`);
  const value = (band: number, suffix: string) =>
    Number(node.params[`band${band}${suffix}`] ?? parameter(band, suffix)?.default);
  const type = (band: number) =>
    String(node.params[`band${band}Type`] ?? parameter(band, "Type")?.defaultString ?? "peak");
  const isPass = (band: number) => ["highpass", "lowpass"].includes(type(band));
  const order = (band: number) => value(band, "Order") || 2;
  const fixedQ = (band: number) => order(band) > 2 && type(band) !== "peak";
  const x = (hz: number) =>
    LEFT + ((right - LEFT) * Math.log(clamp(hz, 20, maxHz) / 20)) / Math.log(maxHz / 20);
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
  wheelHandler.current = (event) => {
    if (disabled || event.ctrlKey) return;
    const handle = event.target instanceof Element ? event.target.closest("[data-eq-band]") : null;
    if (!handle) return;
    const band = Number(handle.getAttribute("data-eq-band"));
    const field = parameter(band, "Q");
    const delta = event.deltaY || event.deltaX;
    if (!field || !Number.isFinite(delta) || delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(band);
    if (fixedQ(band) || drag.current) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? HEIGHT : 1;
    const factor = Math.exp(-clamp(delta * unit, -240, 240) * (event.shiftKey ? 0.0004 : 0.002));
    update([[field, value(band, "Q") * factor]]);
  };
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    // A native listener can consume the gesture; React's wheel handlers are passive.
    const wheel = (event: WheelEvent) => wheelHandler.current?.(event);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  const position = (event: PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return;
    const px = ((event.clientX - box.left) * width) / box.width;
    const py = ((event.clientY - box.top) * HEIGHT) / box.height;
    return {
      px,
      py,
      hz: 20 * (maxHz / 20) ** clamp((px - LEFT) / (right - LEFT), 0, 1),
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
        [isPass(active.band) ? undefined : parameter(active.band, "GainDB"), point.db],
      ]);
  };
  const stop = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const activeBand = Math.min(selected, bandCount);
  const openTypes = (band: number, anchor: SVGElement) => {
    if (disabled || !parameter(band, "Type")?.options?.length) return;
    setSelected(band);
    setMenu({ band, anchor });
  };
  const menuType = menu && parameter(menu.band, "Type");
  return (
    <div className="space-y-2">
      {/* biome-ignore lint/a11y/useSemanticElements: SVG groups the response image and independently focusable band handles. */}
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="effect-graph w-full touch-none select-none border"
        style={{ height: HEIGHT }}
        role="group"
        aria-label={`${descriptor.name} frequency graph`}
        aria-describedby={`${id}-help`}
        onContextMenu={(event) => {
          if (disabled) return;
          const handle =
            event.target instanceof Element ? event.target.closest("[data-eq-band]") : null;
          const anchor = handle?.querySelector<SVGElement>("[role=slider]");
          if (!anchor) return;
          event.preventDefault();
          event.stopPropagation();
          openTypes(Number(handle?.getAttribute("data-eq-band")), anchor);
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || drag.current) return;
          const point = position(event);
          if (!point || point.px < LEFT || point.px > right || point.py < TOP || point.py > BOTTOM)
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
          <rect width={width} height={HEIGHT} fill="transparent" pointerEvents="none" />
          <defs>
            <clipPath id={`${id}-plot`}>
              <rect x={LEFT} y={TOP} width={right - LEFT} height={BOTTOM - TOP} />
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
                x2={right}
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
                (hz === maxHz ||
                  (x(maxHz) - x(hz) > 30 && (index === 0 || x(hz) - x(ticks[index - 1]) > 30))),
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
            x={right}
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
            className="text-waveform-peak"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        {bands.map((band) => {
          const hz = value(band, "FreqHz");
          const gain = isPass(band) ? 0 : value(band, "GainDB");
          const q = value(band, "Q");
          if (![hz, gain, q].every(Number.isFinite)) return null;
          return (
            <g key={band} data-eq-band={band}>
              <circle cx={x(hz)} cy={y(gain)} r="12" fill="transparent" />
              <circle
                cx={x(hz)}
                cy={y(gain)}
                r="6"
                fill={EQ_BAND_COLORS[band - 1]}
                stroke={activeBand === band ? "var(--editor-primary)" : "transparent"}
                strokeWidth="2"
                className="cursor-grab focus:stroke-primary focus:stroke-[3px] focus:outline-none"
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label={`EQ band ${band}`}
                aria-disabled={disabled}
                aria-orientation={isPass(band) ? "horizontal" : "vertical"}
                aria-valuemin={isPass(band) ? parameter(band, "FreqHz")?.min : -24}
                aria-valuemax={isPass(band) ? parameter(band, "FreqHz")?.max : 24}
                aria-valuenow={isPass(band) ? hz : gain}
                aria-valuetext={`${Math.round(hz)} Hz, ${isPass(band) ? "cutoff" : `${gain.toFixed(1)} dB`}, ${fixedQ(band) ? "Butterworth" : `Q ${q.toFixed(2)}`}, ${type(band)}${parameter(band, "Order") ? `, order ${order(band)}` : ""}`}
                aria-haspopup="menu"
                aria-describedby={`${id}-help`}
                onFocus={() => setSelected(band)}
                onKeyDown={(event) => {
                  if (disabled) return;
                  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    openTypes(band, event.currentTarget);
                    return;
                  }
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
                      if (isPass(band)) return;
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
                      if (fixedQ(band)) return;
                      changes = [[parameter(band, "Q"), q * (event.key === "-" ? 1 / 1.1 : 1.1)]];
                      break;
                    case "Home":
                      if (isPass(band)) return;
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
                y={y(gain) - 11}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill={EQ_BAND_COLORS[band - 1]}
                pointerEvents="none"
              >
                {band}
              </text>
            </g>
          );
        })}
      </svg>
      <Menu.Root
        open={Boolean(menu && menu.band <= bandCount && !disabled)}
        modal={false}
        onOpenChange={(open, details) => {
          if (!open) {
            if (details.reason !== "outside-press" && details.reason !== "focus-out")
              menu?.anchor.focus();
            setMenu(undefined);
          }
        }}
      >
        {/* Keep the portal inside the native dialog's top layer. */}
        <Menu.Portal container={svg.current?.parentElement}>
          <Menu.Positioner
            anchor={menu?.anchor}
            positionMethod="fixed"
            align="start"
            sideOffset={6}
            className="z-50"
          >
            <Menu.Popup
              aria-label={`Band ${menu?.band} filter type`}
              finalFocus={false}
              className="min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl outline-none"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  menu?.anchor.focus();
                  setMenu(undefined);
                }
              }}
            >
              <Menu.RadioGroup
                value={menu ? type(menu.band) : ""}
                onValueChange={(type) => {
                  if (menuType && !disabled) onChange({ ...node.params, [menuType.id]: type });
                }}
              >
                {menuType?.options?.map((option) => (
                  <Menu.RadioItem
                    key={option.value}
                    value={option.value}
                    className="flex items-center justify-between gap-4 rounded px-2 py-1 text-sm outline-none data-highlighted:bg-accent"
                  >
                    {option.label}
                    <Menu.RadioItemIndicator>✓</Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <div className="flex flex-wrap items-center gap-2">
        <p
          className="studio-readout min-w-0 flex-1 rounded border border-border/60 bg-background/50 px-2 py-1 text-xs tabular-nums"
          aria-live="polite"
        >
          <span style={{ color: EQ_BAND_COLORS[activeBand - 1] }}>Band {activeBand}</span> ·{" "}
          {formatHz(value(activeBand, "FreqHz"))} Hz ·{" "}
          {isPass(activeBand) ? "Cutoff" : `${value(activeBand, "GainDB").toFixed(1)} dB`} ·{" "}
          {fixedQ(activeBand) ? "Butterworth" : `Q ${value(activeBand, "Q").toFixed(2)}`}
          {parameter(activeBand, "Order") && ` · Order ${order(activeBand)}`}
        </p>
        <label className="flex shrink-0 items-center gap-2 text-xs">
          Bands
          <select
            className="studio-field min-w-14 border px-1.5 py-1 text-xs tabular-nums"
            value={bandCount}
            disabled={disabled}
            onChange={(event) => onChange({ ...node.params, bands: Number(event.target.value) })}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p
        id={`${id}-help`}
        className={descriptor.id === "dyn-eq" ? "sr-only" : "text-xs text-muted-foreground"}
      >
        Drag: frequency/gain · Right-click or Shift+F10: type · Arrows: frequency/gain · Shift: fine
        · Wheel or +/−: Q/BW · Home: zero gain
        {descriptor.id === "eq-parametric" && " · Pass: no gain · Higher-order pass/shelf: fixed Q"}
      </p>
    </div>
  );
}
