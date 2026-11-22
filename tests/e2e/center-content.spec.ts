import { expect, type Page, test } from "@playwright/test";
import { boot, nextFrames, setDoc } from "./helpers";

/** #63 The paper column is centred in the editor area and never under the sidebar. */

const DOC = "第一行文字 first line of the document\n\n第二段 second paragraph";

/** Left / right whitespace of the first line inside the scroller's client box. */
async function gutters(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
    const line = document.querySelector<HTMLElement>(".cm-content .cm-line")!;
    const s = scroller.getBoundingClientRect();
    const l = line.getBoundingClientRect();
    const content = getComputedStyle(document.querySelector(".cm-content")!);
    return {
      left: l.left - s.left,
      right: s.left + scroller.clientWidth - l.right,
      lineLeft: l.left,
      paddingLeft: parseFloat(content.paddingLeft),
    };
  });
}

async function openSidebar(page: Page) {
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    if (!app.sidebar.isVisible()) await app.toggleSidebar();
  });
  // Wait out the slide-in / padding transition.
  await page.waitForTimeout(400);
  await nextFrames(page);
}

test("#63 AC: 1280px — first line is horizontally centred", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  await setDoc(page, DOC);
  const g = await gutters(page);
  expect(g.left).toBeGreaterThan(100);
  expect(Math.abs(g.left - g.right)).toBeLessThan(2);
  await page.screenshot({ path: "test-results/63-center-1280.png" });
});

test("#63 AC: open sidebar — text starts right of the sidebar and stays centred", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  await setDoc(page, DOC);
  await openSidebar(page);
  const sidebarRight = await page
    .getByTestId("sidebar")
    .evaluate((el) => el.getBoundingClientRect().right);
  const g = await gutters(page);
  expect(g.lineLeft).toBeGreaterThan(sidebarRight);
  // Centred within the remaining editor area (scroller starts after the sidebar).
  const scrollerLeft = await page
    .locator(".cm-scroller")
    .evaluate((el) => el.getBoundingClientRect().left);
  expect(scrollerLeft).toBeGreaterThanOrEqual(sidebarRight - 1);
  expect(Math.abs(g.left - g.right)).toBeLessThan(2);
  await page.screenshot({ path: "test-results/63-center-sidebar.png" });
});

test("#63 AC: 390px — left padding is at least 24px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await boot(page);
  await setDoc(page, DOC);
  const g = await gutters(page);
  expect(g.left).toBeGreaterThanOrEqual(24);
  expect(g.paddingLeft).toBeGreaterThanOrEqual(24);
  await page.screenshot({ path: "test-results/63-center-390.png" });
});

test("#63: theme can override the column width via --k-max-width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  await setDoc(page, DOC);
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--k-max-width", "500px"),
  );
  await nextFrames(page);
  const width = await page
    .locator(".cm-content")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(500);
  const g = await gutters(page);
  expect(Math.abs(g.left - g.right)).toBeLessThan(2);
});
