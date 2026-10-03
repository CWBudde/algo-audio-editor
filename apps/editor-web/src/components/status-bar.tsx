import type { DocumentInfoResult } from "@aae/protocol";
import { Info } from "lucide-react";
import type { Ref } from "react";
import { Button } from "@/components/ui/button";

interface StatusBarProps {
  info?: DocumentInfoResult;
  dirty?: boolean;
  onInformation(): void;
  informationDisabled?: boolean;
  informationRef?: Ref<HTMLButtonElement>;
}
export function StatusBar({
  info,
  dirty,
  onInformation,
  informationDisabled,
  informationRef,
}: StatusBarProps) {
  return (
    <footer
      className="flex min-h-9 shrink-0 items-center gap-3 border-t px-3 py-1 text-xs"
      data-testid="document-info"
      data-document-id={info?.documentId}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {info ? (
          <>
            <span
              className="max-w-full truncate font-medium"
              data-testid="document-name"
              title={info.name}
            >
              {info.name}
            </span>
            <span className="text-muted-foreground" data-testid="document-save-status">
              {dirty === undefined ? "Save status pending" : dirty ? "Unsaved changes" : "Saved"}
            </span>
            <span className="text-muted-foreground tabular-nums" data-testid="document-details">
              {info.sampleRate} Hz · {info.channels} {info.channels === 1 ? "channel" : "channels"}{" "}
              · {info.frames} frames · {(info.frames / info.sampleRate).toFixed(3)} s ·{" "}
              {info.bitDepth}-bit {info.float ? "float" : "PCM"}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">No document open</span>
        )}
      </div>
      <Button
        ref={informationRef}
        variant="ghost"
        size="icon-xs"
        aria-label="Information"
        title="About / Status"
        disabled={informationDisabled}
        onClick={onInformation}
      >
        <Info aria-hidden="true" />
      </Button>
    </footer>
  );
}
