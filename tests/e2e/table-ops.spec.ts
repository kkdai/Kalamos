import { expect, test, type Page } from "@playwright/test";
import { MOD, boot, getDoc, nextFrames, setCursor, setDoc } from "./helpers";

/** #59 B: insert dialog, `|a|b|` + Enter, structure operations (toolbar, menu, keys). */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

/** Cell texts of the first table in the document, header first. */
function tableCells(doc: string): string[][] {
  return doc
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .filter((l) => !/^\|(\s*:?-+:?\s*\|)+$/.test(l.trim()))
    .map((l) =>
      l
        .trim()
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
}

/** Every row of the table source has its `|` at the same columns (CJK = 2). */
function isAligned(doc: string): boolean {
  const rows = doc.split("\n").filter((l) => l.trim().startsWith("|"));
  const cols = (l: string) => {
    const out: number[] = [];
    let w = 0;
    for (const ch of l) {
      if (ch === "|") out.push(w);
      w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
    }
    return out.join(",");
  };
  return rows.length > 0 && new Set(rows.map(cols)).size === 1;
}

async function openDialog(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Alt+KeyT`);
  await expect(page.getByTestId("table-insert-dialog")).toBeVisible();
}

/** Row / column of the focused contenteditable cell, or null. */
async function focusedCell(page: Page): Promise<{ row: number; col: number } | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el?.classList.contains("k-table-cell-content") || !el.isContentEditable) return null;
    const td = el.closest<HTMLElement>("[data-row][data-col]");
    return td ? { row: Number(td.dataset.row), col: Number(td.dataset.col) } : null;
  });
}

async function toSource(page: Page): Promise<string> {
  await page.keyboard.press(`${MOD}+Slash`);
  await expect.poll(() => isSourceMode(page)).toBe(true);
  return getDoc(page);
}

async function isSourceMode(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    return app.editor.isSourceMode();
  });
}

test("#59 AC: insert 3×3 → type cells → Tab → add row / delete column → source mode shows correct markdown", async ({
  page,
}) => {
  await setDoc(page, "", 0);
  await openDialog(page);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("table-insert-dialog")).toHaveCount(0);

  for (const [i, text] of ["名稱", "數量", "備註", "蘋果", "3", "紅色"].entries()) {
    if (i > 0) await page.keyboard.press("Tab");
    await page.keyboard.type(text);
  }
  const toolbar = page.getByTestId("table-toolbar");
  await expect(toolbar).toBeVisible();
  // Cursor is in "紅色" (row 1, col 2): delete that column, then add a row below.
  await toolbar.locator('[data-action="deleteCol"]').click();
  await toolbar.locator('[data-action="rowBelow"]').click();
  await page.keyboard.type("5");

  await page.keyboard.press(`${MOD}+Slash`);
  await expect.poll(() => isSourceMode(page)).toBe(true);
  const doc = await getDoc(page);
  expect(tableCells(doc)).toEqual([
    ["名稱", "數量"],
    ["蘋果", "3"],
    ["", "5"],
    ["", ""],
  ]);
  expect(doc.split("\n")[1]).toMatch(/^\| :-+ \| :-+ \|$/); // left-aligned like #7
  // (Typing "5" re-aligns only when the cursor leaves the table: #59 A / BUG-6.)
  // The toolbar is a live-preview feature.
  await expect(toolbar).toHaveCount(0);
});

test("#59: the toolbar floats above the table and hides when the cursor leaves", async ({ page }) => {
  const src = "intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.indexOf("1"));
  const toolbar = page.getByTestId("table-toolbar");
  await expect(toolbar).toBeVisible();
  const tb = (await toolbar.boundingBox())!;
  const table = (await page.getByTestId("table-widget").boundingBox())!;
  expect(tb.y + tb.height).toBeLessThanOrEqual(table.y + 1);
  // Not inside the table widget's DOM.
  expect(await toolbar.evaluate((el) => el.closest(".k-table-wrapper") === null)).toBe(true);
  await setCursor(page, 0);
  await expect(toolbar).toBeHidden();
});

test("#59: the dialog picker picks the size; Escape cancels", async ({ page }) => {
  await setDoc(page, "", 0);
  await openDialog(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("table-insert-dialog")).toHaveCount(0);
  expect(await getDoc(page)).toBe("");

  await openDialog(page);
  const cell = page.locator('.k-table-picker-cell[data-rows="2"][data-cols="4"]');
  await cell.hover();
  await expect(page.locator(".k-table-picker-label")).toHaveText("2 列 × 4 欄");
  await cell.click();
  const cells = tableCells(await getDoc(page));
  expect(cells).toHaveLength(2);
  expect(cells[0]).toHaveLength(4);
  // Focus is back in the editor, in the first header cell.
  await page.keyboard.type("x");
  expect((await getDoc(page)).startsWith("| x")).toBe(true);
});

test("#59: fields set rows (header included) × columns", async ({ page }) => {
  await setDoc(page, "段落", 2);
  await openDialog(page);
  await page.getByTestId("table-dialog-rows").fill("4");
  await page.getByTestId("table-dialog-cols").fill("2");
  await page.getByTestId("table-dialog-ok").click();
  const doc = await getDoc(page);
  expect(doc.startsWith("段落\n\n|")).toBe(true);
  expect(tableCells(doc)).toEqual([["", ""], ["", ""], ["", ""], ["", ""]]);
});

test("#59: `| 名稱 | 數量 |` + Enter becomes a table; typing fills the body row", async ({ page }) => {
  await setDoc(page, "", 0);
  await page.keyboard.type("| 名稱 | 數量 |");
  await page.keyboard.press("Enter");
  await page.keyboard.type("蘋果");
  await page.keyboard.press("Tab");
  await page.keyboard.type("3");
  const doc = await getDoc(page);
  expect(tableCells(doc)).toEqual([["名稱", "數量"], ["蘋果", "3"]]);
  expect(doc.split("\n")[1]).toMatch(/^\| -+ \| -+ \|$/);
});

test("#59: right-click on a rendered cell opens the table menu", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await page.getByTestId("table-widget").locator('td[data-row="1"][data-col="1"]').click({ button: "right" });
  const menu = page.getByTestId("table-context-menu");
  await expect(menu).toBeVisible();
  // The table stays rendered (right-click doesn't move the cursor into it).
  await expect(page.getByTestId("table-widget")).toHaveCount(1);
  // The header row can't be deleted, body rows can.
  await expect(menu.locator('[data-action="deleteRow"]')).toBeEnabled();
  await menu.locator('[data-action="colLeft"]').click();
  await expect(menu).toHaveCount(0);
  expect(tableCells(await getDoc(page))).toEqual([["a", "", "b"], ["1", "", "2"]]);

  // On the header the delete-row item is disabled; Escape closes the menu.
  await setCursor(page, (await getDoc(page)).length);
  await page.getByTestId("table-widget").locator('th[data-row="0"][data-col="0"]').click({ button: "right" });
  await expect(menu.locator('[data-action="deleteRow"]')).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("#59: keyboard shortcuts insert / delete rows and columns and align", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  await setDoc(page, src, src.indexOf("1"));
  await page.keyboard.press(`${MOD}+Alt+ArrowDown`);
  expect(tableCells(await getDoc(page))).toHaveLength(3);
  await page.keyboard.type("x");
  expect(tableCells(await getDoc(page))[2]).toEqual(["x", ""]);
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`);
  expect(tableCells(await getDoc(page))[0]).toEqual(["a", "", "b"]);
  await page.keyboard.press(`${MOD}+Alt+Shift+ArrowUp`);
  expect((await getDoc(page)).split("\n")[1]).toMatch(/^\| -+ \| :-+: \| -+ \|$/);
  await page.keyboard.press(`${MOD}+Alt+Backspace`);
  expect(tableCells(await getDoc(page))[0]).toEqual(["a", "b"]);
  await page.keyboard.press(`${MOD}+Shift+Backspace`);
  expect(tableCells(await getDoc(page))).toEqual([["a", "b"], ["1", "2"]]);
  expect(isAligned(await getDoc(page))).toBe(true);
});

test("#59: IME composition in a freshly inserted table never throws", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setDoc(page, "", 0);
  await openDialog(page);
  await page.keyboard.press("Enter");
  const cdp = await page.context().newCDPSession(page);
  for (const step of ["ㄇ", "ㄇㄧ", "ㄇㄧㄥ"]) {
    await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
    await nextFrames(page);
  }
  await cdp.send("Input.insertText", { text: "名" });
  await page.keyboard.press("Tab");
  await cdp.send("Input.imeSetComposition", { text: "ㄕ", selectionStart: 1, selectionEnd: 1 });
  await nextFrames(page);
  await cdp.send("Input.insertText", { text: "數" });
  await page.keyboard.press(`${MOD}+Alt+ArrowDown`);
  await nextFrames(page, 4);
  const cells = tableCells(await getDoc(page));
  expect(cells[0].slice(0, 2)).toEqual(["名", "數"]);
  expect(cells).toHaveLength(4);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// With #59 A: operations from inside a focused (contenteditable) cell
// ---------------------------------------------------------------------------

test("#59 AC: dialog → type in cells → toolbar +列 → type straight into the new row → markdown", async ({ page }) => {
  await setDoc(page, "", 0);
  await openDialog(page);
  await page.keyboard.press("Enter");
  // Focus is in the first header cell's contenteditable.
  await expect.poll(() => focusedCell(page)).toEqual({ row: 0, col: 0 });
  for (const [i, text] of ["名稱", "數量", "備註", "蘋果"].entries()) {
    if (i > 0) await page.keyboard.press("Tab");
    await page.keyboard.type(text);
  }
  await expect.poll(() => focusedCell(page)).toEqual({ row: 1, col: 0 });
  await page.getByTestId("table-toolbar").locator('[data-action="rowBelow"]').click();
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 0 });
  await page.keyboard.type("香蕉");
  await page.getByTestId("table-toolbar").locator('[data-action="colRight"]').click();
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 1 });
  await page.keyboard.type("12");

  const doc = await toSource(page);
  expect(tableCells(doc)).toEqual([
    ["名稱", "", "數量", "備註"],
    ["蘋果", "", "", ""],
    ["香蕉", "12", "", ""],
    ["", "", "", ""],
  ]);
});

test("#59: shortcuts work in a focused cell and keep focus in the target cell", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await page.getByTestId("table-widget").locator('td[data-row="1"][data-col="0"] .k-table-cell-content').click();
  await expect.poll(() => focusedCell(page)).toEqual({ row: 1, col: 0 });

  await page.keyboard.press(`${MOD}+Alt+ArrowDown`);
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 0 });
  await page.keyboard.type("x");
  await page.keyboard.press(`${MOD}+Alt+ArrowUp`);
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 0 });
  await page.keyboard.type("y");
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`);
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 1 });
  await page.keyboard.type("z");
  await page.keyboard.press(`${MOD}+Alt+Shift+ArrowUp`); // center
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 1 });
  await page.keyboard.press(`${MOD}+Alt+ArrowLeft`);
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 1 });
  await page.keyboard.press(`${MOD}+Alt+Backspace`); // delete that new column
  await page.keyboard.press(`${MOD}+Shift+Backspace`); // delete row 2 ("y", "z")
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 1 });
  await page.keyboard.type("w");

  const doc = await toSource(page);
  expect(tableCells(doc)).toEqual([
    ["a", "", "b"],
    ["1", "", "2"],
    ["x", "w", ""],
  ]);
  expect(doc.split("\n")[1]).toMatch(/^\| -+ \| :-+: \| -+ \|$/);
});

test("#59: the context menu acts on the right-clicked cell while another cell is being edited", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  const widget = page.getByTestId("table-widget");
  await widget.locator('th[data-row="0"][data-col="1"] .k-table-cell-content').click();
  await expect.poll(() => focusedCell(page)).toEqual({ row: 0, col: 1 });
  await widget.locator('td[data-row="1"][data-col="0"]').click({ button: "right" });
  const menu = page.getByTestId("table-context-menu");
  await menu.locator('[data-action="rowBelow"]').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => focusedCell(page)).toEqual({ row: 2, col: 0 });
  await page.keyboard.type("新");
  // Right-clicking a cell focuses it; Escape closes the menu and keeps that focus.
  await widget.locator('th[data-row="0"][data-col="0"]').click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect.poll(() => focusedCell(page)).toEqual({ row: 0, col: 0 });

  const doc = await toSource(page);
  expect(tableCells(doc)).toEqual([["a", "b"], ["1", "2"], ["新", ""]]);
});

// ---------------------------------------------------------------------------
// Review: the toolbar never covers text
// ---------------------------------------------------------------------------

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Client rects of the text of the line containing `needle`. */
async function textRects(page: Page, needle: string): Promise<Box[]> {
  return page.evaluate((n) => {
    const lineEl = [...document.querySelectorAll<HTMLElement>(".cm-line")].find((l) =>
      l.textContent?.includes(n),
    );
    if (!lineEl) return [];
    const range = document.createRange();
    range.selectNodeContents(lineEl);
    return [...range.getClientRects()].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  }, needle);
}

test("#59 review: with a long paragraph right above, the toolbar overlaps neither its text nor the focused cell", async ({
  page,
}) => {
  const para = `長段落開頭${"這是一段很長的文字，會換行好幾次，用來確認工具列不會蓋住表格上方的內容。".repeat(6)}段落結尾`;
  const src = `${para}\n\n| 名稱 | 數量 |\n| --- | --- |\n| 蘋果 | 3 |\n\nend`;
  await setDoc(page, src, src.length);
  const cellEl = page.getByTestId("table-widget").locator('th[data-row="0"][data-col="0"]');
  await cellEl.locator(".k-table-cell-content").click();
  await expect.poll(() => focusedCell(page)).toEqual({ row: 0, col: 0 });
  const toolbar = page.getByTestId("table-toolbar");
  await expect(toolbar).toBeVisible();
  await nextFrames(page, 3);

  const tb = (await toolbar.boundingBox())!;
  const rects = await textRects(page, "長段落開頭");
  expect(rects.length).toBeGreaterThan(1); // it wraps
  for (const r of rects) expect(overlaps(tb, r)).toBe(false);
  expect(overlaps(tb, (await cellEl.boundingBox())!)).toBe(false);
  // Every cell of the table is clear of it too.
  const table = (await page.getByTestId("table-widget").boundingBox())!;
  expect(overlaps(tb, table)).toBe(false);

  // Moving to a body cell (same table) keeps it in place.
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedCell(page)).toEqual({ row: 1, col: 0 });
  const tb2 = (await toolbar.boundingBox())!;
  expect(Math.abs(tb2.y - tb.y)).toBeLessThan(1);
});

test("#59 review: the reserved space doesn't make the clicked cell jump", async ({ page }) => {
  const filler = Array.from({ length: 40 }, (_, i) => `段落 ${i + 1}`).join("\n\n");
  const after = Array.from({ length: 40 }, (_, i) => `後文第${i + 1}段`).join("\n\n");
  const src = `${filler}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n${after}`;
  // Cursor on a line right after the table (outside it): the table is on screen.
  await setDoc(page, src, src.indexOf("後文第2段"));
  await page.evaluate(async () => {
    const view = (await import("/src/main.ts" as string)).getActiveApp().editor.view;
    view.dispatch({ selection: view.state.selection, scrollIntoView: true });
  });
  const cellEl = page.getByTestId("table-widget").locator('td[data-row="1"][data-col="1"]');
  await nextFrames(page, 3);
  const before = (await cellEl.boundingBox())!;
  // Mark the widget DOM: reserving the space must not rebuild the table.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".k-table-wrapper")!.dataset.marker = "kept";
  });
  const content = cellEl.locator(".k-table-cell-content");
  const cbox = (await content.boundingBox())!;
  // Click just inside the right end of the text so the caret lands after "2".
  await content.click({ position: { x: Math.max(1, cbox.width - 1), y: cbox.height / 2 } });
  await expect(page.getByTestId("table-toolbar")).toBeVisible();
  await nextFrames(page, 3);
  const afterBox = (await cellEl.boundingBox())!;
  expect(Math.abs(afterBox.y - before.y)).toBeLessThanOrEqual(1);
  expect(await page.locator('.k-table-wrapper[data-marker="kept"]').count()).toBe(1);
  // Typing goes into the clicked cell.
  await page.keyboard.type("x");
  await expect(cellEl).toContainText("2x");

  // Leaving the table downwards keeps the text below still.
  const endLine = page.locator(".cm-line", { hasText: /^後文第3段$/ });
  await endLine.scrollIntoViewIfNeeded();
  await nextFrames(page, 2);
  const lineBefore = (await endLine.boundingBox())!;
  await endLine.click();
  await expect(page.getByTestId("table-toolbar")).toBeHidden();
  await nextFrames(page, 3);
  const lineAfter = (await endLine.boundingBox())!;
  expect(Math.abs(lineAfter.y - lineBefore.y)).toBeLessThanOrEqual(1);
});
