/*! Adapted from coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, MIT */
// No application cache: HTML is revalidated and each kernel/runtime pair has
// content-addressed URLs. Activating a header-only update never reloads edits.
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
    event.respondWith((async () => {
      const fresh = request.mode === "navigate" || new URL(request.url).pathname.endsWith("/coi-serviceworker.js");
      const response = await fetch(fresh ? new Request(request, { cache: "no-store" }) : request);
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      if (fresh) headers.set("Cache-Control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })());
  });
} else {
  (() => {
    if (window.crossOriginIsolated || !window.isSecureContext || !navigator.serviceWorker) return;
    const script = document.currentScript;
    if (!script) return;
    const scriptURL = new URL(script.src);
    scriptURL.search = "";
    const scope = new URL(".", scriptURL).href;
    const key = `aae-isolation-reload:${scope}`;
    let attempted = false;
    try { attempted = sessionStorage.getItem(key) === "1"; } catch {}
    let reloading = false;
    function reloadOnce() {
      if (attempted || reloading) return;
      reloading = true;
      try { sessionStorage.setItem(key, "1"); } catch { return; }
      window.location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
    navigator.serviceWorker.register(scriptURL.href, { scope, updateViaCache: "none" }).then(
      () => { if (navigator.serviceWorker.controller) reloadOnce(); },
      (error) => console.warn("Cross-origin isolation could not be enabled:", error),
    );
  })();
}
