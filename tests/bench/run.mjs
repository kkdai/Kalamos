#!/usr/bin/env node
/**
 * Kalamos M1 benchmark (PLAN.md AC15: 10k-line document, input → render < 50 ms).
 *
 * - Starts its own Vite dev server (port 1421, so it never clashes with the
 *   e2e webServer on 1420) and a headless Chromium via Playwright.
 * - Seeds a 10 000-line mixed document (headings, lists, tables, code, math,
 *   inline marks) into the ipc mock and opens it through the real app path
 *   (app.openDocument).
 * - Open → first render: openDocument() start → 2nd animation frame after it
 *   resolves (content painted). Median of N runs.
 * - Input latency: for each real keystroke (CDP key events) we take
 *   keydown.timeStamp → the frame after the next requestAnimationFrame
 *   (rAF + MessageChannel ≈ "frame presented"). Keystrokes are spread over the
 *   top / middle / bottom of the document and inside a table, a code block and
 *   a list.
 * - Scenario "as-is": MathJax loads without any shim (BUG-4 fixed via
 *   Vite `define`), so math typesetting cost is included. The run fails if
 *   math did not actually render or if the page logged errors.
 * - Scenario "ataraxia+stichos": the same with focus mode (F8) and typewriter
 *   mode (F9) on (#15).
 *
 * Output: one JSON object on stdout. Logs go to stderr.
 * Exit code 1 if p95 input latency ≥ budget (50 ms) or math did not render.
 *
 * Usage: node tests/bench/run.mjs [--keys 40] [--opens 5] [--lines 10000]
 */
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const args = process.argv.slice(2);
const argNum = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const KEYS_PER_SPOT = argNum("keys", 40);
const OPEN_RUNS = argNum("opens", 5);
const LINES = argNum("lines", 10_000);
const BUDGET_MS = 50;
const PORT = 1421;

const log = (...m) => console.error("[bench]", ...m);

/** Build a ~LINES-line document mixing every block type M1 renders. */
function buildDoc(lines) {
  const out = [];
  let section = 0;
  while (out.length < lines) {
    section++;
    out.push(`## 第 ${section} 節 Section ${section}`, "");
    out.push(
      `這是 **粗體** 與 *斜體*、\`inline code\`、~~刪除~~ 與 [連結](https://example.com/${section}) 的混排段落 ${section}。`,
      "",
    );
    out.push(
      "- 清單項目一",
      "- 清單項目二 **重點**",
      "  - 巢狀項目",
      "- [ ] 待辦事項",
      "- [x] 已完成",
      "",
    );
    out.push("| 欄位 | 數值 | 說明 |", "| --- | ---: | :---: |");
    for (let r = 0; r < 4; r++)
      out.push(`| row${r} | ${section * 10 + r} | *註解* ${r} |`);
    out.push("");
    out.push(
      "```ts",
      `function f${section}(x: number): number {`,
      "  // comment",
      `  return x * ${section};`,
      "}",
      "```",
      "",
    );
    out.push(
      `行內公式 $a_${section}^2 + b^2 = c^2$ 與區塊公式：`,
      "",
      "$$",
      `\\sum_{i=1}^{${section}} i = \\frac{n(n+1)}{2}`,
      "$$",
      "",
    );
    out.push("1. 有序一", "2. 有序二", "3. 有序三", "");
    out.push("> 引用文字 blockquote", "");
  }
  return out.slice(0, lines).join("\n");
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  const r = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    n: s.length,
    p50: r(percentile(s, 50)),
    p95: r(percentile(s, 95)),
    max: r(s[s.length - 1]),
    mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}

async function runScenario(
  browser,
  baseURL,
  doc,
  { name, writingModes = false },
) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(baseURL);
  await page.waitForFunction(() => Boolean(window.__kalamos));
  await page.waitForFunction(async () =>
    Boolean((await import("/src/main.ts")).getActiveApp()),
  );

  await page.evaluate(async (content) => {
    const ipc = await import("/src/ipc.ts");
    ipc.seedMockFile("/bench/10k.md", content);
    ipc.setMockDialogHandlers({ ask: () => true });
  }, doc);

  // Warm-up open (loads language-data chunks, MathJax, fonts).
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts")).getActiveApp();
    await app.openDocument("/bench/10k.md");
  });
  await page.waitForTimeout(1500);
  if (writingModes) {
    await page.evaluate(async () => {
      const app = (await import("/src/main.ts")).getActiveApp();
      app.editor.setFocusMode(true);
      app.editor.setTypewriterMode(true);
    });
  }

  // --- open → first render -------------------------------------------------
  const openTimes = [];
  for (let i = 0; i < OPEN_RUNS; i++) {
    const ms = await page.evaluate(async () => {
      const app = (await import("/src/main.ts")).getActiveApp();
      await app.newDocument();
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      const t0 = performance.now();
      await app.openDocument("/bench/10k.md");
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      const ok = document.querySelectorAll(".cm-content .cm-line").length > 0;
      return ok ? performance.now() - t0 : -1;
    });
    openTimes.push(ms);
  }
  await page.waitForTimeout(500);

  // --- input latency ---------------------------------------------------------
  await page.evaluate(() => {
    window.__benchLat = [];
    window.addEventListener(
      "keydown",
      (e) => {
        const start = e.timeStamp;
        requestAnimationFrame(() => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () =>
            window.__benchLat.push(performance.now() - start);
          ch.port2.postMessage(0);
        });
      },
      { capture: true },
    );
  });

  const docLen = doc.length;
  const lineStartOf = (needle, from = 0) => doc.indexOf(needle, from);
  const mid = Math.floor(docLen / 2);
  const spots = {
    top: doc.indexOf("\n", doc.indexOf("混排段落")),
    middleParagraph: doc.indexOf("\n", lineStartOf("混排段落", mid)),
    bottom: docLen,
    insideTableCell: lineStartOf("| row1 |", mid) + 5,
    insideCodeBlock: doc.indexOf("\n", lineStartOf("  // comment", mid)),
    insideList: doc.indexOf("\n", lineStartOf("- 清單項目一", mid)),
  };

  const perSpot = {};
  const all = [];
  for (const [spot, pos] of Object.entries(spots)) {
    await page.evaluate(async (p) => {
      const app = (await import("/src/main.ts")).getActiveApp();
      const view = app.editor.view;
      view.focus();
      view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      window.__benchLat.length = 0;
    }, pos);
    const text = "abc 中文 xyz ".repeat(10);
    for (let k = 0; k < KEYS_PER_SPOT; k++) {
      const ch = text[k % text.length];
      if (/[a-z ]/.test(ch))
        await page.keyboard.press(ch === " " ? "Space" : ch);
      else await page.keyboard.insertText(ch); // CJK goes through insertText (no keydown)
      await page.waitForTimeout(20);
    }
    // Backspaces exercise deletions too.
    for (let k = 0; k < 10; k++) {
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(100);
    const lat = await page.evaluate(() => [...window.__benchLat]);
    perSpot[spot] = summarize(lat);
    all.push(...lat);
  }

  const lineCount = await page.evaluate(async () => {
    const app = (await import("/src/main.ts")).getActiveApp();
    return app.editor.view.state.doc.lines;
  });
  const mathRendered = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-testid="math-block"] svg, [data-testid="math-inline"] svg',
      ).length > 0,
  );

  await context.close();
  const input = summarize(all);
  return {
    name,
    mathRendered,
    lines: lineCount,
    openToFirstRenderMs: {
      runs: openTimes.map((v) => Math.round(v * 100) / 100),
      ...summarize(openTimes),
    },
    inputLatencyMs: { ...input, perSpot },
    pass:
      input.p95 !== null &&
      input.p95 < BUDGET_MS &&
      mathRendered &&
      pageErrors.length === 0,
    pageErrors: [...new Set(pageErrors)],
  };
}

async function main() {
  const doc = buildDoc(LINES);
  log(`document: ${doc.split("\n").length} lines, ${doc.length} chars`);
  const server = await createServer({
    configFile: "vite.config.ts",
    logLevel: "error",
    server: { port: PORT, strictPort: false },
  });
  await server.listen();
  const baseURL =
    server.resolvedUrls?.local?.[0] ?? `http://localhost:${PORT}/`;
  log(`vite dev server at ${baseURL}`);
  const browser = await chromium.launch();
  const browserVersion = browser.version();
  const results = [];
  try {
    for (const scenario of [
      { name: "as-is" },
      { name: "ataraxia+stichos", writingModes: true },
    ]) {
      log(`scenario ${scenario.name} …`);
      results.push(await runScenario(browser, baseURL, doc, scenario));
    }
  } finally {
    await browser.close();
    await server.close();
  }
  const report = {
    tool: "kalamos-bench",
    date: new Date().toISOString(),
    budgetMs: BUDGET_MS,
    metric:
      "keydown.timeStamp → rAF + MessageChannel (≈ next frame), headless Chromium, Vite dev build",
    browser: `chromium ${browserVersion}`,
    platform: `${process.platform}-${process.arch}`,
    keysPerSpot: KEYS_PER_SPOT,
    scenarios: results,
    pass: results.every((r) => r.pass),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
