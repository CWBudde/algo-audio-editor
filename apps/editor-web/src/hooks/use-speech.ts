import { CHAIN_SPEECH_GENERATE, type SelectionRange } from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CandidateSource,
  type ProcessOptions,
  type ProcessView,
  useProcess,
} from "@/hooks/use-process";
import {
  emptySpeechForm,
  randomSpeechSeed,
  type SpeechForm,
  speechFormForCatalog,
  speechKey,
  speechModelDefaults,
  speechParams,
} from "@/lib/speech-settings";
import type { SpeechClient, SpeechStage } from "@/speech/client";
import type { SpeechCatalog, SpeechLoaded } from "@/speech/messages";

/** The part of SpeechClient the dialog uses; tests substitute a fake. */
export type SpeechEngine = Pick<SpeechClient, "catalog" | "loaded" | "ensureModel" | "synthesize">;

/** Starts (or restarts) the speech worker and keeps it from idling out while held. */
export interface SpeechRuntime {
  start(): Promise<SpeechEngine>;
  hold(): () => void;
}

/** The page's lazily loaded speech worker; its module loads only when the dialog opens. */
export const workerSpeechRuntime: SpeechRuntime = {
  start: async () => (await import("@/speech/runtime")).startSpeech(),
  hold() {
    let release: (() => void) | undefined;
    let released = false;
    void import("@/speech/runtime").then((runtime) => {
      if (!released) release = runtime.holdSpeech();
    });
    return () => {
      released = true;
      release?.();
    };
  },
};

export type SpeechEngineState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready"; catalog: SpeechCatalog; loaded: SpeechLoaded }
  | { status: "failed"; error: string };

/** What Generate is doing before the kernel job runs. */
export type SpeechActivity = SpeechStage | { stage: "start" } | { stage: "place" };

export interface SpeechErrorView {
  message: string;
  /** The speech worker's Go program exited, typically out of memory. */
  stopped: boolean;
}

export interface SpeechView extends ProcessView {
  form: SpeechForm;
  engine: SpeechEngineState;
  activity?: SpeechActivity;
  error?: SpeechErrorView;
  /** A candidate built from exactly the current form is ready to preview or apply. */
  current: boolean;
}

export interface SpeechOptions extends Omit<ProcessOptions, "onError"> {
  runtime?: SpeechRuntime;
}

function describe(error: unknown): SpeechErrorView {
  if (error instanceof Error && error.name === "SpeechStoppedError")
    return {
      stopped: true,
      message:
        "The speech engine stopped, most likely because the model needs more memory than this browser allows. Try a 6-layer model; Generate starts a fresh engine.",
    };
  return { stopped: false, message: error instanceof Error ? error.message : String(error) };
}

/**
 * Generate speech… runs as a process job of the audio generator: the speech
 * worker supplies the PCM, useProcess owns the document lock, preview,
 * clipping acknowledgement, commit, recording and cancellation.
 */
export function useSpeech(options: SpeechOptions) {
  const runtime = options.runtime ?? workerSpeechRuntime;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const [error, setError] = useState<SpeechErrorView>();
  const [activity, setActivity] = useState<SpeechActivity>();
  const [engine, setEngine] = useState<SpeechEngineState>({ status: "idle" });
  const [form, setFormState] = useState<SpeechForm>(() => emptySpeechForm());
  const formRef = useRef(form);
  formRef.current = form;
  const catalog = engine.status === "ready" ? engine.catalog : undefined;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const process = useProcess({
    ...options,
    onError: (_action, failure) => {
      const view = describe(failure);
      setError(view);
      if (view.stopped)
        setEngine((state) =>
          state.status === "ready" ? { ...state, loaded: { model: "", voices: [] } } : state,
        );
    },
  });
  const open = Boolean(process.view);

  const refreshLoaded = useCallback((client: SpeechEngine) => {
    setEngine((state) =>
      state.status === "ready" ? { ...state, loaded: client.loaded() } : state,
    );
  }, []);
  const boot = useRef<() => void>(() => {});
  useEffect(() => {
    if (!open) return;
    let live = true;
    const release = runtimeRef.current.hold();
    boot.current = () => {
      setEngine((state) => (state.status === "ready" ? state : { status: "starting" }));
      runtimeRef.current.start().then(
        (client) => {
          if (!live) return;
          const next = client.catalog;
          setFormState((current) => speechFormForCatalog(current, next));
          setEngine({ status: "ready", catalog: next, loaded: client.loaded() });
        },
        (failure: unknown) => {
          if (live) setEngine({ status: "failed", error: describe(failure).message });
        },
      );
    };
    boot.current();
    return () => {
      live = false;
      boot.current = () => {};
      release();
      setActivity(undefined);
    };
  }, [open]);

  const source = useCallback((): CandidateSource | undefined => {
    const view = process.view;
    const parsed = speechParams(formRef.current, catalogRef.current);
    if (!view || !parsed.params) return;
    const params = parsed.params;
    const { levelDb, ...synthesis } = params;
    return {
      key: speechKey(params),
      // Like Generate audio, macros keep the requested cursor or selection.
      recorded: {
        method: CHAIN_SPEECH_GENERATE,
        params: { documentId: view.info.documentId, ...view.selection, ...params },
      },
      async start(client, info, selection, signal) {
        setActivity({ stage: "start" });
        const speech = await runtimeRef.current.start();
        await speech.ensureModel(params.model, params.voice, setActivity, signal);
        refreshLoaded(speech);
        const result = await speech.synthesize(synthesis, setActivity, signal);
        setActivity({ stage: "place" });
        return client.startAudioProcess(
          {
            documentId: info.documentId,
            start: selection.start,
            end: selection.end,
            channelMask: selection.channelMask,
            operation: "generate",
            generator: "audio",
            sourceSampleRate: result.sampleRate,
            levelDb,
          },
          result.pcm,
        );
      },
    };
  }, [process.view, refreshLoaded]);

  const { runSource } = process;
  const start = useCallback(
    (mode: "prepare" | "preview" | "apply", allowClipping = false) => {
      const candidate = source();
      if (!candidate) return;
      setError(undefined);
      const pending = runSource(mode, candidate, allowClipping);
      void pending?.finally(() => setActivity(undefined));
      return pending;
    },
    [source, runSource],
  );
  const generate = useCallback(() => start("prepare"), [start]);
  const preview = useCallback(() => start("preview"), [start]);
  const apply = useCallback((allowClipping = false) => start("apply", allowClipping), [start]);
  /** Retries what failed: starting the engine, otherwise Generate. */
  const retry = useCallback(() => {
    if (engine.status === "failed") boot.current();
    else return generate();
  }, [engine.status, generate]);

  const setForm = useCallback((change: Partial<SpeechForm>) => {
    setFormState((current) => ({ ...current, ...change }));
  }, []);
  const setModel = useCallback((name: string) => {
    const next = catalogRef.current?.models.find((model) => model.name === name);
    const all = catalogRef.current;
    if (next && all) setFormState((current) => speechModelDefaults(current, next, all));
  }, []);
  const newSeed = useCallback(() => setForm({ seedText: String(randomSpeechSeed()) }), [setForm]);
  const openDialog = useCallback(
    (selection: SelectionRange) => {
      setError(undefined);
      setActivity(undefined);
      process.open(selection, "generate");
    },
    [process.open],
  );

  const parsed = speechParams(form, catalog);
  const view: SpeechView | undefined = process.view && {
    ...process.view,
    form,
    engine,
    activity,
    error,
    current: Boolean(
      parsed.params &&
        process.view.job?.state === "ready" &&
        process.view.preparedKey === speechKey(parsed.params),
    ),
  };
  return {
    view,
    open: openDialog,
    setForm,
    setModel,
    newSeed,
    generate,
    preview,
    apply,
    retry,
    stopPreview: process.stopPreview,
    cancel: process.cancel,
  };
}
