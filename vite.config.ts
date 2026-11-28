import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { createLazyMarkdownHtmlPlugin } from "./scripts/lazy-markdown-html-plugin.mjs";

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

const CORE_CODEMIRROR_PACKAGES = [
  "/node_modules/@codemirror/view/",
  "/node_modules/@codemirror/state/",
  "/node_modules/@codemirror/commands/",
  "/node_modules/@codemirror/language/",
  "/node_modules/@codemirror/autocomplete/",
  "/node_modules/@codemirror/search/",
  "/node_modules/@codemirror/lang-markdown/",
  "/node_modules/@codemirror/language-data/",
  "/node_modules/@lezer/common/",
  "/node_modules/@lezer/lr/",
  "/node_modules/@lezer/highlight/",
  "/node_modules/@lezer/markdown/",
  "/node_modules/style-mod/",
  "/node_modules/w3c-keyname/",
  "/node_modules/crelt/",
  "/node_modules/@marijn/find-cluster-break/",
];

const markdownLangPath = fileURLToPath(
  new URL("./src/editor/markdown-lang.ts", import.meta.url),
).replace(/\\/g, "/");

export default defineConfig({
  clearScreen: false,
  define: sharedDefine,
  optimizeDeps: {
    esbuildOptions: { define: sharedDefine },
  },
  plugins: [createLazyMarkdownHtmlPlugin(markdownLangPath)],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const norm = id.replace(/\\/g, "/");
          if (norm.includes("/node_modules/mathjax-full/")) {
            return "mathjax";
          }
          if (CORE_CODEMIRROR_PACKAGES.some((pkg) => norm.includes(pkg))) {
            return "codemirror";
          }
          return undefined;
        },
      },
    },
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
