# Desktop integration and releases

The desktop shell uses the same web build and Go/WASM kernel as the browser.
It serves `process.resourcesPath/web` in a packaged app and `editor-web/dist`
in development. Both use `app://editor`, COOP/COEP and the production CSP.
The renderer stays sandboxed with context isolation and no Node integration.

## Native workflows

`native-menu.ts` converts the shared command registry, including effect groups,
into the native menu. Enabled states follow document, selection, preview and
modal state. Native clicks run the existing guarded dispatcher. Shortcut labels
appear in the menu; renderer shortcuts retain their text-input and modal guards.
The in-page menubar is hidden in Electron; the command palette remains available.
On macOS, the standard application menu is also present. A `before-input-event`
guard sends editor accelerators through renderer keyboard handling while retaining
native Quit/Window shortcuts; macOS ignores `registerAccelerator: false`.

Open and Save use native dialogs. The main process grants an opaque capability
for one exact path to one renderer; the renderer cannot request arbitrary paths.
`files.ts` validates the sender's main frame and origin for every IPC request.
Open supports WAV, FLAC, AIFF/AIFC and MP3 through the Go codecs; Ogg/Opus and AAC/M4A use available browser codecs. The chooser also permits renamed files; the importer detects their container bytes. Save permits WAV, FLAC, AIFF and marker sidecars (`csv`, `txt`). Reads and
writes have a 1 GiB file limit, independently of the kernel's memory budget.
A read is bounded by its checked regular-file size. Saving writes a sibling
exclusive temporary file, flushes it, and atomically renames it over the selected
regular-file destination. Failed writes leave the previous file intact. The
kernel save point is acknowledged only after that write succeeds. Export keeps
the source dirty state, as in the browser.

Audio launch arguments, macOS open-file events, and second-instance arguments use
the existing window. OS requests wait while a modal or document operation is
active. Successfully imported native files are added to Windows/macOS recent documents
through Electron's API. Linux has no equivalent Electron recent-document list;
the application's own recent-file persistence remains Phase 6.
Opening a new file over dirty audio asks whether to discard or cancel.

Normal window bounds and maximized state persist in `userData/window-state.json`.
Off-screen or invalid saved bounds use the default size. Closing dirty documents
asks Save, Discard or Cancel. Save waits for the complete write and kernel save
acknowledgement; cancelled or failed saves keep the window open. Active document
operations and previews must finish or cancel before closing. Extracted-channel
windows get the same native services and independent close protection.

Installers advertise WAV, FLAC, AIFF/AIFC and MP3 associations. `.aaep` associations wait for project support. Browser-dependent codec formats are available through Open without advertising installer associations. Projects and crash recovery remain Phase 6;
the close guard does not provide autosave.

## App icons

The original artwork is `assets/appicon.png`. Checked-in derivatives include
Windows `build/icon.ico` (16–256 pixels), macOS `build/icon.icns` (16–1024 pixels)
and Linux `build/icons/` (16–512 pixels), all under `apps/desktop/` and selected
explicitly in `electron-builder.yml`. Main and extracted windows use the shared
512-pixel web icon; macOS development launches also set the Dock icon.

The web app includes a multi-size favicon, 32- and 512-pixel PNG icons and a
180-pixel Apple touch icon. Their HTML links use `%BASE_URL%` for sub-path hosting.
To replace the artwork, update the source and run `just icons` with ImageMagick
installed (`magick` or `convert`). `scripts/generate-icons.mjs` resizes without
cropping and writes the platform containers. Normal builds and CI use the
checked-in files and do not require ImageMagick.

## Local packaging

Use Go >=1.25, Node.js >=24 and Bun >=1.4.2. The Bun version matters for the
workspace's version-2 lockfile. The WASM builder uses native Node path handling
so the same `just build` recipe works with Windows paths.

```sh
just install
just desktop-package       # host installers; --publish never
just desktop-package-dir   # unpacked app
```

`apps/desktop/electron-builder.yml` packages the main/preload bundles, production
updater dependencies and web resources. Linux targets AppImage and deb; Windows
uses NSIS; macOS uses dmg plus zip (required by the updater). Artifacts go to
`apps/desktop/release/`, which is ignored by Git. Local development metadata stays
at `0.0.0`; the release workflow injects the tag version into the packaged manifest.

Optional packaged-runtime smoke test on Linux:

```sh
just e2e-desktop-packaged
```

`AAE_USER_DATA` selects a separate profile before the single-instance lock;
the packaged smoke test also uses a temporary profile. The normal desktop suite uses isolated temporary profiles and native dialog
stubs while testing real kernel imports, disk writes and command execution.
The packaged smoke test verifies the ASAR preload, bundled web resources, WASM
startup, cross-origin isolation and absence of renderer Node access.

## Updates and publishing

Application → Check for updates uses `electron-updater` and the GitHub feed
written by electron-builder to `app-update.yml`. It runs only in packaged apps.
Downloads require a native confirmation; installation offers Restart or Later.
Restart uses the normal application quit flow, including every window's unsaved
work guard, and installation runs only after all windows actually close. There
are no renderer-supplied feeds, automatic downloads, or development update checks.

The tag-triggered `desktop-release.yml` builds on Linux, Windows and macOS, uploads
installer artifacts, and publishes the complete platform set to the tag's GitHub
release only after every build succeeds. `workflow_dispatch` produces reviewable
build artifacts without publishing. Update metadata (`latest*.yml`),
blockmaps and the macOS zip must accompany the installers. The workflow uses
`GITHUB_TOKEN` for the final GitHub release upload; no token is embedded in the app.

Configure these GitHub Actions secrets before a signed tag build:

- `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`: exported Developer ID Application
  certificate (`.p12`, base64 or supported certificate URL) and password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: notarization account
  credentials. The app enables hardened runtime and includes the JIT entitlement
  needed by Electron's V8/WASM runtime.
- `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`: Windows Authenticode signing certificate
  and password. Signature verification for NSIS updates retains the updater default.

Tagged Windows/macOS builds fail if signing credentials are missing, and request
`forceCodeSigning`. Linux local artifacts are unsigned; Linux distribution signing
requires a separately configured signing key and release policy. macOS signing,
notarization/stapling, Windows installation/signature verification, Linux package
signature policy, and an actual old-version-to-new-version update on each OS are
still release acceptance work. No signed release or update installation was
performed during Phase 9 implementation.

Primary references: [Electron IPC security](https://www.electronjs.org/docs/latest/tutorial/security),
[OS recent-document support](https://www.electronjs.org/docs/latest/tutorial/recent-documents),
[electron-builder configuration](https://www.electron.build/v26/docs/configuration/),
[updater targets and signing requirements](https://www.electron.build/v26/docs/features/auto-update/).
