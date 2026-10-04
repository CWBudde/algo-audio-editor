import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { desktopFixture } from "@/lib/desktop-test-fixture";
import type { NativeFile } from "@/platform";
import { useDesktop } from "./use-desktop";

afterEach(() => {
  cleanup();
  delete window.aaeDesktop;
});
function options() {
  return {
    commands: [{ id: "file.open" as const, menu: "File", label: "Open…", enabled: true }],
    execute: vi.fn().mockReturnValue(true),
    dirty: true,
    busy: false,
    canOpen: true,
    name: "test.wav",
    save: vi.fn().mockResolvedValue(false),
    openFile: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    onClosingChange: vi.fn(),
  };
}
it("publishes document protection and native menus, and tears down subscriptions", async () => {
  const bridge = desktopFixture();
  window.aaeDesktop = bridge;
  const unsubscribe = vi.fn();
  vi.mocked(bridge.onCommand).mockReturnValue(unsubscribe);
  const opts = options();
  const { result, unmount } = renderHook(() => useDesktop(opts));
  expect(result.current.native).toBe(true);
  expect(bridge.setDocumentState).toHaveBeenCalledWith({
    dirty: true,
    busy: false,
    name: "test.wav",
  });
  expect(bridge.setMenu).toHaveBeenCalled();
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("dispatches known native commands through the current guarded executor", () => {
  const bridge = desktopFixture();
  window.aaeDesktop = bridge;
  let dispatch: (id: string) => void = () => {};
  vi.mocked(bridge.onCommand).mockImplementation((callback) => {
    dispatch = callback;
    return () => {};
  });
  const opts = options();
  const { rerender } = renderHook(() => useDesktop(opts));
  dispatch("unknown.command");
  expect(opts.execute).not.toHaveBeenCalled();
  opts.execute = vi.fn().mockReturnValue(false);
  rerender();
  dispatch("file.open");
  expect(opts.execute).toHaveBeenCalledWith("file.open");
});
it("holds OS-open requests during modal work and drains arrivals made during an import", async () => {
  const bridge = desktopFixture();
  window.aaeDesktop = bridge;
  let notify = () => {};
  vi.mocked(bridge.onOpenFiles).mockImplementation((callback) => {
    notify = callback;
    return () => {};
  });
  const first = { id: "one", name: "one.wav" },
    second = { id: "two", name: "two.wav" };
  const opts = options();
  opts.canOpen = false;
  let complete: () => void = () => {};
  opts.openFile = vi.fn((file: NativeFile) =>
    file.id === "one"
      ? new Promise<void>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(),
  );
  const { rerender } = renderHook(() => useDesktop(opts));
  vi.mocked(bridge.takeOpenFiles).mockResolvedValueOnce([first]);
  notify();
  expect(bridge.takeOpenFiles).not.toHaveBeenCalled();
  opts.canOpen = true;
  rerender();
  await waitFor(() => expect(opts.openFile).toHaveBeenCalledWith(first));
  opts.canOpen = false;
  rerender();
  vi.mocked(bridge.takeOpenFiles).mockResolvedValueOnce([second]);
  notify();
  await act(async () => {
    complete();
  });
  opts.canOpen = true;
  rerender();
  await waitFor(() => expect(opts.openFile).toHaveBeenCalledWith(second));
  expect(opts.openFile).toHaveBeenCalledTimes(2);
});
it.each([false, true])("reports the actual save result before closing (%s)", async (saved) => {
  const bridge = desktopFixture();
  window.aaeDesktop = bridge;
  let close: (request: string) => void = () => {};
  vi.mocked(bridge.onSaveBeforeClose).mockImplementation((callback) => {
    close = callback;
    return () => {};
  });
  const opts = options();
  opts.save.mockResolvedValue(saved);
  renderHook(() => useDesktop(opts));
  await act(async () => {
    close("request");
  });
  expect(bridge.completeClose).toHaveBeenCalledWith("request", saved);
  expect(opts.onClosingChange.mock.calls).toEqual([[true], [false]]);
});
