import type { DocumentInfoResult, TimelineResult } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelinePanel } from "./timeline-panel";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "audio.wav",
  sampleRate: 384000,
  frames: Number.MAX_SAFE_INTEGER,
  channels: 8,
  bitDepth: 32,
  float: true,
};
const timeline: TimelineResult = {
  documentId: info.documentId,
  markers: [{ id: 1, frame: Number.MAX_SAFE_INTEGER - 1, name: "Cue", color: "#123456" }],
  regions: [{ id: 2, start: 384000, end: 768000, name: "Verse", color: "#abcdef" }],
};
const selection = { start: 10, end: 20, channelMask: 5 };
function mounted(options: { busy?: boolean; timeFormat?: "samples" | "seconds" | "hms" } = {}) {
  const callbacks = {
    onUpdateMarker: vi.fn(),
    onUpdateRegion: vi.fn(),
    onRemoveMarker: vi.fn(),
    onRemoveRegion: vi.fn(),
    onJump: vi.fn(),
    onExport: vi.fn(),
  };
  const props = {
    info,
    timeline,
    selection,
    timeFormat: "samples" as const,
    ...options,
    ...callbacks,
  };
  const view = render(<TimelinePanel {...props} />);
  const details = view.container.querySelector("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return { ...view, callbacks, props };
}
afterEach(cleanup);

describe("TimelinePanel", () => {
  it("is collapsed until requested, then exposes named colored entries and delegated exports", () => {
    const callback = vi.fn();
    const { container, queryByRole, getByRole, getByLabelText } = render(
      <TimelinePanel
        info={info}
        timeline={timeline}
        selection={selection}
        timeFormat="samples"
        onUpdateMarker={callback}
        onUpdateRegion={callback}
        onRemoveMarker={callback}
        onRemoveRegion={callback}
        onJump={callback}
        onExport={callback}
      />,
    );
    expect(queryByRole("button", { name: "Export CSV" })).toBeNull();
    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(getByLabelText("Color #123456").style.backgroundColor).toBe("rgb(18, 52, 86)");
    fireEvent.click(getByRole("button", { name: "Export CSV" }));
    fireEvent.click(getByRole("button", { name: "Export labels" }));
    expect(callback.mock.calls).toEqual([["csv"], ["labels"]]);
  });

  it("jumps to markers/regions with the current channel subset and deletes by identity", () => {
    const { getByRole, callbacks } = mounted();
    fireEvent.click(getByRole("button", { name: "Jump to marker Cue" }));
    fireEvent.click(getByRole("button", { name: "Jump to region Verse" }));
    expect(callbacks.onJump.mock.calls).toEqual([
      [{ start: info.frames - 1, end: info.frames - 1, channelMask: 5 }],
      [{ start: 384000, end: 768000, channelMask: 5 }],
    ]);
    fireEvent.click(getByRole("button", { name: "Delete marker Cue" }));
    fireEvent.click(getByRole("button", { name: "Delete region Verse" }));
    expect(callbacks.onRemoveMarker).toHaveBeenCalledWith(1);
    expect(callbacks.onRemoveRegion).toHaveBeenCalledWith(2);
  });

  it.each(["samples", "seconds", "hms"] as const)(
    "roundtrips safe-integer marker positions in %s at 384kHz",
    (timeFormat) => {
      const { getByRole, getByLabelText, callbacks } = mounted({ timeFormat });
      fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
      fireEvent.change(getByLabelText("Timeline name"), { target: { value: "Renamed" } });
      fireEvent.change(getByLabelText("Timeline color"), { target: { value: "#fedcba" } });
      fireEvent.click(getByRole("button", { name: "Save marker" }));
      expect(callbacks.onUpdateMarker).toHaveBeenCalledWith({
        id: 1,
        frame: Number.MAX_SAFE_INTEGER - 1,
        name: "Renamed",
        color: "#fedcba",
      });
    },
  );

  it("validates both region endpoints atomically and commits Enter through the form", () => {
    const { getByRole, getByLabelText, callbacks } = mounted();
    fireEvent.click(getByRole("button", { name: "Edit region Verse" }));
    fireEvent.change(getByLabelText("Region start"), { target: { value: "900000" } });
    fireEvent.click(getByRole("button", { name: "Save region" }));
    expect(getByRole("alert").textContent).toContain("end after start");
    expect(getByLabelText("Region start").getAttribute("aria-invalid")).toBe("true");
    expect(callbacks.onUpdateRegion).not.toHaveBeenCalled();
    fireEvent.change(getByLabelText("Region end"), { target: { value: "960000" } });
    fireEvent.submit(getByRole("form", { name: "Edit region" }));
    expect(callbacks.onUpdateRegion).toHaveBeenCalledWith({
      id: 2,
      start: 900000,
      end: 960000,
      name: "Verse",
      color: "#abcdef",
    });
  });

  it.each(["-1", "9007199254740992", "1.2", "NaN", "", "1e5"])(
    "rejects invalid sample marker input %j",
    (value) => {
      const { getByRole, getByLabelText, callbacks } = mounted();
      fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
      fireEvent.change(getByLabelText("Marker position"), { target: { value } });
      fireEvent.click(getByRole("button", { name: "Save marker" }));
      expect(getByRole("alert")).toBeTruthy();
      expect(callbacks.onUpdateMarker).not.toHaveBeenCalled();
    },
  );

  it("has one editor, supports Escape/cancel, and forgets old-document drafts immediately", () => {
    const { getByRole, getByLabelText, queryByRole, callbacks, rerender, props } = mounted();
    fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
    fireEvent.change(getByLabelText("Timeline name"), { target: { value: "Unsaved" } });
    fireEvent.click(getByRole("button", { name: "Edit region Verse" }));
    expect(queryByRole("form", { name: "Edit marker" })).toBeNull();
    expect((getByLabelText("Timeline name") as HTMLInputElement).value).toBe("Verse");
    fireEvent.keyDown(getByLabelText("Timeline name"), { key: "Escape" });
    expect(queryByRole("form")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(queryByRole("form")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
    rerender(
      <TimelinePanel
        {...props}
        info={{ ...info, documentId: "doc-2" }}
        timeline={{ ...timeline, documentId: "doc-2" }}
      />,
    );
    expect(queryByRole("form")).toBeNull();
    expect(callbacks.onUpdateMarker).not.toHaveBeenCalled();
  });

  it("does not reinterpret a focused draft when the ruler format changes", () => {
    const { getByRole, getByLabelText, rerender, props, callbacks } = mounted();
    fireEvent.click(getByRole("button", { name: "Edit region Verse" }));
    fireEvent.change(getByLabelText("Region start"), { target: { value: "400000" } });
    rerender(<TimelinePanel {...props} timeFormat="seconds" />);
    fireEvent.click(getByRole("button", { name: "Save region" }));
    expect(callbacks.onUpdateRegion).toHaveBeenCalledWith(
      expect.objectContaining({ start: 400000, end: 768000 }),
    );
  });

  it.each(["", "   ", "bad\0name", "🎵".repeat(65)])(
    "retains a rejected name draft %j for correction",
    (name) => {
      const { getByRole, getByLabelText, callbacks } = mounted();
      fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
      fireEvent.change(getByLabelText("Timeline name"), { target: { value: name } });
      fireEvent.click(getByRole("button", { name: "Save marker" }));
      expect(getByRole("alert").textContent).toContain("256 UTF-8 bytes");
      expect((getByLabelText("Timeline name") as HTMLInputElement).value).toBe(name);
      expect(getByLabelText("Timeline name").getAttribute("aria-invalid")).toBe("true");
      expect(callbacks.onUpdateMarker).not.toHaveBeenCalled();
      fireEvent.change(getByLabelText("Timeline name"), { target: { value: "🎵".repeat(64) } });
      fireEvent.click(getByRole("button", { name: "Save marker" }));
      expect(callbacks.onUpdateMarker).toHaveBeenCalledWith(
        expect.objectContaining({ name: "🎵".repeat(64) }),
      );
    },
  );

  it("invalidates drafts synchronously on a same-document client/session replacement", () => {
    const { getByRole, getByLabelText, queryByRole, rerender, props, callbacks } = mounted();
    fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
    fireEvent.change(getByLabelText("Timeline name"), { target: { value: "Old session" } });
    rerender(<TimelinePanel {...props} sessionKey={{}} />);
    expect(queryByRole("form")).toBeNull();
    expect(callbacks.onUpdateMarker).not.toHaveBeenCalled();
  });

  it("disables all workflows while busy, including an already-open draft", () => {
    const { getByRole, getByLabelText, rerender, props, callbacks } = mounted();
    fireEvent.click(getByRole("button", { name: "Edit marker Cue" }));
    rerender(<TimelinePanel {...props} busy />);
    expect((getByLabelText("Timeline name") as HTMLInputElement).disabled).toBe(true);
    for (const name of [
      "Save marker",
      "Delete marker Cue",
      "Jump to region Verse",
      "Export CSV",
      "Export labels",
    ]) {
      const button = getByRole("button", { name });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(callbacks.onUpdateMarker).not.toHaveBeenCalled();
    expect(callbacks.onRemoveMarker).not.toHaveBeenCalled();
    expect(callbacks.onJump).not.toHaveBeenCalled();
    expect(callbacks.onExport).not.toHaveBeenCalled();
  });

  it("does not flatten tabs/newlines in existing names before delegated label export", () => {
    const { rerender, props, getByRole, callbacks } = mounted();
    rerender(
      <TimelinePanel
        {...props}
        timeline={{ ...timeline, markers: [{ ...timeline.markers[0], name: "tab\tline\nname" }] }}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Export labels" }));
    expect(callbacks.onExport).toHaveBeenCalledWith("labels");
  });
});
