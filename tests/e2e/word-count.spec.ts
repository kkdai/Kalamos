import { expect, test } from "@playwright/test";
import { boot, selectRange, setCursor, setDoc } from "./helpers";

/** #14 NV-03 word count: status bar counter, selection stats, popover. */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const DOC = "# 標題 Title\n\n中文English混排，**粗體** and more words.\n\n- item one\n";

test("#14 counter shows the document word count in the status bar", async ({ page }) => {
  await setDoc(page, DOC, 0);
  const counter = page.getByTestId("word-count");
  // 標 題 Title | 中 文 English 混 排 粗 體 and more words | item one
  await expect(counter).toHaveText("15 字");
  await expect(page.locator("#statusbar")).toContainText("15 字");
});

test("#14 AC: selecting text shows statistics for the selection", async ({ page }) => {
  await setDoc(page, DOC, 0);
  const counter = page.getByTestId("word-count");
  await expect(counter).toHaveText("15 字");
  const from = DOC.indexOf("中文");
  await selectRange(page, from, from + "中文English".length);
  await expect(counter).toHaveText("選取 3 / 15 字");
  await setCursor(page, 0);
  await expect(counter).toHaveText("15 字");
});

test("#14 popover shows words, chars, chars without spaces, lines and reading time", async ({ page }) => {
  await setDoc(page, DOC, 0);
  const counter = page.getByTestId("word-count");
  await counter.click();
  const popover = page.getByTestId("word-count-popover");
  await expect(popover).toBeVisible();
  for (const label of ["字數", "字元", "字元（不含空白）", "行數", "閱讀時間"]) {
    await expect(popover.locator("dt", { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
  }
  await expect(popover.locator("dt", { hasText: /^字數$/ }).locator("+ dd")).toHaveText("15");
  await expect(popover.locator("dt", { hasText: /^行數$/ }).locator("+ dd")).toHaveText("5");
  await expect(popover.locator("dt", { hasText: /^閱讀時間$/ }).locator("+ dd")).toHaveText("約 1 分鐘");

  // With a selection the popover shows the selection's numbers.
  const from = DOC.indexOf("item");
  await selectRange(page, from, from + "item one".length);
  await expect(popover).toContainText("選取範圍");
  await expect(popover.locator("dt", { hasText: /^字數$/ }).locator("+ dd")).toHaveText("2");

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
});
