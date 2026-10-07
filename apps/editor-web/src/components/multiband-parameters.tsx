import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import type { ReactNode } from "react";
import type { RackEffect } from "@/lib/effect-presets";

const ENVELOPE_FIELDS = [
  ["attackMs", "AttackMs", "Attack"],
  ["releaseMs", "ReleaseMs", "Release"],
  ["kneeDB", "KneeDB", "Soft knee"],
  ["makeupGainDB", "MakeupGainDB", "Makeup"],
  ["autoMakeup", "AutoMakeup", "Auto gain"],
] as const;

export function MultibandParameters({
  descriptor,
  node,
  disabled,
  onChange,
  numeric,
  curve,
}: {
  descriptor: EffectDescriptor;
  node: RackEffect;
  disabled: boolean;
  onChange(params: RackEffect["params"]): void;
  numeric(props: {
    parameter: EffectParameterDescriptor;
    label: string;
    value: number;
    disabled: boolean;
    onChange(value: number): void;
  }): ReactNode;
  curve(index: number, name: string, graphParams: RackEffect["params"]): ReactNode;
}) {
  const parameter = (field: string) => descriptor.parameters.find((entry) => entry.id === field);
  const value = (field: string) => Number(node.params[field] ?? parameter(field)?.default ?? 0);
  const count = Math.max(2, Math.min(4, Math.round(value("bands") || 3)));
  const rows =
    count === 2
      ? [
          ["low", "Low"],
          ["mid", "High"],
        ]
      : count === 3
        ? [
            ["low", "Low"],
            ["mid", "Mid"],
            ["high", "High"],
          ]
        : [
            ["low", "Low"],
            ["mid", "Low mid"],
            ["upper", "High mid"],
            ["high", "High"],
          ];
  const bandValue = (prefix: string, shared: string, suffix: string) =>
    value("perBand") ? Number(node.params[prefix + suffix] ?? value(shared)) : value(shared);
  const changeBand = (field: string, nextValue: number) => {
    const params = { ...node.params };
    if (!value("perBand")) {
      for (const prefix of ["low", "mid", "upper", "high"])
        for (const [shared, suffix] of ENVELOPE_FIELDS) params[prefix + suffix] = value(shared);
    }
    onChange({ ...params, perBand: 1, [field]: nextValue });
  };
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs">
          Bands
          <select
            className="studio-field border px-2 py-1"
            value={count}
            disabled={disabled}
            onChange={(event) => onChange({ ...node.params, bands: Number(event.target.value) })}
          >
            {[2, 3, 4]
              .filter((n) => n <= (parameter("bands")?.max ?? 3))
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
        </label>
        {parameter("topology") && (
          <label className="flex items-center gap-2 text-xs">
            Topology
            <select
              className="studio-field border px-2 py-1"
              value={String(node.params.topology ?? "feedforward")}
              disabled={disabled}
              onChange={(event) => onChange({ ...node.params, topology: event.target.value })}
            >
              {parameter("topology")?.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs">
          Crossover order
          <select
            className="studio-field border px-2 py-1"
            value={value("order")}
            disabled={disabled}
            onChange={(event) => onChange({ ...node.params, order: Number(event.target.value) })}
          >
            {Array.from({ length: (parameter("order")?.max ?? 24) / 2 }, (_, i) => (i + 1) * 2).map(
              (n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ),
            )}
          </select>
        </label>
        {Array.from({ length: count - 1 }, (_, index) => {
          const field = `cross${index + 1}Hz`;
          const source = parameter(field);
          if (!source) return null;
          const min = index ? Math.max(source.min, value(`cross${index}Hz`) + 100) : source.min;
          const max =
            index < count - 2
              ? Math.min(source.max, value(`cross${index + 2}Hz`) - 100)
              : source.max;
          return (
            <div key={field} className="w-20">
              {numeric({
                parameter: { ...source, min, max },
                label: `Crossover ${index + 1}`,
                value: value(field),
                disabled,
                onChange: (next) =>
                  onChange({
                    ...node.params,
                    [field]: Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : next,
                  }),
              })}
            </div>
          );
        })}
      </div>
      {rows.map(([prefix, name], index) => {
        const auto = Boolean(bandValue(prefix, "autoMakeup", "AutoMakeup"));
        const graphParams: RackEffect["params"] = {
          thresholdDB: value(`${prefix}ThresholdDB`),
          kneeDB: bandValue(prefix, "kneeDB", "KneeDB"),
        };
        const controls = [
          [`${prefix}AttackMs`, "Attack", bandValue(prefix, "attackMs", "AttackMs")],
          [`${prefix}ReleaseMs`, "Release", bandValue(prefix, "releaseMs", "ReleaseMs")],
          [`${prefix}ThresholdDB`, "Threshold", value(`${prefix}ThresholdDB`)],
          [`${prefix}Ratio`, "Ratio", value(`${prefix}Ratio`)],
          [`${prefix}KneeDB`, "Soft knee", bandValue(prefix, "kneeDB", "KneeDB")],
          [`${prefix}MakeupGainDB`, "Makeup", bandValue(prefix, "makeupGainDB", "MakeupGainDB")],
        ] as const;
        return (
          <fieldset
            key={prefix}
            className="min-w-0 rounded-lg border border-border/70 bg-background/40 px-2 pb-2"
          >
            <legend className="px-1 text-xs font-semibold">{name}</legend>
            <div className="grid grid-cols-2 items-center gap-2 min-[480px]:grid-cols-3 min-[760px]:grid-cols-[repeat(6,minmax(0,1fr))_6.5rem]">
              {controls.map(([field, label, current]) => {
                const source = parameter(field);
                return source ? (
                  <div key={field} className="min-w-0">
                    {numeric({
                      parameter: { ...source, label: `${name} ${label}` },
                      label,
                      value: current,
                      disabled: disabled || (field.endsWith("MakeupGainDB") && auto),
                      onChange: (next) => changeBand(field, next),
                    })}
                  </div>
                ) : null;
              })}
              <div className="col-span-2 flex flex-col items-center gap-1 min-[480px]:col-span-3 min-[760px]:col-span-1">
                <div className="w-26">{curve(index, name, graphParams)}</div>
                <label className="flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    checked={auto}
                    disabled={disabled}
                    aria-label={`${name} auto gain`}
                    onChange={(event) =>
                      changeBand(`${prefix}AutoMakeup`, event.target.checked ? 1 : 0)
                    }
                  />
                  Auto gain
                </label>
              </div>
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
