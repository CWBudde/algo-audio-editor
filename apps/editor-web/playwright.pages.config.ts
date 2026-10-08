import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.AAE_E2E_PORT ?? 4193);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid AAE_E2E_PORT");
const remote = process.env.PLAYWRIGHT_BASE_URL;
if (remote) {
  const url = new URL(remote);
  if (url.protocol !== "https:" || !url.pathname.endsWith("/")) {
    throw new Error("PLAYWRIGHT_BASE_URL must be an HTTPS URL with a trailing slash");
  }
}
export default defineConfig({
  testDir: "e2e",
  testMatch: "pages.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never" }],
        ["json", { outputFile: "playwright-json/pages.json" }],
      ]
    : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: remote ?? `http://localhost:${port}/algo-audio-editor/`,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
    trace: "retain-on-failure",
  },
  webServer: remote
    ? undefined
    : {
        command: `bun ../../scripts/serve-pages.mjs ${port}`,
        url: `http://localhost:${port}/algo-audio-editor/`,
        reuseExistingServer: false,
      },
});
