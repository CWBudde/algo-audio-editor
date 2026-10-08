import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { desktopFixture } from "@/lib/desktop-test-fixture";
import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.aaeDesktop;
});

function unload() {
  const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
  // jsdom has no BeforeUnloadEvent; mimic its string returnValue so the legacy
  // assignment is observable instead of being coerced by Event.returnValue.
  Object.defineProperty(event, "returnValue", { value: undefined, writable: true });
  window.dispatchEvent(event);
  return event;
}

function beforeUnloadListeners() {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const count = (spy: typeof add) =>
    spy.mock.calls.filter(([type]) => String(type) === "beforeunload").length;
  return { added: () => count(add), removed: () => count(remove) };
}

it("registers beforeunload only while the document is dirty", () => {
  const listeners = beforeUnloadListeners();
  const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedChangesGuard(dirty), {
    initialProps: { dirty: false },
  });
  expect(listeners.added()).toBe(0);
  expect(unload().defaultPrevented).toBe(false);

  rerender({ dirty: true });
  expect(listeners.added()).toBe(1);
  const event = unload();
  expect(event.defaultPrevented).toBe(true);
  expect(event.returnValue).toBe("");

  rerender({ dirty: false });
  expect(listeners.removed()).toBe(1);
  expect(unload().defaultPrevented).toBe(false);

  rerender({ dirty: true });
  unmount();
  expect(listeners.added()).toBe(2);
  expect(listeners.removed()).toBe(2);
  expect(unload().defaultPrevented).toBe(false);
});

it("leaves close confirmation to the Electron main process", () => {
  window.aaeDesktop = desktopFixture();
  const listeners = beforeUnloadListeners();
  renderHook(() => useUnsavedChangesGuard(true));
  expect(listeners.added()).toBe(0);
  expect(unload().defaultPrevented).toBe(false);
});
