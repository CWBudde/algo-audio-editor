import type { DocumentInfoResult, SelectionRange } from "@aae/protocol";
import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useWaveformKeyboard } from "./use-waveform-keyboard";

const info: DocumentInfoResult = {
  documentId: "doc",
  name: "test.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 172800000,
  bitDepth: 16,
  float: false,
};
function key(key: string, options: Partial<KeyboardEvent<HTMLElement>> = {}) {
  const target = document.createElement("div");
  return {
    key,
    target,
    currentTarget: target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    nativeEvent: { isComposing: false },
    ...options,
  } as unknown as KeyboardEvent<HTMLElement>;
}
function setup(selection: SelectionRange = { start: 10, end: 10, channelMask: 2 }) {
  let owned = false;
  let live = selection;
  const change = vi.fn((range: SelectionRange, _seekFrame?: number) => {
    owned = true;
    live = range;
  });
  const options = {
    info,
    session: {},
    getSelection: () => live,
    disabled: false,
    previewing: false,
    interacting: false,
    change,
    flush: vi.fn(() => {
      owned = false;
    }),
    cancel: vi.fn(() => {
      owned = false;
    }),
    ownsPreview: () => owned,
    interrupt: vi.fn(),
    reveal: vi.fn(),
  };
  return {
    ...renderHook(
      (props) => useWaveformKeyboard({ ...props, hasPreview: () => props.previewing || owned }),
      { initialProps: options },
    ),
    options,
    change,
    setSelection: (range: SelectionRange) => {
      live = range;
    },
  };
}
describe("waveform keyboard geometry", () => {
  it("seeks explicit Home/End boundaries even when the range is already there", () => {
    const s = setup({ start: 0, end: 0, channelMask: 2 });
    s.result.current.onSurfaceKeyDown(key("Home"));
    expect(s.change).toHaveBeenLastCalledWith({ start: 0, end: 0, channelMask: 2 }, 0);
    s.result.current.onSurfaceKeyDown(key("End"));
    s.result.current.onKeyUp(key("End"));
    s.result.current.onSurfaceKeyDown(key("End"));
    expect(s.change).toHaveBeenCalledTimes(3);
    expect(s.change).toHaveBeenLastCalledWith(
      { start: info.frames, end: info.frames, channelMask: 2 },
      info.frames,
    );
  });

  it("resets the extension anchor on editor session replacement", () => {
    const s = setup();
    s.result.current.onSurfaceKeyDown(key("ArrowLeft", { shiftKey: true }));
    s.rerender({ ...s.options, session: {} });
    s.result.current.onSurfaceKeyDown(key("ArrowRight", { shiftKey: true }));
    expect(s.change).toHaveBeenLastCalledWith({ start: 9, end: 11, channelMask: 2 }, 11);
  });
  it("accumulates rapid key repeats before React rerenders without changing the channel mask", () => {
    const s = setup();
    act(() => {
      for (let n = 0; n < 40; n++) s.result.current.onSurfaceKeyDown(key("ArrowRight"));
    });
    expect(s.change).toHaveBeenLastCalledWith({ start: 50, end: 50, channelMask: 2 }, 50);
    expect(s.options.reveal).toHaveBeenLastCalledWith(50);
    s.result.current.onKeyUp(key("ArrowRight"));
    expect(s.options.flush).toHaveBeenCalledTimes(1);
  });
  it("keeps the same extension anchor when moving across it in both directions", () => {
    const s = setup();
    for (const name of ["ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowRight", "ArrowRight"])
      s.result.current.onSurfaceKeyDown(key(name, { shiftKey: true }));
    expect(s.change.mock.calls.map((call) => call)).toEqual([
      [{ start: 10, end: 11, channelMask: 2 }, 11],
      [{ start: 10, end: 10, channelMask: 2 }, 10],
      [{ start: 9, end: 10, channelMask: 2 }, 9],
      [{ start: 10, end: 10, channelMask: 2 }, 10],
      [{ start: 10, end: 11, channelMask: 2 }, 11],
    ]);
  });
  it("collapses a range to the directional edge, extends to boundaries and clamps at EOF", () => {
    const s = setup({ start: 100, end: 200, channelMask: 1 });
    s.result.current.onSurfaceKeyDown(key("ArrowRight"));
    expect(s.change).toHaveBeenLastCalledWith({ start: 200, end: 200, channelMask: 1 }, 200);
    s.result.current.onSurfaceKeyDown(key("End", { shiftKey: true }));
    expect(s.change).toHaveBeenLastCalledWith(
      { start: 200, end: info.frames, channelMask: 1 },
      info.frames,
    );
    s.result.current.onSurfaceKeyDown(key("ArrowRight", { shiftKey: true }));
    expect(s.change).toHaveBeenCalledTimes(2);
    s.result.current.onSurfaceKeyDown(key("Home", { shiftKey: true }));
    expect(s.change).toHaveBeenLastCalledWith({ start: 0, end: 200, channelMask: 1 }, 0);
  });
  it("accelerates edges in documented frame/second units and clamps against the fixed edge", () => {
    const s = setup({ start: 100, end: 1000000, channelMask: 2 });
    s.result.current.onEdgeKeyDown(key("ArrowRight", { shiftKey: true }), "start");
    expect(s.change).toHaveBeenLastCalledWith({ start: 110, end: 1000000, channelMask: 2 }, 110);
    s.result.current.onEdgeKeyDown(key("PageUp"), "start");
    expect(s.change).toHaveBeenLastCalledWith(
      { start: 48110, end: 1000000, channelMask: 2 },
      48110,
    );
    s.result.current.onEdgeKeyDown(key("PageUp", { shiftKey: true }), "start");
    expect(s.change).toHaveBeenLastCalledWith(
      { start: 528110, end: 1000000, channelMask: 2 },
      528110,
    );
    s.result.current.onEdgeKeyDown(key("Home"), "end");
    expect(s.change).toHaveBeenLastCalledWith(
      { start: 528110, end: 528110, channelMask: 2 },
      528110,
    );
    s.result.current.onEdgeKeyDown(key("ArrowLeft"), "start");
    expect(s.change).toHaveBeenLastCalledWith(
      { start: 528109, end: 528110, channelMask: 2 },
      528109,
    );
  });
  it("leaves command modifiers, composition, nested controls and busy/pointer previews alone", () => {
    const s = setup();
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { defaultPrevented: true },
      { nativeEvent: { isComposing: true } },
    ]) {
      const event = key("Home", options as Partial<KeyboardEvent<HTMLElement>>);
      s.result.current.onSurfaceKeyDown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    s.result.current.onSurfaceKeyDown(key("Home", { target: document.createElement("button") }));
    for (const options of [{ disabled: true }, { interacting: true }, { previewing: true }]) {
      s.rerender({ ...s.options, ...options });
      s.result.current.onSurfaceKeyDown(key("ArrowRight"));
    }
    expect(s.change).not.toHaveBeenCalled();
  });
  it("flushes pointer takeover then discards keyboard geometry, and flushes blur", () => {
    const s = setup();
    s.result.current.onSurfaceKeyDown(key("ArrowRight", { shiftKey: true }));
    s.result.current.beforePointer();
    expect(s.options.flush).toHaveBeenCalledTimes(1);
    expect(s.options.cancel).toHaveBeenCalledTimes(1);
    s.setSelection({ start: 300, end: 400, channelMask: 1 });
    s.rerender({ ...s.options });
    s.result.current.onSurfaceKeyDown(key("ArrowLeft", { shiftKey: true }));
    expect(s.change).toHaveBeenLastCalledWith({ start: 299, end: 400, channelMask: 1 }, 299);
    s.result.current.onBlur();
    expect(s.options.flush).toHaveBeenCalledTimes(2);
  });
});
