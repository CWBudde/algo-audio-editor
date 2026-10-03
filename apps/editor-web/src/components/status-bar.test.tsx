import type { DocumentInfoResult } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StatusBar } from "./status-bar";

afterEach(cleanup);
const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "recording.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 48000,
  bitDepth: 16,
  float: false,
};

it("shows document metadata and the exact saved state in the footer", () => {
  const ui = render(<StatusBar info={info} dirty={false} onInformation={vi.fn()} />);
  expect(ui.getByTestId("document-name").textContent).toBe("recording.wav");
  expect(ui.getByTestId("document-details").textContent).toBe(
    "48000 Hz · 2 channels · 48000 frames · 1.000 s · 16-bit PCM",
  );
  expect(ui.getByTestId("document-save-status").textContent).toBe("Saved");
  expect(ui.getByTestId("document-info").getAttribute("data-document-id")).toBe("doc-1");
  ui.rerender(<StatusBar info={{ ...info, documentId: "doc-2" }} dirty onInformation={vi.fn()} />);
  expect(ui.getByTestId("document-save-status").textContent).toBe("Unsaved changes");
  expect(ui.getByTestId("document-info").getAttribute("data-document-id")).toBe("doc-2");
  ui.rerender(<StatusBar info={info} onInformation={vi.fn()} />);
  expect(ui.getByTestId("document-save-status").textContent).toBe("Save status pending");
});

it("handles no document, empty mono files, long names, and large eight-channel files", () => {
  const ui = render(<StatusBar onInformation={vi.fn()} />);
  expect(ui.getByText("No document open")).toBeDefined();
  expect(ui.queryByTestId("document-details")).toBeNull();
  ui.rerender(
    <StatusBar
      info={{
        ...info,
        name: `${"音声".repeat(100)}.wav`,
        frames: 0,
        channels: 1,
        bitDepth: 32,
        float: true,
      }}
      dirty={false}
      onInformation={vi.fn()}
    />,
  );
  expect(ui.getByTestId("document-name").title).toBe(`${"音声".repeat(100)}.wav`);
  expect(ui.getByTestId("document-details").textContent).toBe(
    "48000 Hz · 1 channel · 0 frames · 0.000 s · 32-bit float",
  );
  ui.rerender(
    <StatusBar
      info={{ ...info, frames: 2 ** 32, channels: 8 }}
      dirty={false}
      onInformation={vi.fn()}
    />,
  );
  expect(ui.getByTestId("document-details").textContent).toContain(
    "8 channels · 4294967296 frames",
  );
});

it("opens information only through its button and respects modal disabling", () => {
  const onInformation = vi.fn();
  const ref = { current: null as HTMLButtonElement | null };
  const ui = render(<StatusBar info={info} onInformation={onInformation} informationRef={ref} />);
  fireEvent.click(ui.getByTestId("document-details"));
  expect(onInformation).not.toHaveBeenCalled();
  fireEvent.click(ui.getByRole("button", { name: "Information" }));
  expect(onInformation).toHaveBeenCalledTimes(1);
  expect(ref.current).toBe(ui.getByRole("button", { name: "Information" }));
  ui.rerender(<StatusBar info={info} onInformation={onInformation} informationDisabled />);
  fireEvent.click(ui.getByRole("button", { name: "Information" }));
  expect(onInformation).toHaveBeenCalledTimes(1);
});
