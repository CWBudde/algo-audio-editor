import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("speech model route", () => {
  let speechRoot: string;
  const weights = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index & 0xff));
  beforeEach(async () => {
    speechRoot = path.join(directory, "speech-models");
    await mkdir(path.join(speechRoot, "german", "voices"), { recursive: true });
    await writeFile(path.join(speechRoot, "german", "model.safetensors"), weights);
    await writeFile(path.join(speechRoot, "german", "tokenizer.json"), '{"model":{}}');
    await writeFile(path.join(speechRoot, "german", "notes.txt"), "not a model");
  });

  it("streams model files with isolation headers", async () => {
    const response = await appResponse(
      "app://editor/speech-models/german/model.safetensors",
      webRoot,
      speechRoot,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe(String(weights.length));
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(weights);
    const tokenizer = await appResponse(
      "app://editor/speech-models/german/tokenizer.json",
      webRoot,
      speechRoot,
    );
    expect(tokenizer.headers.get("Content-Type")).toBe("application/json");
    expect(await tokenizer.text()).toBe('{"model":{}}');
  });

  it.each([
    "app://editor/speech-models/%2e%2e%2fprivate.txt",
    "app://editor/speech-models/german%2f..%2f..%2fprivate.txt",
    "app://editor/speech-models/german%5cmodel.safetensors",
    "app://editor/speech-models/german/notes.txt",
    "app://editor/speech-models/german/model.safetensors.0b0c4f2e-6d4c-4c47-9a39-0d5a2c9f8e11.part",
    "app://editor/speech-models/",
  ])("refuses paths outside the model catalog layout: %s", async (url) => {
    const response = await appResponse(url, webRoot, speechRoot);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("returns 404 for missing files, folders, symlinks and an unconfigured root", async () => {
    await mkdir(path.join(speechRoot, "german", "folder.safetensors"));
    await symlink(
      path.join(directory, "private.txt"),
      path.join(speechRoot, "german", "link.safetensors"),
    );
    for (const name of ["missing.safetensors", "folder.safetensors", "link.safetensors", "%ZZ"])
      expect(
        (await appResponse(`app://editor/speech-models/german/${name}`, webRoot, speechRoot))
          .status,
      ).toBe(404);
    expect(
      (await appResponse("app://editor/speech-models/german/model.safetensors", webRoot)).status,
    ).toBe(404);
  });
});
