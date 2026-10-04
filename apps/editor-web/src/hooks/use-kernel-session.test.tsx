import { cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useKernelSession } from "./use-kernel-session";

afterEach(cleanup);
it("keeps callbacks fresh and invalidates captured work on token, identity, client and unmount", () => {
  const client = {};
  const identity = {};
  const invalidate = vi.fn();
  const props = { client, identity, callback: vi.fn() };
  const hook = renderHook(
    (current: typeof props) =>
      useKernelSession(current, current.client, current.identity, invalidate),
    { initialProps: props, wrapper: StrictMode },
  );
  const shared = hook.result.current;
  expect(invalidate).toHaveBeenCalledOnce();
  const token = {};
  shared.token.current = token;
  const active = shared.capture(token);
  expect(active()).toBe(true);
  const callback = vi.fn();
  hook.rerender({ ...props, callback });
  expect(hook.result.current).toBe(shared);
  expect(active()).toBe(true);
  shared.latest.current.callback();
  expect(callback).toHaveBeenCalledOnce();
  shared.token.current = {};
  expect(active()).toBe(false);
  const previousIdentity = shared.capture();
  hook.rerender({ ...props, identity: {} });
  expect(previousIdentity()).toBe(false);
  expect(invalidate).toHaveBeenCalledTimes(2);
  const previousClient = shared.capture();
  hook.rerender({ ...props, client: {} });
  expect(previousClient()).toBe(false);
  expect(invalidate).toHaveBeenCalledTimes(3);
  const beforeUnmount = shared.capture();
  hook.unmount();
  expect(beforeUnmount()).toBe(false);
  expect(shared.mounted.current).toBe(false);
});
