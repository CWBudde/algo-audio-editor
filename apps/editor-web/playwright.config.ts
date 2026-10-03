import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.AAE_E2E_PORT ?? 4173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("AAE_E2E_PORT must be an integer from 1 to 65535");
}
const chromium = {
  ...devices["Desktop Chrome"],
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      grepInvert: /@timing/,
      use: chromium,
    },
    {
      name: "chromium-timing",
      grep: /@timing/,
      // Measure the unchanged one-quantum gate after parallel functional tests,
      // without competing browser audio/render threads on the same host.
      dependencies: ["chromium"],
      workers: 1,
      use: chromium,
    },
  ],
  // Runs against the production build (`just e2e` builds first), served with
  // the same COOP/COEP headers as the dev server.
  webServer: {
    command: `bun run preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Own the preview lifecycle so tests always verify this production build.
    // A busy port fails explicitly; AAE_E2E_PORT avoids unrelated local servers.
    reuseExistingServer: false,
  },
});
