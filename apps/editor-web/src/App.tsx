import type { EditOperation, EditResult, PastePlan, SelectionRange } from "@aae/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AudioEngine } from "@/audio/audio-engine";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { AppMenubar } from "@/components/app-menubar";
import { EditToolbar, PasteConversionDialog } from "@/components/edit-toolbar";
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
import { useDocument } from "@/hooks/use-document";
import { useDocumentMemory } from "@/hooks/use-document-memory";
import { useEdit } from "@/hooks/use-edit";
import { useKernel } from "@/hooks/use-kernel";

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
      void engine?.dispose();
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
  const edit = useEdit({
    client,
    info: doc.info,
    busy: doc.busy,
    withOperation: doc.withOperation,
    async beforeEdit() {
      playbackAction.current++;
      playbackPending.current = false;
      await engine?.stop();
      if (currentEngine.current === engine) {
        setPlaying(false);
        setStats(engine?.stats());
        setPosition(engine?.position() ?? 0);
      }
    },
    onEdited,
    confirmConversion,
    onError: (action, error) => reportError(action)(error),
  });
  const busy = doc.busy || edit.busy;
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        event.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest("input, textarea, select, [role='textbox']")))
      )
        return;
      if (!event.ctrlKey && !event.metaKey && !event.altKey && doc.info && !busy) {
        if (event.code === "Space" && !event.repeat) {
          if (target instanceof HTMLElement && target.closest("button, [role='button']")) return;
          event.preventDefault();
          if (playing) stop();
          else play();
          return;
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          waveformView.current?.clearSelection(event.key === "Home" ? 0 : doc.info.frames);
          seek(event.key === "Home" ? 0 : doc.info.frames);
          return;
        }
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !client || busy) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        doc.open();
      } else if (event.key.toLowerCase() === "s" && doc.info) {
        event.preventDefault();
        doc.save();
      } else if (event.key.toLowerCase() === "e" && event.shiftKey && doc.info) {
        event.preventDefault();
        doc.save();
      } else if (doc.info && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        waveformView.current?.zoomIn();
      } else if (doc.info && event.key === "-") {
        event.preventDefault();
        waveformView.current?.zoomOut();
      } else if (doc.info && event.key === "0") {
        event.preventDefault();
        waveformView.current?.zoomFit();
      } else if (doc.info && ["x", "c", "v"].includes(event.key.toLowerCase()) && !event.shiftKey) {
        const key = event.key.toLowerCase();
        const range = waveformView.current ? waveformView.current.selectionState() : selection;
        if (
          !range ||
          (key !== "v" && range.start === range.end) ||
          (key === "v" && !edit.clipboard?.available)
        )
          return;
        event.preventDefault();
        runEdit(key === "x" ? "cut" : key === "c" ? "copy" : "paste-insert");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    client,
    busy,
    doc.info,
    doc.open,
    doc.save,
    playing,
    play,
    stop,
    seek,
    selection,
    edit.clipboard,
    runEdit,
  ]);

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

  const about =
    kernel.status === "ready"
      ? `Kernel ${kernel.hello.kernelVersion}, ABI v${kernel.hello.protocolVersion}, ${kernel.hello.goVersion}`
      : `Kernel ${kernel.status}`;

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex h-9 items-center gap-3 border-b px-2">
          <span className="px-1 text-sm font-semibold tracking-tight">algo-audio-editor</span>
          <AppMenubar
            aboutText={about}
            onOpen={client && !busy ? doc.open : undefined}
            onSave={doc.info && !busy ? doc.save : undefined}
            onCut={
              !busy && selection && selection.end > selection.start
                ? () => runEdit("cut")
                : undefined
            }
            onCopy={
              !busy && selection && selection.end > selection.start
                ? () => runEdit("copy")
                : undefined
            }
            onPaste={
              !busy && selection && edit.clipboard?.available
                ? () => runEdit("paste-insert")
                : undefined
            }
            onDelete={
              !busy && selection && selection.end > selection.start
                ? () => runEdit("delete")
                : undefined
            }
            onZoomIn={doc.info && !busy ? () => waveformView.current?.zoomIn() : undefined}
            onZoomOut={doc.info && !busy ? () => waveformView.current?.zoomOut() : undefined}
            onZoomFit={doc.info && !busy ? () => waveformView.current?.zoomFit() : undefined}
            onZoomSelection={
              doc.info && !busy ? () => waveformView.current?.zoomSelection() : undefined
            }
          />
        </header>
        <TransportBar
          ref={transportBar}
          ready={engine !== undefined && !busy && Boolean(doc.info?.frames)}
          playing={playing}
          loop={loop}
          follow={follow}
          position={position}
          sampleRate={doc.info?.sampleRate ?? 48000}
          readPosition={readPosition}
          onPlay={play}
          onStop={stop}
          onLoopChange={setLoop}
          onFollowChange={setFollow}
        />
        <EditToolbar
          info={doc.info}
          selection={selection}
          clipboard={edit.clipboard}
          busy={busy}
          onRun={(operation, _range, frames) => runEdit(operation, frames)}
        />
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
              Working on audio…
            </p>
          )}
          {doc.info && client ? (
            <WaveformView
              ref={waveformView}
              client={client}
              info={doc.info}
              position={position}
              playing={playing}
              follow={follow}
              onSeek={seek}
              readPosition={readPosition}
              disabled={busy}
              onSelectionChange={onSelectionChange}
              initialEdit={editSnapshot?.client === client ? editSnapshot.result : undefined}
            />
          ) : (
            <WaveformPlaceholder />
          )}
        </main>
        <StatusBar
          kernel={kernel}
          sampleRate={doc.info?.sampleRate ?? engine?.sampleRate}
          stats={stats}
          memory={memory}
        />
      </div>
      <Toaster theme="dark" />
      <PasteConversionDialog
        plan={pastePlan}
        onConfirm={() => finishConfirmation(true)}
        onCancel={() => finishConfirmation(false)}
      />
    </TooltipProvider>
  );
}
