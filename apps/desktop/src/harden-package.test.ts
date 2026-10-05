import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type FuseConfig,
  FuseState,
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire,
} from "@electron/fuses";
import type { AfterPackContext } from "electron-builder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hardenPackage, { packagedFuses, verifyPackagedFuses } from "./harden-package";

vi.mock("@electron/fuses", async (original) => ({
  ...(await original<typeof import("@electron/fuses")>()),
  flipFuses: vi.fn(),
  getCurrentFuseWire: vi.fn(),
}));

const wire = (): FuseConfig<FuseState> & Record<number, FuseState> => ({
  version: FuseVersion.V1,
  ...Object.fromEntries(
    Object.entries(packagedFuses)
      .filter(([key]) => /^\d+$/.test(key))
      .map(([key, enabled]) => [key, enabled ? FuseState.ENABLE : FuseState.DISABLE]),
  ),
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aae-fuses-"));
  vi.mocked(flipFuses).mockReset().mockResolvedValue(1);
  vi.mocked(getCurrentFuseWire).mockReset().mockResolvedValue(wire());
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function context(platform: string, arch = 1, config = { asar: true, disableAsarIntegrity: false }) {
  return {
    appOutDir: directory,
    electronPlatformName: platform,
    arch,
    packager: {
      config,
      appInfo: { productFilename: "Algo Audio Editor" },
      executableName: "algo-audio-editor",
    },
  } as unknown as AfterPackContext;
}

describe("packaged Electron fuses", () => {
  it.each([
    ["linux", 1, "algo-audio-editor", false],
    ["win32", 1, "Algo Audio Editor.exe", false],
    ["darwin", 1, "Algo Audio Editor.app", false],
    ["darwin", 3, "Algo Audio Editor.app", true],
    ["mas", 3, "Algo Audio Editor.app", true],
  ])("hardens and verifies %s arch %i before signing", async (platform, arch, name, reset) => {
    const resources =
      platform === "darwin" || platform === "mas"
        ? path.join(directory, name, "Contents", "Resources")
        : path.join(directory, "resources");
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(resources, "app.asar"), "asar");
    await hardenPackage(context(platform, arch));
    expect(flipFuses).toHaveBeenCalledWith(path.join(directory, name), {
      ...packagedFuses,
      resetAdHocDarwinSignature: reset,
    });
    expect(getCurrentFuseWire).toHaveBeenCalledWith(path.join(directory, name));
  });

  it("rejects disabled ASAR or integrity metadata without touching the binary", async () => {
    await expect(
      hardenPackage(context("linux", 1, { asar: false, disableAsarIntegrity: false })),
    ).rejects.toThrow("require ASAR");
    await expect(
      hardenPackage(context("linux", 1, { asar: true, disableAsarIntegrity: true })),
    ).rejects.toThrow("integrity metadata");
    expect(flipFuses).not.toHaveBeenCalled();
  });

  it("rejects missing ASAR before flipping fuses", async () => {
    await expect(hardenPackage(context("linux"))).rejects.toThrow();
    expect(flipFuses).not.toHaveBeenCalled();
  });

  it("rejects a symlink in place of the sealed ASAR archive", async () => {
    const target = path.join(directory, "outside.asar");
    await writeFile(target, "asar");
    await mkdir(path.join(directory, "resources"));
    await symlink(target, path.join(directory, "resources", "app.asar"));
    await expect(hardenPackage(context("linux"))).rejects.toThrow("regular file");
    expect(flipFuses).not.toHaveBeenCalled();
  });

  it("propagates patch failures and rejects a no-op patch", async () => {
    await mkdir(path.join(directory, "resources"));
    await writeFile(path.join(directory, "resources", "app.asar"), "asar");
    vi.mocked(flipFuses).mockRejectedValueOnce(new Error("wire changed"));
    await expect(hardenPackage(context("linux"))).rejects.toThrow("wire changed");
    vi.mocked(flipFuses).mockResolvedValueOnce(0);
    await expect(hardenPackage(context("linux"))).rejects.toThrow("no Electron fuse wire");
  });

  it.each(Object.values(FuseV1Options).filter((value) => typeof value === "number"))(
    "rejects policy mismatches for fuse %i",
    async (option) => {
      const actual = wire();
      actual[option] = FuseState.INHERIT;
      vi.mocked(getCurrentFuseWire).mockResolvedValueOnce(actual);
      await expect(verifyPackagedFuses("binary")).rejects.toThrow("release policy");
    },
  );

  it("fails closed when Electron adds another fuse", async () => {
    vi.mocked(getCurrentFuseWire).mockResolvedValueOnce(
      Object.assign(wire(), { 9: FuseState.ENABLE }),
    );
    await expect(verifyPackagedFuses("binary")).rejects.toThrow("fuse count changed");
  });
});
