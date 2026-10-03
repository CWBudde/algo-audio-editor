import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";

const fake = vi.hoisted(() => ({
  position: 0,
  playing: false,
  play: vi.fn(),
  stop: vi.fn(),
  seek: vi.fn(),
  dispose: vi.fn(),
  error: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock("@/audio/audio-engine", () => ({
  AudioEngine: class {
    play = fake.play;
    stop = fake.stop;
    seek = fake.seek;
    dispose = fake.dispose;
    position() {
      return fake.position;
    }
    isPlaying() {
      return fake.playing;
    }
    ended() {
      return false;
    }
    stats() {
      return undefined;
    }
  },
}));
vi.mock("@/hooks/use-kernel", () => {
  const kernel = {
    status: "ready",
    client: {},
    hello: { kernelVersion: "test", protocolVersion: 4, goVersion: "go1.test" },
  };
  return { useKernel: () => kernel };
});
vi.mock("@/hooks/use-document", () => {
  const doc = {
    busy: false,
    info: {
      name: "play.wav",
      sampleRate: 48000,
      channels: 2,
      frames: 48000,
      bitDepth: 16,
      float: false,
    },
    open: fake.open,
    save: fake.save,
    openFile: fake.openFile,
  };
  return { useDocument: () => doc };
});
vi.mock("@/hooks/use-document-memory", () => ({ useDocumentMemory: () => undefined }));
vi.mock("@/components/waveform-view", () => ({ WaveformView: () => null }));
vi.mock("@/components/app-menubar", () => ({ AppMenubar: () => null }));
vi.mock("@/components/status-bar", () => ({ StatusBar: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("sonner", () => ({ toast: { error: fake.error } }));

beforeEach(() => {
  vi.clearAllMocks();
  fake.position = 0;
  fake.playing = false;
  fake.play.mockImplementation(async () => {
    fake.playing = true;
  });
  fake.stop.mockImplementation(async () => {
    fake.playing = false;
  });
  fake.seek.mockImplementation(async (frame: number) => {
    fake.position = frame;
  });
  fake.dispose.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("plays the document using Space, ignores repeats and stops cleanly", async () => {
  const { getByTestId } = render(<App />);
  await act(async () => fireEvent.keyDown(window, { code: "Space", key: " " }));
  expect(fake.play).toHaveBeenCalledWith(expect.objectContaining({ name: "play.wav" }), {
    start: 0,
    end: undefined,
    loop: false,
  });
  fireEvent.keyDown(window, { code: "Space", key: " ", repeat: true });
  expect(fake.stop).not.toHaveBeenCalled();
  fake.position = 1234;
  await act(async () => fireEvent.keyDown(window, { code: "Space", key: " " }));
  expect(fake.stop).toHaveBeenCalledOnce();
  expect(getByTestId("play-position").dataset.frame).toBe("1234");
});

it("Home and End seek, while text and select controls keep their keyboard events", async () => {
  const { getByTestId, getByLabelText } = render(<App />);
  await act(async () => fireEvent.keyDown(window, { key: "End" }));
  expect(fake.seek).toHaveBeenLastCalledWith(48000);
  expect(getByTestId("play-position").dataset.frame).toBe("48000");
  await act(async () => fireEvent.keyDown(window, { key: "Home" }));
  expect(fake.seek).toHaveBeenLastCalledWith(0);
  fireEvent.keyDown(getByLabelText("Follow playback"), { key: "End" });
  fireEvent.keyDown(getByLabelText("Loop"), { code: "Space", key: " " });
  expect(fake.seek).toHaveBeenCalledTimes(2);
  expect(fake.play).not.toHaveBeenCalled();
});

it("an obsolete play failure cannot stop a newer playback action", async () => {
  let rejectFirst: (error: Error) => void = () => {};
  fake.play.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  const { getByTestId } = render(<App />);
  await act(async () => fireEvent.click(getByTestId("play")));
  await act(async () => fireEvent.click(getByTestId("stop")));
  await act(async () => fireEvent.click(getByTestId("play")));
  await act(async () => rejectFirst(new Error("obsolete")));
  expect((getByTestId("stop") as HTMLButtonElement).disabled).toBe(false);
  expect(fake.error).not.toHaveBeenCalled();
});

it("restores the actual cursor and stopped state when a seek fails", async () => {
  const { getByTestId } = render(<App />);
  await act(async () => fireEvent.click(getByTestId("play")));
  fake.seek.mockImplementationOnce(async () => {
    fake.position = 128;
    fake.playing = false;
    throw new Error("seek rejected");
  });
  await act(async () => fireEvent.keyDown(window, { key: "End" }));
  expect(getByTestId("play-position").dataset.frame).toBe("128");
  expect((getByTestId("stop") as HTMLButtonElement).disabled).toBe(true);
  expect(fake.error).toHaveBeenCalledWith("Seeking failed", { description: "seek rejected" });
});
