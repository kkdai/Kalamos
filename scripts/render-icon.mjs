// Render the SVG app icon source to a transparent PNG (#58).
// Usage: node scripts/render-icon.mjs [input.svg] [output.png] [size]
// Uses the already-installed Playwright Chromium; no extra packages.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const input = resolve(process.argv[2] ?? "src-tauri/icons/source/kalamos-icon.svg");
const output = resolve(process.argv[3] ?? "src-tauri/icons/source/kalamos-icon.png");
const size = Number(process.argv[4] ?? 1024);

const svg = await readFile(input, "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`,
  );
  await page.screenshot({ path: output, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`rendered ${output} (${size}×${size})`);
} finally {
  await browser.close();
}
