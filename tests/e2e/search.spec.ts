import { expect, test, type Page } from "@playwright/test";
import { MOD, boot, getDoc, getSelection, nextFrames, setDoc } from "./helpers";

/** #73 A: find & replace in the current document. */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const filler = Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}。`).join("\n\n");

const DOC = [
  "第一段 apple 與 Apple。",
  "",
  "**粗體 apple** 與 [連結](https://example.com/apple)",
  "",
  filler,
  "",
  "| 名稱 | 數量 |",
  "| --- | --- |",
  "| apple | 1 |",
  "",
  "```js",
  "const apple = 1;",
  "```",
  "",
  "end",
].join("\n");

const count = (page: Page) => page.getByTestId("search-count");
const findInput = (page: Page) => page.getByTestId("search-input");

async function selectedText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    const { state } = main.getActiveApp().editor.view;
    const sel = state.selection.main;
    return state.sliceDoc(sel.from, sel.to);
  });
}

async function inViewport(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const scroller = document.querySelector(".cm-scroller");
    if (!el || !scroller) return false;
    const r = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom;
  }, selector);
}

test("#73 Cmd+F → type → Enter / Shift+Enter / Cmd+G walk the hits; Esc returns to the editor", async ({ page }) => {
  await setDoc(page, DOC, 0);
  await page.keyboard.press(`${MOD}+KeyF`);
  await expect(page.getByTestId("search-panel")).toBeVisible();
  await expect(findInput(page)).toBeFocused();
  await page.keyboard.type("apple");
  // paragraph ×2, bold, link URL, table, code.
  await expect(count(page)).toHaveText("1 / 6");
  await expect(page.locator(".cm-searchMatch")).not.toHaveCount(0);
  await expect(page.locator(".cm-searchMatch-selected")).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 / 6");
  await page.keyboard.press("Shift+Enter");
  await expect(count(page)).toHaveText("1 / 6");
  await page.keyboard.press("Shift+Enter");
  await expect(count(page)).toHaveText("6 / 6");
  await page.keyboard.press(`${MOD}+KeyG`);
  await expect(count(page)).toHaveText("1 / 6");
  await page.keyboard.press(`${MOD}+Shift+KeyG`);
  await expect(count(page)).toHaveText("6 / 6");
  // The code block hit (far below the fold) was scrolled into view.
  await expect.poll(() => inViewport(page, ".cm-searchMatch-selected")).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-panel")).toHaveCount(0);
  const focused = await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    return main.getActiveApp().editor.view.hasFocus;
  });
  expect(focused).toBe(true);
  expect(await selectedText(page)).toBe("apple");
});

test("#73 a hit in a hidden link URL is revealed; a table hit is marked inside the widget", async ({ page }) => {
  await setDoc(page, DOC, 0);
  // The URL is hidden by live preview until the cursor goes there.
  await expect(page.locator(".k-mark-hidden", { hasText: "example.com" })).not.toHaveCount(0);
  await page.keyboard.press(`${MOD}+KeyF`);
  await page.keyboard.type("example.com/apple");
  await expect(count(page)).toHaveText("1 / 1");
  await expect(page.locator(".k-mark-hidden", { hasText: "example.com" })).toHaveCount(0);
  await expect(page.locator(".cm-searchMatch-selected")).toHaveText("example.com/apple");
  await expect(page.locator(".cm-searchMatch-selected")).toBeVisible();

  await findInput(page).fill("apple");
  for (let i = 0; i < 6; i++) {
    const text = await count(page).textContent();
    if (text?.startsWith("5 /")) break;
    await page.keyboard.press("Enter");
  }
  await expect(count(page)).toHaveText("5 / 6");
  const td = page.getByTestId("table-widget").locator('[data-row="1"][data-col="0"]');
  await expect(td).toHaveClass(/k-search-cell-current/);
  await expect.poll(() => inViewport(page, ".k-search-cell-current")).toBe(true);
  const highlighted = await page.evaluate(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
    const cur = reg?.get("k-search-current");
    return cur ? [...cur].map((r) => r.toString()) : null;
  });
  expect(highlighted).toEqual(["apple"]);

  // Cmd+G from the editor focuses the cell with the hit selected.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-panel")).toHaveCount(0);
  const active = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      cell: el?.classList.contains("k-table-cell-content") ?? false,
      selected: document.getSelection()?.toString(),
    };
  });
  expect(active).toEqual({ cell: true, selected: "apple" });
});

test("#73 Cmd+Opt+F: replace one, replace all, one Cmd+Z undoes replace all", async ({ page }) => {
  await setDoc(page, DOC, 0);
  await page.keyboard.press(`${MOD}+Alt+KeyF`);
  await expect(page.getByTestId("replace-input")).toBeVisible();
  await findInput(page).click();
  await page.keyboard.type("apple");
  await page.getByTestId("replace-input").click();
  await page.keyboard.type("pear");
  await page.keyboard.press("Enter"); // replace the current hit
  expect((await getDoc(page)).startsWith("第一段 pear 與 Apple。")).toBe(true);
  const afterOne = await getDoc(page);

  await page.getByTestId("replace-all").click();
  const replaced = await getDoc(page);
  expect(replaced).not.toMatch(/apple/i);
  expect(replaced).toContain("| pear | 1 |");
  await expect(count(page)).toHaveText("無結果");

  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+KeyZ`);
  await nextFrames(page);
  expect(await getDoc(page)).toBe(afterOne);
});

test("#73 regex with $1 groups; an invalid regex shows a hint instead of throwing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setDoc(page, "foo-1 foo-22 bar-3", 0);
  await page.keyboard.press(`${MOD}+Alt+KeyF`);
  await page.getByTestId("search-regex").click();
  await findInput(page).click();
  await page.keyboard.type("foo-(\\d+");
  await expect(count(page)).toHaveText("正規表示式無效");
  await expect(page.locator('.k-search-field[data-invalid="true"]')).toHaveCount(1);
  await page.keyboard.type(")");
  await expect(count(page)).toHaveText(/\/ 2$/);
  await page.getByTestId("replace-input").fill("n$1");
  await page.getByTestId("replace-all").click();
  expect(await getDoc(page)).toBe("n1 n22 bar-3");
  expect(errors).toEqual([]);
});

test("#73 selection seeds the query; whole word and case options", async ({ page }) => {
  await setDoc(page, "cat Cat concat cat", 0);
  await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    main.getActiveApp().editor.view.dispatch({ selection: { anchor: 4, head: 7 } });
  });
  await page.keyboard.press(`${MOD}+KeyF`);
  await expect(findInput(page)).toHaveValue("Cat");
  await expect(count(page)).toHaveText(/\/ 4$/);
  await page.getByTestId("search-case").click();
  await expect(count(page)).toHaveText("1 / 1");
  await page.getByTestId("search-case").click();
  await page.getByTestId("search-word").click();
  await expect(count(page)).toHaveText(/\/ 3$/);
});

test("#73 IME: no search while composing, search after compositionend", async ({ page }) => {
  await setDoc(page, "中文搜尋與搜尋結果", 0);
  await page.keyboard.press(`${MOD}+KeyF`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "搜", selectionStart: 1, selectionEnd: 1 });
  await nextFrames(page);
  // The counter stays empty: no query has been set while composing.
  await expect(count(page)).toHaveText("");
  await cdp.send("Input.insertText", { text: "搜尋" });
  await expect(count(page)).toHaveText("1 / 2");
  expect(await getSelection(page)).toEqual({ anchor: 2, head: 4 });
});

test("#73 works in source mode", async ({ page }) => {
  await setDoc(page, DOC, 0);
  await page.keyboard.press(`${MOD}+/`);
  await nextFrames(page);
  await page.keyboard.press(`${MOD}+KeyF`);
  await page.keyboard.type("apple");
  await expect(count(page)).toHaveText("1 / 6");
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 / 6");
});

test("#73 typewriter mode: the hit is scrolled into view (centred)", async ({ page }) => {
  await setDoc(page, DOC, 0);
  await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    main.getActiveApp().editor.setTypewriterMode(true);
  });
  await expect(page.locator(".cm-editor")).toHaveClass(/k-typewriter-mode/);
  await page.keyboard.press(`${MOD}+KeyF`);
  await page.keyboard.type("const apple");
  await expect(count(page)).toHaveText("1 / 1");
  await expect.poll(() => inViewport(page, ".cm-searchMatch-selected")).toBe(true);
});
