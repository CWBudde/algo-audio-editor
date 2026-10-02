import { defineConfig } from "@playwright/test";

// Drives the real Electron app via Playwright's Electron support. Needs the
// web build (apps/editor-web/dist) and this package's dist; `just e2e-desktop`
// builds both first.
export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? [["github"]] : "list",
  use: { trace: "retain-on-failure" },
});
