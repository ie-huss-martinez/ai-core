import { defineConfig, devices } from "@playwright/test";
import { API_KEY, APP_PORT, APP_URL, PROVIDER_URL } from "./constants.ts";

const ci = Boolean(process.env["CI"]);

/**
 * End-to-end tests of the built Next.js example, whose server calls a local
 * stand-in for Anthropic's API. Chromium locally, all three engines in CI,
 * as for the other browser tests. Tests share the stand-in's log, so they
 * run one at a time.
 */
export default defineConfig({
  testDir: "tests",
  forbidOnly: ci,
  retries: 0,
  workers: 1,
  reporter: ci ? "line" : "list",
  use: { baseURL: APP_URL, trace: "retain-on-failure" },
  projects: (
    [
      ["chromium", "Desktop Chrome"],
      ["firefox", "Desktop Firefox"],
      ["webkit", "Desktop Safari"],
    ] as const
  )
    .filter(([name]) => ci || name === "chromium")
    .map(([name, device]) => ({ name, use: { ...devices[device] } })),
  webServer: [
    {
      command: "node stand-in-provider.ts",
      url: `${PROVIDER_URL}/__log`,
      reuseExistingServer: !ci,
      timeout: 30_000,
    },
    {
      command: `node ../examples/next/node_modules/next/dist/bin/next start ../examples/next --port ${APP_PORT}`,
      url: APP_URL,
      reuseExistingServer: !ci,
      timeout: 60_000,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        ANTHROPIC_API_KEY: API_KEY,
        ANTHROPIC_BASE_URL: PROVIDER_URL,
        APP_ORIGIN: APP_URL,
      },
    },
  ],
});
