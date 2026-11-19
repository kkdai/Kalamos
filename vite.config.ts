import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// mathjax-full's components/version.js falls back to `eval('require')` when
// PACKAGE_VERSION is not defined, which throws in the browser / Tauri WebView
// (BUG-4). Define it at build time, for both app code and pre-bundled deps.
const mathjaxVersion: string = JSON.parse(
  readFileSync(
    new URL("./node_modules/mathjax-full/package.json", import.meta.url),
    "utf8",
  ),
).version;
const sharedDefine = { PACKAGE_VERSION: JSON.stringify(mathjaxVersion) };

export default defineConfig({
  clearScreen: false,
  define: sharedDefine,
  optimizeDeps: {
    esbuildOptions: { define: sharedDefine },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
});
