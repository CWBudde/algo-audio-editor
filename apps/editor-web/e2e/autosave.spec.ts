import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { editAndWait, editorReady, recoverOffered, snapshot } from "./autosave-fixture.ts";
import { edit, LEFT, load, RIGHT, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

// Each test owns a browser profile, so it can kill the browser and start it
// again on the same origin-private file system.
let profile: string;
const contexts: BrowserContext[] = [];

// Every test waits out the 5 s guarantee and restarts a browser at least once.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "aae-autosave-"));
});
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
});

async function launch(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profile, {
    baseURL: test.info().project.use.baseURL,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  contexts.push(context);
  await captureKernelWorker(context);
  return context;
}

async function openEditor(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await editorReady(page);
  return page;
}

/**
 * Kills the whole browser process: no unload handlers, no orderly shutdown.
 * The crash command never replies, so wait for the context to go away.
 */
async function crashBrowser(context: BrowserContext, page: Page) {
  const closed = new Promise((resolve) => context.once("close", resolve));
  const session = await context.newCDPSession(page);
  void session.send("Browser.crash").catch(() => {});
  await closed;
}

/** Kills one tab's renderer, and with it the tab's kernel worker. */
async function crashTab(context: BrowserContext, page: Page) {
  const crashed = page.waitForEvent("crash");
  const session = await context.newCDPSession(page);
  void session.send("Page.crash").catch(() => {});
  await crashed;
}

test("a killed browser keeps edits older than 5 s", async () => {
  const first = await launch();
  const page = await openEditor(first);
  const before = await editAndWait(page);
  await crashBrowser(first, page);

  const second = await launch();
  const restarted = await openEditor(second);
  await expect(restarted.getByTestId("recovery-session")).toContainText("edit-48000.wav");
  await recoverOffered(restarted);
  expect(await snapshot(restarted)).toEqual(before);
  await expect(restarted.getByTestId("history-dirty")).toHaveText("Unsaved changes");

  // The recovered session continues: a later crash recovers the newer edit.
  await select(restarted, 0, 1);
  await edit(restarted, "Mute", 8);
  const after = await snapshot(restarted);
  await restarted.waitForTimeout(5_000);
  await crashBrowser(second, restarted);
  const again = await openEditor(await launch());
  await recoverOffered(again);
  expect(await snapshot(again)).toEqual(after);
});

test("a crashed tab's work is offered in the next tab", async () => {
  const context = await launch();
  const crashed = await openEditor(context);
  const before = await editAndWait(crashed);
  await crashTab(context, crashed);

  const next = await openEditor(context);
  await recoverOffered(next);
  expect(await snapshot(next)).toEqual(before);
});

test("open windows, clean documents and closed tabs are not offered", async () => {
  const context = await launch();
  const dirty = await openEditor(context);
  await editAndWait(dirty);
  // A live window keeps its session to itself.
  const second = await openEditor(context);
  await expect(second.getByTestId("recovery-dialog")).toBeHidden();

  // Closing a tab normally is leaving the work, as the unsaved-changes prompt said.
  await dirty.close();
  const clean = await openEditor(context);
  await expect(clean.getByTestId("recovery-dialog")).toBeHidden();
  await load(clean);
  await clean.waitForTimeout(3_000);
  await crashTab(context, clean);

  const third = await openEditor(context);
  await expect(third.getByTestId("recovery-dialog")).toBeHidden();
  await expect(third.getByTestId("autosave-status")).toHaveCount(0);
});

test("discarding deletes the autosave after confirmation", async () => {
  const first = await launch();
  const page = await openEditor(first);
  await editAndWait(page);
  await crashBrowser(first, page);

  const context = await launch();
  const restarted = await openEditor(context);
  const entry = restarted.getByTestId("recovery-session");
  await entry.getByRole("button", { name: "Discard" }).click();
  await entry.getByRole("button", { name: "Keep" }).click();
  await expect(entry).toHaveCount(1);
  await entry.getByRole("button", { name: "Discard" }).click();
  await entry.getByRole("button", { name: "Delete permanently" }).click();
  await expect(restarted.getByTestId("recovery-dialog")).toBeHidden();
  await expect(restarted.getByTestId("document-info")).toContainText("No document open");

  const later = await openEditor(context);
  await expect(later.getByTestId("recovery-dialog")).toBeHidden();
});

test("the status bar reports the last autosave of unsaved changes", async () => {
  const page = await openEditor(await launch());
  await load(page, [LEFT, RIGHT]);
  await expect(page.getByTestId("autosave-status")).toHaveCount(0);
  await select(page, 2, 6);
  await edit(page, "Mute", 8);
  await expect(page.getByTestId("autosave-status")).toHaveAttribute("data-state", "saved");
  await expect(page.getByTestId("autosave-status")).toContainText("Autosaved");
});
