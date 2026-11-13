import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const ALL_BROWSERS = ["chromium", "firefox", "webkit"] as const;

// Browser tests run on Chromium locally, and on all three engines in CI or
// with --mode all-browsers (ADR 0015). ai-core runs in browsers as well as on
// servers, so the browser project checks the entries there too.
export default defineConfig(({ mode }) => {
  const browsers =
    process.env["CI"] || mode === "all-browsers" ? ALL_BROWSERS : (["chromium"] as const);
  return {
    test: {
      projects: [
        {
          test: {
            name: "unit",
            // build.test.ts checks the built package, so it sits next to the
            // Vite config rather than in src/. test/ holds the repository's
            // own checks, such as the CI image.
            include: ["src/**/*.test.ts", "*.test.ts", "test/**/*.test.ts"],
            exclude: ["**/*.browser.test.ts"],
            environment: "node",
            // Fails any request a test didn't plan for (ADR 0006).
            setupFiles: ["src/test/no-network.ts"],
          },
        },
        {
          test: {
            name: "browser",
            include: ["src/**/*.browser.test.ts", "test/**/*.browser.test.ts"],
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              instances: browsers.map((browser) => ({ browser })),
            },
          },
        },
      ],
    },
  };
});
