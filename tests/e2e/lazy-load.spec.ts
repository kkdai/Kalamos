import { expect, test } from "@playwright/test";
import { boot, setDoc } from "./helpers";

/**
 * #146: Startup & lazy-loading verification.
 *
 * Plain documents without math, diagrams, emoji shortcodes, front matter, or
 * export triggers must never request MathJax, Mermaid, or export chunks.
 * Encountering math or a diagram for the first time loads only that engine and
 * renders cleanly without errors.
 */

const MATH_URL_RE = /math-engine|mathjax/i;
const MERMAID_URL_RE = /diagram-engine|mermaid|dompurify/i;
const EXPORT_URL_RE =
  /\/src\/export\/|\/assets\/(?:html|pandoc|pdf|format-picker)-/i;
const EMOJI_URL_RE = /gemoji/i;

function trackRequests(page: import("@playwright/test").Page): string[] {
  const urls: string[] = [];
  page.on("request", (req) => {
    urls.push(req.url());
  });
  return urls;
}

test("#146 plain document never loads MathJax, Mermaid, gemoji, or export modules", async ({
  page,
}) => {
  const urls = trackRequests(page);
  await boot(page);

  const plainDoc = [
    "# 一般文件標題",
    "",
    "這是一段包含 **粗體**、*斜體*、`行內程式碼` 與 [連結](https://example.com) 的純文字段落。",
    "",
    "- 項目一",
    "- 項目二",
    "",
    "| 欄位 A | 欄位 B |",
    "| --- | --- |",
    "| 內容 1 | 內容 2 |",
    "",
    "> 引言段落",
  ].join("\n");

  await setDoc(page, plainDoc, 0);

  // Wait for explicit rendered live-preview state (table widget + heading).
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator("[data-testid='table-widget']")).toHaveCount(1);

  const engineState = await page.evaluate(async () => {
    const math = await import("/src/editor/math.ts" as string);
    const diagrams = await import("/src/editor/diagrams.ts" as string);
    return {
      mathLoaded: math.isMathEngineLoaded(),
      diagramLoaded: diagrams.isDiagramEngineLoaded(),
    };
  });

  expect(engineState.mathLoaded).toBe(false);
  expect(engineState.diagramLoaded).toBe(false);
  expect(urls.filter((u) => MATH_URL_RE.test(u))).toEqual([]);
  expect(urls.filter((u) => MERMAID_URL_RE.test(u))).toEqual([]);
  expect(urls.filter((u) => EXPORT_URL_RE.test(u))).toEqual([]);
  expect(urls.filter((u) => EMOJI_URL_RE.test(u))).toEqual([]);
});

test("#146 math loads MathJax on demand without loading Mermaid", async ({
  page,
}) => {
  const urls = trackRequests(page);
  await boot(page);

  // Start with plain text and confirm neither engine is loaded yet.
  await setDoc(page, "# 純文字\n\n還沒有公式。", 0);
  await expect(page.locator(".cm-content")).toContainText("還沒有公式");
  expect(urls.filter((u) => MATH_URL_RE.test(u))).toEqual([]);
  expect(urls.filter((u) => MERMAID_URL_RE.test(u))).toEqual([]);

  // Introduce inline + block math (cursor stays at 0, outside both formulas).
  const mathDoc = [
    "# 數學公式",
    "",
    "愛因斯坦質能方程 $E = mc^2$ 很有名。",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
    "$$",
  ].join("\n");
  await setDoc(page, mathDoc, 0);

  // Wait for both widgets to finish rendering SVGs with zero errors.
  const inlineMath = page.getByTestId("math-inline");
  const blockMath = page.getByTestId("math-block");
  await expect(inlineMath).toHaveAttribute("data-state", "rendered");
  await expect(inlineMath.locator("svg")).toHaveCount(1);
  await expect(blockMath).toHaveAttribute("data-state", "rendered");
  await expect(blockMath.locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("math-error")).toHaveCount(0);

  expect(urls.some((u) => MATH_URL_RE.test(u))).toBe(true);
  expect(urls.filter((u) => MERMAID_URL_RE.test(u))).toEqual([]);
});

test("#146 diagram loads Mermaid on demand without loading MathJax", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const urls = trackRequests(page);
  await boot(page);

  await setDoc(page, "# 純文字\n\n還沒有圖表。", 0);
  await expect(page.locator(".cm-content")).toContainText("還沒有圖表");
  expect(urls.filter((u) => MERMAID_URL_RE.test(u))).toEqual([]);
  expect(urls.filter((u) => MATH_URL_RE.test(u))).toEqual([]);

  const diagramDoc = [
    "# 流程圖",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[開始] --> B[結束]",
    "```",
  ].join("\n");
  await setDoc(page, diagramDoc, 0);

  const diagram = page.getByTestId("diagram");
  await expect(diagram).toHaveAttribute("data-state", "rendered", {
    timeout: 20_000,
  });
  await expect(diagram.locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("diagram-error")).toHaveCount(0);

  expect(urls.some((u) => MERMAID_URL_RE.test(u))).toBe(true);
  expect(urls.filter((u) => MATH_URL_RE.test(u))).toEqual([]);
});
