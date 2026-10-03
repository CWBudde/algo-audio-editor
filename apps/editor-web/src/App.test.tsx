import { PROTOCOL_VERSION, type ProcessJobResult } from "@aae/protocol";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProcessOptions } from "@/hooks/use-process";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import App from "./App";

const fake = vi.hoisted(() => ({
  position: 0,
  playing: false,
  kernelStatus: "ready" as "ready" | "loading" | "error",
  play: vi.fn(),
  stop: vi.fn(),
  seek: vi.fn(),
  dispose: vi.fn(),
  error: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  exportAudio: vi.fn(),
  openFile: vi.fn(),
  edit: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  jump: vi.fn(),
  processOpen: vi.fn(),
  processOptions: undefined as ProcessOptions | undefined,
  prepare: vi.fn(),
}));

vi.mock("@/audio/audio-engine", () => ({
  AudioEngine: class {
    prepare = fake.prepare;
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
    hello: { kernelVersion: "test", protocolVersion: PROTOCOL_VERSION, goVersion: "go1.test" },
  };
  return {
    useKernel: () =>
      fake.kernelStatus === "ready"
        ? kernel
        : fake.kernelStatus === "error"
          ? { status: "error", error: "Handshake failed" }
          : { status: "loading" },
  };
});
vi.mock("@/hooks/use-document", () => {
  const doc = {
    busy: false,
    info: {
      name: "play.wav",
      documentId: "doc-1",
      sampleRate: 48000,
      channels: 2,
      frames: 48000,
      bitDepth: 16,
      float: false,
    },
    open: fake.open,
    save: fake.save,
    exportAudio: fake.exportAudio,
    exportTimeline: vi.fn(),
    openFile: fake.openFile,
    withOperation: async (work: () => Promise<void>) => work(),
    replaceInfo: vi.fn(),
  };
  return { useDocument: () => doc };
});
vi.mock("@/hooks/use-document-memory", () => ({ useDocumentMemory: () => undefined }));
vi.mock("@/hooks/use-edit", () => ({
  useEdit: () => ({ busy: false, clipboard: undefined, run: fake.edit }),
}));
vi.mock("@/hooks/use-history", () => ({
  useHistory: () => ({
    busy: false,
    history: {
      canUndo: true,
      canRedo: true,
      entries: [],
      currentStateId: "state-1",
      maxEntries: 100,
      maxBytes: 1024,
      retainedBytes: 0,
      dirty: false,
    },
    undo: fake.undo,
    redo: fake.redo,
    jump: fake.jump,
    accept: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-process")>();
  return {
    ...actual,
    useProcess: (options: ProcessOptions) => {
      fake.processOptions = options;
      return {
        view: undefined,
        open: fake.processOpen,
        setParameterText: vi.fn(),
        setOperation: vi.fn(),
        setSettings: vi.fn(),
        preview: vi.fn(),
        apply: vi.fn(),
        stopPreview: vi.fn(),
        cancel: vi.fn(),
      };
    },
  };
});
vi.mock("@/components/waveform-view", () => ({ WaveformView: () => null }));
vi.mock("@/components/app-menubar", () => ({
  AppMenubar: ({
    commands,
    onExecute,
  }: {
    commands: ResolvedCommand[];
    onExecute(id: CommandId): void;
  }) => (
    <>
      {commands
        .filter((command) => command.id.startsWith("process.") || command.id === "help.about")
        .map((command) => (
          <button
            key={command.id}
            type="button"
            disabled={!command.enabled}
            onClick={() => onExecute(command.id)}
          >
            {command.label}
          </button>
        ))}
    </>
  ),
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("sonner", () => ({ toast: { error: fake.error } }));

beforeEach(() => {
  vi.clearAllMocks();
  fake.position = 0;
  fake.playing = false;
  fake.kernelStatus = "ready";
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
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

it("shares Information and Help About without stopping playback or exposing routine status", async () => {
  const ui = render(<App />);
  expect(ui.container.querySelector("[data-kernel-state='ready']")).not.toBeNull();
  expect(ui.queryByRole("dialog")).toBeNull();
  expect(ui.getByTestId("kernel-status").closest("dialog")?.open).toBe(false);
  expect(ui.getByTestId("document-name").textContent).toBe("play.wav");
  expect(ui.getByTestId("document-save-status").textContent).toBe("Saved");
  await act(async () => {
    fireEvent.keyDown(document.body, { code: "Space", key: " " });
  });
  fake.stop.mockClear();
  const information = ui.getByRole("button", { name: "Information" });
  information.focus();
  fireEvent.click(information);
  expect(ui.getByRole("dialog", { name: "About / Status" })).toBeDefined();
  expect(fake.stop).not.toHaveBeenCalled();
  expect(fake.dispose).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { code: "Space", key: " " });
  fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "End" });
  expect(fake.stop).not.toHaveBeenCalled();
  expect(fake.save).not.toHaveBeenCalled();
  expect(fake.undo).not.toHaveBeenCalled();
  expect(fake.seek).not.toHaveBeenCalled();
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(ui.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(information);
  fireEvent.click(ui.getByRole("button", { name: "About" }));
  expect(ui.getAllByRole("dialog", { name: "About / Status" })).toHaveLength(1);
  fireEvent.click(ui.getByRole("button", { name: "Close information" }));
  expect(ui.queryByRole("dialog")).toBeNull();
});

it("keeps actionable startup failures visible outside the information dialog", () => {
  fake.kernelStatus = "error";
  const ui = render(<App />);
  expect(ui.container.querySelector("[data-kernel-state='error']")).not.toBeNull();
  expect(ui.getByRole("alert").textContent).toContain("Handshake failed");
  expect(ui.getByRole("alert").textContent).toContain("Reload the editor");
  expect(ui.queryByRole("dialog")).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "Information" }));
  expect(ui.getByRole("dialog", { name: "About / Status" })).toBeDefined();
  expect(ui.getByTestId("kernel-status").textContent).toBe("kernel error");
});

it("routes Amplify and Normalize commands into the shared processing dialog", () => {
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Amplify…" }));
  expect(fake.processOpen).toHaveBeenLastCalledWith({ start: 0, end: 0, channelMask: 3 });
  fireEvent.click(ui.getByRole("button", { name: "Normalize…" }));
  expect(fake.processOpen).toHaveBeenLastCalledWith(
    { start: 0, end: 0, channelMask: 3 },
    "normalize-peak",
  );
});

it("routes Phase 3.2 commands through the common process lifecycle", () => {
  const ui = render(<App />);
  for (const [label, operation] of [
    ["Fade In / Out…", "fade-in"],
    ["Reverse…", "reverse"],
    ["Invert polarity…", "invert"],
    ["Remove DC offset…", "remove-dc"],
    ["Stereo to mono…", "stereo-to-mono"],
    ["Extract channel…", "extract-channel"],
    ["Change sample rate…", "resample"],
    ["Generate audio…", "generate"],
  ]) {
    fireEvent.click(ui.getByRole("button", { name: label }));
    expect(fake.processOpen).toHaveBeenLastCalledWith(
      { start: 0, end: 0, channelMask: 3 },
      operation,
    );
  }
});

it("previews structural cursor candidates at their output format and restores committed playback on Stop", async () => {
  render(<App />);
  const options = fake.processOptions;
  const info = options?.info;
  if (!options || !info) throw new Error("Process options missing");
  const job = {
    jobId: "preview",
    start: 0,
    end: 48000,
    candidate: {
      sampleRate: 24000,
      channels: 1,
      frames: 24000,
      start: 120,
      end: 120,
      channelMask: 1,
    },
  } as ProcessJobResult;
  await act(async () => options.playPreview(info, job));
  expect(fake.play).toHaveBeenLastCalledWith(
    { ...info, sampleRate: 24000, channels: 1, frames: 24000 },
    { start: 0, end: 24000, loop: true, previewJobId: "preview" },
  );
  await act(async () => options.stopPreview());
  expect(fake.prepare).toHaveBeenLastCalledWith(info);
});

it("groups primary icons in one band and sends undo/redo through the command registry", async () => {
  const ui = render(<App />);
  const band = ui.getByTestId("primary-controls");
  for (const name of [
    "Play",
    "Stop",
    "Undo",
    "Redo",
    "Cut",
    "Copy",
    "Paste",
    "Delete",
    "Crop time (all channels)",
  ]) {
    const button = ui.getByRole("button", { name });
    expect(band.contains(button)).toBe(true);
    expect(button.textContent).toBe("");
  }
  expect((ui.getByRole("button", { name: "Cut" }) as HTMLButtonElement).disabled).toBe(true);
  expect(ui.getByRole("button", { name: "Undo" }).title).toBe("Undo (Ctrl+Z)");
  await act(async () => fireEvent.click(ui.getByRole("button", { name: "Undo" })));
  await act(async () => fireEvent.click(ui.getByRole("button", { name: "Redo" })));
  expect(fake.undo).toHaveBeenCalledOnce();
  expect(fake.redo).toHaveBeenCalledOnce();
  const information = ui.getByRole("button", { name: "Information" });
  fireEvent.click(information);
  expect((ui.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "Undo" }));
  expect(fake.undo).toHaveBeenCalledOnce();
});

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

it("keeps Space on focused buttons available for native button activation", async () => {
  const { getByTestId } = render(<App />);
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "Space",
    key: " ",
  });
  await act(async () => getByTestId("play").dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(fake.play).not.toHaveBeenCalled();
});

it("routes undo/redo shortcuts without stealing input undo or key repeats", async () => {
  const { getByLabelText } = render(<App />);
  await act(async () => fireEvent.keyDown(window, { key: "z", ctrlKey: true }));
  expect(fake.undo).toHaveBeenCalledOnce();
  await act(async () => fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true }));
  await act(async () => fireEvent.keyDown(window, { key: "y", ctrlKey: true }));
  expect(fake.redo).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(window, { key: "z", ctrlKey: true, repeat: true });
  fireEvent.keyDown(window, { key: "z", ctrlKey: true, altKey: true });
  fireEvent.keyDown(getByLabelText("Silence frames"), { key: "z", ctrlKey: true });
  expect(fake.undo).toHaveBeenCalledOnce();
});

it("uses Export instead of Save for Ctrl+Shift+E, including from text fields", async () => {
  const { getByLabelText } = render(<App />);
  await act(async () =>
    fireEvent.keyDown(getByLabelText("Silence frames"), {
      key: "E",
      ctrlKey: true,
      shiftKey: true,
    }),
  );
  expect(fake.exportAudio).toHaveBeenCalledOnce();
  expect(fake.save).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(window, { key: "s", ctrlKey: true }));
  expect(fake.save).toHaveBeenCalledOnce();
});

it("preserves Space on the focused history summary for native disclosure activation", async () => {
  const { container } = render(<App />);
  const summary = container.querySelector("summary");
  if (!summary) throw new Error("missing history disclosure");
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "Space",
    key: " ",
  });
  await act(async () => summary.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
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
