import { vi } from "vitest";
import type { DesktopBridge } from "@/platform";

export function desktopFixture(): DesktopBridge {
  return {
    platform: "linux",
    versions: { electron: "test", chrome: "test", node: "test" },
    openFile: vi.fn().mockResolvedValue(null),
    saveFile: vi.fn().mockResolvedValue(null),
    readFile: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    writeFile: vi.fn().mockResolvedValue(undefined),
    didOpenFile: vi.fn().mockResolvedValue(undefined),
    releaseFile: vi.fn().mockResolvedValue(undefined),
    takeOpenFiles: vi.fn().mockResolvedValue([]),
    onOpenFiles: vi.fn().mockReturnValue(() => {}),
    setMenu: vi.fn().mockResolvedValue(undefined),
    onCommand: vi.fn().mockReturnValue(() => {}),
    setDocumentState: vi.fn().mockResolvedValue(undefined),
    onSaveBeforeClose: vi.fn().mockReturnValue(() => {}),
    completeClose: vi.fn().mockResolvedValue(undefined),
    confirmReplace: vi.fn().mockResolvedValue(false),
  };
}
