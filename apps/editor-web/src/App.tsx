import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AudioEngine } from "@/audio/audio-engine";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { AppMenubar } from "@/components/app-menubar";
import { StatusBar } from "@/components/status-bar";
import { TransportBar } from "@/components/transport-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WaveformPlaceholder } from "@/components/waveform-placeholder";
import { useDocument } from "@/hooks/use-document";
import { useDocumentMemory } from "@/hooks/use-document-memory";
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
  const [frequencyHz, setFrequencyHz] = useState(440);
  const [amplitude, setAmplitude] = useState(0.2);
  const [stats, setStats] = useState<RingBufferStats>();
  const fileInput = useRef<HTMLInputElement>(null);
  const currentEngine = useRef(engine);
  currentEngine.current = engine;

  useEffect(() => {
    currentEngine.current = engine;
    return () => {
      currentEngine.current = undefined;
      void engine?.dispose();
    };
  }, [engine]);

  const doc = useDocument(client, {
    async beforeOpen() {
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
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !client || doc.busy) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        doc.open();
      } else if (event.key.toLowerCase() === "s" && doc.info) {
        event.preventDefault();
        doc.save();
      } else if (event.key.toLowerCase() === "e" && event.shiftKey && doc.info) {
        event.preventDefault();
        doc.save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [client, doc.busy, doc.info, doc.open, doc.save]);

  useEffect(() => {
    if (!client) return;
    client
      .call("tone.configure", { frequencyHz, amplitude })
      .catch(reportError("Could not configure the test tone"));
  }, [client, frequencyHz, amplitude]);

  useEffect(() => {
    if (!engine || !playing) return;
    const timer = setInterval(() => setStats(engine.stats()), STATS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [engine, playing]);

  const play = useCallback(() => {
    if (!engine) return;
    setPlaying(true);
    engine.play().catch((err: unknown) => {
      setPlaying(false);
      reportError("Playback failed")(err);
    });
  }, [engine]);

  const stop = useCallback(() => {
    if (!engine) return;
    engine
      .stop()
      .then(() => setStats(engine.stats()))
      .catch(reportError("Stopping playback failed"))
      .finally(() => setPlaying(false));
  }, [engine]);

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
            onOpen={client && !doc.busy ? doc.open : undefined}
            onSave={doc.info && !doc.busy ? doc.save : undefined}
          />
        </header>
        <TransportBar
          ready={engine !== undefined && !doc.busy}
          playing={playing}
          frequencyHz={frequencyHz}
          amplitude={amplitude}
          onPlay={play}
          onStop={stop}
          onFrequencyChange={setFrequencyHz}
          onAmplitudeChange={setAmplitude}
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
          aria-busy={doc.busy}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) doc.openFile(file);
          }}
        >
          {doc.busy && (
            <p role="status" className="absolute right-3 top-3 text-sm text-muted-foreground">
              Working on audio file…
            </p>
          )}
          <WaveformPlaceholder info={doc.info} />
        </main>
        <StatusBar
          kernel={kernel}
          sampleRate={doc.info?.sampleRate ?? engine?.sampleRate}
          stats={stats}
          memory={memory}
        />
      </div>
      <Toaster theme="dark" />
    </TooltipProvider>
  );
}
