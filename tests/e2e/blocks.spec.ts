import { expect, test, type Page } from "@playwright/test";
import {
  MOD,
  boot,
  getDoc,
  getSelection,
  line,
  nextFrames,
  setCursor,
  setDoc,
} from "./helpers";

/**
 * M1b PRD acceptance criteria (issues #5 lists/links, #7 tables,
 * #8 code blocks + math). Issue number is in each describe title.
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

// ---------------------------------------------------------------------------
// #5 lists, task lists, links
// ---------------------------------------------------------------------------

test.describe("#5 lists / links", () => {
  test("#5 AC: clicking a task checkbox writes [x] back (and [ ] again)", async ({ page }) => {
    const src = "- [ ] 寫測試\n- [x] 已完成\n\nend";
    await setDoc(page, src, src.length);
    const boxes = page.locator(".cm-content input.k-task-checkbox");
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).not.toBeChecked();
    await expect(boxes.nth(1)).toBeChecked();

    await boxes.nth(0).click();
    await expect.poll(() => getDoc(page)).toBe("- [x] 寫測試\n- [x] 已完成\n\nend");
    await boxes.nth(1).click();
    await expect.poll(() => getDoc(page)).toBe("- [x] 寫測試\n- [ ] 已完成\n\nend");
  });

  test("#5 AC: Cmd+Click on a #heading link jumps to that heading", async ({ page }) => {
    const filler = Array.from({ length: 60 }, (_, i) => `填充段落 ${i + 1}`).join("\n\n");
    const src = `# 開頭\n\n[跳到結尾](#結尾-end)\n\n${filler}\n\n## 結尾 End\n\n最後一段`;
    await setDoc(page, src, src.length);
    await setCursor(page, 0);
    const link = line(page, 3).locator(".k-link");
    await expect(link).toHaveText("跳到結尾");
    await link.click({ modifiers: [MOD] });
    await nextFrames(page, 4);
    const target = src.indexOf("## 結尾 End");
    const sel = await getSelection(page);
    expect(sel.head).toBeGreaterThanOrEqual(target);
    expect(sel.head).toBeLessThanOrEqual(target + "## 結尾 End".length);
    await expect(page.locator(".cm-line").filter({ hasText: "結尾 End" })).toBeInViewport();
  });

  test("#5 spec: Enter continues a list; Enter on an empty item ends it", async ({ page }) => {
    await setDoc(page, "- 第一項", "- 第一項".length);
    await page.keyboard.press("Enter");
    await page.keyboard.type("第二項");
    expect(await getDoc(page)).toBe("- 第一項\n- 第二項");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const doc = await getDoc(page);
    expect(doc.startsWith("- 第一項\n- 第二項\n")).toBe(true);
    expect(doc).not.toMatch(/\n- $/);
  });

  test("#5 spec: Tab / Shift+Tab indent and outdent a list item", async ({ page }) => {
    await setDoc(page, "- a\n- b", "- a\n- b".length);
    await page.keyboard.press("Tab");
    expect(await getDoc(page)).toMatch(/^- a\n\s{2,4}- b$/);
    await page.keyboard.press("Shift+Tab");
    expect(await getDoc(page)).toBe("- a\n- b");
  });

  test("#5 spec: Cmd+Shift+[ / ] switch ordered / bullet list", async ({ page }) => {
    await setDoc(page, "- a\n- b", 1);
    await page.keyboard.press(`${MOD}+Shift+BracketLeft`);
    expect(await getDoc(page)).toMatch(/^1\. a\n/);
    await page.keyboard.press(`${MOD}+Shift+BracketRight`);
    expect(await getDoc(page)).toMatch(/^- a\n/);
  });
});

// ---------------------------------------------------------------------------
// #7 tables
// ---------------------------------------------------------------------------

const TABLE = [
  "| 名稱 | 數量 |",
  "| --- | --- |",
  "| 蘋果 | 1 |",
  "| 香蕉 | 2 |",
  "| 櫻桃 | 3 |",
].join("\n");

function bodyOrder(doc: string): string[] {
  return doc
    .split("\n")
    .filter((l) => /^\|\s*(蘋果|香蕉|櫻桃)/.test(l))
    .map((l) => l.split("|")[1].trim());
}

/** Every row of the table source has its `|` at the same columns. */
function isAligned(tableSrc: string): boolean {
  const rows = tableSrc.split("\n").filter((l) => l.trim().startsWith("|"));
  const pipeCols = (l: string) => {
    const cols: number[] = [];
    let w = 0;
    for (const ch of l) {
      if (ch === "|") cols.push(w);
      // East Asian wide chars count as 2 columns.
      w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
    }
    return cols.join(",");
  };
  return new Set(rows.map(pipeCols)).size === 1;
}

test.describe("#7 tables", () => {
  test("#7 spec: table renders as a widget when the cursor is outside", async ({ page }) => {
    const src = `${TABLE}\n\nend`;
    await setDoc(page, src, src.length);
    const table = page.getByTestId("table-widget");
    await expect(table).toHaveCount(1);
    await expect(table.locator("thead th")).toHaveCount(2);
    await expect(table.locator("tbody tr")).toHaveCount(3);
    await expect(table.locator("tbody tr").first()).toContainText("蘋果");
    expect(await getDoc(page)).toBe(src);
  });

  test("#7 AC: dragging a row reorders the source rows", async ({ page }) => {
    const src = `${TABLE}\n\nend`;
    await setDoc(page, src, src.length);
    const table = page.getByTestId("table-widget");
    const handle = table.locator(".k-table-row-handle").nth(0);
    const targetRow = table.locator("tbody tr").nth(2);
    await handle.dragTo(targetRow);
    await expect.poll(async () => bodyOrder(await getDoc(page))).toEqual(["香蕉", "櫻桃", "蘋果"]);
    // Rendered order follows.
    await expect(page.getByTestId("table-widget").locator("tbody tr").first()).toContainText("香蕉");
  });

  test("#7 spec: Cmd+Opt+T inserts a 3-column default table", async ({ page }) => {
    await setDoc(page, "", 0);
    await page.keyboard.press(`${MOD}+Alt+KeyT`);
    await nextFrames(page);
    const doc = await getDoc(page);
    const rows = doc.split("\n").filter((l) => l.startsWith("|"));
    expect(rows[0]).toMatch(/^\|\s*Header 1\s*\|\s*Header 2\s*\|\s*Header 3\s*\|$/);
    expect(rows.length).toBe(4); // header + delimiter + 2 body rows (3 rows × 3 cols)
    expect(isAligned(doc)).toBe(true);
    // The first header cell is selected so typing replaces it.
    await page.keyboard.type("名稱");
    expect((await getDoc(page)).split("\n")[0]).toMatch(/^\|\s*名稱\s*\|/);
  });

  test("#7 spec: typing `| a | b |` + delimiter row produces a table", async ({ page }) => {
    await setDoc(page, "", 0);
    await page.keyboard.type("| a | b |");
    await page.keyboard.press("Enter");
    await page.keyboard.type("| --- | --- |");
    // Enter inside a table adds a formatted body row with the cursor in cell 1.
    await page.keyboard.press("Enter");
    await page.keyboard.type("1");
    await page.keyboard.press("Tab");
    await page.keyboard.type("2");
    expect(await getDoc(page)).toMatch(/^\| a +\| b +\|\n\| -+ \| -+ \|\n\| 1 +\| 2 +\|$/);
    await page.evaluate(async () => {
      const main = await import("/src/main.ts" as string);
      const view = main.getActiveApp().editor.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\nend" } });
    });
    await setCursor(page, (await getDoc(page)).length);
    await expect(page.getByTestId("table-widget")).toHaveCount(1);
    await expect(page.getByTestId("table-widget").locator("tbody td").nth(1)).toContainText("2");
  });

  // BUG-5 (#32): extra cells typed into a row must never be dropped.
  test("#7 spec: typing a literal `| 1 | 2 |` body row keeps its text [BUG-5]", async ({ page }) => {
    await setDoc(page, "| a | b |\n| --- | --- |", "| a | b |\n| --- | --- |".length);
    await page.keyboard.press("Enter");
    await page.keyboard.type("| 1 | 2 |");
    await page.keyboard.press("Enter");
    const doc = await getDoc(page);
    expect(doc).toContain("1");
    expect(doc).toContain("2");
    expect(doc).toMatch(/\| 1 +\| 2 +\|/);
    // The table widened instead of losing a column; every row has the same width.
    const rows = doc.split("\n").filter((l) => l.startsWith("|"));
    expect(new Set(rows.map((r) => r.split("|").length)).size).toBe(1);
    expect(isAligned(doc)).toBe(true);
  });

  test("#7 spec: Tab with extra cells in a row widens the table instead of dropping them [BUG-5]", async ({ page }) => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |";
    await setDoc(page, src, 2);
    await page.keyboard.press("Tab");
    const rows = (await getDoc(page)).split("\n");
    expect(rows[0]).toMatch(/^\| a +\| b +\| +\|$/);
    expect(rows[1]).toMatch(/^\| -+ \| -+ \| -+ \|$/);
    expect(rows[2]).toMatch(/^\| 1 +\| 2 +\| 3 +\|$/);
  });

  test("#7 spec: Enter on an empty last row leaves the table into a new paragraph [BUG-5]", async ({ page }) => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    await setDoc(page, src, src.length);
    await page.keyboard.press("Enter"); // new empty row
    expect((await getDoc(page)).split("\n")).toHaveLength(4);
    await page.keyboard.press("Enter"); // empty last row → exit
    await page.keyboard.type("after");
    const doc = await getDoc(page);
    expect(doc).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nafter");
    await expect(page.getByTestId("table-widget")).toHaveCount(1);
    await expect(page.getByTestId("table-widget").locator("tbody tr")).toHaveCount(1);
  });

  test("#7 spec: exiting a table keeps the following paragraph separated [BUG-5]", async ({ page }) => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n|   |   |\n\nend";
    await setDoc(page, src, src.indexOf("|   |") + 2);
    await page.keyboard.press("Enter");
    await page.keyboard.type("mid");
    const doc = await getDoc(page);
    expect(doc).toMatch(/\| 1 +\| 2 +\|\n\nmid\n\nend$/);
  });

  test("#7 spec: Tab / Shift+Tab move between cells; Tab in last cell adds a row", async ({ page }) => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    await setDoc(page, src, 2); // inside "a"
    await page.keyboard.press("Tab");
    await page.keyboard.type("B");
    expect((await getDoc(page)).split("\n")[0]).toMatch(/^\|\s*a\s*\|\s*B\s*\|$/);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("A");
    expect((await getDoc(page)).split("\n")[0]).toMatch(/^\|\s*A\s*\|\s*B\s*\|$/);

    // Jump to last cell ("2") and Tab → new body row.
    const doc = await getDoc(page);
    await setCursor(page, doc.lastIndexOf("2") + 1);
    await page.keyboard.press("Tab");
    await page.keyboard.type("x");
    const rows = (await getDoc(page)).split("\n").filter((l) => l.startsWith("|"));
    expect(rows.length).toBe(4);
    expect(rows[3]).toMatch(/^\|\s*x\s*\|\s*\|$/);
  });

  test("#7 spec: clicking a cell enters edit; edits are written back to the source", async ({ page }) => {
    const src = `${TABLE}\n\nend`;
    await setDoc(page, src, src.length);
    await page.getByTestId("table-widget").locator('td[data-row="2"][data-col="0"]').click();
    await nextFrames(page);
    // Selection covers the cell text; typing replaces it.
    await page.keyboard.type("芭樂");
    const doc = await getDoc(page);
    expect(bodyOrder(doc.replace("芭樂", "香蕉"))).toEqual(["蘋果", "香蕉", "櫻桃"]);
    expect(doc).toContain("| 芭樂 |");
  });

  // BUG-6 (#32): leaving an edited table re-aligns its source.
  test("#7 spec: after editing a cell and leaving, source columns stay aligned [BUG-6]", async ({ page }) => {
    const aligned = [
      "| name   | qty |",
      "| ------ | --- |",
      "| apple  | 1   |",
      "| banana | 2   |",
    ].join("\n");
    expect(isAligned(aligned)).toBe(true);
    const src = `${aligned}\n\nend`;
    await setDoc(page, src, src.length);
    await page.getByTestId("table-widget").locator('td[data-row="1"][data-col="1"]').click();
    await page.keyboard.type("one hundred");
    await setCursor(page, (await getDoc(page)).length);
    const doc = await getDoc(page);
    expect(doc).toContain("one hundred");
    expect(isAligned(doc.slice(0, doc.indexOf("\n\nend")))).toBe(true);
  });

  test("#7 spec: the re-align on leave is a single undo step [BUG-6]", async ({ page }) => {
    const aligned = "| name  | qty |\n| ----- | --- |\n| apple | 1   |";
    const src = `${aligned}\n\nend`;
    await setDoc(page, src, src.length);
    await page.getByTestId("table-widget").locator('td[data-row="1"][data-col="1"]').click();
    await page.keyboard.type("12345");
    const edited = await getDoc(page);
    expect(isAligned(edited.slice(0, edited.indexOf("\n\nend")))).toBe(false);
    await setCursor(page, edited.length);
    const formatted = await getDoc(page);
    expect(isAligned(formatted.slice(0, formatted.indexOf("\n\nend")))).toBe(true);
    await page.keyboard.press(`${MOD}+z`);
    expect(await getDoc(page)).toBe(edited);
  });

  test("#7 spec: entering and leaving a table without editing never changes it [BUG-6]", async ({ page }) => {
    // Deliberately unaligned source: must survive a visit untouched.
    const src = "| a | bbbbbb |\n|---|---|\n| 1 | 2 |\n\nend";
    await setDoc(page, src, src.length);
    await page.getByTestId("table-widget").locator('td[data-row="1"][data-col="0"]').click();
    await setCursor(page, src.length);
    await nextFrames(page);
    expect(await getDoc(page)).toBe(src);
    expect(await page.evaluate(async () => {
      const app = (await import("/src/main.ts" as string)).getActiveApp();
      return app.editor.isDirty();
    })).toBe(false);
  });

  test("#7 spec: composing in a cell never reformats mid-composition; leaving afterwards re-aligns [BUG-6]", async ({ page }) => {
    const aligned = "| name  | qty |\n| ----- | --- |\n| apple | 1   |";
    const src = `${aligned}\n\nend`;
    await setDoc(page, src, src.length);
    await page.getByTestId("table-widget").locator('td[data-row="1"][data-col="1"]').click();
    const cdp = await page.context().newCDPSession(page);
    for (const step of ["y", "yi", "yib", "yiba"]) {
      await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
      await nextFrames(page);
      // Only the composed text changes; nothing re-pads the table.
      const doc = await getDoc(page);
      expect(doc.split("\n")[2]).toBe(`| apple | ${step}`.padEnd(0) + doc.split("\n")[2].slice(`| apple | ${step}`.length));
      expect(doc.split("\n").slice(0, 2).join("\n")).toBe("| name  | qty |\n| ----- | --- |");
    }
    await cdp.send("Input.insertText", { text: "一百" });
    await nextFrames(page, 4);
    expect((await getDoc(page)).split("\n")[2]).toMatch(/^\| apple \| 一百 *\|$/);
    await setCursor(page, (await getDoc(page)).length);
    const doc = await getDoc(page);
    const tableSrc = doc.slice(0, doc.indexOf("\n\nend"));
    expect(tableSrc).toContain("一百");
    expect(isAligned(tableSrc)).toBe(true);
  });

  test("#7 spec: source mode unloads the table widget", async ({ page }) => {
    const src = `${TABLE}\n\nend`;
    await setDoc(page, src, src.length);
    await expect(page.getByTestId("table-widget")).toHaveCount(1);
    await page.keyboard.press(`${MOD}+/`);
    await expect(page.getByTestId("table-widget")).toHaveCount(0);
    await page.keyboard.press(`${MOD}+/`);
    await expect(page.getByTestId("table-widget")).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// #8 code blocks + math
// ---------------------------------------------------------------------------

async function toggleLineNumbers(page: Page) {
  await page.keyboard.press(`${MOD}+Alt+KeyL`);
  await nextFrames(page);
}

test.describe("#8 code blocks", () => {
  test("#8 AC: highlighting appears as soon as a language is specified", async ({ page }) => {
    const src = "```\nconst a = 1; // note\n```\n\nend";
    await setDoc(page, src, src.length);
    await expect(page.locator(".cm-content .k-tok-keyword")).toHaveCount(0);
    // Add the info string by typing after the opening fence.
    await setCursor(page, 3);
    await page.keyboard.type("js");
    await setCursor(page, (await getDoc(page)).length);
    await expect(page.locator(".cm-content .k-tok-keyword").first()).toHaveText("const", { timeout: 10_000 });
    await expect(page.locator(".cm-content .k-tok-comment").first()).toContainText("// note");
    await expect(page.getByTestId("code-lang-badge")).toHaveAttribute("data-lang", "js");
  });

  test("#8 AC: line numbers toggle with Cmd+Opt+L", async ({ page }) => {
    const src = "```python\nx = 1\ny = 2\nz = 3\n```\n\nend";
    await setDoc(page, src, src.length);
    const numbered = page.locator(".cm-content .k-codeblock-line-numbered");
    await expect(numbered).toHaveCount(0);
    await toggleLineNumbers(page);
    await expect(numbered).toHaveCount(3);
    expect(
      await numbered.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lineNumber)),
    ).toEqual(["1", "2", "3"]);
    await toggleLineNumbers(page);
    await expect(numbered).toHaveCount(0);
    expect(await getDoc(page)).toBe(src);
  });

  test("#8 spec: fences are hidden when the cursor is outside, shown when inside", async ({ page }) => {
    const src = "```js\nlet a;\n```\n\nend";
    await setDoc(page, src, src.length);
    await expect(page.locator(".cm-content .k-code-fence-hidden")).toHaveCount(2);
    await setCursor(page, 8);
    await expect(page.locator(".cm-content .k-code-fence-hidden")).toHaveCount(0);
    await expect(page.locator(".cm-content .k-code-fence-mark")).toHaveCount(2);
  });
});

test.describe("#8 math", () => {
  test("#8 AC: block math renders live as SVG", async ({ page }) => {
    const src = "$$\nE=mc^2\n$$\n\nend";
    await setDoc(page, src, src.length);
    const block = page.getByTestId("math-block");
    await expect(block).toHaveCount(1);
    await expect(block.locator("svg").first()).toBeVisible();

    // Editing inside shows source + live preview that follows the edit.
    await setCursor(page, "$$\nE=mc^2".length);
    const preview = page.getByTestId("math-block-preview");
    await expect(preview).toHaveCount(1);
    await page.keyboard.type("+1");
    await expect(preview).toHaveAttribute("data-tex", /E=mc\^2\+1/);
    await expect(preview.locator("svg").first()).toBeVisible();
  });

  test("#8 AC: with auto-numbering on, block equations are numbered consecutively", async ({ page }) => {
    const src = "$$\na=1\n$$\n\n文字\n\n$$\nb=2\n$$\n\n$$\nc=3\n$$\n\nend";
    await setDoc(page, src, src.length);
    await expect(page.getByTestId("math-eq-number")).toHaveCount(0);
    await page.keyboard.press(`${MOD}+Alt+KeyN`);
    const nums = page.getByTestId("math-eq-number");
    await expect(nums).toHaveCount(3);
    expect(await nums.allTextContents()).toEqual(["(1)", "(2)", "(3)"]);
    await page.keyboard.press(`${MOD}+Alt+KeyN`);
    await expect(nums).toHaveCount(0);
  });

  test("#8 spec: inline $...$ renders as SVG; syntax errors show a red message", async ({ page }) => {
    const src = "質能 $E=mc^2$ 公式\n\n$$\n\\frac{1}{\n$$\n\nend";
    await setDoc(page, src, src.length);
    const inline = page.getByTestId("math-inline");
    await expect(inline).toHaveCount(1);
    await expect(inline.locator("svg").first()).toBeVisible();
    const err = page.getByTestId("math-error");
    await expect(err).toHaveCount(1);
    const color = await err.evaluate((e) => getComputedStyle(e).color);
    const [r, g, b] = color.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 40);
  });

  test("#8 spec: math works offline (no network requests while typesetting)", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname !== "localhost" && url.protocol.startsWith("http")) external.push(req.url());
    });
    const src = "$$\n\\ce{H2O} + \\bbox[red]{x} \\tag{A}\n$$\n\nend";
    await setDoc(page, src, src.length);
    await expect(page.getByTestId("math-block").locator("svg").first()).toBeVisible();
    await expect(page.getByTestId("math-error")).toHaveCount(0);
    expect(external).toEqual([]);
  });
});

test.describe("#11 diagrams", () => {
  test("#11 spec: a mermaid flowchart renders as SVG; editing shows source + live preview", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname !== "localhost" && url.protocol.startsWith("http")) external.push(req.url());
    });
    const src = "```mermaid\nflowchart TD\n  A[開始] --> B{判斷}\n  B -->|是| C[結束]\n```\n\nend";
    await setDoc(page, src, src.length);
    const diagram = page.getByTestId("diagram");
    await expect(diagram).toHaveCount(1);
    await expect(diagram).toHaveAttribute("data-state", "rendered", { timeout: 20_000 });
    const svg = diagram.locator("svg").first();
    await expect(svg).toBeVisible();
    await expect(svg).toContainText("判斷");
    expect(await diagram.locator("script, foreignObject").count()).toBe(0);
    await expect(page.getByTestId("diagram-error")).toHaveCount(0);

    // Cursor inside: source lines are visible, preview follows edits.
    await setCursor(page, src.indexOf("C[結束]") + "C[結束]".length);
    await expect(page.getByTestId("diagram")).toHaveCount(0);
    const preview = page.getByTestId("diagram-preview");
    await expect(preview).toHaveCount(1);
    await expect(page.locator(".cm-line").filter({ hasText: "flowchart TD" })).toHaveCount(1);
    await page.keyboard.type("\n  C --> D[新增節點]");
    await expect(preview.locator("svg").first()).toContainText("新增節點", { timeout: 10_000 });
    expect(external).toEqual([]);
  });

  test("#11 AC: a syntax error shows a red message with a line number, not a blank", async ({ page }) => {
    const src = "```mermaid\nflowchart TD\n  A --> B\n  B --> --> C\n```\n\nend";
    await setDoc(page, src, src.length);
    const err = page.getByTestId("diagram-error");
    await expect(err).toHaveCount(1, { timeout: 20_000 });
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute("data-line", /\d+/);
    await expect(err).toContainText("第");
    const color = await err.evaluate((e) => getComputedStyle(e).color);
    const [r, g, b] = color.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 40);
    // Mermaid's own error SVG ("Syntax error in text") never lands in the page.
    expect(await page.locator("body").innerText()).not.toMatch(/Syntax error in text/);
    expect(await page.locator("svg[aria-roledescription=error]").count()).toBe(0);
  });

  test("#11 spec: flow / sequence blocks are translated and rendered by Mermaid", async ({ page }) => {
    const src =
      "```flow\nst=>start: 開始\ne=>end: 結束\nst->e\n```\n\n" +
      "```sequence\nAlice->Bob: 你好\nBob-->Alice: 嗨\n```\n\nend";
    await setDoc(page, src, src.length);
    const diagrams = page.getByTestId("diagram");
    await expect(diagrams).toHaveCount(2);
    await expect(diagrams.nth(0)).toHaveAttribute("data-state", "rendered", { timeout: 20_000 });
    await expect(diagrams.nth(1)).toHaveAttribute("data-state", "rendered", { timeout: 20_000 });
    await expect(diagrams.nth(0).locator("svg").first()).toContainText("開始");
    await expect(diagrams.nth(1).locator("svg").first()).toContainText("你好");
  });

  test("#11 spec: sequence / gantt / class / state diagrams render with their labels", async ({ page }) => {
    const cases: Array<[string, string]> = [
      ["sequenceDiagram\n  Alice->>Bob: 問候", "問候"],
      ["gantt\n  dateFormat YYYY-MM-DD\n  section 階段\n  任務甲 :a1, 2026-01-01, 3d", "任務甲"],
      ["classDiagram\n  class 動物 {\n    +吃()\n  }", "動物"],
      ["stateDiagram-v2\n  [*] --> 待命\n  待命 --> [*]", "待命"],
    ];
    const src = cases.map(([code]) => "```mermaid\n" + code + "\n```").join("\n\n") + "\n\nend";
    await setDoc(page, src, src.length);
    const diagrams = page.getByTestId("diagram");
    await expect(diagrams).toHaveCount(cases.length);
    for (let i = 0; i < cases.length; i++) {
      await expect(diagrams.nth(i)).toHaveAttribute("data-state", "rendered", { timeout: 20_000 });
      await expect(diagrams.nth(i).locator("svg").first()).toContainText(cases[i][1]);
    }
  });
  test("#11 spec: switching Papyros -> Melan re-renders diagrams with the new palette", async ({ page }) => {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "papyros"));
    const src = "```mermaid\nflowchart TD\n  A[甲] --> B[乙]\n```\n\nend";
    await setDoc(page, src, src.length);
    const diagram = page.getByTestId("diagram");
    await expect(diagram).toHaveAttribute("data-state", "rendered", { timeout: 20_000 });
    const light = await diagram.locator("svg").first().innerHTML();
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "melan"));
    await expect
      .poll(async () => diagram.locator("svg").first().innerHTML(), { timeout: 10_000 })
      .not.toBe(light);
    const textFill = await diagram
      .locator("svg .nodeLabel, svg text")
      .first()
      .evaluate((e) => getComputedStyle(e).fill);
    const [r, g, b] = textFill.match(/\d+/g)!.map(Number);
    // Melan text is light on a dark background.
    expect((r + g + b) / 3).toBeGreaterThan(128);
  });
});

// ---------------------------------------------------------------------------
// #12 ED-06 other blocks + ED-07 [TOC]
// ---------------------------------------------------------------------------

test.describe("#12 blocks / TOC", () => {
  test("#12 AC: hovering a footnote reference shows its content", async ({ page }) => {
    const src = "Kalamos 註腳[^1] 範例。\n\n[^1]: 這是註腳內容 **粗體**。";
    await setDoc(page, src, src.length);
    const ref = page.locator(".cm-content .k-footnote-ref");
    await expect(ref).toHaveText("1");
    await ref.hover();
    const tip = page.getByTestId("footnote-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("這是註腳內容 **粗體**。");
    // Clicking jumps to the definition.
    await ref.click();
    await expect.poll(async () => (await getSelection(page)).head).toBe(src.indexOf("這是"));
  });

  test("#12 spec: an undefined footnote reference stays literal", async ({ page }) => {
    const src = "Missing[^nope] ref\n\nend";
    await setDoc(page, src, src.length);
    await expect(page.locator(".cm-content .k-footnote-ref")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("Missing[^nope] ref");
  });

  test("#12 AC: TOC updates immediately after typing a new heading; clicking scrolls to it", async ({ page }) => {
    const filler = Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}`).join("\n\n");
    const src = `[TOC]\n\n# 第一章\n\n${filler}\n\n## 結尾\n`;
    await setDoc(page, src, src.length);
    const links = page.locator(".cm-content .k-toc a");
    await expect(links).toHaveText(["第一章", "結尾"]);

    await page.keyboard.press(`${MOD}+End`);
    await page.keyboard.type("\n## 新增標題");
    // The TOC is at the top: scroll back (without moving the cursor) so
    // CodeMirror renders it.
    await expect(async () => {
      await page.evaluate(async () => {
        const main = await import("/src/main.ts" as string);
        const view = main.getActiveApp().editor.view;
        // EditorView.scrollIntoView via the instance's class (no bare imports here).
        view.dispatch({ effects: view.constructor.scrollIntoView(0, { y: "start" }) });
      });
      await expect(links).toHaveText(["第一章", "結尾", "新增標題"], { timeout: 500 });
    }).toPass({ timeout: 5000 });

    await links.nth(1).click();
    await expect.poll(async () => {
      const head = (await getSelection(page)).head;
      return (await getDoc(page)).slice(head, head + 2);
    }).toBe("結尾");
    await expect(page.locator(".cm-content .cm-line", { hasText: "結尾" }).first()).toBeInViewport();
  });

  test("#12 spec: horizontal rule renders as a line; source shows on its line", async ({ page }) => {
    const src = "above\n\n***\n\nbelow";
    await setDoc(page, src, src.length);
    await expect(page.locator(".cm-content .k-hr")).toHaveCount(1);
    await setCursor(page, 8);
    await expect(page.locator(".cm-content .k-hr")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("***");
  });

  test("#12 spec: front matter renders as a muted box, not a rule or heading", async ({ page }) => {
    const src = "---\ntitle: 部落格文章\ntags: [a]\n---\n\n# 正文\n";
    await setDoc(page, src, src.length);
    await expect(page.locator(".cm-content .k-frontmatter-line")).toHaveCount(4);
    await expect(page.locator(".cm-content .k-hr")).toHaveCount(0);
    await expect(page.locator(".cm-content .k-h2")).toHaveCount(0);
    await expect(page.locator(".cm-content .k-frontmatter-line").nth(1)).toHaveText("title: 部落格文章");
  });

  test("#12 spec: blockquote markers hide and nested quotes get deeper borders", async ({ page }) => {
    const src = "> 外層\n> > 內層\n\nend";
    await setDoc(page, src, src.length);
    await expect(page.locator(".cm-content .k-quote-depth-1")).toHaveCount(1);
    await expect(page.locator(".cm-content .k-quote-depth-2")).toHaveCount(1);
    await expect(page.locator(".cm-content .k-quote-line .k-mark-hidden")).toHaveCount(3);
  });
});
