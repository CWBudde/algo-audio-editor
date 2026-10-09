import type {
  DocumentInfoResult,
  EditResult,
  ProcessJobResult,
  ProcessStartParams,
  SelectionRange,
} from "@aae/protocol";
import { useCallback, useState } from "react";
import { deferred, holdJobLock, releaseJobLock, runCandidate } from "@/hooks/job-runner";
import { useKernelSession } from "@/hooks/use-kernel-session";
import type { KernelClient } from "@/kernel/client";
import type { AppliedOperation } from "@/lib/operation-chain";
import {
  defaultProcessSettings,
  type ProcessSettings,
  processParams,
  processSettingsKey,
} from "@/lib/process-settings";

export interface ProcessOptions {
  client?: KernelClient;
  info?: DocumentInfoResult;
  busy?: boolean;
  withOperation(work: () => Promise<void>): Promise<void>;
  beforeEdit(): Promise<void>;
  preparePreview(info: DocumentInfoResult): Promise<void>;
  playPreview(info: DocumentInfoResult, job: ProcessJobResult): Promise<void>;
  stopPreview(): Promise<void>;
  onRecorded?(operation: AppliedOperation, info: DocumentInfoResult): void;
  onEdited(result: EditResult, sourceDocumentId: string): void;
  refreshDocument?(client: KernelClient): Promise<void>;
  onExtract?(info: DocumentInfoResult, job: ProcessJobResult): Promise<void>;
  prepareExtract?(): void;
  cancelExtract?(): void;
  onError(action: string, error: unknown): void;
}

export type ProcessPhase = "idle" | "processing" | "ready" | "committing" | "cancelling";
export type ProcessOperation = ProcessStartParams["operation"];
/**
 * Supplies a candidate from outside the settings form, e.g. synthesized speech
 * for the audio generator. The rest of the job lifecycle (lock, preview, clip
 * acknowledgement, commit, recording, cancellation) is the dialog's own.
 */
export interface CandidateSource {
  /** Identity of the request; a ready candidate is reused only while it matches. */
  key: string;
  /** Starts the kernel job. Cancel aborts `signal`. */
  start(
    client: KernelClient,
    info: DocumentInfoResult,
    selection: SelectionRange,
    signal: AbortSignal,
  ): Promise<ProcessJobResult>;
  /** The request recorded for macros once the candidate is committed. */
  recorded: AppliedOperation;
}
export type ProcessRunMode = "prepare" | "preview" | "apply";
export interface ProcessView {
  returnFocus?: HTMLElement;
  info: DocumentInfoResult;
  selection: SelectionRange;
  operation: ProcessOperation;
  parameterText: string;
  settings?: ProcessSettings;
  ready?: boolean;
  phase: ProcessPhase;
  job?: ProcessJobResult;
  /** Key of the candidate the job was built from; see CandidateSource.key. */
  preparedKey?: string;
  previewing: boolean;
}

interface Session {
  client: KernelClient;
  info: DocumentInfoResult;
  selection: SelectionRange;
  operation: ProcessOperation;
  parameterText: string;
  settings: ProcessSettings;
  preparedKey?: string;
  acquired: ReturnType<typeof deferred>;
  done: ReturnType<typeof deferred>;
  released: ReturnType<typeof deferred>;
  job?: ProcessJobResult;
  pending?: Promise<void>;
  /** Aborts a CandidateSource's start. */
  abort?: AbortController;
  cancellation?: Promise<void>;
  closing: boolean;
  committing: boolean;
  committed: boolean;
  previewing: boolean;
  stopPreview(): Promise<void>;
  cancelExtract?(): void;
}

export function parseGain(text: string): number | undefined {
  if (!text.trim()) return;
  const value = Number(text);
  return Number.isFinite(value) && value >= -120 && value <= 60 ? value : undefined;
}

export function parseProcessParameter(
  operation: ProcessOperation,
  text: string,
): number | undefined {
  if (operation === "gain") return parseGain(text);
  if (operation === "spectral-attenuate") {
    const value = parseGain(text);
    return value !== undefined && value <= 0 ? value : undefined;
  }
  if (operation !== "normalize-peak" && operation !== "normalize-loudness") return 0;
  if (!text.trim()) return;
  const value = Number(text);
  const minimum = operation === "normalize-peak" ? -120 : -69;
  return Number.isFinite(value) && value >= minimum && value <= 0 ? value : undefined;
}

export function defaultProcessParameter(operation: ProcessOperation): string {
  if (operation === "spectral-attenuate") return "-12";
  return operation === "gain"
    ? "0"
    : operation === "normalize-peak"
      ? "-1"
      : operation === "normalize-loudness"
        ? "-23"
        : "";
}

export function matchesProcessSettings(
  job: ProcessJobResult | undefined,
  operation: ProcessOperation,
  value: number | undefined,
): boolean {
  return Boolean(
    job?.state === "ready" &&
      value !== undefined &&
      job.operation === operation &&
      (operation === "gain"
        ? job.gainDb === value
        : operation === "normalize-peak" || operation === "normalize-loudness"
          ? job.target === value
          : true),
  );
}

/** Own a shared document lock until a candidate is committed or discarded. */
export function useProcess(options: ProcessOptions) {
  const {
    latest,
    mounted,
    token: session,
    active: sessionActive,
  } = useKernelSession<ProcessOptions, Session>(
    options,
    options.client,
    options.info?.documentId,
    () => {
      const s = session.current;
      if (s && !s.committed) void cancel();
    },
  );
  const [view, setView] = useState<ProcessView>();
  const owns = useCallback(
    (s: Session) =>
      sessionActive(s) &&
      latest.current.client === s.client &&
      latest.current.info?.documentId === s.info.documentId,
    [sessionActive, latest],
  );
  const update = useCallback(
    (s: Session, change: Partial<ProcessView>) => {
      if (owns(s)) setView((previous) => (previous ? { ...previous, ...change } : previous));
    },
    [owns],
  );
  const report = useCallback(
    (s: Session, error: unknown) => {
      if (owns(s)) latest.current.onError("Could not process audio", error);
    },
    [owns, latest],
  );
  const finish = useCallback(
    async (s: Session) => {
      // Re-enable the launcher before closing the modal and restoring focus.
      await releaseJobLock(s);
      if (session.current === s) {
        session.current = undefined;
        if (mounted.current) setView(undefined);
      }
    },
    [session, mounted],
  );
  const discard = useCallback(async (s: Session) => {
    const job = s.job;
    if (!job || job.state === "cancelled") return;
    s.job = await s.client.call("process.cancel", {
      documentId: s.info.documentId,
      jobId: job.jobId,
    });
  }, []);

  const cancel = useCallback(async () => {
    const s = session.current;
    // Once commit has been sent, a successful authoritative reply must win.
    if (!s || s.committing || s.cancellation) return s?.cancellation;
    s.closing = true;
    s.abort?.abort();
    update(s, { phase: "cancelling" });
    s.cancellation = (async () => {
      try {
        // Send cancellation immediately, even while runProcess is awaiting its
        // terminal reply. The worker yields between its bounded Go calls.
        await discard(s);
      } catch (error) {
        report(s, error);
      }
      await s.pending?.catch(() => {});
      try {
        if (s.previewing) await s.stopPreview();
        await discard(s); // start may have replied after the first cancellation.
      } catch (error) {
        report(s, error);
      }
      s.previewing = false;
      s.cancelExtract?.();
      await finish(s);
    })();
    return s.cancellation;
  }, [update, discard, report, finish, session]);

  const open = useCallback(
    (
      selection: SelectionRange,
      operation: ProcessOperation = "gain",
      initialSettings: Partial<ProcessSettings> = {},
    ) => {
      const initial = latest.current;
      const { client, info } = initial;
      if (
        !mounted.current ||
        !client ||
        !info ||
        initial.busy ||
        session.current ||
        (!info.frames && operation !== "generate")
      )
        return;
      const whole =
        operation === "mono-to-stereo" ||
        operation === "stereo-to-mono" ||
        operation === "resample";
      const range = whole
        ? { start: 0, end: info.frames, channelMask: 2 ** info.channels - 1 }
        : selection.start === selection.end && operation !== "crossfade" && operation !== "generate"
          ? { ...selection, start: 0, end: info.frames }
          : { ...selection };
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
      const settings = { ...defaultProcessSettings(info, seed), ...initialSettings };
      if (operation === "crossfade") settings.durationText = "0.01";
      const s: Session = {
        client,
        info,
        selection: { ...selection },
        operation,
        parameterText: defaultProcessParameter(operation),
        settings,
        acquired: deferred(),
        done: deferred(),
        released: deferred(),
        closing: false,
        committing: false,
        committed: false,
        previewing: false,
        stopPreview: initial.stopPreview,
        cancelExtract: initial.cancelExtract,
      };
      session.current = s;
      setView({
        // Capture under the opening gesture, before the lock disables controls
        // and the lazy dialog module finishes loading.
        returnFocus:
          document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
        info,
        selection: range,
        operation,
        parameterText: s.parameterText,
        settings,
        ready: false,
        phase: "idle",
        previewing: false,
      });
      holdJobLock(
        s,
        initial.withOperation,
        () => s.acquired.resolve(),
        (error) => {
          report(s, error);
          s.closing = true;
          s.acquired.resolve();
          if (session.current === s) {
            session.current = undefined;
            if (mounted.current) setView(undefined);
          }
        },
      );
    },
    [report, latest, mounted, session],
  );

  const setParameterText = useCallback(
    (parameterText: string) => {
      const s = session.current;
      if (!s || s.closing || s.pending || s.committing) return;
      s.parameterText = parameterText;
      const params = processParams(s.info, s.selection, s.operation, parameterText, s.settings);
      update(s, {
        parameterText,
        ready:
          s.job?.state === "ready" &&
          Boolean(params && processSettingsKey(params) === s.preparedKey),
      });
    },
    [update, session],
  );

  const setSettings = useCallback(
    (change: Partial<ProcessSettings>) => {
      const s = session.current;
      if (!s || s.closing || s.pending || s.committing) return;
      s.settings = { ...s.settings, ...change };
      const params = processParams(s.info, s.selection, s.operation, s.parameterText, s.settings);
      update(s, {
        settings: s.settings,
        ready:
          s.job?.state === "ready" &&
          Boolean(params && processSettingsKey(params) === s.preparedKey),
      });
    },
    [update, session],
  );

  const setOperation = useCallback(
    (operation: ProcessOperation) => {
      const s = session.current;
      const sameFamily =
        s &&
        ((s.operation.startsWith("normalize-") && operation.startsWith("normalize-")) ||
          ((s.operation === "fade-in" || s.operation === "fade-out") &&
            (operation === "fade-in" || operation === "fade-out")));
      if (!s || !sameFamily || s.closing || s.pending || s.committing || operation === s.operation)
        return;
      s.operation = operation;
      s.parameterText = defaultProcessParameter(operation);
      update(s, { operation, parameterText: s.parameterText, ready: false });
    },
    [update, session],
  );

  const run = useCallback(
    (mode: ProcessRunMode, allowClipping = false, source?: CandidateSource) => {
      const s = session.current;
      if (!s || s.closing || s.pending || s.committing) return;
      const params = source
        ? undefined
        : processParams(s.info, s.selection, s.operation, s.parameterText, s.settings);
      if (!source && !params) return;
      const key = source ? source.key : processSettingsKey(params as ProcessStartParams);
      const operation = s.operation;
      // Invoke before the first await: AudioContext activation belongs to this
      // button gesture, not to the eventual job-completion task.
      let preparation: Promise<void>;
      try {
        if (mode === "apply" && operation === "extract-channel") latest.current.prepareExtract?.();
        preparation =
          mode === "preview" ? latest.current.preparePreview(s.info) : Promise.resolve();
      } catch (error) {
        report(s, error);
        s.cancelExtract?.();
        return;
      }
      void preparation.catch(() => {});
      update(s, { phase: "processing" });
      const work = async () => {
        try {
          await s.acquired.promise;
          await preparation;
          if (s.closing || !owns(s)) return;
          await latest.current.beforeEdit();
          if (s.closing || !owns(s)) return;
          s.previewing = false;
          update(s, { previewing: false });
          if (s.job?.state !== "ready" || s.preparedKey !== key) {
            await discard(s);
            if (s.closing || !owns(s)) return;
            s.preparedKey = undefined;
            update(s, { job: undefined, preparedKey: undefined });
            if (source) {
              const abort = new AbortController();
              s.abort = abort;
              try {
                s.job = await source.start(s.client, s.info, s.selection, abort.signal);
              } finally {
                if (s.abort === abort) s.abort = undefined;
              }
            } else s.job = await s.client.call("process.start", params as ProcessStartParams);
            if (s.closing || !owns(s)) {
              await discard(s);
              return;
            }
            update(s, { job: s.job });
            s.job = await runCandidate(s.client, s.info, s.job, (job) => {
              if (!s.closing) update(s, { job });
            });
            s.preparedKey = key;
            update(s, { preparedKey: key });
          }
          if (s.closing || !owns(s)) return;
          if (s.job?.state !== "ready") {
            s.job = undefined;
            update(s, { phase: "idle", job: undefined, ready: false });
            return;
          }
          if (mode === "prepare") {
            update(s, { phase: "ready", job: s.job, ready: true });
            return;
          }
          if (mode === "preview") {
            s.previewing = true;
            await latest.current.playPreview(s.info, s.job);
            if (!s.closing)
              update(s, { phase: "ready", job: s.job, ready: true, previewing: true });
            return;
          }
          update(s, { phase: "ready", job: s.job, ready: true });
          if ((s.job.peak > 1 || s.job.nonFinite) && !allowClipping) {
            if (operation === "extract-channel") s.cancelExtract?.();
            return;
          }
          s.committing = true;
          update(s, { phase: "committing" });
          if (operation === "extract-channel") {
            if (!latest.current.onExtract) throw new Error("Channel extraction unavailable");
            await latest.current.onExtract(s.info, s.job);
            latest.current.onRecorded?.(
              { method: "process.start", params: params as ProcessStartParams },
              s.info,
            );
            await discard(s);
            await finish(s);
            return;
          }
          // Record the source range resolved by the kernel. Insertion and
          // cursor crossfade coordinates retain their requested meaning.
          const recorded: AppliedOperation = source
            ? source.recorded
            : {
                method: "process.start",
                params:
                  operation === "crossfade" || operation === "generate"
                    ? (params as ProcessStartParams)
                    : {
                        ...(params as ProcessStartParams),
                        start: s.job.start,
                        end: s.job.end,
                        channelMask: s.job.channelMask,
                      },
              };
          const result = await s.client.call("process.commit", {
            documentId: s.info.documentId,
            jobId: s.job.jobId,
          });
          s.committed = true;
          s.job = undefined;
          if (owns(s)) {
            latest.current.onRecorded?.(recorded, s.info);
            latest.current.onEdited(result, s.info.documentId);
          } else if (mounted.current && latest.current.client === s.client) {
            await latest.current.refreshDocument?.(s.client);
          }
          await finish(s);
        } catch (error) {
          // Cancel aborted the candidate source; that is not a failure to report.
          if (!(s.closing && error instanceof DOMException && error.name === "AbortError"))
            report(s, error);
          s.cancelExtract?.();
          try {
            if (s.previewing) await s.stopPreview();
            await discard(s);
          } catch (cleanupError) {
            report(s, cleanupError);
          }
          s.job = undefined;
          s.previewing = false;
          // Cleanup cannot interrupt an authoritative commit. If it rejects
          // after ownership changed, release the old session here instead of
          // leaving its modal/document fence held on the replacement client.
          if (s.committed || !owns(s)) await finish(s);
          else if (!s.closing)
            update(s, { phase: "idle", job: undefined, ready: false, previewing: false });
        } finally {
          s.committing = false;
          s.pending = undefined;
        }
      };
      s.pending = work();
      return s.pending;
    },
    [owns, update, report, discard, finish, session, latest, mounted],
  );

  const stopPreview = useCallback(() => {
    const s = session.current;
    if (!s || s.pending || s.closing || !s.previewing) return;
    update(s, { phase: "processing" });
    s.pending = (async () => {
      try {
        await s.stopPreview();
        s.previewing = false;
        update(s, { previewing: false });
      } catch (error) {
        report(s, error);
      } finally {
        s.pending = undefined;
        if (!s.closing) update(s, { phase: "ready" });
      }
    })();
    return s.pending;
  }, [update, report, session]);

  const preview = useCallback(() => run("preview"), [run]);
  const apply = useCallback((allowClipping = false) => run("apply", allowClipping), [run]);
  /**
   * Runs the same lifecycle with a candidate from `source`: "prepare" builds
   * it without previewing or committing; a ready candidate with the same key
   * is reused by a later "preview" or "apply".
   */
  const runSource = useCallback(
    (mode: ProcessRunMode, source: CandidateSource, allowClipping = false) =>
      run(mode, allowClipping, source),
    [run],
  );
  return {
    view,
    open,
    runSource,
    setParameterText,
    setSettings,
    setOperation,
    preview,
    apply,
    stopPreview,
    cancel,
  };
}
