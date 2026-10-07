import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { DynamicsGraph } from "@/components/dynamics-graph";
import { EffectKnob } from "@/components/effect-knob";
import { FilterResponseGraph } from "@/components/filter-response-graph";
import { GraphicEQGraph } from "@/components/graphic-eq-graph";
import { MultibandParameters } from "@/components/multiband-parameters";
import { EQ_BAND_COLORS, ParametricEQGraph } from "@/components/parametric-eq-graph";
import type { KernelClient } from "@/kernel/client";
import { isCompactDynamics, isStandardFilter, isWeightingFilter } from "@/lib/effect-menu";
import type { RackEffect } from "@/lib/effect-presets";
import { filterFamilySupports, filterOrderOptions, filterParameters } from "@/lib/filter-controls";

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
  thumbnail = false,
  graphNode,
}: {
  descriptor: EffectDescriptor;
  node: RackEffect;
  sampleRate: number;
  client?: KernelClient;
  disabled: boolean;
  onChange(params: RackEffect["params"]): void;
  thumbnail?: boolean;
  graphNode?: RackEffect;
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
            if (active) {
              setPoints([]);
              setError(String(error));
            }
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
  if (isStandardFilter(descriptor.id) || isWeightingFilter(descriptor.id))
    return (
      <div>
        <FilterResponseGraph
          name={isWeightingFilter(descriptor.id) ? descriptor.name : "Filter"}
          {...{ points, sampleRate }}
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
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
      <div
        className={
          thumbnail
            ? "w-full"
            : isCompactDynamics(descriptor.id)
              ? "mx-auto w-full max-w-[22.5rem]"
              : "mx-auto max-w-[40rem]"
        }
      >
        <DynamicsGraph
          {...{ descriptor, points, disabled, thumbnail }}
          node={graphNode ?? node}
          compact={isCompactDynamics(descriptor.id)}
        />
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
  const standardFilter = isStandardFilter(descriptor.id);
  const kind = String(node.params.kind ?? "lowpass");
  const family = String(node.params.family ?? "rbj");
  const orderMaximum =
    descriptor.parameters.find((parameter) => parameter.id === "order")?.max ?? 12;
  const parameters = (
    standardFilter ? filterParameters(descriptor, node) : descriptor.parameters
  ).filter((parameter) => parameter.id !== "irIndex");
  const changeFilter = (field: string, value: string | number) => {
    const params = { ...node.params, [field]: value };
    const nextKind = String(params.kind ?? "lowpass");
    if (!filterFamilySupports(nextKind, String(params.family ?? "rbj"))) params.family = "rbj";
    if (field === "kind" || field === "family") {
      const q = Number(
        params.q ?? descriptor.parameters.find((parameter) => parameter.id === "q")?.default ?? 1,
      );
      params.q =
        params.family === "moog" ? Math.max(0, Math.min(4, q)) : Math.max(0.2, Math.min(8, q));
    }
    const orders = filterOrderOptions(nextKind, String(params.family ?? "rbj"), orderMaximum);
    if (orders.length && !orders.includes(Number(params.order)))
      params.order =
        params.family === "moog"
          ? (orders.findLast((order) => order <= Number(params.order)) ?? orders[0])
          : (orders.find((order) => order >= Number(params.order)) ?? orders.at(-1) ?? 2);
    onChange(params);
  };
  const control = (
    parameter: EffectParameterDescriptor,
    label = parameter.label,
    vertical = false,
  ) => {
    const field = `${id}-${parameter.id}`;
    if (standardFilter && parameter.id === "order") {
      const options = filterOrderOptions(kind, family, orderMaximum);
      const selected =
        family === "moog"
          ? (options.findLast((order) => order <= Number(node.params.order)) ?? options[0])
          : (options.find((order) => order >= Number(node.params.order)) ?? options.at(-1));
      return (
        <label key={parameter.id} className="min-w-0 space-y-1 text-xs">
          <span className="block">{family === "moog" ? "Oversampling" : "Order"}</span>
          <select
            className="studio-field w-full border px-2 py-1.5 text-xs"
            aria-label={family === "moog" ? "Oversampling" : "Order"}
            value={selected}
            disabled={disabled}
            onChange={(event) => changeFilter("order", Number(event.target.value))}
          >
            {options.map((order, index) => (
              <option key={order} value={order}>
                {family === "moog" ? `${2 ** index}×` : order}
              </option>
            ))}
          </select>
        </label>
      );
    }
    const gainBand = /^band(\d+)GainDB$/.exec(parameter.id)?.[1];
    const passGain =
      descriptor.id === "eq-parametric" &&
      gainBand !== undefined &&
      ["highpass", "lowpass"].includes(String(node.params[`band${gainBand}Type`]));
    const qBand = /^band(\d+)Q$/.exec(parameter.id)?.[1];
    const fixedQ =
      descriptor.id === "eq-parametric" &&
      qBand !== undefined &&
      Number(node.params[`band${qBand}Order`] ?? 2) > 2 &&
      String(node.params[`band${qBand}Type`] ?? "peak") !== "peak";
    if (descriptor.id === "eq-parametric" && /^band\d+Order$/.test(parameter.id))
      return (
        <label key={parameter.id} className="flex shrink-0 items-center gap-2 text-xs">
          Order
          <select
            aria-label={parameter.label}
            className="studio-field min-w-14 border px-1.5 py-1 text-xs tabular-nums"
            value={Number(node.params[parameter.id] ?? parameter.default)}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...node.params, [parameter.id]: Number(event.target.value) })
            }
          >
            {[2, 4, 6, 8, 10, 12].map((order) => (
              <option key={order} value={order}>
                {order}
              </option>
            ))}
          </select>
        </label>
      );
    if (parameter.type === "enum")
      return (
        <div
          key={parameter.id}
          className={
            label === "Type" && !standardFilter
              ? "flex min-w-0 items-center gap-2"
              : "min-w-0 space-y-1"
          }
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
            onChange={(event) =>
              standardFilter
                ? changeFilter(parameter.id, event.target.value)
                : onChange({ ...node.params, [parameter.id]: event.target.value })
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
        {...{ parameter, vertical }}
        label={fixedQ ? "Q (fixed)" : label}
        disabled={
          disabled ||
          passGain ||
          fixedQ ||
          (descriptor.id === "dyn-compressor" &&
            parameter.id === "makeupGainDB" &&
            Boolean(node.params.autoMakeup))
        }
        value={Number(node.params[parameter.id])}
        onChange={(value) => onChange({ ...node.params, [parameter.id]: value })}
      />
    );
  };
  if (descriptor.id === "dyn-multiband")
    return (
      <MultibandParameters
        {...{ descriptor, node, disabled, onChange }}
        numeric={(props) => <NumericParameter {...props} />}
        curve={(index, name, params) => (
          <EffectCurve
            descriptor={{ ...descriptor, name: `${name} band`, view: "dynamics" }}
            node={{ ...node, params: { ...node.params, responseBand: index } }}
            graphNode={{ ...node, params }}
            {...{ disabled, client, sampleRate, onChange }}
            thumbnail
          />
        )}
      />
    );
  if (isCompactDynamics(descriptor.id)) {
    const fields = [
      "thresholdDB",
      "ratio",
      "kneeDB",
      "makeupGainDB",
      "rangeDB",
      "attackMs",
      "releaseMs",
      "holdMs",
      ...(descriptor.id === "dyn-gate" ? ["topology"] : []),
      "lookaheadMs",
    ];
    return (
      <div className="grid items-center gap-5 min-[760px]:grid-cols-2">
        <EffectCurve {...{ descriptor, node, disabled, client, sampleRate, onChange }} />
        <div className="grid min-w-0 grid-cols-2 items-start gap-x-3 gap-y-5">
          {fields
            .flatMap((field) => parameters.filter((parameter) => parameter.id === field))
            .map((parameter) => (
              <div key={parameter.id} className="min-w-0">
                {control(
                  parameter,
                  (
                    {
                      thresholdDB: "Threshold",
                      ratio: "Ratio",
                      kneeDB: "Knee",
                      makeupGainDB: "Makeup",
                      rangeDB: "Range",
                      attackMs: "Attack",
                      releaseMs: "Release",
                      holdMs: "Hold",
                      topology: "Topology",
                      lookaheadMs: "Lookahead",
                    } as Record<string, string>
                  )[parameter.id],
                )}
                {parameter.id === "makeupGainDB" &&
                  parameters
                    .filter((entry) => entry.id === "autoMakeup")
                    .map((entry) => (
                      <div key={entry.id} className="mt-2 flex justify-center">
                        {control(entry, "Auto gain")}
                      </div>
                    ))}
              </div>
            ))}
          <div className="col-span-2 flex flex-wrap items-start gap-3 empty:hidden">
            {parameters
              .filter(
                (parameter) => !fields.includes(parameter.id) && parameter.id !== "autoMakeup",
              )
              .map((parameter) => (
                <div key={parameter.id} className="min-w-0 flex-1 basis-20">
                  {control(
                    parameter,
                    parameter.id === "rmsWindowMs" ? "RMS window" : parameter.label,
                  )}
                </div>
              ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      {(descriptor.view !== "generic" || standardFilter) && !nonlinearMoog && (
        <EffectCurve
          key={descriptor.id}
          {...{ descriptor, node, disabled, client, sampleRate, onChange }}
        />
      )}
      {nonlinearMoog && (
        <p className="text-xs text-muted-foreground">
          Moog response depends on the input signal. Adjust its controls and use live preview.
        </p>
      )}
      {standardFilter ? (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-end gap-3">
            {["kind", "family", "order"]
              .flatMap((field) => parameters.filter((parameter) => parameter.id === field))
              .map((parameter) => (
                <div
                  key={parameter.id}
                  className={parameter.id === "order" ? "w-24" : "min-w-36 flex-1"}
                >
                  {control(parameter)}
                </div>
              ))}
          </div>
          <div className="flex flex-wrap items-start gap-3">
            {parameters
              .filter((parameter) => !["kind", "family", "order"].includes(parameter.id))
              .map((parameter) => (
                <div key={parameter.id} className="w-24">
                  {control(parameter)}
                </div>
              ))}
          </div>
          {family === "rbj" && (
            <p className="text-xs text-muted-foreground">Single biquad (second order).</p>
          )}
          {kind === "allpass" && (
            <p className="text-xs text-muted-foreground">
              All-pass changes phase; the magnitude response stays flat.
            </p>
          )}
          {family !== "rbj" && family !== "moog" && kind === "peak" && (
            <p className="text-xs text-muted-foreground">
              Order sets the prototype order; the peak uses twice as many poles.
            </p>
          )}
        </div>
      ) : descriptor.id === "eq-parametric" ? (
        <div
          className={`grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 ${Number(node.params.bands) === 6 ? "min-[1000px]:grid-cols-3" : "min-[1000px]:grid-cols-4"}`}
        >
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
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {fields
                        .filter((parameter) => parameter.type === "enum")
                        .map((parameter) => control(parameter, "Type"))}
                    </div>
                    {fields
                      .filter((parameter) => parameter.id.endsWith("Order"))
                      .map((parameter) => control(parameter))}
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    {fields
                      .filter(
                        (parameter) => parameter.type !== "enum" && !parameter.id.endsWith("Order"),
                      )
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
