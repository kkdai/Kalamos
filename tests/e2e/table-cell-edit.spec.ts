import { expect, test, type Page } from "@playwright/test";
import { MOD, boot, getDoc, getSelection, nextFrames, setCursor, setDoc } from "./helpers";

/**
 * #59 A: tables are an editable grid in live preview — every cell is edited
 * in place (real keyboard), the markdown behind it stays correct.
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const cell = (page: Page, row: number, col: number) =>
  page.getByTestId("table-widget").locator(`[data-row="${row}"][data-col="${col}"] .k-table-cell-content`);

async function activeCell(page: Page): Promise<{ row: number; col: number } | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el?.classList.contains("k-table-cell-content")) return null;
    const td = el.closest<HTMLElement>("th, td")!;
    return { row: Number(td.dataset.row), col: Number(td.dataset.col) };
  });
}

function rows(doc: string): string[][] {
  return doc
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim()));
}

test("#59 insert 3×3 → type cells with Tab → source mode shows the correct markdown", async ({ page }) => {
  await setDoc(page, "", 0);
  await page.keyboard.press(`${MOD}+Alt+KeyT`);
  await nextFrames(page);
  await expect(page.getByTestId("table-widget")).toHaveCount(1);
  expect(await activeCell(page)).toEqual({ row: 0, col: 0 });
  for (const [i, text] of ["名稱", "數量", "備註", "蘋果", "12", "a|b", "香蕉"].entries()) {
    if (i > 0) await page.keyboard.press("Tab");
    await page.keyboard.type(text);
  }
  // Still a grid the whole time.
  await expect(page.getByTestId("table-widget")).toHaveCount(1);
  expect(await activeCell(page)).toEqual({ row: 2, col: 0 });
  await page.keyboard.press(`${MOD}+/`); // source mode
  await nextFrames(page);
  await expect(page.getByTestId("table-widget")).toHaveCount(0);
  const doc = await getDoc(page);
  const r = rows(doc);
  expect(r).toHaveLength(4);
  expect(r[0]).toEqual(["名稱", "數量", "備註"]);
  expect(r[1].every((d) => /^:-+$/.test(d))).toBe(true); // default table is left-aligned
  expect(r[2]).toEqual(["蘋果", "12", "a\\|b"]);
  expect(r[3]).toEqual(["香蕉", "", ""]);
  await page.keyboard.press(`${MOD}+/`);
  await expect(page.getByTestId("table-widget")).toHaveCount(1);
  await expect(cell(page, 1, 2)).toHaveText("a|b");
});

test("#59 typing in a cell keeps the grid, the same cell DOM, and focus", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await cell(page, 1, 1).click();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-row="1"][data-col="1"]')!.dataset.marker = "same";
  });
  await page.keyboard.press("End");
  await page.keyboard.type("345 六七");
  expect((await getDoc(page)).split("\n")[2]).toBe("| 1 | 2345 六七 |");
  await expect(page.locator('[data-marker="same"]')).toHaveCount(1);
  expect(await activeCell(page)).toEqual({ row: 1, col: 1 });
});

test("#59 a dispatch from elsewhere mid-typing never steals focus from the cell", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await cell(page, 1, 0).click();
  await page.keyboard.press("End");
  await page.keyboard.type("x");
  await page.evaluate(async () => {
    const view = (await import("/src/main.ts" as string)).getActiveApp().editor.view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    view.dispatch({ selection: view.state.selection });
  });
  await nextFrames(page);
  await page.keyboard.type("y");
  expect(await activeCell(page)).toEqual({ row: 1, col: 0 });
  const doc = await getDoc(page);
  expect(doc.split("\n")[2]).toBe("| 1xy | 2 |");
  expect(doc.endsWith("end!")).toBe(true);
});

test("#59 IME composition in a cell: nothing written mid-composition, no RangeError, undo works", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const src = "| 名稱 | 數量 |\n| --- | --- |\n| 蘋果 | 十二 |\n\n結尾[^1]\n\n[^1]: 註腳";
  await setDoc(page, src, src.length);
  await cell(page, 1, 1).click();
  await page.keyboard.press(`${MOD}+a`);
  const cdp = await page.context().newCDPSession(page);
  for (const step of ["ㄧ", "ㄧˋ", "一", "一ㄅ", "一百"]) {
    await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
    await nextFrames(page);
    expect(await getDoc(page)).toBe(src);
    expect(await activeCell(page)).toEqual({ row: 1, col: 1 });
  }
  await cdp.send("Input.insertText", { text: "一百" });
  await nextFrames(page, 3);
  expect((await getDoc(page)).split("\n")[2]).toBe("| 蘋果 | 一百 |");
  // Leave and come back; no stale positions anywhere.
  await setCursor(page, (await getDoc(page)).length);
  await cell(page, 1, 0).click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press(`${MOD}+z`);
  expect((await getDoc(page)).split("\n")[2]).toMatch(/^\| 蘋果 +\| 一百 +\|$/);
  expect(errors.filter((m) => /RangeError/.test(m))).toEqual([]);
});

test("#59 Cmd+Z / Cmd+Shift+Z inside a cell", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await cell(page, 1, 1).click();
  await page.keyboard.press("End");
  await page.keyboard.type("345");
  expect((await getDoc(page)).split("\n")[2]).toBe("| 1 | 2345 |");
  await page.keyboard.press(`${MOD}+z`);
  expect(await getDoc(page)).toBe(src); // one grouped step, not one char, not the whole table
  await expect(cell(page, 1, 1)).toHaveText("2");
  await page.keyboard.press(`${MOD}+Shift+z`);
  expect((await getDoc(page)).split("\n")[2]).toBe("| 1 | 2345 |");
  await expect(cell(page, 1, 1)).toHaveText("2345");
  expect(await activeCell(page)).toEqual({ row: 1, col: 1 });
});

test("#59 keyboard: Enter, arrows, Shift+Enter, Cmd+Enter", async ({ page }) => {
  const src = "intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await cell(page, 0, 0).click();
  await page.keyboard.press("Enter"); // down the column
  expect(await activeCell(page)).toEqual({ row: 1, col: 0 });
  await page.keyboard.press("ArrowRight"); // caret at end → next cell
  expect(await activeCell(page)).toEqual({ row: 1, col: 1 });
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft"); // caret at start → previous cell
  expect(await activeCell(page)).toEqual({ row: 1, col: 0 });
  await page.keyboard.press("ArrowUp");
  expect(await activeCell(page)).toEqual({ row: 0, col: 0 });
  await page.keyboard.press("ArrowUp"); // header → line above the table
  expect(await activeCell(page)).toBeNull();
  const sel = await getSelection(page);
  expect(sel.head).toBe(src.indexOf("\n\n") + 1);

  await cell(page, 1, 1).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("x");
  expect((await getDoc(page)).split("\n")[4]).toBe("| 1 | 2<br>x |");
  await expect(cell(page, 1, 1)).toHaveText("2\nx");

  await page.keyboard.press("Enter"); // last row → new row, same column
  expect(await activeCell(page)).toEqual({ row: 2, col: 1 });
  await page.keyboard.press("Enter"); // empty last row → leave the table
  expect(await activeCell(page)).toBeNull();
  await page.keyboard.type("after");
  expect(await getDoc(page)).toMatch(/\| 1 +\| 2<br>x +\|\n\nafter\n\nend$/);

  await cell(page, 1, 0).click();
  await page.keyboard.press(`${MOD}+Enter`); // jump out to a new paragraph
  await page.keyboard.type("P");
  expect(await getDoc(page)).toMatch(/\| 1 +\| 2<br>x +\|\n\nP\n\nafter\n\nend$/);
});

test("#59 paste is plain text; Cmd+B / Cmd+I wrap the selection", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await cell(page, 1, 0).click();
  await page.keyboard.press(`${MOD}+a`);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "p|q\nr");
    data.setData("text/html", "<b>bold</b>");
    document.activeElement!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  expect((await getDoc(page)).split("\n")[2]).toBe("| p\\|q<br>r | 2 |");

  await cell(page, 1, 1).click();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+b`);
  expect((await getDoc(page)).split("\n")[2]).toBe("| p\\|q<br>r | **2** |");
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+i`);
  expect((await getDoc(page)).split("\n")[2]).toBe("| p\\|q<br>r | ***2*** |");
  // Rendered once the cell loses focus.
  await setCursor(page, (await getDoc(page)).length);
  await expect(cell(page, 1, 1).locator(".k-strong")).toHaveCount(1);
});

test("#59 replacing the document while a cell is focused is safe", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  await cell(page, 1, 0).click();
  await page.keyboard.type("z");
  await setDoc(page, "# other\n\n| x |\n| --- |\n| 9 |", 0);
  await page.keyboard.type("T");
  expect(await getDoc(page)).toBe("T# other\n\n| x |\n| --- |\n| 9 |");
  expect(errors).toEqual([]);
});

test("#59 a selection inside a table (e.g. a search hit) marks the cell and does not steal focus", async ({ page }) => {
  const src = "| a | b |\n| --- | --- |\n| 1 | needle |\n\nend";
  await setDoc(page, src, src.length);
  await page.evaluate(async () => {
    const view = (await import("/src/main.ts" as string)).getActiveApp().editor.view;
    view.contentDOM.blur();
    const at = view.state.doc.toString().indexOf("needle");
    view.dispatch({ selection: { anchor: at, head: at + 6 }, scrollIntoView: true });
  });
  await nextFrames(page);
  await expect(page.locator(".k-table-cell-active")).toHaveCount(1);
  await expect(page.locator(".k-table-cell-active")).toContainText("needle");
  expect(await activeCell(page)).toBeNull();
});

test("#59 row drag handles float in the first column's padding: body text lines up with the header", async ({ page }) => {
  const src = "| 名稱 | 數量 |\n| --- | --- |\n| 蘋果 | 1 |\n| 香蕉 | 2 |\n\nend";
  await setDoc(page, src, src.length);
  const headerLeft = (await cell(page, 0, 0).boundingBox())!.x;
  for (const row of [1, 2]) {
    expect(Math.abs((await cell(page, row, 0).boundingBox())!.x - headerLeft)).toBeLessThan(1);
  }
  // Hidden until the row is hovered, then visible left of the table.
  const handle = page.getByTestId("table-widget").locator(".k-table-row-handle").first();
  await expect(handle).toHaveCSS("opacity", "0");
  await page.getByTestId("table-widget").locator("tbody tr").first().hover();
  await expect(handle).toHaveCSS("opacity", "1");
  // Inside the first cell's left padding: left of the text, never over it.
  const tdLeft = (await page.getByTestId("table-widget").locator("tbody td").first().boundingBox())!.x;
  const box = (await handle.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(tdLeft);
  expect(box.x + box.width).toBeLessThanOrEqual(headerLeft + 1);
});
