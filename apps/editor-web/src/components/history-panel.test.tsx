import type { HistoryListResult } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "./history-panel";

const history: HistoryListResult = {
  documentId: "doc-1",
  currentStateId: "state-2",
  savedStateId: "state-0",
  dirty: true,
  canUndo: true,
  canRedo: true,
  maxEntries: 100,
  maxBytes: 1048576,
  retainedBytes: 4096,
  entries: [
    { stateId: "state-0", label: "Opened document" },
    { stateId: "state-1", label: "Cut" },
    { stateId: "state-2", label: "Mute" },
    { stateId: "state-3", label: "Duplicate" },
  ],
};
function mounted(overrides: { history?: HistoryListResult; busy?: boolean } = {}) {
  const props = { history, onUndo: vi.fn(), onRedo: vi.fn(), onJump: vi.fn(), ...overrides };
  const view = render(<HistoryPanel {...props} />);
  const details = view.container.querySelector("details");
  if (!details) throw new Error("History panel details missing");
  details.open = true;
  return { ...view, props, details };
}
afterEach(cleanup);

describe("HistoryPanel", () => {
  it("is a compact collapsible landmark with an always visible dirty indicator", () => {
    const { getByRole, getByTestId, container } = render(
      <HistoryPanel history={history} onUndo={vi.fn()} onRedo={vi.fn()} onJump={vi.fn()} />,
    );
    expect(getByRole("complementary", { name: "Edit history" })).toBeTruthy();
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(getByTestId("history-dirty").textContent).toBe("Unsaved changes");
    const summary = container.querySelector("summary");
    if (!summary) throw new Error("Missing summary");
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
  });

  it("exposes undo/redo and row jumps with exact state IDs", () => {
    const { getByRole, props } = mounted();
    fireEvent.click(getByRole("button", { name: "Undo edit" }));
    fireEvent.click(getByRole("button", { name: "Redo edit" }));
    fireEvent.click(getByRole("button", { name: "Go to Opened document" }));
    fireEvent.click(getByRole("button", { name: "Go to Duplicate" }));
    expect(props.onUndo).toHaveBeenCalledOnce();
    expect(props.onRedo).toHaveBeenCalledOnce();
    expect(props.onJump).toHaveBeenNthCalledWith(1, "state-0");
    expect(props.onJump).toHaveBeenNthCalledWith(2, "state-3");
  });

  it("marks current, saved and redo states accessibly and disables current-state navigation", () => {
    const { getByRole, getByTestId, props } = mounted();
    const current = getByRole("button", { name: "Go to Mute" }) as HTMLButtonElement;
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(current.disabled).toBe(true);
    expect(current.textContent).toContain("Current");
    expect(getByTestId("history-state-state-0").textContent).toContain("Saved");
    expect(getByTestId("history-state-state-3").textContent).toContain("Redo");
    expect(getByTestId("history-state-state-1").dataset.redo).toBe("false");
    fireEvent.click(current);
    expect(props.onJump).not.toHaveBeenCalled();
  });

  it("shows retained audio bytes and edit limits without confusing base state with a command", () => {
    const { getByTestId } = mounted();
    expect(getByTestId("history-budget").textContent).toBe(
      "4 states · limit 100 edits · retained 4 KiB / 1 MiB",
    );
  });

  it("disables navigation while busy", () => {
    const { getAllByRole, props } = mounted({ busy: true });
    for (const button of getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(props.onUndo).not.toHaveBeenCalled();
    expect(props.onRedo).not.toHaveBeenCalled();
    expect(props.onJump).not.toHaveBeenCalled();
  });

  it("uses kernel canUndo/canRedo flags and shows a clean saved state", () => {
    const { getByRole, getByTestId } = mounted({
      history: {
        ...history,
        dirty: false,
        currentStateId: "state-0",
        canUndo: false,
        canRedo: true,
      },
    });
    expect(getByTestId("history-dirty").textContent).toBe("Saved");
    expect((getByRole("button", { name: "Undo edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole("button", { name: "Redo edit" }) as HTMLButtonElement).disabled).toBe(false);
    expect(getByTestId("history-state-state-0").textContent).toContain("Current · Saved");
    expect(getByTestId("history-state-state-1").dataset.redo).toBe("true");
  });

  it("renders gracefully without a loaded document", () => {
    const { getByTestId, getAllByRole, queryByTestId } = mounted({ history: undefined });
    expect(getByTestId("history-dirty").textContent).toBe("No document");
    expect(queryByTestId("history-budget")).toBeNull();
    for (const button of getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
