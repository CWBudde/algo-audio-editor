import type { Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  allowedExternalURL,
  isExtractionURL,
  registerPermissions,
  sameApplication,
} from "./security";

const APP_URL = "app://editor/index.html";
const AUDIO = { isMainFrame: true, requestingUrl: APP_URL, securityOrigin: "app://editor" };

function permissions(applicationURL = APP_URL) {
  let check!: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
  let request!: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
  const session = {
    setPermissionCheckHandler: (handler: typeof check) => {
      check = handler;
    },
    setPermissionRequestHandler: (handler: typeof request) => {
      request = handler;
    },
  } as unknown as Session;
  registerPermissions(session, applicationURL);
  const contents = {
    getURL: () => applicationURL,
    isDestroyed: () => false,
  } as unknown as WebContents;
  return { check, request, contents };
}

describe("desktop origin and external navigation", () => {
  it.each([
    ["app://editor", APP_URL, true],
    ["app://editor/index.html?extract=test", APP_URL, true],
    ["app://editor.evil/index.html", APP_URL, false],
    ["app://editor:12/index.html", APP_URL, false],
    ["https://editor/index.html", APP_URL, false],
    ["app://user@editor/index.html", APP_URL, false],
    ["app://other/index.html", APP_URL, false],
    ["data:text/html,editor", APP_URL, false],
    ["invalid", APP_URL, false],
    ["http://localhost:5173/page", "http://localhost:5173/", true],
    ["http://localhost:5174/", "http://localhost:5173/", false],
    ["http://127.0.0.1:5173/", "http://localhost:5173/", false],
    ["https://localhost:5173/", "http://localhost:5173/", false],
  ])("compares %s with %s", (value, applicationURL, allowed) => {
    expect(sameApplication(value, applicationURL)).toBe(allowed);
  });

  it.each([
    "https://github.com/cwbudde/algo-audio-editor",
    "https://github.com/cwbudde/algo-audio-editor/blob/main/PLAN.md",
  ])("permits existing UI link %s", (value) => {
    expect(allowedExternalURL(value)).toBe(value);
  });
  it.each([
    "https://github.com.evil/cwbudde/algo-audio-editor",
    "https://user@github.com/cwbudde/algo-audio-editor",
    "https://github.com:444/cwbudde/algo-audio-editor",
    "https://github.com/cwbudde/algo-audio-editor?redirect=evil",
    "https://github.com/cwbudde/algo-audio-editor/issues",
    "https://unrelated.example/",
    "http://github.com/cwbudde/algo-audio-editor",
    "file:///tmp/audio.wav",
    "javascript:alert(1)",
    "malformed",
  ])("denies external link %s", (value) => {
    expect(allowedExternalURL(value)).toBeUndefined();
  });

  it("requires the editor page and a complete UUID to open extracted documents", () => {
    const id = "12345678-abcd-1234-abcd-123456789abc";
    expect(isExtractionURL(`${APP_URL}?extract=${id}`, APP_URL)).toBe(true);
    for (const value of [
      `${APP_URL}?extract=${"-".repeat(36)}`,
      `app://editor/other.html?extract=${id}`,
      `https://editor/index.html?extract=${id}`,
      `${APP_URL}?extract=bad`,
      "malformed",
    ])
      expect(isExtractionURL(value, APP_URL)).toBe(false);
  });
});

describe("deny-default desktop permissions", () => {
  it("allows only audio checks and audio-only requests in the live app main frame", () => {
    const { check, request, contents } = permissions();
    expect(check(contents, "media", "app://editor", { ...AUDIO, mediaType: "audio" })).toBe(true);
    const callback = vi.fn();
    request(contents, "media", callback, { ...AUDIO, mediaTypes: ["audio"] });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    "notifications",
    "geolocation",
    "fileSystem",
    "display-capture",
    "clipboard-read",
    "midi",
    "unknown",
  ] as const)("denies %s on both paths", (permission) => {
    const { check, request, contents } = permissions();
    expect(check(contents, permission, "app://editor", AUDIO)).toBe(false);
    const callback = vi.fn();
    request(contents, permission, callback, AUDIO);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([undefined, [], ["video"], ["audio", "video"], ["audio", "audio"]] as const)(
    "denies absent, empty or non-exclusive media types %s",
    (mediaTypes) => {
      const { request, contents } = permissions();
      const callback = vi.fn();
      request(contents, "media", callback, { ...AUDIO, mediaTypes: mediaTypes && [...mediaTypes] });
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("denies unknown or video checks, workers, subframes, foreign frames and destroyed contents", () => {
    const { check, request, contents } = permissions();
    for (const mediaType of [undefined, "video", "unknown"] as const)
      expect(check(contents, "media", "app://editor", { ...AUDIO, mediaType })).toBe(false);
    expect(check(null, "media", "app://editor", { ...AUDIO, mediaType: "audio" })).toBe(false);
    for (const details of [
      { ...AUDIO, isMainFrame: false },
      { ...AUDIO, requestingUrl: "app://other/index.html" },
      { ...AUDIO, securityOrigin: "https://unrelated.example" },
    ]) {
      expect(check(contents, "media", "app://editor", { ...details, mediaType: "audio" })).toBe(
        false,
      );
      const callback = vi.fn();
      request(contents, "media", callback, { ...details, mediaTypes: ["audio"] });
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    }
    expect(check(contents, "media", "app://other", { ...AUDIO, mediaType: "audio" })).toBe(false);
    for (const other of [
      { getURL: () => "https://unrelated.example", isDestroyed: () => false },
      { getURL: () => APP_URL, isDestroyed: () => true },
    ]) {
      const foreign = other as unknown as WebContents;
      expect(check(foreign, "media", "app://editor", { ...AUDIO, mediaType: "audio" })).toBe(false);
      const callback = vi.fn();
      request(foreign, "media", callback, { ...AUDIO, mediaTypes: ["audio"] });
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    }
  });

  it("permits only the exact configured development origin", () => {
    const url = "http://localhost:5173/";
    const { check, request, contents } = permissions(url);
    const details = { isMainFrame: true, requestingUrl: url, mediaType: "audio" as const };
    expect(check(contents, "media", url, details)).toBe(true);
    for (const origin of [
      "http://localhost:5174",
      "http://127.0.0.1:5173",
      "https://localhost:5173",
      "app://editor",
    ])
      expect(check(contents, "media", origin, details)).toBe(false);
    const callback = vi.fn();
    request(contents, "media", callback, { ...details, mediaTypes: ["audio"] });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
  });
});
