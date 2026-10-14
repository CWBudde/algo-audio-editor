import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { editorReady } from "./autosave-fixture.ts";
import { edit, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

// Opt-in, serial acceptance of Phase 18's recovery gate on the one-hour FLAC
// fixture (just flac-hour-fixture PATH): ~84k blocks of 4,096 frames, the worst
// case for block count. It retains ~1.5 GiB per kernel and writes ~1.4 GB to
// the profile's OPFS.
const fixture = process.env.AAE_HOUR_FLAC_FIXTURE;
const HOUR = "48000 Hz · 2 channels · 172800000 frames · 3600.000 s";

if (fixture) {
  test("recovers a killed one-hour stereo document within 10 s", async () => {
    test.setTimeout(900_000);
    const profile = await mkdtemp(join(tmpdir(), "aae-autosave-hour-"));
    const launch = async () => {
      const context = await chromium.launchPersistentContext(profile, {
        baseURL: test.info().project.use.baseURL,
      });
      await captureKernelWorker(context);
      const page = await context.newPage();
      await page.goto("/");
      await editorReady(page);
      return { context, page };
    };
    const painted = async (page: Page) => {
      for (const id of ["waveform-channel-0", "waveform-channel-1", "waveform-overview"])
        await expect(page.getByTestId(id)).toHaveAttribute("data-rendered", "true", {
          timeout: 600_000,
        });
    };
    const crash = async (context: BrowserContext, page: Page) => {
      const closed = new Promise((resolve) => context.once("close", resolve));
      void (await context.newCDPSession(page)).send("Browser.crash").catch(() => {});
      await closed;
    };
    try {
      const first = await launch();
      const opened = Date.now();
      await first.page.getByTestId("audio-file-input").setInputFiles(fixture);
      await expect(first.page.getByTestId("document-details")).toContainText(HOUR, {
        timeout: 600_000,
      });
      await painted(first.page);
      const openMs = Date.now() - opened;
      // A short mute makes the document dirty; the indicator appears once the
      // whole prefill and this edit are on disk.
      await (
        await revealControl(first.page.getByLabel("Time format", { exact: true }))
      ).selectOption("samples");
      await first.page.getByLabel("Time format", { exact: true }).press("Escape");
      await select(first.page, 0, 4800);
      const edited = Date.now();
      await edit(first.page, "Mute", 172_800_000);
      await expect(first.page.getByTestId("autosave-status")).toHaveAttribute(
        "data-state",
        "saved",
        { timeout: 600_000 },
      );
      const prefillMs = Date.now() - opened;
      const editToSavedMs = Date.now() - edited;
      await crash(first.context, first.page);

      const second = await launch();
      const started = Date.now();
      await second.page
        .getByTestId("recovery-session")
        .getByRole("button", { name: "Recover" })
        .click();
      await expect(second.page.getByTestId("document-details")).toContainText(HOUR, {
        timeout: 600_000,
      });
      const documentMs = Date.now() - started;
      await painted(second.page);
      const recoverMs = Date.now() - started;
      await expect(second.page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
      const report = { openMs, prefillMs, editToSavedMs, documentMs, recoverMs };
      console.info(`one-hour autosave recovery: ${JSON.stringify(report)}`);
      await test.info().attach("autosave-hour", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      expect(recoverMs).toBeLessThanOrEqual(10_000);
      await second.context.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
}
