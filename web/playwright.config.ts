import { defineConfig } from "@playwright/test";

const url = new URL(process.env.TEST_WEB_URL ?? "http://127.0.0.1:4173");
if (
  !["http:", "https:"].includes(url.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.href !== `${url.origin}/`
) {
  throw new Error("TEST_WEB_URL must be a loopback HTTP(S) origin.");
}

// Start the actual Web/API and an isolated PostgreSQL database before running.
export default defineConfig({
  testDir: "./tests",
  outputDir: "../test-results/web",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: url.origin,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1360, height: 1000 },
    trace: "retain-on-failure",
  },
});
