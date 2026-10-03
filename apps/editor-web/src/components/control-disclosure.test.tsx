import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlDisclosure } from "./control-disclosure";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ControlDisclosure", () => {
  it("keeps popovers inside the viewport and repositions them on resize", () => {
    const { getByTestId, getByText } = render(
      <ControlDisclosure data-testid="settings">
        <summary>Settings</summary>
        <div data-disclosure-panel data-testid="panel">
          Options
        </div>
      </ControlDisclosure>,
    );
    const details = getByTestId("settings") as HTMLDetailsElement;
    const panel = getByTestId("panel");
    vi.spyOn(getByText("Settings"), "getBoundingClientRect").mockReturnValue(
      new DOMRect(950, 700, 28, 28),
    );
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(950, 728, 300, 200));
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.left).toBe("716px");
    expect(panel.style.top).toBe("496px");
    vi.stubGlobal("innerWidth", 340);
    fireEvent(window, new Event("resize"));
    expect(panel.style.left).toBe("32px");
    expect(panel.style.maxWidth).toBe("324px");
  });
  it("keeps native activation and dismisses outside without stealing focus", () => {
    const { getByText, getByTestId } = render(
      <>
        <ControlDisclosure data-testid="settings">
          <summary>Settings</summary>
          <input aria-label="Option" />
        </ControlDisclosure>
        <button type="button">Outside</button>
      </>,
    );
    const details = getByTestId("settings") as HTMLDetailsElement;
    fireEvent.click(getByText("Settings"));
    expect(details.open).toBe(true);
    const outside = getByText("Outside");
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("Escape dismisses and restores summary focus, but does not consume keys outside", () => {
    const { getByText, getByLabelText, getByTestId } = render(
      <>
        <ControlDisclosure data-testid="settings">
          <summary>Settings</summary>
          <input aria-label="Option" />
        </ControlDisclosure>
        <button type="button">Outside</button>
      </>,
    );
    const details = getByTestId("settings") as HTMLDetailsElement;
    details.open = true;
    const input = getByLabelText("Option");
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(getByText("Settings"));
    details.open = true;
    const outside = getByText("Outside");
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: "Escape" })).toBe(true);
    expect(details.open).toBe(true);
  });
});
