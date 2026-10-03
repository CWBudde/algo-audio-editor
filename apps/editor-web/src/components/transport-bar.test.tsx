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
  const follow = getByLabelText("Follow playback");
  const settings = follow.closest("details");
  expect(settings?.open).toBe(false);
  const summary = settings?.querySelector("summary");
  if (!summary) throw new Error("Missing playback settings");
  fireEvent.click(summary);
  expect(settings?.open).toBe(true);
  fireEvent.change(getByLabelText("Follow playback"), { target: { value: "continuous" } });
  expect(onFollowChange).toHaveBeenCalledWith("continuous");
  rerender(<TransportBar {...props} playing />);
  expect((getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
  expect((getByLabelText("Loop") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(getByRole("button", { name: "Stop" }));
  expect(onStop).toHaveBeenCalledOnce();
});

it("uses command availability and execution rather than stale transport callbacks", () => {
  const onExecute = vi.fn();
  const onPlay = vi.fn();
  const onStop = vi.fn();
  const commands = [
    {
      id: "transport.toggle-playback" as const,
      label: "Play / Stop",
      menu: "Transport",
      enabled: true,
      shortcutLabel: "Space",
    },
    { id: "transport.stop" as const, label: "Stop", menu: "Transport", enabled: false },
  ];
  const props = {
    ready: true,
    playing: false,
    loop: false,
    follow: "page" as const,
    position: 0,
    sampleRate: 48000,
    onPlay,
    onStop,
    onLoopChange: vi.fn(),
    onFollowChange: vi.fn(),
    commands,
    onExecute,
    frameless: true,
  };
  const ui = render(<TransportBar {...props} />);
  fireEvent.click(ui.getByRole("button", { name: "Play" }));
  expect(onExecute).toHaveBeenCalledExactlyOnceWith("transport.toggle-playback");
  expect(onPlay).not.toHaveBeenCalled();
  expect((ui.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
  ui.rerender(
    <TransportBar
      {...props}
      playing
      commands={commands.map((command) => ({
        ...command,
        enabled: command.id === "transport.stop",
      }))}
    />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Stop" }));
  expect(onExecute).toHaveBeenLastCalledWith("transport.stop");
  expect(onStop).not.toHaveBeenCalled();
});
