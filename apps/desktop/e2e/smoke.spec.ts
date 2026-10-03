import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { playbackWAV } from "../../editor-web/e2e/playback-fixture.js";

test("loads the editor over app:// with cross-origin isolation", async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, ".."), "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await app.firstWindow();
    // Console errors catch what pageerror misses: CSP violations and a
    // preload script that failed to load.
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    expect(page.url()).toBe("app://editor/index.html");
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");
    await expect(page.getByTestId("cross-origin-isolated")).toHaveText("yes");
    await expect(page.getByTestId("platform")).toContainText("Electron");

    await expect(page.getByTestId("play")).toBeDisabled();
    await page.getByTestId("audio-file-input").setInputFiles({
      name: "desktop-playback.wav",
      mimeType: "audio/wav",
      buffer: playbackWAV(),
    });
    await expect(page.getByTestId("document-name")).toHaveText("desktop-playback.wav");
    await page.getByTestId("play").click();
    await expect
      .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
      .toBeGreaterThan(48_000);
    await page.getByTestId("stop").click();
    await expect(page.getByTestId("underruns")).toHaveText("0");

    // Drive the shared production file and peak path inside the Electron shell,
    // not just its unloaded app frame. Native dialogs arrive in Phase 9.
    const wav = Buffer.alloc(44 + 16 * 4);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(192000, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    for (let frame = 0; frame < 16; frame++) {
      wav.writeInt16LE(16384, 44 + frame * 4);
      wav.writeInt16LE(-8192, 46 + frame * 4);
    }
    await page.getByTestId("audio-file-input").setInputFiles({
      name: "desktop-waveform.wav",
      mimeType: "audio/wav",
      buffer: wav,
    });
    await expect(page.getByTestId("document-name")).toHaveText("desktop-waveform.wav");
    await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
    await expect(page.getByTestId("waveform-channel-1")).toHaveAttribute("data-rendered", "true");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-start-frame", "4");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-end-frame", "12");
    await page.getByLabel("Time format", { exact: true }).selectOption("samples");
    await page.getByLabel("Selection end", { exact: true }).fill("8");
    await page.getByLabel("Selection end", { exact: true }).press("Enter");
    await page.getByLabel("Selection start", { exact: true }).fill("4");
    await page.getByLabel("Selection start", { exact: true }).press("Enter");
    await page.getByRole("button", { name: "Right", exact: true }).click();
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-channel-mask", "2");
    await expect(page.getByTestId("waveform-selection")).toHaveCount(0);
    await page.getByLabel("Marker or region name").fill("Desktop region");
    await page.getByLabel("Marker or region color").fill("#123456");
    await page.getByRole("button", { name: "Add region", exact: true }).click();
    await expect(page.getByTestId("timeline-region-1")).toBeVisible();
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await page.locator("summary").filter({ hasText: "Markers and regions (1)" }).click();
    await page.getByRole("button", { name: "Edit region Desktop region", exact: true }).click();
    await page.getByLabel("Timeline name", { exact: true }).fill("Desktop region edited");
    await page.getByLabel("Timeline color", { exact: true }).fill("#abcdef");
    await page.getByRole("button", { name: "Save region", exact: true }).click();
    await expect(page.getByTestId("region-row-1")).toContainText("Desktop region edited");
    await expect(page.getByTestId("region-row-1").getByLabel("Color #abcdef")).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("region-row-1")).toContainText("Desktop region");
    await expect(page.getByTestId("region-row-1").getByLabel("Color #123456")).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(page.getByTestId("region-row-1")).toContainText("Desktop region edited");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-start", "4");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "8");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.getByTestId("document-details")).toContainText("· 12 frames");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-start", "4");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "4");
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.getByTestId("document-details")).toContainText("· 16 frames");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "8");
    await expect(page.getByTestId("timeline-region-1")).toHaveCount(0);
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("document-details")).toContainText("· 12 frames");
    await page.keyboard.press("Control+Shift+z");
    await expect(page.getByTestId("document-details")).toContainText("· 16 frames");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "8");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    const search = palette.getByRole("combobox", { name: "Search commands" });
    await expect(search).toBeFocused();
    await search.fill("zoom to fit");
    await search.press("Enter");
    await expect(palette).not.toBeVisible();
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-start-frame", "0");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-end-frame", "16");
    await page.getByRole("menuitem", { name: "Process", exact: true }).click();
    await page.locator('[role="menuitem"][data-command-id="process.amplify"]').click();
    const amplify = page.getByRole("dialog", { name: "Amplify", exact: true });
    await amplify.getByLabel("Gain (dB)").fill("-6");
    await amplify.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(amplify.getByTestId("process-status")).toContainText("Previewing");
    await expect(page.getByTestId("underruns")).toHaveText("0");
    await amplify.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(amplify).not.toBeVisible();
    await expect(page.getByTestId("document-details")).toContainText("· 16 frames");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-start", "4");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "8");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
