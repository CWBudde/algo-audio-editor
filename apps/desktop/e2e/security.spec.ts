import { createServer } from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeEditor, launchEditor } from "./launch";

test("only app audio permission and explicit external links are allowed", async () => {
  const app = await launchEditor({
    args: [path.join(__dirname, ".."), "--use-fake-device-for-media-stream"],
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    expect(
      await page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const tracks = stream.getTracks().map((track) => track.kind);
        for (const track of stream.getTracks()) track.stop();
        return tracks;
      }),
    ).toEqual(["audio"]);
    expect(
      await page.evaluate(async () => {
        const denied: string[] = [];
        for (const constraints of [{ video: true }, { video: true, audio: true }]) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            for (const track of stream.getTracks()) track.stop();
            denied.push("allowed");
          } catch (error) {
            denied.push((error as DOMException).name);
          }
        }
        denied.push(await Notification.requestPermission());
        return denied;
      }),
    ).toEqual(["NotAllowedError", "NotAllowedError", "denied"]);
    expect(
      await page.evaluate(async () => {
        const statuses: number[] = [];
        for (const path of ["/%", "/%E0%A4", "/%2e%2e%2fprivate.txt"])
          statuses.push((await fetch(path)).status);
        return statuses;
      }),
    ).toEqual([404, 404, 403]);

    await app.evaluate(({ BrowserWindow, shell }) => {
      const opened: string[] = [];
      Object.assign(globalThis, { securityOpened: opened, securityNavigations: 0 });
      BrowserWindow.getAllWindows()[0].webContents.on("will-navigate", () => {
        const state = globalThis as unknown as { securityNavigations: number };
        state.securityNavigations++;
      });
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await page.getByRole("link", { name: "Source code", exact: true }).click();
    await page.getByRole("link", { name: "Roadmap", exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { securityOpened: string[] }).securityOpened),
      )
      .toEqual([
        "https://github.com/cwbudde/algo-audio-editor",
        "https://github.com/cwbudde/algo-audio-editor/blob/main/PLAN.md",
      ]);
    await page.evaluate(() => {
      for (const url of [
        "https://unrelated.example/",
        "https://github.com.evil/cwbudde/algo-audio-editor",
        "https://github.com/cwbudde/algo-audio-editor/issues",
        "file:///tmp/private.txt",
      ])
        window.open(url, "_blank");
      window.location.assign("https://unrelated.example/");
    });
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { securityNavigations: number }).securityNavigations,
        ),
      )
      .toBe(1);
    expect(page.url()).toBe("app://editor/index.html");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { securityOpened: string[] }).securityOpened.length,
      ),
    ).toBe(2);
  } finally {
    await closeEditor(app);
  }
});

test("server redirects cannot navigate the editor to an external origin", async () => {
  let reachedDestination = false;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: `http://localhost:${address.port}/destination` });
    } else {
      reachedDestination = true;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.write("<html>external</html>");
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const result = await app.evaluate(async ({ BrowserWindow }, url) => {
      const win = BrowserWindow.getAllWindows()[0];
      let redirects = 0;
      win.webContents.on("will-redirect", () => {
        redirects++;
      });
      try {
        await win.loadURL(url);
        return { code: "loaded", redirects };
      } catch (error) {
        return { code: (error as Error & { code?: string }).code, redirects };
      }
    }, `http://127.0.0.1:${address.port}/redirect`);
    expect(result.redirects).toBe(1);
    expect(["ERR_ABORTED", "ERR_FAILED"]).toContain(result.code);
    expect(reachedDestination).toBe(false);
    expect((await app.firstWindow()).url()).toBe("app://editor/index.html");
  } finally {
    await closeEditor(app);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
