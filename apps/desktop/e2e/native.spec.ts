import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { fixture } from "../../editor-web/e2e/edit-fixture.js";
import { closeEditor, launchEditor } from "./launch.js";

async function command(app: ElectronApplication, id: string) {
  await expect
    .poll(() =>
      app.evaluate(({ Menu, BrowserWindow }, id) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(id);
        if (!item?.enabled) return false;
        item.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
        return true;
      }, id),
    )
    .toBe(true);
}
async function setDialogs(
  app: ElectronApplication,
  settings: { input?: string; output?: string; choice?: number },
) {
  await app.evaluate(({ dialog }, settings) => {
    const scope = globalThis as unknown as {
      __openCalls: number;
      __saveCalls: number;
      __messages: string[];
    };
    scope.__openCalls ??= 0;
    scope.__saveCalls ??= 0;
    scope.__messages ??= [];
    dialog.showOpenDialog = (async () => {
      scope.__openCalls++;
      return { canceled: !settings.input, filePaths: settings.input ? [settings.input] : [] };
    }) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => {
      scope.__saveCalls++;
      return { canceled: !settings.output, filePath: settings.output };
    }) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      scope.__messages.push((args.at(-1) as { message: string }).message);
      return { response: settings.choice ?? 2, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, settings);
}
/** Open through the menu and wait until the renderer has released the document lock. */
async function open(app: ElectronApplication, page: Page) {
  const calls = () =>
    app.evaluate(() => (globalThis as unknown as { __openCalls?: number }).__openCalls ?? 0);
  const before = await calls();
  await command(app, "file.open");
  // The native menu trails the renderer's busy state, so it can still report
  // file.open enabled before the open has started. Wait for the dialog itself.
  await expect.poll(calls).toBeGreaterThan(before);
  await expect(page.getByTestId("document-drop-zone")).toHaveAttribute("aria-busy", "false");
}

test("native menus, launch/open-with WAV, scoped file access and disk save", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-native-"));
  const input = path.join(directory, "launch.wav"),
    output = path.join(directory, "saved.wav");
  const source = fixture([[0, 0.5, -0.5, 0]]);
  await writeFile(input, source);
  const app = await launchEditor({ args: [path.join(__dirname, ".."), input] });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("document-name")).toHaveText("launch.wav");
    await expect(page.getByRole("menubar")).toHaveCount(0);
    expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
    expect(
      await page.evaluate(async () => {
        try {
          await window.aaeDesktop?.readFile("/etc/passwd");
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(
      await page.evaluate(async () => {
        try {
          await window.aaeDesktop?.saveFile("../escape.wav", ["wav"]);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    await command(app, "help.about");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.open")?.enabled,
        ),
      )
      .toBe(false);
    await page.keyboard.press("Escape");
    await command(app, "timeline.add-marker");
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await setDialogs(app, { output });
    await command(app, "file.save");
    await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
    expect((await readFile(output)).subarray(0, 4).toString()).toBe("RIFF");
    await setDialogs(app, {});
    await open(app, page);
    await expect(page.getByTestId("document-name")).toHaveText("launch.wav");
    await command(app, "timeline.add-marker");
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    const other = path.join(directory, "other.wav");
    await writeFile(other, source);
    await setDialogs(app, { input: other, choice: 0 });
    await open(app, page);
    await expect(page.getByTestId("document-name")).toHaveText("launch.wav");
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await setDialogs(app, { input: other, choice: 1 });
    await open(app, page);
    await expect(page.getByTestId("document-name")).toHaveText("other.wav");
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("close cancellation and failed or cancelled saves retain dirty work; successful save closes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-close-"));
  const input = path.join(directory, "close.wav"),
    output = path.join(directory, "saved.wav"),
    invalid = path.join(directory, "directory.wav");
  await writeFile(input, fixture([[0, 0.5, -0.5, 0]]));
  await mkdir(invalid);
  const app = await launchEditor({ args: [path.join(__dirname, ".."), input] });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("document-name")).toHaveText("close.wav");
    await command(app, "timeline.add-marker");
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    const close = () =>
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close();
      });
    await setDialogs(app, { choice: 2 });
    await close();
    await expect(page.getByTestId("document-name")).toHaveText("close.wav");
    await setDialogs(app, { choice: 0, output: invalid });
    await close();
    await expect(page.getByText("Could not save audio")).toBeVisible();
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.save")?.enabled,
        ),
      )
      .toBe(true);
    const saves = await app.evaluate(
      () => (globalThis as unknown as { __saveCalls: number }).__saveCalls,
    );
    await setDialogs(app, { choice: 0 });
    await close();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { __saveCalls: number }).__saveCalls),
      )
      .toBe(saves + 1);
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.save")?.enabled,
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    // The stubbed cancellation returns immediately. Let the renderer finish
    // its close acknowledgement before issuing the next native close event.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await setDialogs(app, { choice: 0, output });
    const closed = page.waitForEvent("close");
    await close();
    await closed;
    expect((await readFile(output)).subarray(0, 4).toString()).toBe("RIFF");
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal window bounds survive relaunch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-window-"));
  const options = {
    args: [path.join(__dirname, "..")],
    env: { ...process.env, AAE_USER_DATA: directory },
  };
  // Explicit profile shared only by these two sequential processes.
  const { _electron: electron } = await import("@playwright/test");
  let app = await electron.launch(options);
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 30, width: 1000, height: 650 }),
    );
    // X11 applies bounds asynchronously, so wait until the window reports
    // them before closing; otherwise the close-time save can record the old
    // size on a loaded runner.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds()),
      )
      .toMatchObject({ width: 1000, height: 650 });
    // Closing the only window quits the app on Windows/Linux, which flushes the
    // state file before exiting. macOS keeps a windowless app running, so quit
    // it as Cmd+Q would once the window is gone. Wait for that exit rather than
    // racing it.
    const exited = app.waitForEvent("close");
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      .catch(() => {});
    if (process.platform === "darwin") {
      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
        .toBe(0);
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
    }
    await exited;
    expect(
      JSON.parse(await readFile(path.join(directory, "window-state.json"), "utf8")),
    ).toMatchObject({ width: 1000, height: 650 });
    app = await electron.launch(options);
    await app.firstWindow();
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
    ).toMatchObject({ width: 1000, height: 650 });
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second process routes open-with to the existing window and records successful OS recents", async () => {
  // The second process resolves its argument against the canonical cwd
  // (macOS reports /var/folders/… as /private/var/folders/…).
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "aae-instance-")));
  await writeFile(path.join(directory, "second.wav"), fixture([[0, 0.5, -0.5, 0]]));
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    const settings = await app.evaluate(({ app }) => {
      const scope = globalThis as unknown as { __recents: string[] };
      scope.__recents = [];
      app.addRecentDocument = (file) => {
        scope.__recents.push(file);
      };
      return { executable: process.execPath, profile: app.getPath("userData") };
    });
    const child = spawn(
      settings.executable,
      ["--no-sandbox", path.join(__dirname, ".."), "second.wav"],
      { cwd: directory, env: { ...process.env, AAE_USER_DATA: settings.profile }, stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(await exited).toBe(0);
    await expect(page.getByTestId("document-name")).toHaveText("second.wav");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __recents: string[] }).__recents))
      .toEqual([path.join(directory, "second.wav")]);
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("native macro commands record, export JSON to disk, replay and undo", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-native-macro-"));
  const input = path.join(directory, "source.wav"),
    output = path.join(directory, "macro.json");
  await writeFile(input, fixture([[0, 0.5, -0.5, 0.25]]));
  const app = await launchEditor({ args: [path.join(__dirname, ".."), input] });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("document-name")).toHaveText("source.wav");
    await command(app, "file.record-macro");
    await expect(page.getByRole("button", { name: "Recording macro · Stop" })).toBeVisible();
    await command(app, "process.reverse");
    const process = page.locator("dialog[open]");
    await process.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(process).not.toBeVisible();
    await command(app, "file.stop-recording");
    await command(app, "file.automation");
    const dialog = page.getByRole("dialog", { name: "Macros and automation" });
    await expect(dialog.getByRole("status")).toHaveText("1 operation");
    await setDialogs(app, { output });
    await dialog.getByRole("button", { name: "Export chain" }).click();
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(output, "utf8"));
        } catch {
          return undefined;
        }
      })
      .toEqual({
        version: 1,
        operations: [
          { method: "process.start", range: "document", params: { operation: "reverse" } },
        ],
      });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await command(app, "edit.undo");
    await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
    await command(app, "file.automation");
    await dialog.getByRole("button", { name: "Apply macro" }).click();
    await expect(dialog.getByRole("status")).toContainText("1 of 1 completed");
    expect(
      await app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.open")?.enabled,
      ),
    ).toBe(false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await command(app, "edit.undo");
    await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
