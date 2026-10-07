import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import type { ReactNode } from "react";
import { EQ_BAND_COLORS } from "@/components/parametric-eq-graph";
import type { RackEffect } from "@/lib/effect-presets";

const FIELDS = [
  ["FreqHz", "Frequency"],
  ["GainDB", "Gain"],
  ["Q", "Q / BW"],
  ["ThresholdDB", "Threshold"],
  ["Ratio", "Ratio"],
  ["KneeDB", "Knee"],
  ["RangeDB", "Range"],
  ["AttackMs", "Attack"],
  ["ReleaseMs", "Release"],
] as const;

export function DynamicEQParameters({
  descriptor,
  node,
  control,
  frequency,
  curve,
}: {
  descriptor: EffectDescriptor;
  node: RackEffect;
  control(parameter: EffectParameterDescriptor, label?: string): ReactNode;
  frequency: ReactNode;
  curve(index: number, graphParams: RackEffect["params"]): ReactNode;
}) {
  const count = Math.max(1, Math.min(8, Math.round(Number(node.params.bands) || 3)));
  return (
    <div className="space-y-1">
      {frequency}
      <p className="text-xs text-muted-foreground">
        EQ curve: static gain. Band I/O: steady-state dynamics at the band frequency.
      </p>
      {Array.from({ length: count }, (_, index) => {
        const prefix = `band${index + 1}`;
        const parameter = (suffix: string) =>
          descriptor.parameters.find((entry) => entry.id === prefix + suffix);
        const value = (suffix: string) =>
          Number(node.params[prefix + suffix] ?? parameter(suffix)?.default);
        return (
          <fieldset
            key={prefix}
            className="min-w-0 rounded-lg border border-border/70 bg-background/40 px-2 py-1"
          >
            <legend className="sr-only">Band {index + 1}</legend>
            <div className="grid items-center gap-3 min-[900px]:grid-cols-[minmax(0,1fr)_8rem]">
              <div className="grid min-w-0 items-center gap-3 min-[1000px]:grid-cols-[7rem_minmax(0,1fr)]">
                <div className="grid grid-cols-2 gap-1 min-[1000px]:grid-cols-1">
                  <span
                    className="col-span-2 text-xs font-semibold min-[1000px]:col-span-1"
                    style={{ color: EQ_BAND_COLORS[index] }}
                    aria-hidden="true"
                  >
                    Band {index + 1}
                  </span>
                  {["Type", "Mode"].map((suffix) => {
                    const source = parameter(suffix);
                    return source ? (
                      <div key={suffix} className="min-w-0">
                        {control(source, suffix)}
                      </div>
                    ) : null;
                  })}
                </div>
                <div className="grid grid-cols-3 items-start gap-2 min-[560px]:grid-cols-6 min-[1000px]:grid-cols-9">
                  {FIELDS.map(([suffix, label]) => {
                    const source = parameter(suffix);
                    return source ? (
                      <div key={suffix} className="min-w-0">
                        {control(
                          {
                            ...source,
                            label: `Band ${index + 1} ${label}`,
                          },
                          label,
                        )}
                      </div>
                    ) : null;
                  })}
                </div>
              </div>
              <div className="w-32 justify-self-end">
                {curve(index, { thresholdDB: value("ThresholdDB"), kneeDB: value("KneeDB") })}
              </div>
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
