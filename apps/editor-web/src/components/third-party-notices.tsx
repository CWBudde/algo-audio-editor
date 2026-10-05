import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";

const MAX_NOTICE_BYTES = 8 * 1024 * 1024;
type NoticeState =
  | { status: "idle" | "loading" }
  | { status: "ready"; text: string }
  | { status: "error" };

async function readNotices(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Notices unavailable");
  if (Number(response.headers.get("content-length")) > MAX_NOTICE_BYTES) {
    await response.body.cancel();
    throw new Error("Notices exceed size limit");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_NOTICE_BYTES) {
        await reader.cancel();
        throw new Error("Notices exceed size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (!text.trim()) throw new Error("Notices empty");
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Loads the bundled license texts only when requested, with no external navigation. */
export function ThirdPartyNotices() {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<NoticeState>({ status: "idle" });
  const ready = state.status === "ready";
  useEffect(() => {
    if (!expanded || ready) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetch(`${import.meta.env.BASE_URL}third-party-notices.txt`, {
      signal: controller.signal,
      cache: attempt > 0 ? "reload" : "default",
    })
      .then(readNotices)
      .then((text) => {
        if (!controller.signal.aborted) setState({ status: "ready", text });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [expanded, attempt, ready]);

  return (
    <section className="mt-4 border-t pt-4" aria-label="Third-party licenses">
      <Button
        variant="outline"
        aria-expanded={expanded}
        aria-controls={`${id}-notices`}
        onClick={() => setExpanded((value) => !value)}
      >
        Third-party notices
      </Button>
      {expanded && (
        <div id={`${id}-notices`} className="mt-3">
          {state.status === "loading" && <p role="status">Loading third-party notices…</p>}
          {state.status === "error" && (
            <div>
              <p role="alert" className="text-sm text-destructive">
                Third-party notices could not be loaded. Please retry.
              </p>
              <Button variant="outline" className="mt-2" onClick={() => setAttempt((n) => n + 1)}>
                Retry notices
              </Button>
            </div>
          )}
          {state.status === "ready" && (
            <textarea
              aria-label="Third-party license texts"
              readOnly
              value={state.text}
              spellCheck={false}
              className="h-56 max-h-[40dvh] w-full resize-none rounded border bg-background p-3 font-mono text-xs leading-relaxed"
            />
          )}
        </div>
      )}
    </section>
  );
}
