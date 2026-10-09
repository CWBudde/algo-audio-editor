import { MAX_SPEECH_TEXT_LENGTH } from "@aae/protocol";
import { useId, useLayoutEffect, useRef } from "react";
import type { SpeechActivity, SpeechView } from "@/hooks/use-speech";
import { formatBytes } from "@/lib/format-bytes";
import {
  SPEECH_CREDIT_URL,
  type SpeechFieldError,
  type SpeechForm,
  speechParams,
  speechPlacement,
  speechTextLength,
} from "@/lib/speech-settings";
import { speechModelBytes } from "@/speech/model-source";

interface SpeechDialogProps {
  view?: SpeechView;
  onFormChange(change: Partial<SpeechForm>): void;
  onModelChange(model: string): void;
  onNewSeed(): void;
  onGenerate(): void;
  onPreview(): void;
  onStopPreview(): void;
  onApply(allowClipping: boolean): void;
  onRetry(): void;
  onCancel(): void;
}

const fieldClass = "studio-field mt-1 w-full min-w-0 border px-3 py-2 text-sm";
const smallField = "studio-field mt-1 w-full min-w-0 rounded border px-2 py-1.5 font-mono text-xs";
const buttonClass = "studio-button border px-3 py-2 text-sm disabled:opacity-50";

const fieldErrors: Record<SpeechFieldError, string> = {
  model: "Choose a model and one of its voices.",
  text: `Enter text with at least one letter or digit, up to ${MAX_SPEECH_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
  temperature: "Temperature must be from 0 to 2.",
  samplerSteps: "Sampler steps must be a whole number from 1 to 64.",
  eosThreshold: "End-of-speech threshold must be a finite number.",
  seed: "Seed must be a whole number from 0 to 4294967295.",
  level: "Level must be from −120 to 0 dB.",
};

function percent(done: number, total: number) {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
}

function activityText(activity: SpeechActivity): string {
  switch (activity.stage) {
    case "start":
      return "Starting the speech engine…";
    case "download":
      return `Downloading model… ${percent(activity.done, activity.total)}%`;
    case "read":
      return `Reading model… ${percent(activity.done, activity.total)}%`;
    case "load":
      return "Loading model…";
    case "synthesize":
      // go-pocket-tts counts chunks (sentences) from 1.
      return `Sentence ${Math.max(1, activity.chunk)} of ${Math.max(1, activity.chunks)}`;
    case "place":
      return "Placing speech…";
  }
}

function activityProgress(activity: SpeechActivity): { value: number; max: number } | undefined {
  if (activity.stage === "download" || activity.stage === "read")
    return { value: activity.done, max: Math.max(1, activity.total) };
  if (activity.stage === "synthesize") {
    const chunks = Math.max(1, activity.chunks);
    const within = activity.maxSteps > 0 ? Math.min(1, activity.step / activity.maxSteps) : 0;
    return { value: Math.max(0, activity.chunk - 1) + within, max: chunks };
  }
}

export function SpeechDialog({
  view,
  onFormChange,
  onModelChange,
  onNewSeed,
  onGenerate,
  onPreview,
  onStopPreview,
  onApply,
  onRetry,
  onCancel,
}: SpeechDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLElement | undefined>(undefined);
  const open = Boolean(view);
  const returnFocus = view?.returnFocus;
  const latestOpen = useRef(open);
  latestOpen.current = open;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = undefined;
      return;
    }
    opener.current = returnFocus?.isConnected
      ? returnFocus
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    element.showModal();
    textArea.current?.focus();
    return () => {
      element.close();
      if (!latestOpen.current) return;
      const target = opener.current;
      queueMicrotask(() => {
        if (!element.open && target?.isConnected) target.focus({ preventScroll: true });
      });
      opener.current = undefined;
    };
  }, [open, returnFocus]);

  const engine = view?.engine;
  const catalog = engine?.status === "ready" ? engine.catalog : undefined;
  const model = catalog?.models.find((candidate) => candidate.name === view?.form.model);
  const parsed = view ? speechParams(view.form, catalog) : undefined;
  const fieldError = catalog ? parsed?.error : undefined;
  const working =
    view?.phase === "processing" || view?.phase === "committing" || view?.phase === "cancelling";
  const cancellable = view?.phase !== "committing" && view?.phase !== "cancelling";
  const current = Boolean(view?.current);
  const warning = Boolean(current && view?.job && (view.job.peak > 1 || view.job.nonFinite));
  const length = view ? speechTextLength(view.form.text) : 0;
  const disabled = working || !catalog;
  const field = (
    label: string,
    key: Exclude<keyof SpeechForm, "model" | "voice" | "text">,
    error: SpeechFieldError,
  ) => (
    <label className="mt-2 block text-xs text-muted-foreground">
      {label}
      <input
        aria-label={label}
        type="text"
        inputMode="decimal"
        value={view?.form[key] ?? ""}
        disabled={disabled}
        aria-invalid={fieldError === error}
        className={smallField}
        onChange={(event) => onFormChange({ [key]: event.target.value })}
      />
    </label>
  );
  const progress = view?.activity && activityProgress(view.activity);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-help`}
      aria-modal="true"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        if (cancellable) onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        Generate speech
      </h2>
      <p
        id={`${id}-help`}
        className="studio-dialog-help mt-1 max-w-[72ch] text-sm leading-relaxed text-muted-foreground"
      >
        Speech is synthesized on this device. Generate builds a private copy; Preview plays it and
        Apply creates one undoable edit.
      </p>
      {view && (
        <>
          <p
            className="studio-section mt-3 break-words border px-3 py-2 text-xs leading-relaxed text-muted-foreground"
            data-testid="speech-placement"
          >
            {speechPlacement(view.info, view.selection)}
          </p>
          {engine?.status === "starting" && (
            <p role="status" className="mt-3 text-sm">
              Starting the speech engine…
            </p>
          )}
          {engine?.status === "failed" && (
            <div role="alert" className="mt-3 text-sm text-destructive">
              <p>The speech engine could not start: {engine.error}</p>
              <button type="button" className={`${buttonClass} mt-2`} onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          <label
            className="mt-3 block text-xs font-medium text-muted-foreground"
            htmlFor={`${id}-model`}
          >
            Model
          </label>
          <select
            id={`${id}-model`}
            value={view.form.model}
            disabled={disabled}
            className={fieldClass}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {!catalog && <option value={view.form.model}>Loading models…</option>}
            {catalog?.models.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.label} · {formatBytes(speechModelBytes(candidate))}
                {engine?.status === "ready" && engine.loaded.model === candidate.name
                  ? " · loaded"
                  : ""}
              </option>
            ))}
          </select>
          <label
            className="mt-3 block text-xs font-medium text-muted-foreground"
            htmlFor={`${id}-voice`}
          >
            Voice
          </label>
          <select
            id={`${id}-voice`}
            value={view.form.voice}
            disabled={disabled || !model}
            className={fieldClass}
            onChange={(event) => onFormChange({ voice: event.target.value })}
          >
            {!model && <option value={view.form.voice}>—</option>}
            {model?.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.id}
              </option>
            ))}
          </select>
          <div className="mt-3 flex items-baseline justify-between gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor={`${id}-text`}>
              Text
            </label>
            <span
              className={`text-xs tabular-nums ${length > MAX_SPEECH_TEXT_LENGTH ? "text-destructive" : "text-muted-foreground"}`}
              data-testid="speech-text-length"
            >
              {length.toLocaleString("en-US")} / {MAX_SPEECH_TEXT_LENGTH.toLocaleString("en-US")}
            </span>
          </div>
          <textarea
            ref={textArea}
            id={`${id}-text`}
            rows={5}
            value={view.form.text}
            disabled={working}
            aria-invalid={fieldError === "text"}
            className={`${fieldClass} resize-y leading-relaxed`}
            onChange={(event) => onFormChange({ text: event.target.value })}
          />
          <details className="studio-section mt-3 border p-3 text-xs">
            <summary className="cursor-pointer text-sm">Advanced</summary>
            <div className="grid grid-cols-2 gap-x-3">
              {field("Temperature", "temperatureText", "temperature")}
              {field("Sampler steps", "samplerStepsText", "samplerSteps")}
              {field("EOS threshold", "eosThresholdText", "eosThreshold")}
              {field("Level (dB)", "levelText", "level")}
            </div>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">{field("Seed", "seedText", "seed")}</div>
              <button
                type="button"
                className="studio-button border px-2 py-1.5 text-xs disabled:opacity-50"
                disabled={disabled}
                onClick={onNewSeed}
              >
                New seed
              </button>
            </div>
          </details>
          {fieldError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {fieldErrors[fieldError]}
            </p>
          )}
          <div className="studio-section mt-4 border p-3" aria-live="polite">
            <p role="status" className="text-sm" data-testid="speech-status">
              {view.phase === "cancelling"
                ? "Cancelling…"
                : view.phase === "committing"
                  ? "Applying…"
                  : view.phase === "processing"
                    ? view.activity && view.activity.stage !== "place"
                      ? activityText(view.activity)
                      : view.job
                        ? "Placing speech…"
                        : "Working…"
                    : view.previewing
                      ? "Previewing generated speech"
                      : current
                        ? "Speech ready"
                        : view.job?.state === "ready"
                          ? "Text or settings changed. Generate again to rebuild the speech."
                          : "Ready to generate"}
            </p>
            {view.phase === "processing" && progress && (
              <progress
                aria-label="Speech progress"
                className="mt-2 w-full"
                max={progress.max}
                value={progress.value}
              />
            )}
            {view.phase === "processing" && !progress && view.job?.state === "running" && (
              <progress
                aria-label="Speech progress"
                className="mt-2 w-full"
                max={view.job.totalFrames}
                value={view.job.processedFrames}
              />
            )}
            {current && view.job?.candidate && (
              <p className="mt-1 text-xs text-muted-foreground">
                Output sample peak: {view.job.peak.toFixed(6)}
                {view.job.nonFinite ? " · nonfinite samples present" : ""}
              </p>
            )}
            {warning && (
              <p role="alert" className="mt-2 text-sm text-warning">
                The generated speech exceeds full scale or contains nonfinite samples. PCM export
                may clip. Apply anyway to keep this result.
              </p>
            )}
          </div>
          {view.error && (
            <div role="alert" className="mt-3 text-sm text-destructive">
              <p>{view.error.message}</p>
              <button
                type="button"
                className={`${buttonClass} mt-2`}
                disabled={working || !catalog}
                onClick={onRetry}
              >
                Retry
              </button>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            <a
              href={SPEECH_CREDIT_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Kyutai PocketTTS
            </a>{" "}
            · weights CC-BY-4.0
          </p>
          <div className="studio-dialog-actions mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            <button
              type="button"
              className={buttonClass}
              disabled={!cancellable}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={working || !parsed?.params}
              onClick={onGenerate}
            >
              Generate
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={working || (!view.previewing && !current)}
              onClick={view.previewing ? onStopPreview : onPreview}
            >
              {view.previewing ? "Stop preview" : "Preview"}
            </button>
            <button
              type="button"
              className="studio-button studio-button-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={working || !current}
              onClick={() => onApply(warning)}
            >
              {warning ? "Apply anyway" : "Apply"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
