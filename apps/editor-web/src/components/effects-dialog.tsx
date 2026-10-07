import type { EffectDescriptor } from "@aae/protocol";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { EffectParameters } from "@/components/effect-parameters";
import type { EffectsView } from "@/hooks/use-effects";
import type { KernelClient } from "@/kernel/client";
import {
  effectMenuEntries,
  isCompactDynamics,
  isStandardFilter,
  isWeightingFilter,
} from "@/lib/effect-menu";
import type { EffectPreset, RackEffect } from "@/lib/effect-presets";
import { createRackEffect, stereoSelection, validRack } from "@/lib/effect-rack";

interface Props {
  view?: EffectsView;
  descriptors: EffectDescriptor[];
  presets: EffectPreset[];
  client?: KernelClient;
  catalogError?: string;
  onChange(change: Partial<Pick<EffectsView, "rack" | "wet" | "bypass">>): void;
  onPreview(): void;
  onStopPreview(): void;
  onApply(allowClipping?: boolean): void;
  onCancel(): void;
  onLoadIR(nodeId: string, file: File): void;
  onSavePreset(name: string): void;
  onDeletePreset(id: string): void;
  onLoadPreset(id: string): void;
}
export function EffectsDialog(props: Props) {
  const { view, descriptors } = props;
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | undefined>(undefined);
  const open = Boolean(view);
  const latestOpen = useRef(open);
  latestOpen.current = open;
  const [effectId, setEffectId] = useState("");
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = undefined;
      return;
    }
    opener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element.showModal();
    element.querySelector<HTMLElement>("select, button")?.focus();
    return () => {
      element.close();
      if (latestOpen.current && opener.current?.isConnected) {
        opener.current.focus({ preventScroll: true });
        opener.current = undefined;
      }
    };
  }, [open]);
  const working = view && !["idle", "ready"].includes(view.phase);
  const entries = effectMenuEntries(descriptors);
  const singleType = view?.rack.length === 1 ? view.rack[0].type : "";
  const title = isStandardFilter(singleType)
    ? "Filter"
    : isWeightingFilter(singleType)
      ? "Weighting filters"
      : "Effects rack";
  const valid = view && validRack(view.rack, descriptors, view.selection.channelMask);
  const changeNode = (index: number, change: Partial<RackEffect>) => {
    if (view)
      props.onChange({
        rack: view.rack.map((node, i) => (i === index ? { ...node, ...change } : node)),
      });
  };
  const move = (index: number, direction: number) => {
    if (!view) return;
    const rack = [...view.rack];
    const target = index + direction;
    if (target < 0 || target >= rack.length) return;
    [rack[index], rack[target]] = [rack[target], rack[index]];
    props.onChange({ rack });
  };
  return (
    <dialog
      ref={dialog}
      className={`studio-dialog m-auto max-h-[calc(100dvh-2rem)] ${isStandardFilter(singleType) || isWeightingFilter(singleType) || isCompactDynamics(singleType) || singleType === "dyn-multiband" ? "w-[min(51.2rem,calc(100vw-2rem))]" : "w-[min(64rem,calc(100vw-2rem))]"} overflow-y-auto border p-4 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]`}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-help`}
      onCancel={(event) => {
        event.preventDefault();
        if (view?.phase !== "committing") props.onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading font-semibold tracking-tight">
        {title}
      </h2>
      <p id={`${id}-help`} className="studio-dialog-help mt-1 text-muted-foreground">
        Preview the selected time and channels, then apply the rack in one undo step. A cursor uses
        the whole document.
      </p>
      {view && (
        <div className="mt-2.5 space-y-2.5">
          <div className="studio-section grid items-end gap-3 border px-3 py-2 sm:grid-cols-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`${id}-add`}
                  className="block text-xs font-medium text-muted-foreground"
                >
                  Add effect
                </label>
                <select
                  id={`${id}-add`}
                  className="studio-field mt-1 w-full border px-2 py-1.5 text-sm"
                  value={effectId}
                  disabled={Boolean(working) || view.rack.length >= 32}
                  onChange={(event) => setEffectId(event.target.value)}
                >
                  <option value="">Choose an effect</option>
                  {[...new Set(entries.map((descriptor) => descriptor.category))].map(
                    (category) => (
                      <optgroup key={category} label={category}>
                        {entries
                          .filter((effect) => effect.category === category)
                          .map((effect) => (
                            <option
                              key={effect.id}
                              value={effect.id}
                              disabled={
                                effect.channelMode === "stereo" &&
                                !stereoSelection(view.selection.channelMask)
                              }
                            >
                              {effect.name}
                            </option>
                          ))}
                      </optgroup>
                    ),
                  )}
                </select>
              </div>
              <button
                type="button"
                className="studio-button border px-3 py-1 disabled:opacity-50"
                disabled={Boolean(working) || !effectId || view.rack.length >= 32}
                onClick={() => {
                  const descriptor = descriptors.find((entry) => entry.id === effectId);
                  if (descriptor)
                    props.onChange({ rack: [...view.rack, createRackEffect(descriptor)] });
                }}
              >
                Add
              </button>
            </div>
            <details className="min-w-0 rounded border border-border/60 p-2">
              <summary className="cursor-pointer text-sm">User presets</summary>
              <div className="mt-2">
                <label htmlFor={`${id}-preset`} className="text-sm">
                  User preset
                </label>
                <select
                  id={`${id}-preset`}
                  className="studio-field mx-2 max-w-full border px-2 py-1 text-sm"
                  value={presetId}
                  disabled={Boolean(working)}
                  onChange={(event) => {
                    setPresetId(event.target.value);
                    if (event.target.value) props.onLoadPreset(event.target.value);
                  }}
                >
                  <option value="">Choose a preset</option>
                  {props.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={Boolean(working) || !presetId}
                  className="studio-button border px-2 py-1 text-sm disabled:opacity-50"
                  onClick={() => {
                    props.onDeletePreset(presetId);
                    setPresetId("");
                  }}
                >
                  Delete preset
                </button>
                <div className="mt-2 flex gap-2">
                  <input
                    className="studio-field min-w-0 flex-1 border px-2 py-1 text-sm"
                    aria-label="Preset name"
                    placeholder="Name this rack"
                    value={presetName}
                    disabled={Boolean(working)}
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="studio-button border px-2 py-1 text-sm disabled:opacity-50"
                    disabled={Boolean(working) || !valid || !presetName.trim()}
                    onClick={() => props.onSavePreset(presetName)}
                  >
                    Save preset
                  </button>
                </div>
              </div>
            </details>
          </div>
          <ol className="space-y-3" aria-label="Effect order">
            {view.rack.map((node, index) => {
              const original = descriptors.find((entry) => entry.id === node.type);
              const descriptor = isStandardFilter(node.type)
                ? (descriptors.find((entry) => entry.id === "filter") ?? original)
                : original;
              if (!descriptor)
                return (
                  <li key={node.id} role="alert">
                    Unavailable effect {node.type}
                  </li>
                );
              return (
                <li
                  key={node.id}
                  data-effect-id={descriptor.id}
                  className="effect-rack-node border p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border/60 pb-1.5">
                    <h3 className="text-sm font-semibold tracking-tight">
                      {index + 1}. {descriptor.name}
                    </h3>
                    <div className="flex min-w-0 items-center gap-2">
                      <label
                        className="text-xs text-muted-foreground"
                        htmlFor={`${id}-factory-${node.id}`}
                      >
                        Factory preset
                      </label>
                      <select
                        key={node.type}
                        id={`${id}-factory-${node.id}`}
                        className="studio-field min-w-0 max-w-52 border px-2 py-1 text-xs"
                        defaultValue=""
                        disabled={Boolean(working)}
                        onChange={(event) => {
                          const preset = descriptor.presets.find(
                            (entry) => entry.id === event.target.value,
                          );
                          if (preset)
                            changeNode(index, {
                              type: descriptor.id,
                              params: {
                                ...createRackEffect(descriptor).params,
                                ...preset.num,
                                ...preset.str,
                                ...(node.type === "reverb-conv"
                                  ? { irIndex: node.params.irIndex }
                                  : {}),
                              },
                            });
                        }}
                      >
                        <option value="">Default parameters</option>
                        {descriptor.presets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(node.bypassed)}
                          disabled={Boolean(working)}
                          onChange={(event) =>
                            changeNode(index, { bypassed: event.target.checked })
                          }
                        />{" "}
                        Bypass {descriptor.name}
                      </label>
                      <button
                        type="button"
                        className="studio-button size-7 border text-sm disabled:opacity-40"
                        aria-label={`Move ${descriptor.name} up`}
                        disabled={Boolean(working) || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="studio-button size-7 border text-sm disabled:opacity-40"
                        aria-label={`Move ${descriptor.name} down`}
                        disabled={Boolean(working) || index === view.rack.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="studio-button border px-2 py-1 text-xs disabled:opacity-40"
                        aria-label={`Remove ${descriptor.name}`}
                        disabled={Boolean(working)}
                        onClick={() =>
                          props.onChange({ rack: view.rack.filter((_, i) => i !== index) })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {node.type === "reverb-conv" && (
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-muted-foreground">
                        Impulse response WAV
                        <input
                          type="file"
                          accept="audio/wav,.wav"
                          disabled={Boolean(working)}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) props.onLoadIR(node.id, file);
                          }}
                        />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        {node.irName ?? "Load an impulse response before preview or apply."}
                      </p>
                    </div>
                  )}
                  {isWeightingFilter(node.type) && (
                    <label className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      Weighting
                      <select
                        aria-label="Weighting"
                        className="studio-field min-w-36 border px-2 py-1.5"
                        value={node.type}
                        disabled={Boolean(working)}
                        onChange={(event) => {
                          const next = descriptors.find((entry) => entry.id === event.target.value);
                          if (next)
                            changeNode(index, {
                              type: next.id,
                              params: createRackEffect(next).params,
                            });
                        }}
                      >
                        {descriptors
                          .filter((entry) => isWeightingFilter(entry.id))
                          .map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <EffectParameters
                    descriptor={descriptor}
                    node={
                      descriptor.id !== node.type
                        ? {
                            ...node,
                            params: { ...createRackEffect(descriptor).params, ...node.params },
                          }
                        : node
                    }
                    client={props.client}
                    sampleRate={view.info.sampleRate}
                    disabled={Boolean(working)}
                    onChange={(params) =>
                      changeNode(index, {
                        type:
                          isStandardFilter(descriptor.id) && params.family === "moog"
                            ? "filter-moog"
                            : descriptor.id,
                        params,
                      })
                    }
                  />
                </li>
              );
            })}
          </ol>
          <div className="studio-section flex flex-wrap items-center gap-4 border px-3 py-2">
            <label className="text-sm">
              <input
                type="checkbox"
                checked={view.bypass}
                disabled={Boolean(working)}
                onChange={(event) => props.onChange({ bypass: event.target.checked })}
              />{" "}
              Bypass rack
            </label>
            <label className="flex flex-1 items-center gap-2 text-sm">
              Wet/dry
              <input
                className="min-w-12 flex-1 accent-primary"
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(view.wet * 100)}
                disabled={Boolean(working)}
                onChange={(event) => props.onChange({ wet: Number(event.target.value) / 100 })}
              />
              <output className="shrink-0 text-xs tabular-nums">
                {Math.round(view.wet * 100)}% wet
              </output>
            </label>
          </div>
          {view.meters && (
            <fieldset aria-label="Input and output meters" className="grid grid-cols-2 gap-3">
              {["input", "output"].map((side) => (
                <div key={side}>
                  <p className="text-sm capitalize">{side}</p>
                  {view.meters?.[side === "input" ? "inputPeak" : "outputPeak"].map(
                    (peak, channel) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: channel indices are stable meter identities.
                      <div key={`${side}-${channel}`} className="flex items-center gap-2 text-xs">
                        <meter
                          aria-label={`${side} channel ${channel + 1} peak`}
                          min="0"
                          max="1"
                          value={peak}
                        />
                        <output>
                          {peak.toFixed(4)} peak ·{" "}
                          {view.meters?.[side === "input" ? "inputRms" : "outputRms"][
                            channel
                          ].toFixed(4)}{" "}
                          RMS
                        </output>
                      </div>
                    ),
                  )}
                </div>
              ))}
            </fieldset>
          )}
          {(view.error || props.catalogError) && (
            <p role="alert" className="text-sm text-destructive">
              {view.error ?? props.catalogError}
            </p>
          )}
          {!valid && view.rack.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {view.rack.some(
                (node) =>
                  descriptors.find((effect) => effect.id === node.type)?.channelMode === "stereo",
              ) && !stereoSelection(view.selection.channelMask)
                ? "Select complete stereo pairs before using stereo effects."
                : "Complete the required parameters and impulse response before preview or apply."}
            </p>
          )}
          {view.phase === "ready" && view.job && (view.job.peak > 1 || view.job.nonFinite) && (
            <p role="alert" className="text-sm text-destructive">
              The rack output{" "}
              {view.job.nonFinite ? "contains nonfinite samples" : "exceeds full scale"}. Review the
              levels before applying.
            </p>
          )}
          <p role="status" data-testid="effects-status" className="text-xs text-muted-foreground">
            {view.phase === "idle"
              ? view.previewing
                ? "Previewing live effects"
                : "Ready"
              : view.phase === "applying"
                ? `Applying… ${view.job?.processedFrames ?? 0} / ${view.job?.totalFrames ?? view.info.frames} frames`
                : view.phase === "ready"
                  ? "Review output levels"
                  : view.phase === "opening"
                    ? "Opening…"
                    : view.phase === "cancelling"
                      ? "Cancelling…"
                      : "Preparing preview…"}
          </p>
          <div className="studio-dialog-actions flex flex-wrap justify-end gap-2 border-t border-border pt-2">
            {view.previewing ? (
              <button
                type="button"
                className="studio-button border px-3 py-2 text-sm"
                disabled={Boolean(working)}
                onClick={props.onStopPreview}
              >
                Stop preview
              </button>
            ) : (
              <button
                type="button"
                className="studio-button border px-3 py-2 text-sm disabled:opacity-50"
                disabled={Boolean(working) || !valid}
                onClick={props.onPreview}
              >
                Preview
              </button>
            )}
            <button
              type="button"
              className="studio-button border px-3 py-2 text-sm disabled:opacity-50"
              disabled={view.phase === "cancelling" || view.phase === "committing"}
              onClick={props.onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="studio-button studio-button-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={Boolean(working) || !valid}
              onClick={() => props.onApply(view.phase === "ready")}
            >
              {view.phase === "ready" ? "Apply anyway" : "Apply rack"}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
