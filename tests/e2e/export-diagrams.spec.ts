import { expect, test } from "@playwright/test";
import { boot } from "./helpers";

/** #37: diagrams in the PDF export HTML, rendered by the real Mermaid. */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const fence = (info: string, src: string) => `\`\`\`${info}\n${src}\n\`\`\``;

test("#37 export HTML has static, light-themed, uniquely-scoped SVG for every diagram", async ({ page }) => {
  test.setTimeout(60_000);
  const doc = [
    "# 圖表",
    fence("mermaid", "flowchart TD\n  A[開始] --> B{判斷?}\n  B -->|是| C[結束]"),
    fence("mermaid", "sequenceDiagram\n  Alice->>Bob: 你好"),
    fence("flow", "st=>start: 開始\ne=>end: 結束\nst->e"),
    fence("sequence", "Alice->Bob: Hi"),
    fence("mermaid", "flowchart TD\n  A --> ((("),
    fence("mermaid", "flowchart TD\n  A[開始] --> B{判斷?}\n  B -->|是| C[結束]"),
  ].join("\n\n");

  // The editor is in the dark Melan theme; the export must not be.
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "melan"));
  const html = await page.evaluate(async (md) => {
    const { buildExportHtml } = await import("/src/export/html.ts" as string);
    const r = await buildExportHtml(md, { title: "t", docPath: null });
    return r.html.slice(r.html.indexOf("<body>"));
  }, doc);

  const figures = html.match(/<figure class="k-diagram" data-kind="\w+"><svg/g) ?? [];
  expect(figures).toHaveLength(5);
  expect(html).toContain('<p class="k-diagram-error">圖表語法錯誤');
  expect(html).toContain('<pre class="k-code" data-lang="mermaid">');
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/foreignObject/i);
  expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThan(10);
  expect(new Set(ids).size).toBe(ids.length);
  // Every url(#…) reference points at an id in the page.
  for (const m of html.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1]);

  // Light print palette: Papyros ink on white, not Melan's light text.
  expect(html.toLowerCase()).toContain("#2b2622");
  expect(html.toLowerCase()).not.toContain("#e8e0d0");
});

test("#37 twenty diagrams build the export HTML quickly", async ({ page }) => {
  test.setTimeout(60_000);
  const doc = Array.from({ length: 20 }, (_, i) =>
    fence("mermaid", `flowchart LR\n  A${i}[節點 ${i}] --> B${i}[Next ${i}]`),
  ).join("\n\n");
  const result = await page.evaluate(async (md) => {
    const { buildExportHtml } = await import("/src/export/html.ts" as string);
    const t0 = performance.now();
    const r = await buildExportHtml(md, { title: "t", docPath: null });
    return { ms: performance.now() - t0, figures: (r.html.match(/<figure class="k-diagram"/g) ?? []).length };
  }, doc);
  expect(result.figures).toBe(20);
  expect(result.ms).toBeLessThan(15_000);
});
