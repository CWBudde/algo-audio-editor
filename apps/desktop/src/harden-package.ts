import { lstat } from "node:fs/promises";
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

// electron-builder's public hook uses builder-util's numeric Arch.arm64 value.
const ARM64_ARCH = 3;

/** Explicitly review every fuse when Electron adds one; never inherit new defaults. */
export const packagedFuses = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Electron enforces ASAR integrity on macOS/Windows; Linux lacks enforcement.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
} satisfies FuseConfig;

/** Read the real binary back so packaging cannot silently ship unchanged bits. */
export async function verifyPackagedFuses(executable: string) {
  const actual = await getCurrentFuseWire(executable);
  if (actual.version !== packagedFuses.version)
    throw new Error("package: unsupported fuse version");
  const expectedKeys = Object.keys(packagedFuses).filter((key) => /^\d+$/.test(key));
  const actualKeys = Object.keys(actual).filter((key) => /^\d+$/.test(key));
  if (actualKeys.length !== expectedKeys.length) {
    throw new Error("package: Electron fuse count changed; review the complete fuse policy");
  }
  for (const key of expectedKeys) {
    const option = Number(key) as FuseV1Options;
    const expected = packagedFuses[option] ? FuseState.ENABLE : FuseState.DISABLE;
    if (actual[option] !== expected) {
      throw new Error(`package: ${FuseV1Options[option]} fuse does not match the release policy`);
    }
  }
}

/** electron-builder afterPack runs before code signing and embeds ASAR hashes itself. */
export default async function hardenPackage(context: AfterPackContext) {
  const { packager, electronPlatformName: platform, appOutDir } = context;
  if (packager.config.asar !== true || packager.config.disableAsarIntegrity === true) {
    throw new Error("package: hardened releases require ASAR with integrity metadata");
  }
  const extension = { darwin: ".app", mas: ".app", win32: ".exe", linux: "" }[platform];
  if (extension === undefined)
    throw new Error(`package: unsupported Electron platform ${platform}`);
  const name =
    platform === "linux" && "executableName" in packager
      ? String(packager.executableName)
      : packager.appInfo.productFilename;
  const executable = path.join(appOutDir, `${name}${extension}`);
  const resources =
    platform === "darwin" || platform === "mas"
      ? path.join(executable, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  if (!(await lstat(path.join(resources, "app.asar"))).isFile()) {
    throw new Error("package: app.asar must be a regular file");
  }
  const count = await flipFuses(executable, {
    ...packagedFuses,
    // Preserve runnable unsigned arm64 bundles; signing still follows this hook.
    resetAdHocDarwinSignature:
      (platform === "darwin" || platform === "mas") && context.arch === ARM64_ARCH,
  });
  if (count < 1) throw new Error("package: no Electron fuse wire was patched");
  await verifyPackagedFuses(executable);
}
