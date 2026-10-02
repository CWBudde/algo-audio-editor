import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AudioEngine } from "@/audio/audio-engine";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { AppMenubar } from "@/components/app-menubar";
import { StatusBar } from "@/components/status-bar";
import { TransportBar } from "@/components/transport-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WaveformPlaceholder } from "@/components/waveform-placeholder";
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
  const engine = useMemo(() => (client ? new AudioEngine(client) : undefined), [client]);

  const [playing, setPlaying] = useState(false);
  const [frequencyHz, setFrequencyHz] = useState(440);
  const [amplitude, setAmplitude] = useState(0.2);
  const [stats, setStats] = useState<RingBufferStats>();

  useEffect(() => () => void engine?.dispose(), [engine]);

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
          <AppMenubar aboutText={about} />
        </header>
        <TransportBar
          ready={engine !== undefined}
          playing={playing}
          frequencyHz={frequencyHz}
          amplitude={amplitude}
          onPlay={play}
          onStop={stop}
          onFrequencyChange={setFrequencyHz}
          onAmplitudeChange={setAmplitude}
        />
        <main className="min-h-0 flex-1 overflow-auto">
          <WaveformPlaceholder />
        </main>
        <StatusBar kernel={kernel} sampleRate={engine?.sampleRate} stats={stats} />
      </div>
      <Toaster theme="dark" />
    </TooltipProvider>
  );
}
