import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { EffectSlider } from "@/components/effect-slider";
import type { KernelClient } from "@/kernel/client";
import type { RackEffect } from "@/lib/effect-presets";

function NumericParameter({
  parameter,
  value,
  disabled,
  onChange,
}: {
  parameter: EffectParameterDescriptor;
  value: number;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(Number.isFinite(value) ? String(value) : "");
  }, [value]);
  const logarithmic = parameter.scale === "log" && parameter.min > 0;
  const sliderValue = logarithmic ? Math.log(Math.max(parameter.min, value)) : value;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm">
        {parameter.label}
        {parameter.unit && ` (${parameter.unit})`}
      </label>
      <div className="flex items-center gap-3">
        <EffectSlider
          className="flex-1"
          aria-label={`${parameter.label} slider`}
          disabled={disabled}
          value={[Number.isFinite(sliderValue) ? sliderValue : parameter.min]}
          min={logarithmic ? Math.log(parameter.min) : parameter.min}
          max={logarithmic ? Math.log(parameter.max) : parameter.max}
          step={logarithmic ? 0.001 : parameter.step || (parameter.max - parameter.min) / 1000}
          onValueChange={(values) => {
            const position = Array.isArray(values) ? values[0] : values;
            onChange(logarithmic ? Math.exp(position) : position);
          }}
        />
        <input
          id={id}
          className="w-28 rounded border px-2 py-1 text-sm"
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
  return (
    <div>
      <svg
        ref={svg}
        viewBox="0 0 400 160"
        className="w-full rounded border bg-muted/30"
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
        <path d="M0 80H400" stroke="currentColor" opacity="0.25" />
        <path
          data-testid="effect-response-path"
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
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
  return (
    <div className="space-y-4">
      {descriptor.view !== "generic" && !nonlinearMoog && (
        <EffectCurve {...{ descriptor, node, disabled, client, sampleRate, onChange }} />
      )}
      {nonlinearMoog && (
        <p className="text-xs text-muted-foreground">
          Moog response depends on the input signal. Adjust its controls and use live preview.
        </p>
      )}
      {descriptor.parameters
        .filter((parameter) => parameter.id !== "irIndex")
        .map((parameter) => {
          const field = `${id}-${parameter.id}`;
          if (parameter.type === "enum")
            return (
              <div key={parameter.id}>
                <label htmlFor={field} className="text-sm">
                  {parameter.label}
                </label>
                <select
                  id={field}
                  className="ml-3 rounded border px-2 py-1 text-sm"
                  value={String(node.params[parameter.id])}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...node.params, [parameter.id]: event.target.value })
                  }
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
              <label key={parameter.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(node.params[parameter.id])}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...node.params, [parameter.id]: event.target.checked ? 1 : 0 })
                  }
                />
                {parameter.label}
              </label>
            );
          return (
            <NumericParameter
              key={parameter.id}
              parameter={parameter}
              value={Number(node.params[parameter.id])}
              disabled={disabled}
              onChange={(value) => onChange({ ...node.params, [parameter.id]: value })}
            />
          );
        })}
    </div>
  );
}
