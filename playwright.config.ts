import { defineConfig, devices } from "@playwright/test";

/**
 * Kalamos M1 e2e harness (bench lives in tests/bench/run.mjs).
 *
 * Runs against the Vite dev server (port 1420, same as Tauri devUrl). Outside
 * Tauri, src/ipc.ts falls back to its in-memory mock, so no native window is
 * needed. Tests drive the real UI through data-testid / window.__kalamos and
 * reach the mock IPC + app object via dynamic import of /src/ipc.ts and
 * /src/main.ts (Vite serves the same module instance the page already loaded).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "test-results/e2e.json" }]]
    : [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    viewport: { width: 1200, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1200, height: 800 },
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
