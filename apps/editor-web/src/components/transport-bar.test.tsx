import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TransportBar, type TransportBarHandle } from "./transport-bar";

afterEach(cleanup);

it("exposes document controls and a sample-rate-aware position without test tone controls", () => {
  const onPlay = vi.fn();
  const onStop = vi.fn();
  const onLoopChange = vi.fn();
  const onFollowChange = vi.fn();
  const props = {
    ready: true,
    playing: false,
    loop: false,
    follow: "page" as const,
    position: 22050,
    sampleRate: 44100,
    onPlay,
    onStop,
    onLoopChange,
    onFollowChange,
  };
  const handle = createRef<TransportBarHandle>();
  const { getByRole, getByLabelText, getByTestId, rerender, queryByText } = render(
    <TransportBar {...props} ref={handle} />,
  );
  fireEvent.click(getByRole("button", { name: "Play" }));
  expect(onPlay).toHaveBeenCalledOnce();
  expect(getByTestId("play-position").textContent).toBe("0.500 s · 22050 frames");
  handle.current?.updatePosition(44100);
  expect(getByTestId("play-position").textContent).toBe("1.000 s · 44100 frames");
  expect(queryByText("Test tone")).toBeNull();
  fireEvent.click(getByLabelText("Loop"));
  expect(onLoopChange).toHaveBeenCalledWith(true);
  fireEvent.change(getByLabelText("Follow playback"), { target: { value: "continuous" } });
  expect(onFollowChange).toHaveBeenCalledWith("continuous");
  rerender(<TransportBar {...props} playing />);
  expect((getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
  expect((getByLabelText("Loop") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(getByRole("button", { name: "Stop" }));
  expect(onStop).toHaveBeenCalledOnce();
});
