import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpectralSelectionLayer } from "./spectral-selection-layer";

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary = true;
  constructor(type: string, options: MouseEventInit & { pointerId?: number } = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
  }
}
beforeEach(() => vi.stubGlobal("PointerEvent", TestPointerEvent));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const base = {
  documentId: "doc",
  frames: 1000,
  sampleRate: 48000,
  channel: 1,
  viewport: { start: 0, end: 1000 },
  width: 100,
  height: 100,
  tool: "rectangle" as const,
  disabled: false,
};
function setup(svg: Element) {
  const node = svg as SVGSVGElement;
  node.setPointerCapture = vi.fn();
  node.hasPointerCapture = () => true;
  node.releasePointerCapture = vi.fn();
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON() {},
  });
  return node;
}
it("publishes a rectangle only on release, preserves its channel and clears on Escape", () => {
  const onChange = vi.fn();
  const view = render(<SpectralSelectionLayer {...base} onChange={onChange} />);
  const svg = setup(view.getByRole("application"));
  fireEvent.pointerDown(svg, { clientX: 90, clientY: 20, button: 0 });
  fireEvent.pointerMove(svg, { clientX: 10, clientY: 80 });
  expect(onChange).not.toHaveBeenCalled();
  expect(svg.getAttribute("data-start-frame")).toBe("100");
  fireEvent.pointerUp(svg, { clientX: 10, clientY: 80 });
  expect(onChange).toHaveBeenCalledWith({
    documentId: "doc",
    channelMask: 2,
    mask: { start: 100, end: 900, lowHz: (1 - 0.8) * 24000, highHz: 19200 },
  });
  fireEvent.keyDown(svg, { key: "Escape" });
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});
it("retains a bounded polygon and rejects canceled, obsolete and disabled gestures", () => {
  const onChange = vi.fn();
  const view = render(<SpectralSelectionLayer {...base} tool="lasso" onChange={onChange} />);
  let svg = setup(view.getByRole("application"));
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 90, button: 0 });
  for (let i = 0; i < 160; i++)
    fireEvent.pointerMove(svg, { clientX: 20 + (i % 60), clientY: 20 + (i % 50) });
  fireEvent.pointerUp(svg, { clientX: 10, clientY: 90 });
  expect(onChange.mock.calls[0]?.[0].mask.points.length).toBeLessThanOrEqual(128);
  onChange.mockClear();
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 90, button: 0 });
  fireEvent.pointerCancel(svg);
  fireEvent.pointerUp(svg, { clientX: 90, clientY: 10 });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 90, button: 0 });
  view.rerender(<SpectralSelectionLayer {...base} documentId="new" onChange={onChange} />);
  svg = view.getByRole("application") as unknown as SVGSVGElement;
  fireEvent.pointerUp(svg, { clientX: 90, clientY: 10 });
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<SpectralSelectionLayer {...base} disabled onChange={onChange} />);
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 90, button: 0 });
  fireEvent.pointerUp(svg, { clientX: 90, clientY: 10 });
  expect(onChange).not.toHaveBeenCalled();
});
