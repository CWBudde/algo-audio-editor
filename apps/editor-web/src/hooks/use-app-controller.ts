import type {
  ClipboardInfo,
  EditOperation,
  EditResult,
  HistoryListResult,
  PastePlan,
  SelectionRange,
  SelectionResult,
} from "@aae/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AudioEngine } from "@/audio/audio-engine";
import type { PlaybackFollow, TransportBarHandle } from "@/components/transport-bar";
import type { WaveformViewHandle } from "@/components/waveform-view";
import { useAnalysisDialog } from "@/hooks/use-analysis-dialog";
import { useAutomation } from "@/hooks/use-automation";
import { useBatch } from "@/hooks/use-batch";
import { useCommands } from "@/hooks/use-commands";
import { useDesktop } from "@/hooks/use-desktop";
import { useDocument } from "@/hooks/use-document";
import { useDocumentMemory } from "@/hooks/use-document-memory";
import { useEdit } from "@/hooks/use-edit";
import { useEffects } from "@/hooks/use-effects";
import { useExport } from "@/hooks/use-export";
import { useHistory } from "@/hooks/use-history";
import { useKernel } from "@/hooks/use-kernel";
import { useMetadata } from "@/hooks/use-metadata";
import { useProcess } from "@/hooks/use-process";
import { useSelection } from "@/hooks/use-selection";
import { useSpeech } from "@/hooks/use-speech";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { DEFAULT_SPECTRAL_SETTINGS, type SpectralSettings } from "@/lib/analysis-settings";
import {
  cancelExtractionWindow,
  openExtractedChannel,
  prepareExtractionWindow,
} from "@/lib/extraction-window";
import { parseSelectionTime } from "@/lib/selection";
import type { SpectralSelection } from "@/lib/spectral-selection";

const EMPTY_DOCUMENT: import("@aae/protocol").DocumentInfoResult = {
  documentId: "",
  name: "",
  channels: 1,
  sampleRate: 48000,
  frames: 0,
  bitDepth: 32,
  float: true,
};

function reportError(action: string) {
  return (err: unknown) => {
    toast.error(action, { description: err instanceof Error ? err.message : String(err) });
  };
}

export function useAppController() {
  const kernel = useKernel();
  const client = kernel.status === "ready" ? kernel.client : undefined;
  const memory = useDocumentMemory(client);
  const engine = useMemo(() => (client ? new AudioEngine(client) : undefined), [client]);

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [loop, setLoop] = useState(false);
  const [follow, setFollow] = useState<PlaybackFollow>("page");
  const playbackAction = useRef(0);
  const playbackPending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const waveformView = useRef<WaveformViewHandle>(null);
  const transportBar = useRef<TransportBarHandle>(null);
  const currentEngine = useRef(engine);
  currentEngine.current = engine;
  const editedDocument = useRef<{ client: typeof client; id: string } | undefined>(undefined);
  const [editSnapshot, setEditSnapshot] = useState<{ client: typeof client; result: EditResult }>();
  const [pastePlan, setPastePlan] = useState<PastePlan>();
  const [desktopClosing, setDesktopClosing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [informationOpen, setInformationOpen] = useState(false);
  const [metersOpen, setMetersOpen] = useState(false);
  const [spectrumOpen, setSpectrumOpen] = useState(false);
  const [spectralView, setSpectralView] = useState<"waveform" | "spectrogram" | "split">(
    "waveform",
  );
  const [spectralSelection, setSpectralSelection] = useState<SpectralSelection>();
  const [noiseProfile, setNoiseProfile] = useState<SelectionResult>();
  const [spectralSettings, setSpectralSettings] = useState(DEFAULT_SPECTRAL_SETTINGS);
  const changeSpectralSettings = useCallback(
    (change: Partial<SpectralSettings>) =>
      setSpectralSettings((previous) => ({ ...previous, ...change })),
    [],
  );
  const informationButton = useRef<HTMLButtonElement>(null);
  const [silenceValue, setSilenceValue] = useState("48000");
  const acceptHistory = useRef<((history: HistoryListResult) => void) | undefined>(undefined);
  const acceptClipboard = useRef<((clipboard: ClipboardInfo) => void) | undefined>(undefined);
  const confirmation = useRef<
    | {
        client: typeof client;
        documentId: string | undefined;
        resolve(accept: boolean): void;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    currentEngine.current = engine;
    return () => {
      currentEngine.current = undefined;
      void engine?.dispose().catch(reportError("Could not release audio resources"));
    };
  }, [engine]);

  const doc = useDocument(client, {
    async beforeOpen() {
      playbackAction.current++;
      await engine?.stop();
      if (currentEngine.current === engine) {
        setPlaying(false);
      }
    },
    fallbackOpen: () => fileInput.current?.click(),
    reportError: (action, error) => reportError(action)(error),
    onSaved: (history) => acceptHistory.current?.(history),
  });

  useEffect(() => {
    if (
      doc.info &&
      (doc.info.documentId !== editedDocument.current?.id ||
        client !== editedDocument.current?.client)
    )
      setPosition(0);
  }, [client, doc.info]);

  const documentId = doc.info?.documentId;
  useEffect(() => {
    setSilenceValue(String(documentId ? (doc.info?.sampleRate ?? 48000) : 48000));
  }, [documentId, doc.info?.sampleRate]);
  const finishConfirmation = useCallback((accept: boolean) => {
    const pending = confirmation.current;
    confirmation.current = undefined;
    setPastePlan(undefined);
    pending?.resolve(accept);
  }, []);
  useLayoutEffect(
    () => () => {
      const pending = confirmation.current;
      if (pending?.client === client && pending?.documentId === documentId)
        finishConfirmation(false);
    },
    [client, documentId, finishConfirmation],
  );
  const confirmConversion = useCallback(
    (plan: PastePlan) =>
      new Promise<boolean>((resolve) => {
        finishConfirmation(false);
        confirmation.current = { client, documentId, resolve };
        setPastePlan(plan);
      }),
    [client, documentId, finishConfirmation],
  );
  const onEdited = useCallback(
    (result: EditResult, sourceDocumentId: string) => {
      acceptHistory.current?.(result.history);
      if (result.clipboard) acceptClipboard.current?.(result.clipboard);
      if (!result.changed) return;
      editedDocument.current = { client, id: result.document.documentId };
      if (!doc.replaceInfo(result.document, sourceDocumentId)) return;
      setPosition(result.selection.start);
      setPlaying(false);
      setEditSnapshot({ client, result });
    },
    [client, doc.replaceInfo],
  );
  const beforeEdit = useCallback(async () => {
    playbackAction.current++;
    playbackPending.current = false;
    await engine?.stop();
    if (currentEngine.current === engine) {
      setPlaying(false);
      setPosition(engine?.position() ?? 0);
    }
  }, [engine]);
  const automation = useAutomation({
    client,
    info: doc.info,
    busy: doc.busy,
    withOperation: doc.withOperation,
    beforeEdit,
    onEdited,
  });
  const batch = useBatch(automation.chain);
  const history = useHistory({
    client,
    info: doc.info,
    busy: doc.busy,
    withOperation: doc.withOperation,
    beforeEdit,
    onEdited,
    onError: (action, error) => reportError(action)(error),
    refreshDocument: doc.refreshInfo,
  });
  acceptHistory.current = history.accept;
  const edit = useEdit({
    onRecorded: automation.record,
    client,
    info: doc.info,
    busy: doc.busy || history.busy,
    withOperation: doc.withOperation,
    beforeEdit,
    onEdited,
    confirmConversion,
    onError: (action, error) => reportError(action)(error),
    refreshDocument: doc.refreshInfo,
  });
  acceptClipboard.current = edit.acceptClipboard;
  const busy = doc.busy || edit.busy || history.busy;
  const analysis = useAnalysisDialog({
    client,
    info: doc.info,
    busy,
    beforeEdit,
    withOperation: doc.withOperation,
    onEdited,
    stateId: history.history?.currentStateId,
  });
  const metadata = useMetadata({
    client,
    info: doc.info,
    busy,
    stateId: history.history?.currentStateId,
    withOperation: doc.withOperation,
    onChanged: history.accept,
  });
  const exporting = useExport({
    client,
    info: doc.info,
    busy,
    withOperation: doc.withOperation,
    onError: (action, error) => reportError(action)(error),
  });
  const effects = useEffects({
    onRecorded: automation.record,
    client,
    info: doc.info,
    busy,
    withOperation: doc.withOperation,
    beforeEdit,
    preparePreview: (info) =>
      engine ? engine.prepare(info) : Promise.reject(new Error("Audio engine unavailable")),
    async playPreview(info, preview) {
      if (!engine) throw new Error("Audio engine unavailable");
      const action = ++playbackAction.current;
      playbackPending.current = true;
      setPosition(preview.start);
      setPlaying(true);
      try {
        await engine.play(info, {
          start: preview.start,
          end: preview.end,
          loop: true,
          effectPreviewId: preview.previewId,
        });
      } finally {
        if (action === playbackAction.current) playbackPending.current = false;
      }
    },
    async stopPreview() {
      if (currentEngine.current === engine) await beforeEdit();
      else await engine?.stop();
      if (engine && doc.info && currentEngine.current === engine) await engine.prepare(doc.info);
    },
    onEdited,
    onError: (action, error) => reportError(action)(error),
    refreshDocument: doc.refreshInfo,
  });
  const processOptions = {
    onRecorded: automation.record,
    client,
    info: doc.info,
    busy,
    withOperation: doc.withOperation,
    beforeEdit,
    prepareExtract: prepareExtractionWindow,
    cancelExtract: cancelExtractionWindow,
    onExtract: async (_info, job) => {
      if (!client) throw new Error("Kernel unavailable");
      await openExtractedChannel(client, job);
    },
    preparePreview: (info) =>
      engine ? engine.prepare(info) : Promise.reject(new Error("Audio engine unavailable")),
    async playPreview(info, job) {
      if (!engine) throw new Error("Audio engine unavailable");
      const action = ++playbackAction.current;
      playbackPending.current = true;
      const candidate = job.candidate;
      const previewInfo = candidate
        ? {
            ...info,
            sampleRate: candidate.sampleRate,
            channels: candidate.channels,
            frames: candidate.frames,
          }
        : info;
      const cursor = candidate && candidate.start === candidate.end;
      const start = cursor ? 0 : (candidate?.start ?? job.start);
      const end = cursor ? candidate.frames : (candidate?.end ?? job.end);
      setPosition(start);
      setPlaying(true);
      try {
        await engine.play(previewInfo, {
          start,
          end,
          loop: true,
          previewJobId: job.jobId,
        });
      } finally {
        if (action === playbackAction.current) playbackPending.current = false;
      }
    },
    async stopPreview() {
      if (currentEngine.current === engine) await beforeEdit();
      else await engine?.stop();
      if (engine && doc.info && currentEngine.current === engine) await engine.prepare(doc.info);
    },
    onEdited,
    onError: (action, error) => reportError(action)(error),
    refreshDocument: doc.refreshInfo,
  } satisfies Parameters<typeof useProcess>[0];
  const processing = useProcess(processOptions);
  // Generate speech… is a second process session: the same lock, preview and
  // commit path, with the audio generator's PCM from the speech worker.
  const speech = useSpeech(processOptions);
  useEffect(() => {
    document.title = doc.info
      ? `${history.history?.dirty ? "* " : ""}${doc.info.name} — algo-audio-editor`
      : "algo-audio-editor";
  }, [doc.info, history.history?.dirty]);
  const selectionEditor = useSelection(
    doc.info ? client : undefined,
    doc.info ?? EMPTY_DOCUMENT,
    editSnapshot &&
      editSnapshot.client === client &&
      editSnapshot.result.document.documentId === documentId
      ? editSnapshot.result
      : undefined,
    {
      busy,
      withOperation: doc.withOperation,
      onTimelineChanged: (result) => history.accept(result.history),
    },
  );
  const selection = doc.info && !selectionEditor.previewing ? selectionEditor.selection : undefined;
  const runEdit = useCallback(
    (operation: EditOperation, frames?: number) => {
      const range = selection;
      if (range && !busy) void edit.run(operation, range, frames);
    },
    [selection, busy, edit.run],
  );

  const readPosition = useCallback(
    () => (playing && !playbackPending.current && engine ? engine.position() : position),
    [engine, playing, position],
  );

  const play = useCallback(() => {
    if (!engine || !doc.info || busy || doc.info.frames === 0) return;
    const action = ++playbackAction.current;
    const selected = selection;
    const range = selected && selected.end > selected.start ? selected : undefined;
    const start = range ? range.start : position < doc.info.frames ? position : 0;
    setPosition(start);
    playbackPending.current = true;
    setPlaying(true);
    engine
      .play(doc.info, { start, end: range?.end, loop })
      .catch((err: unknown) => {
        if (action !== playbackAction.current) return;
        setPlaying(false);
        reportError("Playback failed")(err);
      })
      .finally(() => {
        if (action === playbackAction.current) playbackPending.current = false;
      });
  }, [engine, doc.info, busy, position, loop, selection]);

  const stop = useCallback(() => {
    if (!engine) return;
    const action = ++playbackAction.current;
    playbackPending.current = false;
    setPosition(engine.position());
    engine
      .stop()
      .then(() => {
        if (action !== playbackAction.current) return;
        setPosition(engine.position());
        setPlaying(false);
      })
      .catch(reportError("Stopping playback failed"));
  }, [engine]);

  const seek = useCallback(
    (frame: number) => {
      if (!engine || !doc.info || busy) return;
      const action = ++playbackAction.current;
      playbackPending.current = true;
      setPosition(frame);
      engine
        .seek(frame)
        .then(() => {
          if (action !== playbackAction.current) return;
          setPlaying(engine.isPlaying());
        })
        .catch((error: unknown) => {
          if (action !== playbackAction.current) return;
          setPlaying(engine.isPlaying());
          setPosition(engine.position());
          reportError("Seeking failed")(error);
        })
        .finally(() => {
          if (action === playbackAction.current) playbackPending.current = false;
        });
    },
    [engine, doc.info, busy],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Source changes invalidate document-local restoration controls.
  useLayoutEffect(() => {
    setSpectralSelection(undefined);
    setNoiseProfile(undefined);
  }, [client, doc.info?.documentId]);
  const currentSpectralSelection =
    spectralSelection?.documentId === doc.info?.documentId && spectralView !== "waveform"
      ? spectralSelection
      : undefined;
  const currentNoiseProfile =
    noiseProfile?.documentId === doc.info?.documentId ? noiseProfile : undefined;
  const profileCovers = (range: SelectionRange | undefined) =>
    Boolean(
      currentNoiseProfile &&
        range &&
        (currentNoiseProfile.channelMask & range.channelMask) === range.channelMask,
    );
  const { commands, execute } = useCommands({
    getContext: () => ({
      recordingMacro: automation.recording,
      ready: Boolean(client),
      audioReady: Boolean(engine),
      busy,
      info: doc.info,
      selection,
      clipboard: edit.clipboard,
      hasSpectralSelection: Boolean(currentSpectralSelection),
      spectralHealAvailable: Boolean(
        currentSpectralSelection &&
          currentSpectralSelection.mask.end - currentSpectralSelection.mask.start <= 256 &&
          currentSpectralSelection.mask.start >= 2 &&
          currentSpectralSelection.mask.end <= (doc.info?.frames ?? 0) - 2,
      ),
      noiseProfileReady: profileCovers(selection),
      canUndo: history.history?.canUndo ?? false,
      canRedo: history.history?.canRedo ?? false,
      playing,
      silenceFrames: parseSelectionTime(silenceValue, 1, "samples"),
      effects: effects.descriptors,
      modalOpen: Boolean(
        desktopClosing ||
          pastePlan ||
          automation.open ||
          batch.open ||
          processing.view ||
          speech.view ||
          effects.view ||
          exporting.view ||
          informationOpen ||
          metadata.view ||
          analysis.view,
      ),
    }),
    paletteOpen,
    onError: (_id, error) => reportError("Command failed")(error),
    actions: {
      "file.automation": automation.show,
      "file.batch": batch.show,
      "file.record-macro": automation.startRecording,
      "file.stop-recording": automation.stopRecording,
      "file.metadata": metadata.open,
      "process.capture-noise-profile": () => {
        const range = selection;
        if (range && doc.info) {
          setNoiseProfile({ documentId: doc.info.documentId, ...range });
          toast.success("Noise profile set from selection");
        }
      },
      "process.noise-reduce": () => {
        const range = selection;
        if (range && currentNoiseProfile)
          processing.open(range, "noise-reduce", { noiseProfile: currentNoiseProfile });
      },
      ...Object.fromEntries(
        (["spectral-attenuate", "spectral-remove", "spectral-heal"] as const).map((operation) => [
          `process.${operation}`,
          () => {
            if (!currentSpectralSelection) return;
            const { mask, channelMask } = currentSpectralSelection;
            processing.open({ start: mask.start, end: mask.end, channelMask }, operation, {
              spectralMask: mask,
              fftSize: spectralSettings.fftSize,
            });
          },
        ]),
      ),
      "analyze.meters": () => setMetersOpen((open) => !open),
      "analyze.spectrum": () => setSpectrumOpen((open) => !open),
      "view.waveform": () => setSpectralView("waveform"),
      "view.spectrogram": () => setSpectralView("spectrogram"),
      "view.split-spectral": () => setSpectralView("split"),
      ...Object.fromEntries(
        (["statistics", "pitch", "clipping"] as const).map((kind) => [
          `analyze.${kind}`,
          () => {
            const range = selection;
            if (range) analysis.open(kind, range);
          },
        ]),
      ),
      ...Object.fromEntries(
        effects.descriptors.map((descriptor) => [
          `effects.${descriptor.id}`,
          () => {
            const range = selection;
            if (range) effects.open(range, descriptor.id);
          },
        ]),
      ),
      "effects.rack": () => {
        const range = selection;
        if (range) effects.open(range);
      },
      "file.open": async () => {
        await doc.open();
      },
      "file.save": async () => {
        await doc.save();
      },
      "file.export": () => {
        const range = selection;
        if (range) exporting.open(range);
      },
      "edit.undo": async () => {
        await history.undo();
      },
      "edit.redo": async () => {
        await history.redo();
      },
      "edit.cut": () => runEdit("cut"),
      "edit.copy": () => runEdit("copy"),
      "edit.paste-insert": () => runEdit("paste-insert"),
      "edit.paste-replace": () => runEdit("paste-replace"),
      "edit.paste-mix": () => runEdit("paste-mix"),
      "edit.delete": () => runEdit("delete"),
      "edit.crop": () => runEdit("crop"),
      "edit.duplicate": () => runEdit("duplicate"),
      "edit.swap-channels": () => runEdit("swap-channels"),
      "edit.mute": () => runEdit("mute"),
      "edit.insert-silence": () =>
        runEdit("insert-silence", parseSelectionTime(silenceValue, 1, "samples")),
      "edit.select-all": () => waveformView.current?.selectAll(),
      "timeline.add-marker": () => waveformView.current?.addMarker(),
      "timeline.add-region": () => waveformView.current?.addRegion(),
      "timeline.export-csv": () => doc.exportTimeline("csv"),
      "timeline.export-labels": () => doc.exportTimeline("labels"),
      "view.zoom-in": () => waveformView.current?.zoomIn(),
      "view.zoom-out": () => waveformView.current?.zoomOut(),
      "view.zoom-fit": () => waveformView.current?.zoomFit(),
      "view.zoom-selection": () => waveformView.current?.zoomSelection(),
      "transport.toggle-playback": () => {
        if (playing) stop();
        else play();
      },
      "transport.stop": stop,
      "transport.seek-start": () => {
        waveformView.current?.clearSelection(0);
        seek(0);
      },
      "transport.seek-end": () => {
        if (doc.info) {
          waveformView.current?.clearSelection(doc.info.frames);
          seek(doc.info.frames);
        }
      },
      "commands.palette": () => setPaletteOpen(!paletteOpen),
      "process.amplify": () => {
        const range = selection;
        if (range) processing.open(range);
      },
      "process.normalize": () => {
        const range = selection;
        if (range) processing.open(range, "normalize-peak");
      },
      ...Object.fromEntries(
        [
          ["process.fade", "fade-in"],
          ["process.crossfade", "crossfade"],
          ["process.reverse", "reverse"],
          ["process.invert", "invert"],
          ["process.remove-dc", "remove-dc"],
          ["process.mono-to-stereo", "mono-to-stereo"],
          ["process.stereo-to-mono", "stereo-to-mono"],
          ["process.extract-channel", "extract-channel"],
          ["process.resample", "resample"],
          ["process.generate", "generate"],
          ["process.remove-clicks", "remove-clicks"],
          ["process.declip", "declip"],
          ["process.time-stretch", "time-stretch"],
          ["process.remove-hum", "remove-hum"],
        ].map(([id, operation]) => [
          id,
          () => {
            const range = selection;
            if (range) processing.open(range, operation as Parameters<typeof processing.open>[1]);
          },
        ]),
      ),
      "process.generate-speech": () => {
        const range = selection;
        if (range) speech.open(range);
      },
      "help.about": () => setInformationOpen(true),
    },
  });

  const timelineOptions = useMemo(
    () => ({
      busy,
      withOperation: doc.withOperation,
      onTimelineChanged: (result: import("@aae/protocol").TimelineMutationResult) =>
        history.accept(result.history),
    }),
    [busy, doc.withOperation, history.accept],
  );
  const resetMeters = useCallback(() => {
    void client
      ?.call("meters.configure", { reset: true })
      .catch(reportError("Could not reset meters"));
  }, [client]);
  const dirty = Boolean(
    doc.info && (history.history?.documentId !== doc.info.documentId || history.history.dirty),
  );
  useUnsavedChangesGuard(dirty);
  const desktop = useDesktop({
    commands,
    execute,
    dirty,
    busy:
      busy ||
      Boolean(
        automation.open ||
          batch.open ||
          processing.view ||
          speech.view ||
          effects.view ||
          exporting.view ||
          analysis.view ||
          metadata.view ||
          pastePlan,
      ),
    canOpen:
      Boolean(client) &&
      !desktopClosing &&
      !busy &&
      !automation.open &&
      !batch.open &&
      !processing.view &&
      !speech.view &&
      !effects.view &&
      !exporting.view &&
      !analysis.view &&
      !metadata.view &&
      !pastePlan,
    onClosingChange: setDesktopClosing,
    name: doc.info?.name,
    save: doc.saveAndWait,
    openFile: doc.openNativeFile,
    onError: reportError("Desktop operation failed"),
  });

  useEffect(() => {
    if (!engine || !playing) return;
    let animation = 0;
    const update = () => {
      if (!playbackPending.current) {
        const frame = engine.position();
        waveformView.current?.updatePlayback(frame);
        transportBar.current?.updatePosition(frame);
        if (engine.ended()) {
          setPosition(engine.position());
          setPlaying(false);
          return;
        }
      }
      animation = requestAnimationFrame(update);
    };
    animation = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(animation);
    };
  }, [engine, playing]);

  return {
    timelineOptions,
    resetMeters,
    analysis,
    automation,
    batch,
    busy,
    changeSpectralSettings,
    client,
    commands,
    desktop,
    doc,
    edit,
    editSnapshot,
    effects,
    engine,
    execute,
    exporting,
    fileInput,
    finishConfirmation,
    follow,
    history,
    informationButton,
    informationOpen,
    kernel,
    loop,
    memory,
    metadata,
    metersOpen,
    paletteOpen,
    pastePlan,
    playing,
    position,
    processing,
    speech,
    readPosition,
    runEdit,
    seek,
    selection,
    selectionEditor,
    setFollow,
    setInformationOpen,
    setLoop,
    setMetersOpen,
    setPaletteOpen,
    setSilenceValue,
    setSpectralSelection,
    setSpectrumOpen,
    silenceValue,
    spectralSettings,
    spectralView,
    spectrumOpen,
    transportBar,
    waveformView,
  };
}
