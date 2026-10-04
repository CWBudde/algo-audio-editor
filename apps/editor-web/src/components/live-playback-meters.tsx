import type { DocumentInfoResult } from "@aae/protocol";
import { PlaybackMeters } from "@/components/playback-meters";
import { usePlaybackMeters } from "@/hooks/use-playback-meters";
import type { KernelClient } from "@/kernel/client";

/** The 20 Hz meter subscription updates only its panel. */
export function LivePlaybackMeters({
  client,
  info,
  onReset,
  onClose,
}: {
  client?: KernelClient;
  info: DocumentInfoResult;
  onReset(): void;
  onClose(): void;
}) {
  const { snapshot, error } = usePlaybackMeters(client, info, true);
  return <PlaybackMeters snapshot={snapshot} error={error} onReset={onReset} onClose={onClose} />;
}
