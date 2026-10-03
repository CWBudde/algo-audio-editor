import type { HelloResult } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KernelState } from "@/hooks/use-kernel";
import { AboutStatusDialog } from "./about-status-dialog";

const ready: KernelState = {
  status: "ready",
  client: {} as never,
  hello: {
    kernelVersion: "test",
    goVersion: "go1.test",
    protocolVersion: 10,
    sampleRate: 48000,
  } as HelloResult,
};

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps diagnostic instrumentation mounted but hidden while closed", () => {
  const ui = render(<AboutStatusDialog open={false} onClose={vi.fn()} kernel={ready} />);
  expect(ui.queryByRole("dialog")).toBeNull();
  expect(ui.getByTestId("kernel-status").textContent).toBe("kernel ready");
  expect(ui.getByTestId("kernel-version").textContent).toBe("test (go1.test)");
  expect(ui.getByText("ABI v10")).toBeDefined();
  expect(ui.getByTestId("document-memory").textContent).toBe("–");
  expect(ui.getByTestId("frames-played").textContent).toBe("0");
});

it("updates live diagnostics without reopening the dialog or moving focus", () => {
  vi.stubGlobal("crossOriginIsolated", true);
  const close = vi.fn();
  const ui = render(
    <AboutStatusDialog
      open
      onClose={close}
      kernel={ready}
      memory={{ sampleBytes: 0, peakBytes: 0, uniqueBlocks: 0, blockReferences: 0 }}
    />,
  );
  const button = ui.getByRole("button", { name: "Close information" });
  expect(document.activeElement).toBe(button);
  expect(ui.getByTestId("document-memory").textContent).toBe("0 B");
  ui.rerender(
    <AboutStatusDialog
      open
      onClose={close}
      kernel={ready}
      sampleRate={44100}
      stats={{
        consumedFrames: 400,
        bufferedFrames: 20,
        underrunFrames: 3,
        documentFrame: 400,
        ended: false,
      }}
      memory={{
        sampleBytes: 1024 ** 2,
        peakBytes: 1024 ** 2 / 2,
        uniqueBlocks: 2,
        blockReferences: 4,
      }}
    />,
  );
  expect(ui.getByTestId("frames-played").textContent).toBe("400");
  expect(ui.getByTestId("underruns").textContent).toBe("3");
  expect(ui.getByTestId("document-memory").textContent).toBe("1.5 MiB");
  expect(ui.getByTestId("cross-origin-isolated").textContent).toBe("yes");
  expect(ui.getByText("44100 Hz")).toBeDefined();
  expect(document.activeElement).toBe(button);
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
});

it("synchronizes native cancel and close requests with the parent", () => {
  const onClose = vi.fn();
  const ui = render(<AboutStatusDialog open onClose={onClose} kernel={{ status: "loading" }} />);
  const dialog = ui.getByRole("dialog", { name: "About / Status" });
  const cancel = new Event("cancel", { cancelable: true });
  fireEvent(dialog, cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(ui.getByRole("button", { name: "Close information" }));
  expect(onClose).toHaveBeenCalledTimes(2);
  (dialog as HTMLDialogElement).open = false;
  fireEvent(dialog, new Event("close"));
  expect(onClose).toHaveBeenCalledTimes(3);
});

it("restores the opener under StrictMode and on unmount", () => {
  const ui = render(
    <StrictMode>
      <button type="button">Opener</button>
      <AboutStatusDialog open={false} onClose={vi.fn()} kernel={ready} />
    </StrictMode>,
  );
  const opener = ui.getByRole("button", { name: "Opener" });
  opener.focus();
  ui.rerender(
    <StrictMode>
      <button type="button">Opener</button>
      <AboutStatusDialog open onClose={vi.fn()} kernel={ready} />
    </StrictMode>,
  );
  expect(document.activeElement).toBe(ui.getByRole("button", { name: "Close information" }));
  ui.rerender(
    <StrictMode>
      <button type="button">Opener</button>
      <AboutStatusDialog open={false} onClose={vi.fn()} kernel={ready} />
    </StrictMode>,
  );
  expect(document.activeElement).toBe(opener);
  ui.rerender(
    <StrictMode>
      <button type="button">Opener</button>
      <AboutStatusDialog open onClose={vi.fn()} kernel={ready} />
    </StrictMode>,
  );
  ui.rerender(
    <StrictMode>
      <button type="button">Opener</button>
    </StrictMode>,
  );
  expect(document.activeElement).toBe(opener);
});

it("survives StrictMode initial-open cleanup and ignores a delayed native close after reopen", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const onClose = vi.fn();
  const ui = render(
    <StrictMode>
      <AboutStatusDialog open onClose={onClose} kernel={ready} />
    </StrictMode>,
  );
  expect(ui.getByRole("dialog", { name: "About / Status" })).toBeDefined();
  expect(document.activeElement).toBe(ui.getByRole("button", { name: "Close information" }));
  fireEvent(ui.getByRole("dialog"), new Event("close"));
  expect(onClose).not.toHaveBeenCalled();
  ui.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("restores an open menu's trigger instead of its disposable menu item", () => {
  const ui = render(
    <>
      <button type="button" aria-haspopup="menu" aria-expanded="true">
        Help
      </button>
      <div role="menu">
        <button type="button" role="menuitem">
          About
        </button>
      </div>
      <AboutStatusDialog open={false} onClose={vi.fn()} kernel={ready} />
    </>,
  );
  const help = ui.getByRole("button", { name: "Help" });
  ui.getByRole("menuitem", { name: "About" }).focus();
  ui.rerender(
    <>
      <button type="button" aria-haspopup="menu" aria-expanded="true">
        Help
      </button>
      <div role="menu">
        <button type="button" role="menuitem">
          About
        </button>
      </div>
      <AboutStatusDialog open onClose={vi.fn()} kernel={ready} />
    </>,
  );
  ui.rerender(
    <>
      <button type="button" aria-haspopup="menu" aria-expanded="false">
        Help
      </button>
      <AboutStatusDialog open={false} onClose={vi.fn()} kernel={ready} />
    </>,
  );
  expect(document.activeElement).toBe(help);
});

it("shows failure diagnostics and restores a fallback when an opener disappears", () => {
  const fallback = document.createElement("button");
  document.body.append(fallback);
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const ref = { current: fallback };
  const ui = render(
    <AboutStatusDialog
      open
      onClose={vi.fn()}
      kernel={{ status: "error", error: "Handshake failed" }}
      fallbackFocusRef={ref}
    />,
  );
  expect(ui.getByText("Handshake failed")).toBeDefined();
  expect(ui.getByTestId("kernel-status").title).toBe("Handshake failed");
  opener.remove();
  ui.rerender(
    <AboutStatusDialog
      open={false}
      onClose={vi.fn()}
      kernel={{ status: "loading" }}
      fallbackFocusRef={ref}
    />,
  );
  expect(document.activeElement).toBe(fallback);
  fallback.remove();
});
