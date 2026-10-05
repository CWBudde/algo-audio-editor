import type { Session } from "electron";

const EXTERNAL_URLS = new Set([
  "https://github.com/cwbudde/algo-audio-editor",
  "https://github.com/cwbudde/algo-audio-editor/blob/main/PLAN.md",
]);

export function parsedURL(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Custom app:// URLs have an opaque URL.origin: compare their scheme and host. */
export function sameApplication(value: string, applicationURL: string): boolean {
  const target = parsedURL(value);
  const application = parsedURL(applicationURL);
  return !!(
    target &&
    application &&
    !target.username &&
    !target.password &&
    target.protocol === application.protocol &&
    target.host === application.host
  );
}

export function allowedExternalURL(value: string): string | undefined {
  const target = parsedURL(value);
  if (!target || target.username || target.password) return undefined;
  return EXTERNAL_URLS.has(target.href) ? target.href : undefined;
}

export function isExtractionURL(value: string, applicationURL: string): boolean {
  const target = parsedURL(value);
  const application = parsedURL(applicationURL);
  return !!(
    target &&
    application &&
    sameApplication(value, applicationURL) &&
    target.pathname === application.pathname &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      target.searchParams.get("extract") ?? "",
    )
  );
}

/** Both handlers are required: checks and requests are separate Chromium paths. */
export function registerPermissions(session: Session, applicationURL: string) {
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    return (
      permission === "media" &&
      details.mediaType === "audio" &&
      details.isMainFrame &&
      !!contents &&
      !contents.isDestroyed() &&
      sameApplication(contents.getURL(), applicationURL) &&
      sameApplication(origin, applicationURL) &&
      !!details.requestingUrl &&
      sameApplication(details.requestingUrl, applicationURL) &&
      (!details.securityOrigin || sameApplication(details.securityOrigin, applicationURL))
    );
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      permission === "media" &&
        "mediaTypes" in details &&
        details.mediaTypes?.length === 1 &&
        details.mediaTypes[0] === "audio" &&
        details.isMainFrame &&
        !contents.isDestroyed() &&
        sameApplication(contents.getURL(), applicationURL) &&
        sameApplication(details.requestingUrl, applicationURL) &&
        (!details.securityOrigin || sameApplication(details.securityOrigin, applicationURL)),
    );
  });
}
