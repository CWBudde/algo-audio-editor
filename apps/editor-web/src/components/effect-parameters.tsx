import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { DynamicsGraph } from "@/components/dynamics-graph";
import { EffectKnob } from "@/components/effect-knob";
import { GraphicEQGraph } from "@/components/graphic-eq-graph";
import { EQ_BAND_COLORS, ParametricEQGraph } from "@/components/parametric-eq-graph";
import type { KernelClient } from "@/kernel/client";
import type { RackEffect } from "@/lib/effect-presets";

function NumericParameter({
  parameter,
  value,
  disabled,
  onChange,
  label = parameter.label,
  vertical = false,
}: {
  parameter: EffectParameterDescriptor;
  value: number;
  disabled: boolean;
  onChange(value: number): void;
  label?: string;
  vertical?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(Number.isFinite(value) ? String(Number(value.toPrecision(6))) : "");
  }, [value]);
  return (
    <div className="min-w-0 space-y-1 text-center">
      <label
        htmlFor={id}
        className="block truncate text-[11px] font-medium text-muted-foreground"
        title={parameter.label}
      >
        {label}
      </label>
      {vertical ? (
        <div className="relative mx-auto flex h-36 w-8 justify-center">
          {parameter.min < 0 && parameter.max > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-waveform-center"
            />
          )}
          <input
            type="range"
            aria-label={`${parameter.label} slider`}
            aria-orientation="vertical"
            aria-valuetext={`${value}${parameter.unit ? ` ${parameter.unit}` : ""}`}
            className="graphic-eq-fader relative h-full w-8 cursor-ns-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            min={parameter.min}
            max={parameter.max}
            step={parameter.step || "any"}
            value={Number.isFinite(value) ? value : parameter.default}
            disabled={disabled}
            title="Drag to adjust. Double-click to reset."
            onChange={(event) => onChange(Number(event.target.value))}
            onDoubleClick={() => {
              if (!disabled) onChange(parameter.default);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (disabled) return;
              const current = Number.isFinite(value) ? value : parameter.default;
              const step = parameter.step || (event.shiftKey ? 0.1 : 0.5);
              let next: number;
              switch (event.key) {
                case "ArrowUp":
                case "ArrowRight":
                  next = current + step;
                  break;
                case "ArrowDown":
                case "ArrowLeft":
                  next = current - step;
                  break;
                case "PageUp":
                  next = current + step * 10;
                  break;
                case "PageDown":
                  next = current - step * 10;
                  break;
                case "Home":
                  next = parameter.min;
                  break;
                case "End":
                  next = parameter.max;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              onChange(
                Math.max(parameter.min, Math.min(parameter.max, Number(next.toPrecision(7)))),
              );
            }}
          />
        </div>
      ) : (
        <EffectKnob {...{ parameter, value, disabled, onChange }} />
      )}
      <div className="studio-field flex items-center border focus-within:ring-1 focus-within:ring-ring">
        <input
          id={id}
          aria-label={`${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ""}`}
          className="w-full min-w-0 bg-transparent py-0.5 pl-1 text-center text-xs tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          type="number"
          min={parameter.min}
          max={parameter.max}
          step={parameter.step || "any"}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
            onChange(event.target.value.trim() ? Number(event.target.value) : Number.NaN);
          }}
        />
        {parameter.unit && (
          <span className="shrink-0 pr-1 text-[10px] text-muted-foreground">{parameter.unit}</span>
        )}
      </div>
    </div>
  );
}
function EffectCurve({
  descriptor,
  node,
  sampleRate,
  client,
  disabled,
  onChange,
}: {
  descriptor: EffectDescriptor;
  node: RackEffect;
  sampleRate: number;
  client?: KernelClient;
  disabled: boolean;
  onChange(params: RackEffect["params"]): void;
}) {
  const [points, setPoints] = useState<[number, number][]>([]);
  const [error, setError] = useState<string>();
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    let active = true;
    setError(undefined);
    const timer = setTimeout(() => {
      if (!client) return;
      void client
        .call("effects.response", {
          effectId: descriptor.id,
          params: node.params,
          sampleRate,
          points: 256,
          mode: descriptor.view === "dynamics" ? "transfer" : "frequency",
        })
        .then(
          (response) => {
            if (!active) return;
            const data = new DataView(response.data);
            setPoints(
              Array.from({ length: response.count }, (_, index): [number, number] => [
                data.getFloat64(index * 16, true),
                data.getFloat64(index * 16 + 8, true),
              ]),
            );
          },
          (error) => {
            if (active) setError(String(error));
          },
        );
    }, 20);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, descriptor.id, descriptor.view, node.params, sampleRate]);
  const activeBands = Number(node.params.bands ?? 8);
  const frequency = descriptor.parameters
    .filter((parameter) => parameter.type === "number" && /freq|frequency/i.test(parameter.id))
    .slice(0, activeBands);
  const gain = descriptor.parameters
    .filter((parameter) => parameter.type === "number" && /gain/i.test(parameter.id))
    .slice(0, frequency.length || undefined);
  const transfer = descriptor.view === "dynamics";
  const minimum = points[0]?.[0] ?? (transfer ? -80 : 20);
  const maximum = points.at(-1)?.[0] ?? (transfer ? 0 : sampleRate * 0.49);
  const x = (value: number) =>
    transfer
      ? (400 * (value - minimum)) / (maximum - minimum)
      : (400 * Math.log(Math.max(minimum, value) / minimum)) / Math.log(maximum / minimum);
  const y = (db: number) =>
    transfer
      ? 160 - (160 * (Math.max(-80, Math.min(24, db)) + 80)) / 104
      : 80 - Math.max(-36, Math.min(36, db)) * 2;
  const path = points
    .map(([value, db], index) => `${index ? "L" : "M"}${x(value)},${y(db)}`)
    .join(" ");
  const editCurve = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || descriptor.view !== "eq" || !gain.length) return;
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const hz =
      minimum *
      (maximum / minimum) ** Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const centers = frequency.length
      ? frequency.map((parameter) => Number(node.params[parameter.id]))
      : gain.map((parameter) => Number(/([\d.]+)\s*Hz/i.exec(parameter.label)?.[1]));
    if (centers.some((center) => !Number.isFinite(center) || center <= 0)) return;
    const index = centers.reduce(
      (best, center, index) =>
        Math.abs(Math.log(center / hz)) < Math.abs(Math.log(centers[best] / hz)) ? index : best,
      0,
    );
    const target = gain[index];
    const db = (80 - ((event.clientY - box.top) / box.height) * 160) / 2;
    onChange({
      ...node.params,
      [target.id]: Math.max(target.min, Math.min(target.max, db)),
      ...(frequency[index]
        ? {
            [frequency[index].id]: Math.max(
              frequency[index].min,
              Math.min(frequency[index].max, hz),
            ),
          }
        : {}),
    });
  };
  if (descriptor.id === "eq-parametric")
    return (
      <div>
        <ParametricEQGraph {...{ descriptor, node, points, sampleRate, disabled, onChange }} />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  if (descriptor.id === "eq-graphic")
    return (
      <div>
        <GraphicEQGraph {...{ descriptor, node, points, sampleRate, disabled, onChange }} />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  if (descriptor.view === "dynamics")
    return (
      <div className="mx-auto max-w-[40rem]">
        <DynamicsGraph {...{ descriptor, node, points, disabled }} />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <div className="mx-auto max-w-[40rem]">
      <svg
        ref={svg}
        viewBox="0 0 400 160"
        className="effect-graph w-full border"
        role="img"
        aria-label={`${descriptor.name} response curve`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          editCurve(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons & 1) editCurve(event);
        }}
      >
        <title>{descriptor.name} response computed by the audio kernel</title>
        <path d="M0 80H400" stroke="currentColor" className="text-waveform-center" />
        <path
          data-testid="effect-response-path"
          className="text-waveform-peak"
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p className="text-xs text-muted-foreground">
        {descriptor.view === "eq" ? "Click the curve to adjust the nearest band. " : ""}Kernel
        response ·{" "}
        {transfer
          ? `${minimum}–${maximum} dB input / −80–24 dB output`
          : `${minimum.toFixed(0)}–${maximum.toFixed(0)} Hz · ±36 dB`}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function EffectParameters({
  descriptor,
  node,
  disabled,
  client,
  sampleRate,
  onChange,
}: {
  descriptor: EffectDescriptor;
  node: RackEffect;
  disabled: boolean;
  client?: KernelClient;
  sampleRate: number;
  onChange(params: RackEffect["params"]): void;
}) {
  const id = useId();
  const nonlinearMoog =
    descriptor.id === "filter-moog" ||
    (descriptor.id.startsWith("filter") && node.params.family === "moog");
  const parameters = descriptor.parameters.filter((parameter) => parameter.id !== "irIndex");
  const control = (
    parameter: EffectParameterDescriptor,
    label = parameter.label,
    vertical = false,
  ) => {
    const field = `${id}-${parameter.id}`;
    if (parameter.type === "enum")
      return (
        <div
          key={parameter.id}
          className={label === "Type" ? "flex min-w-0 items-center gap-2" : "min-w-0 space-y-1"}
        >
          <label htmlFor={field} className="block text-xs">
            {label}
          </label>
          <select
            id={field}
            aria-label={parameter.label}
            className="studio-field w-full min-w-0 border px-1.5 py-1 text-xs"
            value={String(node.params[parameter.id])}
            disabled={disabled}
            onChange={(event) => onChange({ ...node.params, [parameter.id]: event.target.value })}
          >
            {parameter.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    if (parameter.type === "boolean")
      return (
        <label key={parameter.id} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={Boolean(node.params[parameter.id])}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...node.params, [parameter.id]: event.target.checked ? 1 : 0 })
            }
          />
          {label}
        </label>
      );
    return (
      <NumericParameter
        key={parameter.id}
        {...{ parameter, label, disabled, vertical }}
        value={Number(node.params[parameter.id])}
        onChange={(value) => onChange({ ...node.params, [parameter.id]: value })}
      />
    );
  };
  return (
    <div className="space-y-2.5">
      {descriptor.view !== "generic" && !nonlinearMoog && (
        <div
          className={
            descriptor.id === "eq-parametric"
              ? "grid grid-cols-[minmax(0,1fr)_5rem] items-start gap-3"
              : undefined
          }
        >
          <EffectCurve {...{ descriptor, node, disabled, client, sampleRate, onChange }} />
          {descriptor.id === "eq-parametric" && (
            <div className="space-y-2.5">
              {parameters
                .filter((parameter) => !/^band\d/.test(parameter.id))
                .map((parameter) => control(parameter))}
            </div>
          )}
        </div>
      )}
      {nonlinearMoog && (
        <p className="text-xs text-muted-foreground">
          Moog response depends on the input signal. Adjust its controls and use live preview.
        </p>
      )}
      {descriptor.id === "eq-parametric" ? (
        <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 min-[1000px]:grid-cols-4">
          {Array.from(
            { length: Math.max(1, Math.min(8, Math.round(Number(node.params.bands) || 4))) },
            (_, index) => {
              const band = index + 1;
              const fields = parameters.filter((parameter) =>
                parameter.id.startsWith(`band${band}`),
              );
              return (
                <fieldset
                  key={band}
                  className="min-w-0 rounded-lg border border-border/70 bg-background/40 px-2 pb-2"
                >
                  <legend
                    className="px-1 text-[11px] font-semibold"
                    style={{ color: EQ_BAND_COLORS[index] }}
                  >
                    Band {band}
                  </legend>
                  {fields
                    .filter((parameter) => parameter.type === "enum")
                    .map((parameter) => control(parameter, "Type"))}
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    {fields
                      .filter((parameter) => parameter.type !== "enum")
                      .map((parameter) =>
                        control(
                          parameter,
                          parameter.id.endsWith("FreqHz")
                            ? "Frequency"
                            : parameter.id.endsWith("GainDB")
                              ? "Gain"
                              : parameter.label.replace(/^Band\s*\d+\s*/i, ""),
                        ),
                      )}
                  </div>
                </fieldset>
              );
            },
          )}
        </div>
      ) : descriptor.id === "eq-graphic" ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(3.5rem,1fr))] items-start gap-2">
          {parameters
            .filter((parameter) => parameter.id !== "order")
            .map((parameter) => control(parameter, parameter.label.replace(/\s*gain$/i, ""), true))}
          <div className="border-l border-border pl-2">
            {parameters
              .filter((parameter) => parameter.id === "order")
              .map((parameter) => control(parameter, "Order", true))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,7rem))] items-start gap-3">
          {parameters.map((parameter) => control(parameter))}
        </div>
      )}
    </div>
  );
}
