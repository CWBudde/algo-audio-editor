import type {
  EditOperation,
  EditResult,
  HistoryListResult,
  PastePlan,
  SelectionRange,
  SelectionResult,
} from "@aae/protocol";
import { Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AudioEngine } from "@/audio/audio-engine";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { AboutStatusDialog } from "@/components/about-status-dialog";
import { AnalysisControls } from "@/components/analysis-controls";
import { AnalysisDialog } from "@/components/analysis-dialog";
import { AppMenubar } from "@/components/app-menubar";
import { CommandPalette } from "@/components/command-palette";
import { EditToolbar, PasteConversionDialog } from "@/components/edit-toolbar";
import { EffectsDialog } from "@/components/effects-dialog";
import { ExportDialog } from "@/components/export-dialog";
import { HistoryPanel } from "@/components/history-panel";
import { IconAction } from "@/components/icon-action";
import { PlaybackMeters } from "@/components/playback-meters";
import { ProcessDialog } from "@/components/process-dialog";
import { SpectrumPanel } from "@/components/spectrum-panel";
import { StatusBar } from "@/components/status-bar";
import {
  type PlaybackFollow,
  TransportBar,
  type TransportBarHandle,
} from "@/components/transport-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WaveformPlaceholder } from "@/components/waveform-placeholder";
import { WaveformView, type WaveformViewHandle } from "@/components/waveform-view";
import { useAnalysisDialog } from "@/hooks/use-analysis-dialog";
import { useCommands } from "@/hooks/use-commands";
import { useDesktop } from "@/hooks/use-desktop";
import { useDocument } from "@/hooks/use-document";
import { useDocumentMemory } from "@/hooks/use-document-memory";
import { useEdit } from "@/hooks/use-edit";
import { useEffects } from "@/hooks/use-effects";
import { useExport } from "@/hooks/use-export";
import { useHistory } from "@/hooks/use-history";
import { useKernel } from "@/hooks/use-kernel";
import { usePlaybackMeters } from "@/hooks/use-playback-meters";
import { useProcess } from "@/hooks/use-process";
import { DEFAULT_SPECTRAL_SETTINGS, type SpectralSettings } from "@/lib/analysis-settings";
import {
  cancelExtractionWindow,
  openExtractedChannel,
  prepareExtractionWindow,
} from "@/lib/extraction-window";
import { parseSelectionTime } from "@/lib/selection";
import type { SpectralSelection } from "@/lib/spectral-selection";

const STATS_INTERVAL_MS = 200;

function reportError(action: string) {
  return (err: unknown) => {
    toast.error(action, { description: err instanceof Error ? err.message : String(err) });
  };
}

export default function App() {
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
  const [stats, setStats] = useState<RingBufferStats>();
  const fileInput = useRef<HTMLInputElement>(null);
  const waveformView = useRef<WaveformViewHandle>(null);
  const transportBar = useRef<TransportBarHandle>(null);
  const currentEngine = useRef(engine);
  currentEngine.current = engine;
  const editedDocument = useRef<{ client: typeof client; id: string } | undefined>(undefined);
  const [selected, setSelected] = useState<{ documentId: string; range: SelectionRange }>();
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
  // Preview readiness changes without changing coordinates on pointer-up.
  // Refresh registry availability after the waveform updates its live handle.
  const [, setCommandReady] = useState(true);
  const [silenceValue, setSilenceValue] = useState("48000");
  const acceptHistory = useRef<((history: HistoryListResult) => void) | undefined>(undefined);
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
        setStats(engine?.stats());
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
      if (!result.changed) return;
      editedDocument.current = { client, id: result.document.documentId };
      doc.replaceInfo(result.document, sourceDocumentId);
      setPosition(result.selection.start);
      setPlaying(false);
      setSelected({ documentId: result.document.documentId, range: result.selection });
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
      setStats(engine?.stats());
      setPosition(engine?.position() ?? 0);
    }
  }, [engine]);
  const history = useHistory({
    client,
    info: doc.info,
    busy: doc.busy,
    withOperation: doc.withOperation,
    beforeEdit,
    onEdited,
    onError: (action, error) => reportError(action)(error),
  });
  acceptHistory.current = history.accept;
  const edit = useEdit({
    client,
    info: doc.info,
    busy: doc.busy || history.busy,
    withOperation: doc.withOperation,
    beforeEdit,
    onEdited,
    confirmConversion,
    onError: (action, error) => reportError(action)(error),
  });
  const busy = doc.busy || edit.busy || history.busy;
  const playbackMeters = usePlaybackMeters(client, doc.info, metersOpen);
  const analysis = useAnalysisDialog({
    client,
    info: doc.info,
    busy,
    beforeEdit,
    withOperation: doc.withOperation,
    onEdited,
    stateId: history.history?.currentStateId,
  });
  const exporting = useExport({
    client,
    info: doc.info,
    busy,
    withOperation: doc.withOperation,
    onError: (action, error) => reportError(action)(error),
  });
  const effects = useEffects({
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
  });
  const processing = useProcess({
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
  });
  useEffect(() => {
    document.title = doc.info
      ? `${history.history?.dirty ? "* " : ""}${doc.info.name} — algo-audio-editor`
      : "algo-audio-editor";
  }, [doc.info, history.history?.dirty]);
  const selection: SelectionRange | undefined = doc.info
    ? selected?.documentId === doc.info.documentId
      ? selected.range
      : { start: 0, end: 0, channelMask: (1 << doc.info.channels) - 1 }
    : undefined;
  const onSelectionChange = useCallback(
    (range: SelectionRange) => {
      if (!documentId) return;
      setSelected((previous) =>
        previous?.documentId === documentId &&
        previous.range.start === range.start &&
        previous.range.end === range.end &&
        previous.range.channelMask === range.channelMask
          ? previous
          : { documentId, range },
      );
    },
    [documentId],
  );
  const runEdit = useCallback(
    (operation: EditOperation, frames?: number) => {
      const range = waveformView.current ? waveformView.current.selectionState() : selection;
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
    const selected = waveformView.current?.selection();
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
  }, [engine, doc.info, busy, position, loop]);

  const stop = useCallback(() => {
    if (!engine) return;
    const action = ++playbackAction.current;
    playbackPending.current = false;
    setPosition(engine.position());
    engine
      .stop()
      .then(() => {
        if (action !== playbackAction.current) return;
        setStats(engine.stats());
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
          setStats(engine.stats());
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
      ready: Boolean(client),
      audioReady: Boolean(engine),
      busy,
      info: doc.info,
      selection: waveformView.current ? waveformView.current.selectionState() : selection,
      clipboard: edit.clipboard,
      hasSpectralSelection: Boolean(currentSpectralSelection),
      spectralHealAvailable: Boolean(
        currentSpectralSelection &&
          currentSpectralSelection.mask.end - currentSpectralSelection.mask.start <= 256 &&
          currentSpectralSelection.mask.start >= 2 &&
          currentSpectralSelection.mask.end <= (doc.info?.frames ?? 0) - 2,
      ),
      noiseProfileReady: profileCovers(waveformView.current?.selectionState() ?? selection),
      canUndo: history.history?.canUndo ?? false,
      canRedo: history.history?.canRedo ?? false,
      playing,
      silenceFrames: parseSelectionTime(silenceValue, 1, "samples"),
      effects: effects.descriptors,
      modalOpen: Boolean(
        desktopClosing ||
          pastePlan ||
          processing.view ||
          effects.view ||
          exporting.view ||
          informationOpen ||
          analysis.view,
      ),
    }),
    paletteOpen,
    onError: (_id, error) => reportError("Command failed")(error),
    actions: {
      "process.capture-noise-profile": () => {
        const range = waveformView.current?.selectionState() ?? selection;
        if (range && doc.info) {
          setNoiseProfile({ documentId: doc.info.documentId, ...range });
          toast.success("Noise profile set from selection");
        }
      },
      "process.noise-reduce": () => {
        const range = waveformView.current?.selectionState() ?? selection;
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
            const range = waveformView.current?.selectionState() ?? selection;
            if (range) analysis.open(kind, range);
          },
        ]),
      ),
      ...Object.fromEntries(
        effects.descriptors.map((descriptor) => [
          `effects.${descriptor.id}`,
          () => {
            const range = waveformView.current?.selectionState() ?? selection;
            if (range) effects.open(range, descriptor.id);
          },
        ]),
      ),
      "effects.rack": () => {
        const range = waveformView.current?.selectionState() ?? selection;
        if (range) effects.open(range);
      },
      "file.open": async () => {
        await doc.open();
      },
      "file.save": async () => {
        await doc.save();
      },
      "file.export": () => {
        const range = waveformView.current?.selectionState() ?? selection;
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
        const range = waveformView.current ? waveformView.current.selectionState() : selection;
        if (range) processing.open(range);
      },
      "process.normalize": () => {
        const range = waveformView.current ? waveformView.current.selectionState() : selection;
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
            const range = waveformView.current ? waveformView.current.selectionState() : selection;
            if (range) processing.open(range, operation as Parameters<typeof processing.open>[1]);
          },
        ]),
      ),
      "help.about": () => setInformationOpen(true),
    },
  });

  const desktop = useDesktop({
    commands,
    execute,
    dirty: Boolean(
      doc.info && (history.history?.documentId !== doc.info.documentId || history.history.dirty),
    ),
    busy:
      busy ||
      Boolean(processing.view || effects.view || exporting.view || analysis.view || pastePlan),
    canOpen:
      Boolean(client) &&
      !desktopClosing &&
      !busy &&
      !processing.view &&
      !effects.view &&
      !exporting.view &&
      !analysis.view &&
      !pastePlan,
    onClosingChange: setDesktopClosing,
    name: doc.info?.name,
    save: doc.saveAndWait,
    openFile: doc.openNativeFile,
    onError: reportError("Desktop operation failed"),
  });

  useEffect(() => {
    if (!engine || !playing) return;
    const timer = setInterval(() => setStats(engine.stats()), STATS_INTERVAL_MS);
    let animation = 0;
    const update = () => {
      if (!playbackPending.current) {
        const frame = engine.position();
        waveformView.current?.updatePlayback(frame);
        transportBar.current?.updatePosition(frame);
        if (engine.ended()) {
          setPosition(engine.position());
          setStats(engine.stats());
          setPlaying(false);
          return;
        }
      }
      animation = requestAnimationFrame(update);
    };
    animation = requestAnimationFrame(update);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(animation);
    };
  }, [engine, playing]);

  return (
    <TooltipProvider>
      <div
        className="flex h-dvh flex-col bg-background text-foreground"
        data-kernel-state={kernel.status}
      >
        <header className="flex h-9 shrink-0 min-w-0 items-center gap-2 border-b px-2">
          <span className="hidden shrink-0 px-1 text-sm font-semibold tracking-tight md:inline">
            algo-audio-editor
          </span>
          {!desktop.native && <AppMenubar commands={commands} onExecute={execute} />}
        </header>
        {kernel.status === "error" && (
          <p
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          >
            Audio kernel unavailable: {kernel.error}. Reload the editor to restart it; unsaved
            changes may be lost.
          </p>
        )}
        {kernel.status !== "error" && globalThis.crossOriginIsolated === false && (
          <p role="alert" className="border-b px-3 py-2 text-sm">
            Audio playback requires cross-origin isolation. Open this editor from a supported server
            or the desktop app.
          </p>
        )}
        <fieldset
          className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1"
          aria-label="Editor actions"
          data-testid="primary-controls"
        >
          <TransportBar
            frameless
            commands={commands}
            onExecute={execute}
            ref={transportBar}
            ready={engine !== undefined && !busy && Boolean(doc.info?.frames)}
            playing={playing}
            loop={loop}
            follow={follow}
            position={position}
            sampleRate={doc.info?.sampleRate ?? 48000}
            readPosition={readPosition}
            onPlay={() => execute("transport.toggle-playback")}
            onStop={() => execute("transport.stop")}
            onLoopChange={setLoop}
            onFollowChange={setFollow}
          />
          <fieldset aria-label="Undo and redo" className="flex items-center gap-1 border-l pl-2">
            {(
              [
                ["edit.undo", Undo2, "Undo"],
                ["edit.redo", Redo2, "Redo"],
              ] as const
            ).map(([id, icon, label]) => {
              const command = commands.find((item) => item.id === id);
              return (
                <IconAction
                  key={id}
                  icon={icon}
                  label={label}
                  disabled={!command?.enabled}
                  onClick={() => execute(id)}
                  shortcutLabel={command?.shortcutLabel}
                  ariaShortcut={command?.ariaShortcut}
                />
              );
            })}
          </fieldset>
          <EditToolbar
            frameless
            commands={commands}
            onExecute={execute}
            info={doc.info}
            selection={selection}
            clipboard={edit.clipboard}
            busy={busy}
            silenceValue={silenceValue}
            onSilenceValueChange={setSilenceValue}
            onRun={(operation, _range, frames) => runEdit(operation, frames)}
          />
          {doc.info && (
            <HistoryPanel
              frameless
              commands={commands}
              onExecute={execute}
              history={history.history}
              busy={busy}
              onUndo={() => execute("edit.undo")}
              onRedo={() => execute("edit.redo")}
              onJump={(stateId) => {
                void history.jump(stateId);
              }}
            />
          )}
        </fieldset>
        <input
          ref={fileInput}
          type="file"
          accept=".wav,.flac,.aif,.aiff,.aifc,.mp3,.ogg,.opus,.m4a,.aac,audio/*"
          className="hidden"
          data-testid="audio-file-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) doc.openFile(file);
          }}
        />
        <main
          className="relative min-h-0 flex-1 overflow-auto"
          data-testid="document-drop-zone"
          aria-busy={busy}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) doc.openFile(file);
          }}
        >
          {doc.info && spectralView !== "waveform" && (
            <div className="border-b p-2">
              <AnalysisControls
                showAveraging={false}
                settings={spectralSettings}
                onChange={changeSpectralSettings}
                disabled={Boolean(analysis.view)}
              />
            </div>
          )}
          {busy && (
            <p role="status" className="absolute right-3 top-3 text-sm text-muted-foreground">
              Working on document…
            </p>
          )}
          {doc.info && client ? (
            <WaveformView
              commands={commands}
              onExecute={execute}
              ref={waveformView}
              client={client}
              info={doc.info}
              timelineOptions={{
                busy,
                withOperation: doc.withOperation,
                onTimelineChanged: (result) => history.accept(result.history),
              }}
              onExportTimeline={doc.exportTimeline}
              position={position}
              playing={playing}
              follow={follow}
              onSeek={seek}
              readPosition={readPosition}
              disabled={busy}
              onSelectionChange={onSelectionChange}
              onCommandStateChange={setCommandReady}
              initialEdit={editSnapshot?.client === client ? editSnapshot.result : undefined}
              spectralView={spectralView}
              onSpectralSelectionChange={setSpectralSelection}
              spectralSettings={spectralSettings}
              analysisPaused={Boolean(
                analysis.view || effects.view || processing.view || exporting.view || busy,
              )}
              analysisStateId={history.history?.currentStateId}
            />
          ) : (
            <WaveformPlaceholder />
          )}
        </main>
        {doc.info && client && spectrumOpen && selection && (
          <SpectrumPanel
            client={client}
            info={doc.info}
            selection={selection}
            settings={spectralSettings}
            onSettings={changeSpectralSettings}
            playing={playing}
            paused={Boolean(
              analysis.view || effects.view || processing.view || exporting.view || busy,
            )}
            onClose={() => setSpectrumOpen(false)}
            stateId={history.history?.currentStateId}
          />
        )}
        {doc.info && metersOpen && (
          <PlaybackMeters
            snapshot={playbackMeters.snapshot}
            error={playbackMeters.error}
            onReset={() => {
              void client
                ?.call("meters.configure", { reset: true })
                .catch(reportError("Could not reset meters"));
            }}
            onClose={() => setMetersOpen(false)}
          />
        )}
        <StatusBar
          info={doc.info}
          dirty={history.history?.dirty}
          onInformation={() => execute("help.about")}
          informationDisabled={
            paletteOpen || !commands.find((command) => command.id === "help.about")?.enabled
          }
          informationRef={informationButton}
        />
      </div>
      <Toaster theme="dark" />
      <AnalysisDialog
        view={analysis.view}
        onCancel={analysis.cancel}
        onCommit={() => void analysis.commit()}
      />
      <AboutStatusDialog
        open={informationOpen}
        onClose={() => setInformationOpen(false)}
        kernel={kernel}
        sampleRate={engine?.sampleRate}
        stats={stats}
        memory={memory}
        fallbackFocusRef={informationButton}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
        onExecute={execute}
      />
      <PasteConversionDialog
        plan={pastePlan}
        onConfirm={() => finishConfirmation(true)}
        onCancel={() => finishConfirmation(false)}
      />
      <EffectsDialog
        view={effects.view}
        descriptors={effects.descriptors}
        presets={effects.presets}
        client={client}
        catalogError={effects.catalogError}
        onChange={effects.change}
        onPreview={() => void effects.preview()}
        onStopPreview={() => void effects.stopPreview()}
        onApply={(allowClipping) => void effects.apply(allowClipping)}
        onCancel={() => void effects.cancel()}
        onLoadIR={(node, file) => void effects.loadIR(node, file)}
        onSavePreset={(name) => void effects.savePreset(name)}
        onDeletePreset={(id) => void effects.deletePreset(id)}
        onLoadPreset={(id) => void effects.loadPreset(id)}
      />
      <ExportDialog
        view={exporting.view}
        onSettingsChange={exporting.setSettings}
        onExport={() => void exporting.submit()}
        onCancel={() => void exporting.cancel()}
      />
      <ProcessDialog
        view={processing.view}
        onParameterTextChange={processing.setParameterText}
        onOperationChange={processing.setOperation}
        onSettingsChange={processing.setSettings}
        onPreview={() => {
          void processing.preview();
        }}
        onStopPreview={() => {
          void processing.stopPreview();
        }}
        onApply={(allowClipping) => {
          void processing.apply(allowClipping);
        }}
        onCancel={() => {
          void processing.cancel();
        }}
      />
    </TooltipProvider>
  );
}
