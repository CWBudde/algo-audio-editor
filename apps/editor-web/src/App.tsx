import type {
  EditOperation,
  EditResult,
  HistoryListResult,
  PastePlan,
  SelectionRange,
} from "@aae/protocol";
import { Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AudioEngine } from "@/audio/audio-engine";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { AboutStatusDialog } from "@/components/about-status-dialog";
import { AppMenubar } from "@/components/app-menubar";
import { CommandPalette } from "@/components/command-palette";
import { EditToolbar, PasteConversionDialog } from "@/components/edit-toolbar";
import { HistoryPanel } from "@/components/history-panel";
import { IconAction } from "@/components/icon-action";
import { ProcessDialog } from "@/components/process-dialog";
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
import { useCommands } from "@/hooks/use-commands";
import { useDocument } from "@/hooks/use-document";
import { useDocumentMemory } from "@/hooks/use-document-memory";
import { useEdit } from "@/hooks/use-edit";
import { useHistory } from "@/hooks/use-history";
import { useKernel } from "@/hooks/use-kernel";
import { useProcess } from "@/hooks/use-process";
import { parseSelectionTime } from "@/lib/selection";

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [informationOpen, setInformationOpen] = useState(false);
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
  const processing = useProcess({
    client,
    info: doc.info,
    busy,
    withOperation: doc.withOperation,
    beforeEdit,
    preparePreview: (info) =>
      engine ? engine.prepare(info) : Promise.reject(new Error("Audio engine unavailable")),
    async playPreview(info, job) {
      if (!engine) throw new Error("Audio engine unavailable");
      const action = ++playbackAction.current;
      playbackPending.current = true;
      setPosition(job.start);
      setPlaying(true);
      try {
        await engine.play(info, {
          start: job.start,
          end: job.end,
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

  const { commands, execute } = useCommands({
    getContext: () => ({
      ready: Boolean(client),
      audioReady: Boolean(engine),
      busy,
      info: doc.info,
      selection: waveformView.current ? waveformView.current.selectionState() : selection,
      clipboard: edit.clipboard,
      canUndo: history.history?.canUndo ?? false,
      canRedo: history.history?.canRedo ?? false,
      playing,
      silenceFrames: parseSelectionTime(silenceValue, 1, "samples"),
      modalOpen: Boolean(pastePlan || processing.view || informationOpen),
    }),
    paletteOpen,
    onError: (_id, error) => reportError("Command failed")(error),
    actions: {
      "file.open": doc.open,
      "file.save": doc.save,
      "file.export": doc.exportAudio,
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
      "help.about": () => setInformationOpen(true),
    },
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
          <AppMenubar commands={commands} onExecute={execute} />
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
          accept=".wav,audio/wav,audio/x-wav"
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
            />
          ) : (
            <WaveformPlaceholder />
          )}
        </main>
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
      <ProcessDialog
        view={processing.view}
        onParameterTextChange={processing.setParameterText}
        onOperationChange={processing.setOperation}
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
