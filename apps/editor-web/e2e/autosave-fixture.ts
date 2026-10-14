/// <reference lib="dom" />
import type { DocumentInfoResult, HistoryListResult, TimelineResult } from "@aae/protocol";
import { expect, type Page } from "@playwright/test";
import { edit, LEFT, load, RIGHT, select } from "./edit-fixture.ts";

/** The kernel's own view of the document: samples, anchors and save state. */
export async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const probe = window.__aaeTest;
    if (!probe) throw new Error("kernel probe missing");
    const info = (await probe.request("doc.info")) as DocumentInfoResult;
    const history = (await probe.request("history.list", {
      documentId: info.documentId,
    })) as HistoryListResult;
    const pcm = (await probe.request("doc.readPCM", {
      documentId: info.documentId,
      stateId: history.currentStateId,
      start: 0,
      frames: info.frames,
      channelMask: 2 ** info.channels - 1,
    })) as { data: ArrayBuffer };
    const timeline = (await probe.request("timeline.get", {
      documentId: info.documentId,
    })) as TimelineResult;
    return {
      name: info.name,
      frames: info.frames,
      samples: Array.from(new Float32Array(pcm.data)),
      markers: timeline.markers.map(({ frame, name }) => ({ frame, name })),
      dirty: history.dirty,
    };
  });
}

/** Mutes frames 2–6 and adds a marker, then waits out the 5 s guarantee. */
export async function editAndWait(page: Page) {
  await load(page, [LEFT, RIGHT]);
  await select(page, 2, 6);
  await edit(page, "Mute", 8);
  await page.evaluate(async () => {
    const probe = window.__aaeTest;
    const info = (await probe?.request("doc.info")) as DocumentInfoResult;
    await probe?.request("markers.add", { documentId: info.documentId, frame: 3, name: "cue" });
  });
  const state = await snapshot(page);
  expect(state.dirty).toBe(true);
  // doc.readPCM packs channels one after another: frames 2–5 of both are muted.
  expect([...state.samples.slice(2, 6), ...state.samples.slice(10, 14)]).toEqual(Array(8).fill(0));
  await page.waitForTimeout(5_000);
  return state;
}

/** Waits for the startup search for crashed sessions to finish. */
export async function editorReady(page: Page) {
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await expect(page.locator("[data-autosave]")).toHaveAttribute("data-autosave", "ready");
}

/** Recovers the single offered session. */
export async function recoverOffered(page: Page) {
  const dialog = page.getByTestId("recovery-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("recovery-session")).toHaveCount(1);
  await page.getByTestId("recovery-session").getByRole("button", { name: "Recover" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("document-details")).toContainText("8 frames");
}
