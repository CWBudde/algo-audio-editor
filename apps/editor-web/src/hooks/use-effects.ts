import type {
  DocumentInfoResult,
  EditResult,
  EffectDescriptor,
  EffectMetersResult,
  EffectPreviewParams,
  EffectPreviewResult,
  ProcessJobResult,
  SelectionRange,
} from "@aae/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";
import {
  type EffectPreset,
  loadEffectPresets,
  persistentPreset,
  type RackEffect,
  removeEffectIR,
  restoreEffectIR,
  saveEffectPresets,
  storeEffectIR,
} from "@/lib/effect-presets";
import { createRackEffect, rackGraph, validRack } from "@/lib/effect-rack";

export interface EffectsOptions {
  client?: KernelClient;
  info?: DocumentInfoResult;
  busy?: boolean;
  withOperation(work: () => Promise<void>): Promise<void>;
  beforeEdit(): Promise<void>;
  preparePreview(info: DocumentInfoResult): Promise<void>;
  playPreview(info: DocumentInfoResult, preview: EffectPreviewResult): Promise<void>;
  stopPreview(): Promise<void>;
  onEdited(result: EditResult, sourceDocumentId: string): void;
  onError(action: string, error: unknown): void;
}
export interface EffectsView {
  info: DocumentInfoResult;
  selection: SelectionRange;
  rack: RackEffect[];
  wet: number;
  bypass: boolean;
  phase: "opening" | "idle" | "starting" | "applying" | "committing" | "ready" | "cancelling";
  previewing: boolean;
  preview?: EffectPreviewResult;
  meters?: EffectMetersResult;
  job?: ProcessJobResult;
  error?: string;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Session extends EffectsView {
  client: KernelClient;
  done: ReturnType<typeof deferred>;
  released: ReturnType<typeof deferred>;
  ready: Promise<void>;
  stopAudio(): Promise<void>;
  beforeEdit(): Promise<void>;
  impulseIds: Set<number>;
  createdAssets: Set<string>;
  pending?: Promise<void>;
  updatePending?: Promise<void>;
  closing: boolean;
  committing: boolean;
  revision: number;
  acknowledged: number;
}
export function useEffects(options: EffectsOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const session = useRef<Session | undefined>(undefined);
  const [view, setView] = useState<EffectsView>();
  const [descriptors, setDescriptors] = useState<EffectDescriptor[]>([]);
  const catalog = useRef(descriptors);
  catalog.current = descriptors;
  const [presets, setPresets] = useState<EffectPreset[]>([]);
  const presetList = useRef(presets);
  const [catalogError, setCatalogError] = useState<string>();
  const owns = useCallback(
    (s: Session) =>
      mounted.current &&
      session.current === s &&
      latest.current.client === s.client &&
      latest.current.info?.documentId === s.info.documentId,
    [],
  );
  const update = useCallback(
    (s: Session, change: Partial<EffectsView>) => {
      Object.assign(s, change);
      if (owns(s)) setView((previous) => (previous ? { ...previous, ...change } : previous));
    },
    [owns],
  );
  const report = useCallback(
    (s: Session, error: unknown) => {
      if (owns(s) && !s.closing) {
        update(s, { error: error instanceof Error ? error.message : String(error) });
        latest.current.onError("Could not use effects", error);
      }
    },
    [owns, update],
  );
  useEffect(() => {
    let active = true;
    setDescriptors([]);
    setCatalogError(undefined);
    const client = options.client;
    if (typeof client?.call !== "function") return;
    void client.call("effects.list", { sampleRate: options.info?.sampleRate }).then(
      (result) => {
        if (active) setDescriptors(result.effects);
      },
      (error) => {
        if (active) setCatalogError(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [options.client, options.info?.sampleRate]);
  useEffect(() => {
    let active = true;
    void loadEffectPresets().then(
      (result) => {
        if (active) {
          presetList.current = result;
          setPresets(result);
        }
      },
      (error) => {
        if (active) setCatalogError(`Could not load user presets: ${String(error)}`);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const request = useCallback(
    (s: Session): EffectPreviewParams => ({
      documentId: s.info.documentId,
      ...s.selection,
      graph: rackGraph(s.rack),
      wet: s.wet,
      bypass: s.bypass,
    }),
    [],
  );
  const removeImpulses = useCallback(async (s: Session, all = false) => {
    if (s.preview && !all) return;
    const retained = new Set(s.rack.map((node) => node.params.irIndex));
    for (const id of s.impulseIds) {
      if (!all && retained.has(id)) continue;
      await s.client.call("effects.ir.remove", { documentId: s.info.documentId, irId: id });
      s.impulseIds.delete(id);
    }
  }, []);
  const cleanAssets = useCallback(async (s: Session) => {
    const retained = new Set(
      presetList.current.flatMap((preset) => preset.rack.map((node) => node.irAssetId)),
    );
    for (const asset of s.createdAssets) {
      if (!retained.has(asset)) await removeEffectIR(asset);
      s.createdAssets.delete(asset);
    }
  }, []);
  const stop = useCallback(
    async (s: Session) => {
      const preview = s.preview;
      update(s, { previewing: false });
      await s.stopAudio();
      await s.updatePending?.catch(() => {});
      if (preview) {
        await s.client.call("effects.preview.stop", {
          documentId: s.info.documentId,
          previewId: preview.previewId,
        });
      }
      update(s, { preview: undefined, previewing: false, meters: undefined });
      await removeImpulses(s);
    },
    [update, removeImpulses],
  );
  const finish = useCallback(async (s: Session) => {
    if (session.current === s) {
      session.current = undefined;
      if (mounted.current) setView(undefined);
    }
    s.done.resolve();
    await s.released.promise;
  }, []);
  const cancel = useCallback(async () => {
    const s = session.current;
    if (!s || s.committing || s.closing) return;
    s.closing = true;
    update(s, { phase: "cancelling" });
    try {
      if (s.job?.state === "running")
        await s.client.call("process.cancel", {
          documentId: s.info.documentId,
          jobId: s.job.jobId,
        });
      await s.pending?.catch(() => {});
      await stop(s);
      if (s.job && s.job.state !== "cancelled")
        await s.client.call("process.cancel", {
          documentId: s.info.documentId,
          jobId: s.job.jobId,
        });
    } catch (error) {
      if (mounted.current) latest.current.onError("Could not close effects", error);
    } finally {
      await removeImpulses(s, true).catch((error) => {
        if (mounted.current) latest.current.onError("Could not release impulse responses", error);
      });
      await cleanAssets(s).catch((error) => {
        if (mounted.current) latest.current.onError("Could not release impulse files", error);
      });
      await finish(s);
    }
  }, [update, stop, finish, removeImpulses, cleanAssets]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: replacement invalidates the owning modal/preview session.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void cancel();
    };
  }, [options.client, options.info?.documentId, cancel]);
  const open = useCallback(
    (selection: SelectionRange, effectId?: string) => {
      const { client, info, busy } = latest.current;
      if (!mounted.current || !client || !info?.frames || busy || session.current) return;
      const descriptor = catalog.current.find((effect) => effect.id === effectId);
      const ready = deferred();
      const s: Session = {
        client,
        info,
        selection: { ...selection },
        rack: descriptor ? [createRackEffect(descriptor)] : [],
        wet: 1,
        bypass: false,
        phase: "opening",
        previewing: false,
        done: deferred(),
        released: deferred(),
        ready: ready.promise,
        closing: false,
        committing: false,
        stopAudio: latest.current.stopPreview,
        beforeEdit: latest.current.beforeEdit,
        impulseIds: new Set(),
        createdAssets: new Set(),
        revision: 0,
        acknowledged: 0,
      };
      session.current = s;
      setView({ ...s });
      void latest.current
        .withOperation(async () => {
          await s.beforeEdit();
          if (!s.closing && owns(s)) update(s, { phase: "idle" });
          ready.resolve();
          await s.done.promise;
        })
        .catch((error) => {
          report(s, error);
          s.done.resolve();
          if (session.current === s) {
            session.current = undefined;
            if (mounted.current) setView(undefined);
          }
        })
        .finally(() => {
          ready.resolve();
          s.released.resolve();
        });
    },
    [owns, update, report],
  );
  const syncPreview = useCallback(
    (s: Session) => {
      if (!s.preview || !s.previewing || s.closing || s.updatePending) return;
      s.updatePending = (async () => {
        try {
          while (
            owns(s) &&
            s.preview &&
            s.previewing &&
            !s.closing &&
            s.acknowledged < s.revision
          ) {
            const revision = s.revision;
            const preview = await s.client.call("effects.preview.update", {
              ...request(s),
              previewId: s.preview.previewId,
            });
            if (s.closing || !owns(s)) break;
            s.acknowledged = revision;
            update(s, { preview });
            await removeImpulses(s);
          }
        } catch (error) {
          report(s, error);
        } finally {
          s.updatePending = undefined;
        }
      })();
    },
    [owns, request, update, report, removeImpulses],
  );
  const change = useCallback(
    (next: Partial<Pick<EffectsView, "rack" | "wet" | "bypass">>) => {
      const s = session.current;
      if (!s || s.closing || s.pending || !owns(s)) return;
      if (next.wet !== undefined && (!Number.isFinite(next.wet) || next.wet < 0 || next.wet > 1))
        return;
      update(s, { ...next, phase: "idle", error: undefined });
      s.revision++;
      if (validRack(s.rack, catalog.current, s.selection.channelMask)) syncPreview(s);
    },
    [owns, update, syncPreview],
  );
  const preview = useCallback(() => {
    const s = session.current;
    if (
      !s ||
      s.pending ||
      s.closing ||
      !owns(s) ||
      !validRack(s.rack, catalog.current, s.selection.channelMask)
    )
      return;
    // preparePreview unlocks WebAudio under the actual Preview button gesture.
    const preparation = latest.current.preparePreview(s.info);
    update(s, { phase: "starting", error: undefined });
    s.pending = (async () => {
      try {
        await preparation;
        await s.ready;
        if (s.closing || !owns(s)) return;
        await stop(s);
        if (s.closing || !owns(s)) return;
        const result = await s.client.call("effects.preview.start", request(s));
        s.preview = result;
        if (s.closing || !owns(s)) return;
        await latest.current.playPreview(s.info, result);
        if (s.closing || !owns(s)) return;
        s.acknowledged = s.revision;
        update(s, { preview: result, previewing: true, phase: "idle" });
      } catch (error) {
        report(s, error);
        await stop(s).catch((error) => report(s, error));
        update(s, { phase: "idle" });
      } finally {
        s.pending = undefined;
      }
    })();
    return s.pending;
  }, [owns, update, stop, request, report]);
  const stopPreview = useCallback(() => {
    const s = session.current;
    if (!s || s.pending || s.closing) return;
    update(s, { phase: "starting" });
    s.pending = (async () => {
      try {
        await stop(s);
      } catch (error) {
        report(s, error);
      } finally {
        s.pending = undefined;
        if (owns(s) && !s.closing) update(s, { phase: "idle" });
      }
    })();
    return s.pending;
  }, [stop, report, owns, update]);
  useEffect(() => {
    const s = session.current;
    if (!s || !view?.previewing) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (!active || polling || !s.preview || !owns(s) || s.closing) return;
      polling = true;
      try {
        const meters = await s.client.call("effects.preview.meters", {
          documentId: s.info.documentId,
          previewId: s.preview.previewId,
        });
        if (active && owns(s) && s.previewing) update(s, { meters });
      } catch (error) {
        if (active) report(s, error);
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 50);
    void poll();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view?.previewing, owns, update, report]);
  const apply = useCallback(
    (allowClipping = false) => {
      const s = session.current;
      if (
        !s ||
        s.pending ||
        s.closing ||
        !owns(s) ||
        !validRack(s.rack, catalog.current, s.selection.channelMask)
      )
        return;
      update(s, { phase: "applying", error: undefined });
      s.pending = (async () => {
        try {
          await s.ready;
          await stop(s);
          if (s.closing || !owns(s)) return;
          // Re-render at selection start, including fresh state and the final rack.
          if (s.job) {
            await s.client.call("process.cancel", {
              documentId: s.info.documentId,
              jobId: s.job.jobId,
            });
            s.job = undefined;
          }
          const job = await s.client.call("effects.apply", request(s));
          s.job = job;
          if (s.closing || !owns(s)) return;
          const ready =
            job.state === "running"
              ? await s.client.runProcess(
                  { documentId: s.info.documentId, jobId: job.jobId },
                  (job) => {
                    s.job = job;
                    update(s, { job });
                  },
                )
              : job;
          s.job = ready;
          if (s.closing || !owns(s) || ready.state !== "ready") return;
          if (!allowClipping && (ready.nonFinite || ready.peak > 1)) {
            update(s, { phase: "ready", job: ready });
            return;
          }
          s.committing = true;
          update(s, { phase: "committing" });
          const result = await s.client.call("process.commit", {
            documentId: s.info.documentId,
            jobId: ready.jobId,
          });
          if (mounted.current && latest.current.client === s.client)
            latest.current.onEdited(result, s.info.documentId);
          s.job = undefined;
          await removeImpulses(s, true).catch((error) => {
            latest.current.onError("Could not release impulse responses", error);
          });
          await cleanAssets(s).catch((error) =>
            latest.current.onError("Could not release impulse files", error),
          );
          await finish(s);
        } catch (error) {
          if (s.job) {
            try {
              await s.client.call("process.cancel", {
                documentId: s.info.documentId,
                jobId: s.job.jobId,
              });
              s.job = undefined;
            } catch (cleanupError) {
              report(s, cleanupError);
            }
          }
          report(s, error);
          update(s, { phase: "idle" });
        } finally {
          s.committing = false;
          s.pending = undefined;
        }
      })();
      return s.pending;
    },
    [owns, update, stop, request, report, finish, removeImpulses, cleanAssets],
  );
  const loadIR = useCallback(
    (nodeId: string, file: File) => {
      const s = session.current;
      if (!s || s.pending || s.closing || !owns(s)) return;
      update(s, { phase: "starting", error: undefined });
      s.pending = (async () => {
        try {
          const bytes = await file.arrayBuffer();
          const asset = crypto.randomUUID();
          const persistedBytes = bytes.slice(0);
          if (!owns(s) || s.closing) return;
          const result = await s.client.loadImpulseResponse(s.info.documentId, file.name, bytes);
          s.impulseIds.add(result.irId);
          try {
            s.createdAssets.add(asset);
            await storeEffectIR(asset, persistedBytes);
          } catch (error) {
            await removeEffectIR(asset).then(
              () => s.createdAssets.delete(asset),
              (cleanupError) =>
                latest.current.onError("Could not release impulse file", cleanupError),
            );
            await s.client.call("effects.ir.remove", {
              documentId: s.info.documentId,
              irId: result.irId,
            });
            s.impulseIds.delete(result.irId);
            throw error;
          }
          if (!owns(s) || s.closing) return;
          update(s, {
            rack: s.rack.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    params: { ...node.params, irIndex: result.irId },
                    irAssetId: asset,
                    irName: result.name,
                  }
                : node,
            ),
            phase: "idle",
          });
          s.revision++;
        } catch (error) {
          report(s, error);
          update(s, { phase: "idle" });
        } finally {
          s.pending = undefined;
          syncPreview(s);
        }
      })();
      return s.pending;
    },
    [owns, update, report, syncPreview],
  );
  const savePreset = useCallback(
    async (name: string) => {
      const s = session.current;
      if (
        !s ||
        s.pending ||
        s.closing ||
        !owns(s) ||
        !name.trim() ||
        !validRack(s.rack, catalog.current, s.selection.channelMask)
      )
        return;
      const preset = persistentPreset({
        id: crypto.randomUUID(),
        name: name.trim(),
        rack: s.rack.map((node) => ({ ...node, params: { ...node.params } })),
        wet: s.wet,
        bypass: s.bypass,
      });
      update(s, { phase: "starting", error: undefined });
      const task = (async () => {
        try {
          const next = [...presetList.current, preset];
          await saveEffectPresets(next);
          presetList.current = next;
          if (mounted.current) setPresets(next);
        } catch (error) {
          report(s, error);
        } finally {
          s.pending = undefined;
          if (owns(s) && !s.closing) update(s, { phase: "idle" });
        }
      })();
      s.pending = task;
      await task;
    },
    [report, owns, update],
  );
  const deletePreset = useCallback(
    async (id: string) => {
      const s = session.current;
      if (!s || s.pending || s.closing || !owns(s)) return;
      update(s, { phase: "starting", error: undefined });
      const task = (async () => {
        try {
          const deleted = presetList.current.find((preset) => preset.id === id);
          const next = presetList.current.filter((preset) => preset.id !== id);
          await saveEffectPresets(next);
          presetList.current = next;
          if (mounted.current) setPresets(next);
          const retained = new Set(
            next.flatMap((preset) => preset.rack.map((node) => node.irAssetId)),
          );
          const active = new Set(s.rack.map((node) => node.irAssetId));
          for (const asset of new Set(deleted?.rack.map((node) => node.irAssetId))) {
            if (!asset || retained.has(asset)) continue;
            s.createdAssets.add(asset);
            if (!active.has(asset)) {
              await removeEffectIR(asset);
              s.createdAssets.delete(asset);
            }
          }
        } catch (error) {
          report(s, error);
        } finally {
          s.pending = undefined;
          if (owns(s) && !s.closing) update(s, { phase: "idle" });
        }
      })();
      s.pending = task;
      await task;
    },
    [report, owns, update],
  );
  const loadPreset = useCallback(
    (id: string) => {
      const s = session.current;
      const preset = presetList.current.find((entry) => entry.id === id);
      if (!s || s.pending || s.closing || !preset || !owns(s)) return;
      update(s, { phase: "starting", error: undefined });
      s.pending = (async () => {
        try {
          const rack: RackEffect[] = [];
          for (const saved of preset.rack) {
            const descriptor = catalog.current.find((entry) => entry.id === saved.type);
            if (!descriptor) throw new Error(`Effect ${saved.type} is unavailable`);
            const node = {
              ...createRackEffect(descriptor),
              ...saved,
              id: crypto.randomUUID(),
              params: { ...createRackEffect(descriptor).params, ...saved.params },
            };
            if (saved.type === "reverb-conv") {
              if (!saved.irAssetId)
                throw new Error("This convolution preset has no saved impulse file");
              const bytes = await restoreEffectIR(saved.irAssetId);
              if (!owns(s) || s.closing) return;
              const impulse = await s.client.loadImpulseResponse(
                s.info.documentId,
                saved.irName ?? "Impulse.wav",
                bytes,
              );
              s.impulseIds.add(impulse.irId);
              node.params.irIndex = impulse.irId;
            }
            rack.push(node);
          }
          if (!owns(s) || s.closing) return;
          update(s, { rack, wet: preset.wet, bypass: preset.bypass, phase: "idle" });
          s.revision++;
        } catch (error) {
          report(s, error);
          update(s, { phase: "idle" });
        } finally {
          s.pending = undefined;
          syncPreview(s);
        }
      })();
      return s.pending;
    },
    [owns, update, report, syncPreview],
  );
  return {
    view,
    descriptors,
    catalogError,
    presets,
    open,
    change,
    preview,
    stopPreview,
    apply,
    cancel,
    loadIR,
    savePreset,
    deletePreset,
    loadPreset,
  };
}
