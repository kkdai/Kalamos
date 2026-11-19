import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
