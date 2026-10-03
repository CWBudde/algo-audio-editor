import type { SelectionRange } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSelectionTime } from "@/lib/selection";
import type { TimeFormat } from "@/lib/waveform-geometry";
import { SelectionBar } from "./selection-bar";

const selection: SelectionRange = { start: 100, end: 200, channelMask: 3 };

function mounted(
  overrides: {
    selection?: SelectionRange;
    frames?: number;
    sampleRate?: number;
    channels?: number;
    timeFormat?: TimeFormat;
    disabled?: boolean;
  } = {},
) {
  const onChange = vi.fn();
  const props = {
    selection,
    frames: 1000,
    sampleRate: 48000,
    channels: 2,
    timeFormat: "samples" as TimeFormat,
    ...overrides,
    onChange,
  };
  return { ...render(<SelectionBar {...props} />), props, onChange };
}

function edit(input: HTMLElement, text: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}

afterEach(cleanup);

describe("SelectionBar numeric editing", () => {
  it("discloses channel choices while keeping numeric fields directly editable", () => {
    const { getByTestId, getByLabelText, getByText } = mounted();
    const details = getByTestId("channel-settings") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(getByLabelText("Selection start")).toBeTruthy();
    expect(getByText("Channels: All")).toBeTruthy();
    fireEvent.click(details.querySelector("summary") as HTMLElement);
    expect(details.open).toBe(true);
    expect(getByLabelText("Channel 1 selected")).toBeTruthy();
  });
  it("exposes exact start/end/length labels and sample coordinate values", () => {
    const { getByLabelText } = mounted();
    expect((getByLabelText("Selection start") as HTMLInputElement).value).toBe("100");
    expect((getByLabelText("Selection end") as HTMLInputElement).value).toBe("200");
    expect((getByLabelText("Selection length") as HTMLInputElement).value).toBe("100");
  });

  it.each([
    ["Selection start", "50", { start: 50, end: 200, channelMask: 3 }],
    ["Selection end", "250", { start: 100, end: 250, channelMask: 3 }],
    ["Selection length", "50", { start: 100, end: 150, channelMask: 3 }],
    ["Selection length", "0", { start: 100, end: 100, channelMask: 3 }],
  ])("commits %s atomically on Enter and does not repeat on blur", (label, text, expected) => {
    const { getByLabelText, onChange } = mounted();
    const input = getByLabelText(label as string);
    edit(input, text as string);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expected);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("commits on blur but not for unchanged focused or equivalent numeric values", () => {
    const { getByLabelText, onChange } = mounted();
    const input = getByLabelText("Selection start");
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    edit(input, "0100");
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    edit(input, "75");
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...selection, start: 75 });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it.each([
    ["Selection start", "201"],
    ["Selection start", "-1"],
    ["Selection end", "99"],
    ["Selection end", "1001"],
    ["Selection length", "901"],
    ["Selection length", "1,00"],
  ])("rejects invalid %s=%s without mutating another coordinate", (label, text) => {
    const { getByLabelText, getByRole, onChange } = mounted();
    const input = getByLabelText(label);
    edit(input, text);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(getByRole("alert").id);
    expect((input as HTMLInputElement).value).toBe(text);
  });

  it("recovers from invalid input and cancels drafts with Escape", () => {
    const { getByLabelText, queryByRole, onChange } = mounted();
    const input = getByLabelText("Selection start");
    edit(input, "300");
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("100");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(queryByRole("alert")).toBeNull();
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    edit(input, "150");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...selection, start: 150 });
  });

  it("preserves a focused draft and validates against latest external bounds and channels", () => {
    const { getByLabelText, rerender, props, onChange } = mounted();
    const input = getByLabelText("Selection start");
    edit(input, "150");
    rerender(<SelectionBar {...props} selection={{ start: 120, end: 140, channelMask: 2 }} />);
    expect((input as HTMLInputElement).value).toBe("150");
    expect((getByLabelText("Selection end") as HTMLInputElement).value).toBe("140");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "130" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ start: 130, end: 140, channelMask: 2 });
  });

  it("does not overwrite an external change when an untouched draft blurs", () => {
    const { getByLabelText, rerender, props, onChange } = mounted();
    const input = getByLabelText("Selection start");
    fireEvent.focus(input);
    rerender(<SelectionBar {...props} selection={{ ...selection, start: 120 }} />);
    expect((input as HTMLInputElement).value).toBe("100");
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("120");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates unfocused values across time formats and keeps the editing draft's original units", () => {
    const { getByLabelText, rerender, props, onChange } = mounted({
      selection: { start: 48000, end: 96000, channelMask: 3 },
      frames: 192000,
      timeFormat: "seconds",
    });
    const input = getByLabelText("Selection start");
    expect((input as HTMLInputElement).value).toBe("1");
    edit(input, "1.5");
    rerender(<SelectionBar {...props} timeFormat="samples" sampleRate={96000} />);
    expect((input as HTMLInputElement).value).toBe("1.5");
    expect((getByLabelText("Selection end") as HTMLInputElement).value).toBe("96,000");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ start: 72000, end: 96000, channelMask: 3 });
  });

  it("round-trips high-rate long-frame fields and rejects overflowing length arithmetic", () => {
    const long = {
      start: Number.MAX_SAFE_INTEGER - 1,
      end: Number.MAX_SAFE_INTEGER,
      channelMask: 1,
    };
    const { getByLabelText, rerender, props, onChange } = mounted({
      selection: long,
      frames: Number.MAX_SAFE_INTEGER,
      sampleRate: 384000,
      channels: 1,
      timeFormat: "hms",
    });
    expect((getByLabelText("Selection start") as HTMLInputElement).value).toBe(
      formatSelectionTime(long.start, 384000, "hms"),
    );
    const input = getByLabelText("Selection start");
    edit(input, formatSelectionTime(long.start - 1, 384000, "hms"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...long, start: long.start - 1 });
    onChange.mockClear();
    rerender(
      <SelectionBar
        {...props}
        timeFormat="samples"
        selection={{ start: 1, end: 2, channelMask: 1 }}
      />,
    );
    const length = getByLabelText("Selection length");
    edit(length, String(Number.MAX_SAFE_INTEGER));
    fireEvent.blur(length);
    expect(onChange).not.toHaveBeenCalled();
    expect(length.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("SelectionBar channel targeting", () => {
  it("supports All, Left and Right stereo choices", () => {
    const { getByRole, rerender, props, onChange } = mounted();
    expect(getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button", { name: "Left" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...selection, channelMask: 1 });
    rerender(<SelectionBar {...props} selection={{ ...selection, channelMask: 1 }} />);
    expect(getByRole("button", { name: "Left" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button", { name: "Right" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...selection, channelMask: 2 });
    rerender(<SelectionBar {...props} selection={{ ...selection, channelMask: 2 }} />);
    fireEvent.click(getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenLastCalledWith(selection);
  });

  it("offers arbitrary channel subsets and never removes the final selected channel", () => {
    const initial = { ...selection, channelMask: 255 };
    const { getByLabelText, queryByRole, rerender, props, onChange } = mounted({
      selection: initial,
      channels: 8,
    });
    expect(queryByRole("button", { name: "Left" })).toBeNull();
    fireEvent.click(getByLabelText("Channel 8 selected"));
    expect(onChange).toHaveBeenLastCalledWith({ ...selection, channelMask: 127 });
    rerender(<SelectionBar {...props} selection={{ ...selection, channelMask: 1 }} />);
    const last = getByLabelText("Channel 1 selected") as HTMLInputElement;
    expect(last.checked).toBe(true);
    expect(last.disabled).toBe(true);
    fireEvent.click(last);
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.click(getByLabelText("Channel 4 selected"));
    expect(onChange).toHaveBeenLastCalledWith({ ...selection, channelMask: 9 });
  });

  it("defaults invalid external masks to All for display without ever emitting an empty mask", () => {
    const { getByRole, getByLabelText, onChange } = mounted({
      selection: { ...selection, channelMask: 0 },
    });
    expect(getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect((getByLabelText("Channel 1 selected") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(getByRole("button", { name: "Left" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...selection, channelMask: 1 });
  });

  it("disables all numeric and channel controls without callbacks", () => {
    const { getByLabelText, getAllByRole, getByRole, onChange } = mounted({ disabled: true });
    for (const input of [
      ...getAllByRole("textbox"),
      ...getAllByRole("checkbox"),
      ...getAllByRole("button"),
    ])
      expect(input.matches(":disabled")).toBe(true);
    edit(getByLabelText("Selection start"), "50");
    fireEvent.keyDown(getByLabelText("Selection start"), { key: "Enter" });
    fireEvent.click(getByRole("button", { name: "Left" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
