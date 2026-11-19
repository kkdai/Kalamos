import { expect, test } from "@playwright/test";
import { boot, setDoc } from "./helpers";

/** #15 WM-01 Ataraxia (F8) / WM-02 Stichos (F9). */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const opacityOf = (page: import("@playwright/test").Page, text: string) =>
  page
    .locator(".cm-content .cm-line", { hasText: text })
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity));

test("#15 AC: F8 dims every line except the current block", async ({ page }) => {
  const src = "第一段 current\n\n第二段 other\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n第三段";
  await setDoc(page, src, 3);
  await page.keyboard.press("F8");
  await expect(page.getByTestId("status")).toHaveText("Ataraxia 專注模式：開");
  await expect.poll(() => opacityOf(page, "第二段")).toBeLessThan(0.6);
  expect(await opacityOf(page, "第一段")).toBe(1);
  // Block widgets (the table) are dimmed too.
  const table = page.locator(".cm-content > :not(.cm-line)").filter({ has: page.locator("table") }).first();
  await expect.poll(() => table.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.6);

  // Moving the cursor moves the focus.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => opacityOf(page, "第二段")).toBe(1);
  await expect.poll(() => opacityOf(page, "第一段")).toBeLessThan(0.6);

  await page.keyboard.press("F8");
  await expect(page.getByTestId("status")).toHaveText("Ataraxia 專注模式：關");
  await expect.poll(() => opacityOf(page, "第一段")).toBe(1);
});

test("#15 AC: F9 keeps the line being typed vertically centred", async ({ page }) => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
  const src = lines.join("\n");
  const pos = src.indexOf("line 190");
  await setDoc(page, src, pos);
  await page.keyboard.press("F9");
  await expect(page.getByTestId("status")).toHaveText("Stichos 打字機模式：開");
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await page.keyboard.press("Enter");
  await page.keyboard.type("new line here");

  const offset = async () =>
    page.evaluate(async () => {
      const view = (await import("/src/main.ts" as string)).getActiveApp().editor.view;
      const scroller = view.scrollDOM.getBoundingClientRect();
      const coords = view.coordsAtPos(view.state.selection.main.head);
      if (!coords) return 1;
      const center = (coords.top + coords.bottom) / 2;
      return Math.abs(center - (scroller.top + scroller.height / 2)) / scroller.height;
    });
  await expect.poll(offset).toBeLessThan(0.15);

  // Arrow keys keep it centred too.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect.poll(offset).toBeLessThan(0.15);
});

test("#15 F8 / F9 settings persist and are restored on launch (mock)", async ({ page }) => {
  await setDoc(page, "text", 0);
  await page.keyboard.press("F8");
  await page.keyboard.press("F9");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const ipc = await import("/src/ipc.ts" as string);
        const s = await ipc.getSettings();
        return [s.focusMode, s.typewriterMode];
      }),
    )
    .toEqual([true, true]);

  // Simulated relaunch: modes off in the editor, init() restores them from settings.
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    app.editor.setFocusMode(false);
    app.editor.setTypewriterMode(false);
    await app.init();
  });
  await expect(page.locator(".cm-editor")).toHaveClass(/k-focus-mode/);
  await expect(page.locator(".cm-editor")).toHaveClass(/k-typewriter-mode/);
});
