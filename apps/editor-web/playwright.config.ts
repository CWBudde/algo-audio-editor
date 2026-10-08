import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.AAE_E2E_PORT ?? 4173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("AAE_E2E_PORT must be an integer from 1 to 65535");
}
const chromium = {
  ...devices["Desktop Chrome"],
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
};
// Hardware timing gates (`@timing`) measure real-time audio on the target
// laptop; shared CI runners cannot meet them. `just e2e-timing` opts in.
const timing = process.env.AAE_TIMING === "1";

export default defineConfig({
  testDir: "e2e",
  testIgnore: "**/pages.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // The JSON report feeds the CI summary of tests that only passed on retry.
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never" }],
        ["json", { outputFile: "playwright-json/browser.json" }],
      ]
    : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      grepInvert: /@timing/,
      use: chromium,
    },
    ...(timing
      ? [
          {
            name: "chromium-timing",
            grep: /@timing/,
            // Measure the unchanged one-quantum gate after parallel functional
            // tests, without competing browser audio/render threads on the host.
            dependencies: ["chromium"],
            workers: 1,
            use: chromium,
          },
        ]
      : []),
  ],
  // Runs against the production build (`just e2e` builds first), served with
  // the same COOP/COEP headers as the dev server.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `bun run --bun preview --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        // Own the preview lifecycle so tests always verify this production build.
        // A busy port fails explicitly; AAE_E2E_PORT avoids unrelated local servers.
        reuseExistingServer: false,
      },
});
