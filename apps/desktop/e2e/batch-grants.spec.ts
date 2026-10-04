import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeEditor, launchEditor } from "./launch.js";

interface PickerState {
  calls: number;
  resolvers: Array<(result: { canceled: boolean; filePaths: string[] }) => void>;
}

interface PickerTestGlobal {
  __batchPickerRegression: PickerState;
}

test("nine concurrent folder pickers reserve at most eight grants and release their slots", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-batch-picker-limit-"));
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await app.evaluate(({ dialog }) => {
      const state: PickerState = { calls: 0, resolvers: [] };
      (globalThis as unknown as PickerTestGlobal).__batchPickerRegression = state;
      dialog.showOpenDialog = (() => {
        state.calls++;
        return new Promise((resolve) => state.resolvers.push(resolve));
      }) as typeof dialog.showOpenDialog;
    });
    const pending = page.evaluate(() =>
      Promise.all(
        Array.from({ length: 9 }, async () => {
          try {
            const folder = await window.aaeDesktop?.pickBatchDirectory?.();
            return { id: folder?.id ?? "", error: "" };
          } catch (error) {
            return { id: "", error: String(error) };
          }
        }),
      ),
    );
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as PickerTestGlobal).__batchPickerRegression.calls,
        ),
      )
      .toBe(8);
    await app.evaluate((_electron, directory) => {
      for (const resolve of (
        globalThis as unknown as PickerTestGlobal
      ).__batchPickerRegression.resolvers.splice(0))
        resolve({ canceled: false, filePaths: [directory] });
    }, directory);
    const results = await pending;
    const ids = results.filter((result) => result.id).map((result) => result.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(results.filter((result) => result.error)).toEqual([
      { id: "", error: expect.stringContaining("Too many pending batch folders") },
    ]);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    const full = await page.evaluate(async () => {
      try {
        await window.aaeDesktop?.pickBatchDirectory?.();
        return "accepted";
      } catch (error) {
        return String(error);
      }
    });
    expect(full).toContain("Too many pending batch folders");
    await page.evaluate(async (ids) => {
      for (const id of ids) await window.aaeDesktop?.releaseBatchDirectory?.(id);
    }, ids);
    const next = await page.evaluate(() => window.aaeDesktop?.pickBatchDirectory?.());
    expect(next?.id).toBeTruthy();
    await page.evaluate((id) => window.aaeDesktop?.releaseBatchDirectory?.(id), next?.id ?? "");
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a folder picker resolving after reload cannot retain a stale grant", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-batch-picker-reload-"));
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await app.evaluate(({ dialog }) => {
      const state: PickerState = { calls: 0, resolvers: [] };
      (globalThis as unknown as PickerTestGlobal).__batchPickerRegression = state;
      dialog.showOpenDialog = (() => {
        state.calls++;
        return new Promise((resolve) => state.resolvers.push(resolve));
      }) as typeof dialog.showOpenDialog;
    });
    await page.evaluate(() => {
      void window.aaeDesktop?.pickBatchDirectory?.().catch(() => {});
    });
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as PickerTestGlobal).__batchPickerRegression.calls,
        ),
      )
      .toBe(1);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await app.evaluate(({ dialog }, directory) => {
      const state = (globalThis as unknown as PickerTestGlobal).__batchPickerRegression;
      state.resolvers.shift()?.({ canceled: false, filePaths: [directory] });
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    const ids = await page.evaluate(async () => {
      const ids: string[] = [];
      for (let index = 0; index < 7; index++) {
        const folder = await window.aaeDesktop?.pickBatchDirectory?.();
        if (!folder) throw new Error("Folder picker returned no grant");
        ids.push(folder.id);
      }
      return ids;
    });
    // The expired handler may still be finishing filesystem awaits. Poll for
    // its released reservation while retaining seven new-session grants. A
    // leaked stale grant permanently consumes the eighth slot and fails here.
    let eighth = "";
    await expect
      .poll(async () => {
        eighth = await page.evaluate(async () => {
          try {
            return (await window.aaeDesktop?.pickBatchDirectory?.())?.id ?? "";
          } catch {
            return "";
          }
        });
        return eighth;
      })
      .not.toBe("");
    ids.push(eighth);
    expect(new Set(ids).size).toBe(8);
    await page.evaluate(async (ids) => {
      for (const id of ids) await window.aaeDesktop?.releaseBatchDirectory?.(id);
    }, ids);
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
