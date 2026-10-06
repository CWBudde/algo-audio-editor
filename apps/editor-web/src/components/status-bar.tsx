import type { DocumentInfoResult } from "@aae/protocol";
import type { Ref } from "react";
import { Button } from "@/components/ui/button";
import { Info } from "@/lib/icons";

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
      className="editor-status flex min-h-8 shrink-0 items-center gap-3 border-t px-3 py-1 text-[11px]"
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
            <span
              className="editor-save-status flex shrink-0 items-center gap-1.5 text-muted-foreground"
              data-dirty={dirty}
              data-testid="document-save-status"
            >
              <span
                aria-hidden="true"
                className="editor-save-dot size-1.5 rounded-full bg-current"
              />
              {dirty === undefined ? "Save status pending" : dirty ? "Unsaved changes" : "Saved"}
            </span>
            <span
              className="min-w-0 truncate font-mono text-[10px] text-muted-foreground tabular-nums"
              data-testid="document-details"
            >
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
