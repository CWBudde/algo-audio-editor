import { afterEach } from "vitest";
import { resetPreferences } from "@/lib/preferences";

// Preferences persist in localStorage behind a module-level store; start every
// test from the defaults so one test's settings never leak into the next.
afterEach(() => {
  // Node-environment test files have no localStorage.
  globalThis.localStorage?.clear();
  resetPreferences();
});
