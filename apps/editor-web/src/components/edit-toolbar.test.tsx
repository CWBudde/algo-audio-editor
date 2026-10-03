import type {
  ClipboardInfo,
  DocumentInfoResult,
  EditOperation,
  PastePlan,
  SelectionRange,
} from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditToolbar, PasteConversionDialog } from "./edit-toolbar";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "a.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 1000,
  bitDepth: 16,
  float: false,
};
const selection: SelectionRange = { start: 100, end: 200, channelMask: 3 };
const clipboard: ClipboardInfo = {
  version: "1",
  available: true,
  sampleRate: 48000,
  channels: 2,
  frames: 100,
};
function mounted(
  overrides: {
    info?: DocumentInfoResult;
    selection?: SelectionRange;
    clipboard?: ClipboardInfo;
    busy?: boolean;
  } = {},
) {
  const props = { info, selection, clipboard, onRun: vi.fn(), ...overrides };
  return { props, ...render(<EditToolbar {...props} />) };
}
afterEach(cleanup);

describe("EditToolbar", () => {
  it("uses an exact controlled silence value and lets the parent own draft and document resets", () => {
    const onRun = vi.fn();
    const onSilenceValueChange = vi.fn();
    const props = { info, selection, onRun, onSilenceValueChange };
    const { getByLabelText, getByRole, rerender } = render(
      <EditToolbar {...props} silenceValue="2,147,483,649" />,
    );
    const field = getByLabelText("Silence frames") as HTMLInputElement;
    fireEvent.click(getByRole("button", { name: "Insert silence" }));
    expect(onRun).toHaveBeenCalledExactlyOnceWith("insert-silence", selection, 2147483649);
    fireEvent.change(field, { target: { value: "128" } });
    expect(onSilenceValueChange).toHaveBeenCalledExactlyOnceWith("128");
    expect(field.value).toBe("2,147,483,649");
    rerender(<EditToolbar {...props} silenceValue="128" />);
    fireEvent.click(getByRole("button", { name: "Insert silence" }));
    expect(onRun).toHaveBeenLastCalledWith("insert-silence", selection, 128);
    rerender(
      <EditToolbar
        {...props}
        info={{ ...info, documentId: "doc-2", sampleRate: 44100 }}
        silenceValue="128"
      />,
    );
    expect(field.value).toBe("128");
    expect(onSilenceValueChange).toHaveBeenCalledTimes(1);
  });

  it("validates controlled silence values and restores local defaults when control is removed", () => {
    const props = { info, selection, onRun: vi.fn() };
    const { getByLabelText, getByRole, rerender } = render(
      <EditToolbar {...props} silenceValue="0" />,
    );
    expect(getByLabelText("Silence frames").getAttribute("aria-invalid")).toBe("true");
    expect((getByRole("button", { name: "Insert silence" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<EditToolbar {...props} info={{ ...info, sampleRate: 44100 }} />);
    expect((getByLabelText("Silence frames") as HTMLInputElement).value).toBe("44100");
    fireEvent.change(getByLabelText("Silence frames"), { target: { value: "64" } });
    fireEvent.click(getByRole("button", { name: "Insert silence" }));
    expect(props.onRun).toHaveBeenCalledExactlyOnceWith("insert-silence", selection, 64);
  });

  it.each([
    ["Cut", "cut"],
    ["Copy", "copy"],
    ["Paste", "paste-insert"],
    ["Replace with clipboard", "paste-replace"],
    ["Mix clipboard", "paste-mix"],
    ["Delete", "delete"],
    ["Crop time (all channels)", "crop"],
    ["Duplicate", "duplicate"],
    ["Swap selected channels", "swap-channels"],
    ["Mute", "mute"],
  ] as const)(
    "dispatches %s as %s with exact selected channels",
    (label, operation: EditOperation) => {
      const { getByRole, props } = mounted();
      fireEvent.click(getByRole("button", { name: label }));
      expect(props.onRun).toHaveBeenCalledExactlyOnceWith(operation, selection, undefined);
    },
  );

  it("disables everything while busy or without a loaded document", () => {
    const { getAllByRole, getByLabelText, props, rerender } = mounted({ busy: true });
    for (const button of getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect((getByLabelText("Silence frames") as HTMLInputElement).disabled).toBe(true);
    expect(props.onRun).not.toHaveBeenCalled();
    rerender(<EditToolbar {...props} busy={false} info={undefined} />);
    for (const button of getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires nonempty ranges only for range actions and permits full-document channel swap", () => {
    const { getByRole, props } = mounted({ selection: { ...selection, end: selection.start } });
    for (const name of ["Cut", "Copy", "Delete", "Crop time (all channels)", "Duplicate", "Mute"])
      expect((getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (getByRole("button", { name: "Swap selected channels" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(getByRole("button", { name: "Swap selected channels" }));
    expect(props.onRun).toHaveBeenCalledWith("swap-channels", props.selection, undefined);
  });

  it("can paste and insert silence into an empty loaded document", () => {
    const { getByRole, props } = mounted({
      info: { ...info, frames: 0 },
      selection: { start: 0, end: 0, channelMask: 3 },
    });
    fireEvent.click(getByRole("button", { name: "Paste" }));
    expect(props.onRun).toHaveBeenCalledWith("paste-insert", props.selection, undefined);
    fireEvent.click(getByRole("button", { name: "Insert silence" }));
    expect(props.onRun).toHaveBeenCalledWith("insert-silence", props.selection, 48000);
  });

  it.each([undefined, { ...clipboard, available: false }, { ...clipboard, frames: 0 }])(
    "disables paste modes for an unavailable clipboard",
    (value) => {
      const { getByRole } = mounted({ clipboard: value });
      for (const name of ["Paste", "Replace with clipboard", "Mix clipboard"])
        expect((getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      expect((getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false);
    },
  );

  it.each([
    [129, true],
    [3, true],
    [255, false],
    [128, false],
    [0, false],
  ])(
    "requires exactly two valid selected channels for eight-channel swap (%s)",
    (channelMask, enabled) => {
      const { getByRole, props } = mounted({
        info: { ...info, channels: 8 },
        selection: { ...selection, channelMask: Number(channelMask) },
      });
      const swap = getByRole("button", { name: "Swap selected channels" }) as HTMLButtonElement;
      expect(!swap.disabled).toBe(enabled);
      fireEvent.click(swap);
      expect(props.onRun).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );

  it("preserves a subset mask for copy while explicitly describing crop's all-channel time scope", () => {
    const { getByRole, props } = mounted({ selection: { ...selection, channelMask: 2 } });
    fireEvent.click(getByRole("button", { name: "Copy" }));
    fireEvent.click(getByRole("button", { name: "Crop time (all channels)" }));
    expect(props.onRun).toHaveBeenNthCalledWith(
      1,
      "copy",
      { ...selection, channelMask: 2 },
      undefined,
    );
    expect(props.onRun).toHaveBeenNthCalledWith(
      2,
      "crop",
      { ...selection, channelMask: 2 },
      undefined,
    );
  });

  it("uses sample counts exactly, accepts commas, and resets the duration for a new document", () => {
    const { getByLabelText, getByRole, props, rerender } = mounted();
    fireEvent.change(getByLabelText("Silence frames"), { target: { value: "2,147,483,649" } });
    fireEvent.click(getByRole("button", { name: "Insert silence" }));
    expect(props.onRun).toHaveBeenCalledWith("insert-silence", selection, 2147483649);
    rerender(<EditToolbar {...props} info={{ ...info, documentId: "doc-2", sampleRate: 44100 }} />);
    expect((getByLabelText("Silence frames") as HTMLInputElement).value).toBe("44100");
  });

  it.each(["0", "-1", "0.5", "no", "1,00", "9007199254740991"])(
    "rejects invalid or overflowing silence duration %s",
    (value) => {
      const { getByLabelText, getByRole, props } = mounted();
      const field = getByLabelText("Silence frames");
      fireEvent.change(field, { target: { value } });
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe(getByRole("alert").id);
      const button = getByRole("button", { name: "Insert silence" }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(props.onRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...selection, start: -1 },
    { ...selection, end: 1001 },
    { ...selection, channelMask: 4 },
    { ...selection, start: 100.5 },
  ])("rejects invalid external selection before dispatch", (range) => {
    const { getAllByRole, props } = mounted({ selection: range });
    for (const button of getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(props.onRun).not.toHaveBeenCalled();
  });
});

describe("PasteConversionDialog", () => {
  const plan: PastePlan = {
    conversionRequired: true,
    sourceRate: 44100,
    targetRate: 48000,
    sourceChannels: 1,
    targetChannels: 2,
    frames: 109,
    clipboardVersion: "1",
  };
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      }),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the exact conversion and exposes explicit cancel/confirm choices", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByRole, getByText } = render(
      <PasteConversionDialog plan={plan} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(getByRole("dialog", { name: "Convert clipboard" })).toBeTruthy();
    expect(getByText(/44100 Hz \/ 1 channels to 48000 Hz \/ 2 channels/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Convert and paste" }));
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("handles native Escape cancellation and closes when the pending plan disappears", () => {
    const onCancel = vi.fn();
    const props = { plan, onCancel, onConfirm: vi.fn() };
    const { getByRole, queryByRole, rerender } = render(<PasteConversionDialog {...props} />);
    const dialog = getByRole("dialog");
    const event = new Event("cancel", { cancelable: true, bubbles: true });
    fireEvent(dialog, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(<PasteConversionDialog {...props} plan={undefined} />);
    expect(queryByRole("dialog")).toBeNull();
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
  });

  it.each([
    [1, 8, "Mono is copied to every selected channel."],
    [8, 1, "Source channels are averaged into the selected mono channel."],
    [
      5,
      2,
      "Source channels fold cyclically into selected channels; contributors to each channel are averaged.",
    ],
    [2, 5, "Source channels repeat cyclically across the selected channels."],
  ])(
    "explains the kernel channel mapping for %s to %s channels",
    (sourceChannels, targetChannels, text) => {
      const { getByText, getByRole } = render(
        <PasteConversionDialog
          plan={{
            ...plan,
            sourceChannels: Number(sourceChannels),
            targetChannels: Number(targetChannels),
          }}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(getByText(String(text))).toBeTruthy();
      expect(getByRole("dialog").getAttribute("aria-describedby")).toBe(
        getByText(String(text)).parentElement?.id,
      );
    },
  );

  it("does not imply channel mixing for rate-only conversion", () => {
    const { queryByText, getByText } = render(
      <PasteConversionDialog
        plan={{ ...plan, sourceChannels: 2, targetChannels: 2 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(getByText(/44100 Hz \/ 2 channels to 48000 Hz \/ 2 channels/)).toBeTruthy();
    expect(queryByText(/copied to every|averaged|cyclically/)).toBeNull();
  });
});
