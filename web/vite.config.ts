import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = fileURLToPath(new URL("..", import.meta.url));
const mathjax = JSON.parse(
  readFileSync(
    new URL("../node_modules/mathjax-full/package.json", import.meta.url),
    "utf8",
  ),
);
const sharedDefine = { PACKAGE_VERSION: JSON.stringify(mathjax.version) };

export default defineConfig({
  root,
  define: sharedDefine,
  resolve: {
    alias: [
      {
        find: /^\.\/desktop-editor-host$/,
        replacement: fileURLToPath(
          new URL("../src/editor/browser-editor-host.ts", import.meta.url),
        ),
      },
    ],
  },
  optimizeDeps: { esbuildOptions: { define: sharedDefine } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(repository), repository] },
    proxy: {
      "/api": { target: "http://127.0.0.1:4173", changeOrigin: false },
    },
  },
});
