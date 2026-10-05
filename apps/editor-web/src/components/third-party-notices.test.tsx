import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThirdPartyNotices } from "./third-party-notices";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("loads license texts on demand from the hosting subpath and displays literal read-only text", async () => {
  vi.stubEnv("BASE_URL", "/algo-audio-editor/");
  const text = "Copyright Example\nMIT License\n<script>literal license text</script>";
  const fetch = vi.fn().mockResolvedValue(new Response(text));
  vi.stubGlobal("fetch", fetch);
  const ui = render(<ThirdPartyNotices />);
  expect(fetch).not.toHaveBeenCalled();
  const button = ui.getByRole("button", { name: "Third-party notices" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(fetch).toHaveBeenCalledWith("/algo-audio-editor/third-party-notices.txt", {
    signal: expect.any(AbortSignal),
    cache: "default",
  });
  const field = (await ui.findByRole("textbox", {
    name: "Third-party license texts",
  })) as HTMLTextAreaElement;
  expect(field.value).toBe(text);
  expect(field.readOnly).toBe(true);
  expect(ui.container.querySelector("script")).toBeNull();
  fireEvent.click(button);
  expect(ui.queryByRole("textbox")).toBeNull();
  fireEvent.click(button);
  expect(ui.getByRole("textbox")).toBeDefined();
  expect(fetch).toHaveBeenCalledOnce();
});

it("announces a failed request and retries without closing the About dialog", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response("BSD license texts"));
  vi.stubGlobal("fetch", fetch);
  const ui = render(<ThirdPartyNotices />);
  fireEvent.click(ui.getByRole("button", { name: "Third-party notices" }));
  expect(ui.getByRole("status").textContent).toContain("Loading");
  expect((await ui.findByRole("alert")).textContent).toContain("could not be loaded");
  fireEvent.click(ui.getByRole("button", { name: "Retry notices" }));
  await ui.findByRole("textbox");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][1].cache).toBe("reload");
  expect(ui.queryByRole("alert")).toBeNull();
});

it("aborts pending loads when collapsed or unmounted and ignores a late reply", async () => {
  let resolve: ((response: Response) => void) | undefined;
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const ui = render(<ThirdPartyNotices />);
  const button = ui.getByRole("button", { name: "Third-party notices" });
  fireEvent.click(button);
  const firstSignal = fetch.mock.calls[0][1].signal as AbortSignal;
  fireEvent.click(button);
  expect(firstSignal.aborted).toBe(true);
  await act(async () => resolve?.(new Response("late response")));
  fireEvent.click(button);
  expect(ui.getByRole("status")).toBeDefined();
  const secondSignal = fetch.mock.calls[1][1].signal as AbortSignal;
  ui.unmount();
  expect(secondSignal.aborted).toBe(true);
  await act(async () => resolve?.(new Response("late unmount response")));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  [
    "advertised size",
    () => new Response("small body", { headers: { "content-length": "8388609" } }),
  ],
  ["streamed size", () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))],
  ["empty text", () => new Response("  \n")],
])("rejects invalid notices: %s", async (_name, response) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
  const ui = render(<ThirdPartyNotices />);
  fireEvent.click(ui.getByRole("button", { name: "Third-party notices" }));
  await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
  expect(ui.queryByRole("textbox")).toBeNull();
});
