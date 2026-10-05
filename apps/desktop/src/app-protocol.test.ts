import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { appResponse } from "./app-protocol";

let directory: string;
let webRoot: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aae-protocol-"));
  webRoot = path.join(directory, "web");
  await mkdir(webRoot);
  await writeFile(path.join(webRoot, "index.html"), "<html>editor</html>");
  await writeFile(path.join(directory, "private.txt"), "private");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("serves the editor with CSP and isolation headers", async () => {
  for (const url of ["app://editor/", "app://editor/index.html"]) {
    const response = await appResponse(url, webRoot);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>editor</html>");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain("object-src 'none'");
  }
});

it.each([
  "app://editor/%",
  "app://editor/%ZZ",
  "app://editor/%E0%A4",
  "not a url",
  "app://other/index.html",
  "https://editor/index.html",
  "app://user@editor/index.html",
  "app://editor/missing.js",
  "app://editor/%00",
])("returns a response for malformed/missing request %s", async (url) => {
  expect((await appResponse(url, webRoot)).status).toBe(404);
});

it("rejects decoded traversal without exposing neighboring files", async () => {
  const response = await appResponse("app://editor/%2e%2e%2fprivate.txt", webRoot);
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("forbidden");
});
