import type { AnalysisJobResult } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnalysisView } from "@/hooks/use-analysis-dialog";
import { AnalysisDialog } from "./analysis-dialog";

const info = {
  documentId: "doc",
  name: "tone.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 100,
  bitDepth: 32,
  float: true,
};
const view: AnalysisView = {
  info,
  selection: { start: 10, end: 30, channelMask: 2 },
  kind: "statistics",
  working: false,
  committing: false,
  job: {
    documentId: "doc",
    jobId: "analysis",
    start: 10,
    end: 30,
    channelMask: 2,
    kind: "statistics",
    state: "ready",
    processedFrames: 20,
    totalFrames: 20,
    sampleRate: 48000,
    dataBytes: 0,
    channels: [1],
    integratedLUFS: -20,
    statistics: [
      {
        channel: 1,
        peak: 0.5,
        rms: 0.25,
        dc: -0.125,
        crestDB: 6.02,
        zeroCrossings: 9,
        clippedSamples: 3,
      },
    ],
  },
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(cleanup);
it("shows physical channels and clear units for kernel statistics and restores focus", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const onCancel = vi.fn();
  const ui = render(<AnalysisDialog view={view} onCancel={onCancel} onCommit={vi.fn()} />);
  expect(ui.getByRole("dialog", { name: "Audio statistics" })).toBeTruthy();
  expect(ui.getByRole("columnheader", { name: "DC offset" })).toBeTruthy();
  expect(ui.getByText("-0.125000")).toBeTruthy();
  expect(ui.getByText(/-20.0 LUFS/)).toBeTruthy();
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onCancel).toHaveBeenCalledOnce();
  ui.rerender(<AnalysisDialog onCancel={onCancel} onCommit={vi.fn()} />);
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
it("displays kernel pitch frequency and confidence and permits bounded-job Escape cancellation", () => {
  const onCancel = vi.fn(),
    ui = render(
      <AnalysisDialog
        view={{
          ...view,
          kind: "pitch",
          job: {
            ...(view.job as AnalysisJobResult),
            kind: "pitch",
            records: 1,
            dataBytes: 32,
            data: new Float64Array([1, 20, 440, 0.98]).buffer,
          },
        }}
        onCancel={onCancel}
        onCommit={vi.fn()}
      />,
    );
  expect(ui.getByText("440.00")).toBeTruthy();
  expect(ui.getByText("0.980")).toBeTruthy();
  expect(ui.getByTestId("pitch-track-path").getAttribute("d")).toMatch(/^M/);
  ui.rerender(
    <AnalysisDialog view={{ ...view, working: true }} onCancel={onCancel} onCommit={vi.fn()} />,
  );
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onCancel).toHaveBeenCalledOnce();
  ui.rerender(
    <AnalysisDialog
      view={{ ...view, working: true, committing: true }}
      onCancel={onCancel}
      onCommit={vi.fn()}
    />,
  );
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect((ui.getByRole("button", { name: "Cancel analysis" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
