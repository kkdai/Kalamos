import { expect, type Page, test } from "@playwright/test";
import {
  boot,
  getDoc,
  getSelection,
  isCollapsed,
  line,
  MOD,
  nextFrames,
  selectRange,
  setCursor,
  setDoc,
  withIpc,
} from "./helpers";

/**
 * PLAN.md M1a acceptance criteria that can run in a plain browser
 * (ipc mock): AC 5–10, 12–14. AC numbers are in the test titles so
 * .herdr/qa/harness-plan.md and the report can map them 1:1.
 */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

// ---------------------------------------------------------------------------
// AC5 — live preview hides markers when the cursor leaves, shows them again
// ---------------------------------------------------------------------------

interface InlineCase {
  name: string;
  src: string;
  contentClass: string;
  contentText: string;
}

const INLINE_CASES: InlineCase[] = [
  {
    name: "bold",
    src: "**粗體**",
    contentClass: "k-strong",
    contentText: "粗體",
  },
  { name: "italic", src: "*斜體*", contentClass: "k-em", contentText: "斜體" },
  {
    name: "inline code",
    src: "`code`",
    contentClass: "k-code",
    contentText: "code",
  },
  {
    name: "strike",
    src: "~~刪除~~",
    contentClass: "k-strike",
    contentText: "刪除",
  },
  {
    name: "link",
    src: "[文字](https://example.com)",
    contentClass: "k-link",
    contentText: "文字",
  },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    name: `h${n}`,
    src: `${"#".repeat(n)} 標題${n}`,
    contentClass: `k-h${n}`,
    contentText: `標題${n}`,
  })),
];

async function hiddenMarksCollapsed(
  page: Page,
): Promise<{ count: number; allCollapsed: boolean }> {
  return page.evaluate(() => {
    const first = document.querySelector(".cm-content .cm-line");
    const marks = Array.from(first?.querySelectorAll(".k-mark-hidden") ?? []);
    return {
      count: marks.length,
      allCollapsed: marks.every((m) => m.getBoundingClientRect().width < 0.5),
    };
  });
}

for (const c of INLINE_CASES) {
  test(`AC5 ${c.name}: markers hidden when cursor leaves, shown when it returns`, async ({
    page,
  }) => {
    await setDoc(page, "");
    // Type it for real, then move the cursor to another line.
    await page.keyboard.type(c.src);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("x");
    await nextFrames(page);

    const first = line(page, 1);
    await expect(first.locator(`.${c.contentClass}`).first()).toContainText(
      c.contentText,
    );
    const hidden = await hiddenMarksCollapsed(page);
    expect(hidden.count).toBeGreaterThan(0);
    expect(hidden.allCollapsed).toBe(true);
    // Rendered width of the line must not include the markers: the visible
    // text equals the content text (markers collapse to zero width).
    await expect(first.locator(".k-mark")).toHaveCount(0);

    // Cursor back onto the markers → visible again. Offset 1 is inside the
    // marker for every case (`#`, `**`, `` ` ``, `~~`, `[`); since #49 a
    // heading's `#` shows only with the cursor on it, not in the title text.
    await setCursor(page, 1);
    await expect(first.locator(".k-mark-hidden")).toHaveCount(0);
    const visibleMarks = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(".cm-content .cm-line:first-child .k-mark"),
      ).map((m) => m.getBoundingClientRect().width),
    );
    expect(visibleMarks.length).toBeGreaterThan(0);
    expect(visibleMarks.every((w) => w > 0.5)).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// AC6 — decoration only: the document string never changes
// ---------------------------------------------------------------------------

test("AC6 live preview never mutates the document string", async ({ page }) => {
  const src = [
    "# 標題 Title",
    "",
    "**粗體** *斜體* `code` ~~刪除~~ [連結](https://example.com)",
    "",
    "- item",
    "- [ ] task",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "$$",
    "E=mc^2",
    "$$",
    "",
    "end",
  ].join("\n");
  await setDoc(page, "");
  await page.keyboard.insertText(src);
  await nextFrames(page);
  expect(await getDoc(page)).toBe(src);
  // Walk the cursor across every line (activates / deactivates decorations).
  for (let pos = 0; pos <= src.length; pos += 7) {
    await setCursor(page, pos);
  }
  await setCursor(page, src.length);
  expect(await getDoc(page)).toBe(src);
  const viewDoc = await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    return main.getActiveApp().editor.view.state.doc.toString();
  });
  expect(viewDoc).toBe(src);
});

// ---------------------------------------------------------------------------
// AC7 — Cmd+/ source mode: content and cursor preserved, rich widgets unloaded
// ---------------------------------------------------------------------------

test("AC7 Cmd+/ toggles source mode, keeps content and cursor, unloads widgets", async ({
  page,
}) => {
  const src = [
    "**粗體** 段落",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "$$",
    "x^2",
    "$$",
    "",
    "end",
  ].join("\n");
  await setDoc(page, src, src.length);
  await expect(page.getByTestId("table-widget")).toHaveCount(1);
  await expect(page.getByTestId("math-block")).toHaveCount(1);
  await setCursor(page, 4);
  const before = await getSelection(page);

  await page.keyboard.press(`${MOD}+/`);
  await nextFrames(page);
  expect(await page.evaluate(() => window.__kalamos!.isSourceMode())).toBe(
    true,
  );
  expect(await getDoc(page)).toBe(src);
  expect(await getSelection(page)).toEqual(before);
  await expect(page.locator(".cm-content .k-mark-hidden")).toHaveCount(0);
  await expect(page.locator(".cm-content .k-strong")).toHaveCount(0);
  await expect(page.getByTestId("table-widget")).toHaveCount(0);
  await expect(page.getByTestId("math-block")).toHaveCount(0);

  await page.keyboard.press(`${MOD}+/`);
  await nextFrames(page);
  expect(await page.evaluate(() => window.__kalamos!.isSourceMode())).toBe(
    false,
  );
  expect(await getDoc(page)).toBe(src);
  expect(await getSelection(page)).toEqual(before);
  await expect(page.getByTestId("table-widget")).toHaveCount(1);
  await expect(page.getByTestId("math-block")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// AC8 — Cmd+B / Cmd+I / Cmd+Shift+` / Cmd+K toggle on selection
// ---------------------------------------------------------------------------

const TOGGLES = [
  { key: `${MOD}+b`, wrapped: "**中文字串**", cls: "k-strong" },
  { key: `${MOD}+i`, wrapped: "*中文字串*", cls: "k-em" },
  { key: `${MOD}+Shift+Backquote`, wrapped: "`中文字串`", cls: "k-code" },
  { key: `${MOD}+k`, wrapped: "[中文字串]()", cls: "k-link" },
];

for (const t of TOGGLES) {
  test(`AC8 ${t.key} toggles ${t.cls} on a CJK selection`, async ({ page }) => {
    const src = "中文字串 tail\n\nend";
    await setDoc(page, src);
    await selectRange(page, 0, 4);
    await page.keyboard.press(t.key);
    await nextFrames(page);
    expect(await getDoc(page)).toBe(`${t.wrapped} tail\n\nend`);

    // Rendered once the cursor leaves the line.
    const docNow = await getDoc(page);
    await setCursor(page, docNow.length);
    await expect(line(page, 1).locator(`.${t.cls}`)).toContainText("中文字串");

    // Toggle back off: re-select the inner text and press again.
    const inner = docNow.indexOf("中文字串");
    await selectRange(page, inner, inner + 4);
    await page.keyboard.press(t.key);
    await nextFrames(page);
    expect(await getDoc(page)).toBe(src);
  });
}

// BUG-1 / #22: CJK-friendly flanking (src/editor/cjk-emphasis.ts) lets `**`
// sit between full-width punctuation and CJK letters.
test("AC8 bold around CJK punctuation renders (「你好」 followed by CJK) [BUG-1 #22]", async ({
  page,
}) => {
  const src = "他說「你好」再見\n\nend";
  await setDoc(page, src);
  await selectRange(page, 2, 6);
  await page.keyboard.press(`${MOD}+b`);
  expect(await getDoc(page)).toBe("他說**「你好」**再見\n\nend");
  await setCursor(page, (await getDoc(page)).length);
  await expect(line(page, 1).locator(".k-strong")).toContainText("「你好」");
});

test("#22 typing `中文**「粗體」**中文` / `中文**粗體。**中文` renders strong; text unchanged", async ({
  page,
}) => {
  await setDoc(page, "\n\nend", 0);
  await page.keyboard.type("中文**「粗體」**中文");
  await setCursor(page, (await getDoc(page)).length);
  const strong = line(page, 1).locator(".k-strong");
  await expect(strong).toHaveText("「粗體」");
  await expect(line(page, 1).locator(".k-mark-hidden")).toHaveCount(2);

  await setCursor(page, 0);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("中文**粗體。**中文");
  await setCursor(page, (await getDoc(page)).length);
  await expect(line(page, 2).locator(".k-strong")).toHaveText("粗體。");
  expect(await getDoc(page)).toBe(
    "中文**「粗體」**中文\n中文**粗體。**中文\n\nend",
  );
});

// ---------------------------------------------------------------------------
// AC9 — IME composition does not recompute decorations
// ---------------------------------------------------------------------------

async function isComposing(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    return Boolean(main.getActiveApp().editor.view.composing);
  });
}

test("AC9 decorations are frozen during IME composition (CDP imeSetComposition)", async ({
  page,
}) => {
  const src = "**粗體** 與 *斜體*\n\n";
  await setDoc(page, src, src.length);
  const cdp = await page.context().newCDPSession(page);

  // Watch the first (decorated) line for any DOM churn while composing.
  await page.evaluate(() => {
    const w = window as unknown as { __mut: number; __obs?: MutationObserver };
    w.__mut = 0;
    const target = document.querySelector(".cm-content .cm-line")!;
    w.__obs = new MutationObserver((list) => {
      w.__mut += list.length;
    });
    w.__obs.observe(target, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  const snapshot = () =>
    page.evaluate(
      () => document.querySelector(".cm-content .cm-line")!.innerHTML,
    );
  const before = await snapshot();

  for (const step of ["n", "ni", "nih", "niha", "nihao", "你好"]) {
    await cdp.send("Input.imeSetComposition", {
      text: step,
      selectionStart: step.length,
      selectionEnd: step.length,
    });
    await expect.poll(() => isComposing(page)).toBe(true);
    await expect.poll(() => getDoc(page)).toBe(`${src}${step}`);
    await nextFrames(page);
    expect(await isComposing(page)).toBe(true);
    expect(await snapshot()).toBe(before);
  }
  const mutations = await page.evaluate(
    () => (window as unknown as { __mut: number }).__mut,
  );
  expect(mutations).toBe(0);

  await cdp.send("Input.insertText", { text: "你好" });
  await expect.poll(() => getDoc(page)).toBe(`${src}你好`);
  await expect.poll(() => isComposing(page)).toBe(false);
  // After commit decorations are live again (markers still hidden on line 1).
  await expect
    .poll(() =>
      isCollapsed(page, ".cm-content .cm-line:first-child .k-mark-hidden"),
    )
    .toBe(true);
});

test("AC9 composing on a decorated line keeps its markers stable", async ({
  page,
}) => {
  // Cursor at the end of a heading line. Since #49 the `##` is hidden there
  // (shown only with the cursor on it); either way its marker decorations
  // must not change while composing.
  const src = "## 標題";
  await setDoc(page, src, src.length);
  const cdp = await page.context().newCDPSession(page);
  const markCount = () =>
    page.evaluate(
      () =>
        document.querySelectorAll(
          ".cm-content .cm-line:first-child .k-mark, .cm-content .cm-line:first-child .k-mark-hidden",
        ).length,
    );
  await expect.poll(markCount).toBeGreaterThan(0);
  const before = await markCount();
  for (const step of ["z", "zh", "zho", "中"]) {
    await cdp.send("Input.imeSetComposition", {
      text: step,
      selectionStart: step.length,
      selectionEnd: step.length,
    });
    await expect.poll(() => isComposing(page)).toBe(true);
    await expect.poll(() => getDoc(page)).toBe(`${src}${step}`);
    await nextFrames(page);
    expect(await isComposing(page)).toBe(true);
    expect(await markCount()).toBe(before);
  }
  await cdp.send("Input.insertText", { text: "中" });
  await expect.poll(() => getDoc(page)).toBe("## 標題中");
});

test("AC9 math live preview does not re-render during IME composition", async ({
  page,
}) => {
  // Cursor inside a $$ block shows source + live preview below (#8). Each
  // pinyin step must not re-typeset the preview while composing.
  const src = "$$\nx+\n$$\n\nend";
  await setDoc(page, src, 5);
  const preview = page.getByTestId("math-block-preview");
  await expect(preview).toHaveCount(1);
  // Wait for MathJax's initial render so the preview widget is fully settled
  // before starting IME composition.
  await expect(preview.locator("svg")).toHaveCount(1);
  const texBefore = await preview.getAttribute("data-tex");
  expect(texBefore).toBe("\nx+\n");
  const cdp = await page.context().newCDPSession(page);
  for (const step of ["y", "yi", "一"]) {
    await cdp.send("Input.imeSetComposition", {
      text: step,
      selectionStart: step.length,
      selectionEnd: step.length,
    });
    await expect.poll(() => isComposing(page)).toBe(true);
    await expect.poll(() => getDoc(page)).toBe(`$$\nx+${step}\n$$\n\nend`);
    await nextFrames(page);
    expect(await isComposing(page)).toBe(true);
    expect(await preview.getAttribute("data-tex")).toBe(texBefore);
  }
  await cdp.send("Input.insertText", { text: "一" });
  await expect.poll(() => getDoc(page)).toBe("$$\nx+一\n$$\n\nend");
  await expect(preview).toHaveAttribute("data-tex", "\nx+一\n");
});

// ---------------------------------------------------------------------------
// AC10 — sidebar: hidden by default, Cmd+Shift+L, three tabs, Cmd+Shift+O
// ---------------------------------------------------------------------------

test("AC10 sidebar hidden by default; Cmd+Shift+L toggles; three tabs", async ({
  page,
}) => {
  const sidebar = page.locator("#sidebar");
  await expect(sidebar).toHaveAttribute("data-visible", "false");
  await page.getByTestId("editor").click();
  await page.keyboard.press(`${MOD}+Shift+l`);
  await expect(sidebar).toHaveAttribute("data-visible", "true");
  await expect(page.getByTestId("sidebar-tab-tree")).toBeVisible();
  await expect(page.getByTestId("sidebar-tab-list")).toBeVisible();
  await expect(page.getByTestId("sidebar-tab-outline")).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+l`);
  await expect(sidebar).toHaveAttribute("data-visible", "false");
});

// BUG-2 (#32): opening a folder must reveal a hidden sidebar on the file tree.
test("AC10 Cmd+Shift+O with hidden sidebar reveals the opened folder [BUG-2]", async ({
  page,
}) => {
  await withIpc(
    page,
    "ipc.setMockDialogHandlers({ openFolder: () => '/demo' });",
  );
  // Start from the outline tab to check we switch back to the file tree.
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    await app.sidebar.setTab("outline");
  });
  await expect(page.locator("#sidebar")).toHaveAttribute(
    "data-visible",
    "false",
  );
  await page.getByTestId("editor").click();
  await page.keyboard.press(`${MOD}+Shift+o`);
  await expect(page.getByTestId("sidebar-folder-title")).toContainText("demo");
  await expect(page.locator("#sidebar")).toHaveAttribute(
    "data-visible",
    "true",
  );
  await expect(page.getByTestId("sidebar-tab-tree")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByTestId("file-item").filter({ hasText: "welcome.md" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      withIpc<boolean>(
        page,
        "return (await ipc.getSettings()).sidebarVisible;",
      ),
    )
    .toBe(true);
});

test("AC10 cancelling the Cmd+Shift+O dialog leaves a hidden sidebar hidden", async ({
  page,
}) => {
  await withIpc(page, "ipc.setMockDialogHandlers({ openFolder: () => null });");
  await page.getByTestId("editor").click();
  await page.keyboard.press(`${MOD}+Shift+o`);
  await page.waitForTimeout(200);
  await expect(page.locator("#sidebar")).toHaveAttribute(
    "data-visible",
    "false",
  );
});

test("AC10 Cmd+Shift+O opens a folder; clicking a file opens it", async ({
  page,
}) => {
  await withIpc(
    page,
    "ipc.setMockDialogHandlers({ openFolder: () => '/demo' });",
  );
  await page.getByTestId("editor").click();
  await page.keyboard.press(`${MOD}+Shift+o`);
  await expect(page.getByTestId("sidebar-folder-title")).toContainText("demo");
  await expect(page.locator("#sidebar")).toHaveAttribute(
    "data-visible",
    "true",
  );

  // File tree tab
  const welcome = page
    .getByTestId("file-item")
    .filter({ hasText: "welcome.md" });
  await expect(welcome).toHaveCount(1);
  await welcome.click();
  const expected = await withIpc<string>(
    page,
    "return ipc.readMockFile('/demo/welcome.md');",
  );
  await expect.poll(() => getDoc(page)).toBe(expected);

  // File list tab
  await page.getByTestId("sidebar-tab-list").click();
  const notes = page.getByTestId("file-item").filter({ hasText: "notes.md" });
  await expect(notes).toHaveCount(1);
  await notes.click();
  const notesContent = await withIpc<string>(
    page,
    "return ipc.readMockFile('/demo/notes.md');",
  );
  await expect.poll(() => getDoc(page)).toBe(notesContent);
});

// ---------------------------------------------------------------------------
// AC12 — outline: levels, click scrolls, current section highlighted
// ---------------------------------------------------------------------------

function longDoc(): { src: string; headingPos: number[] } {
  const parts: string[] = [];
  const headingPos: number[] = [];
  const levels = [1, 2, 3, 2, 3, 1];
  let offset = 0;
  levels.forEach((lvl, i) => {
    const h = `${"#".repeat(lvl)} Section ${i + 1}`;
    headingPos.push(offset);
    const body = Array.from(
      { length: 40 },
      (_, j) => `段落 ${i + 1}.${j + 1} 內文`,
    ).join("\n\n");
    const block = `${h}\n\n${body}\n\n`;
    parts.push(block);
    offset += block.length;
  });
  return { src: parts.join(""), headingPos };
}

test("AC12 outline lists heading levels, click scrolls, active section highlighted", async ({
  page,
}) => {
  const { src, headingPos } = longDoc();
  await setDoc(page, src, 0);
  await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    const app = main.getActiveApp();
    if (!app.sidebar.isVisible()) await app.toggleSidebar();
  });
  await page.getByTestId("sidebar-tab-outline").click();
  const items = page.getByTestId("outline-item");
  await expect(items).toHaveCount(6);
  expect(
    await items.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.level),
    ),
  ).toEqual(["1", "2", "3", "2", "3", "1"]);

  // Click the 5th heading → selection at heading, heading line visible.
  await items.nth(4).click();
  await nextFrames(page, 4);
  const sel = await getSelection(page);
  expect(sel.head).toBe(headingPos[4]);
  const headingLine = page.locator(".cm-line").filter({ hasText: "Section 5" });
  await expect(headingLine).toBeInViewport();
  await expect(items.nth(4)).toHaveAttribute("data-active", "true");

  // Move cursor into section 2 body → outline item 2 active.
  await setCursor(page, headingPos[1] + 30);
  await expect(items.nth(1)).toHaveAttribute("data-active", "true");
  await expect(items.nth(4)).toHaveAttribute("data-active", "false");
});

// ---------------------------------------------------------------------------
// AC13 — theme menu: built-ins + custom themes, applies immediately, persists
// ---------------------------------------------------------------------------

test("AC13 theme menu lists Papyros, Melan, Nyx and custom themes; selection applies and persists", async ({
  page,
}) => {
  await page.getByTestId("theme-menu-button").click();
  const menu = page.getByTestId("theme-menu");
  await expect(menu).toHaveAttribute("data-visible", "true");
  const ids = await page
    .getByTestId("theme-option")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.themeId));
  expect(ids).toEqual(
    expect.arrayContaining(["papyros", "melan", "nyx", "custom:night"]),
  );

  await page
    .locator('[data-testid="theme-option"][data-theme-id="melan"]')
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "melan");
  // body has a 180 ms background transition (PRD §12.5) → poll.
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    )
    .toBe("rgb(28, 26, 23)");
  await expect
    .poll(() =>
      withIpc<string>(page, "return (await ipc.getSettings()).theme;"),
    )
    .toBe("melan");

  // Select Nyx (#137)
  await page.getByTestId("theme-menu-button").click();
  await page
    .locator('[data-testid="theme-option"][data-theme-id="nyx"]')
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "nyx");
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    )
    .toBe("rgb(18, 17, 16)");
  await expect
    .poll(() =>
      withIpc<string>(page, "return (await ipc.getSettings()).theme;"),
    )
    .toBe("nyx");

  // A CSS file dropped into themes/ appears the next time the menu opens.
  await withIpc(
    page,
    "ipc.seedMockCustomTheme('forest', ':root[data-custom-theme] { --k-bg: #102010; --k-text: #e0f0e0; }');",
  );
  await page.getByTestId("theme-menu-button").click();
  const forest = page.locator(
    '[data-testid="theme-option"][data-theme-id="custom:forest"]',
  );
  await expect(forest).toHaveCount(1);
  await forest.click();
  await expect(page.locator("html")).toHaveAttribute("data-custom-theme", /.*/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--k-bg")
          .trim()
          .toLowerCase(),
      ),
    )
    .toBe("#102010");
  await expect
    .poll(() =>
      withIpc<string>(page, "return (await ipc.getSettings()).theme;"),
    )
    .toBe("custom:forest");
});

// ---------------------------------------------------------------------------
// AC14 — palette matches PRD §12.3 and text contrast ≥ 4.5:1
// (also AC1's "default follows system light/dark", browser side)
// ---------------------------------------------------------------------------

const PRD_PALETTE: Record<string, Record<string, string>> = {
  papyros: {
    "--k-bg": "#f5efe0",
    "--k-surface": "#ede4cf",
    "--k-text": "#2b2622",
    "--k-text-muted": "#6e6355",
    "--k-accent": "#5e7a4a",
    "--k-link": "#a4552f",
    "--k-divider": "#d9cdb3",
  },
  melan: {
    "--k-bg": "#1c1a17",
    "--k-surface": "#25221e",
    "--k-text": "#e8e0d0",
    "--k-text-muted": "#9c9384",
    "--k-accent": "#93ae7c",
    "--k-link": "#d98a63",
    "--k-divider": "#3a362f",
  },
  nyx: {
    "--k-bg": "#121110",
    "--k-surface": "#1a1917",
    "--k-text": "#e6e0d6",
    "--k-text-muted": "#9a9285",
    "--k-accent": "#93ae7c",
    "--k-link": "#de9068",
    "--k-divider": "#2b2926",
  },
};

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

async function readTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate((keys) => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      keys.map((k) => [k, cs.getPropertyValue(k).trim().toLowerCase()]),
    );
  }, Object.keys(PRD_PALETTE.papyros));
}

for (const theme of ["papyros", "melan", "nyx"]) {
  test(`AC14 ${theme} palette equals spec and text contrast ≥ 4.5:1`, async ({
    page,
  }) => {
    await page.evaluate(
      (t) => document.documentElement.setAttribute("data-theme", t),
      theme,
    );
    const tokens = await readTokens(page);
    expect(tokens).toEqual(PRD_PALETTE[theme]);
    for (const bgKey of ["--k-bg", "--k-surface"] as const) {
      expect(
        contrast(tokens["--k-text"], tokens[bgKey]),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens["--k-text-muted"], tokens[bgKey]),
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      contrast(tokens["--k-link"], tokens["--k-bg"]),
    ).toBeGreaterThanOrEqual(4.5);
    if (theme === "nyx") {
      expect(
        contrast(tokens["--k-link"], tokens["--k-surface"]),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("AC1 document title follows the active tab (#81; Tauri window title: manual)", async ({
  page,
}) => {
  await expect(page).toHaveTitle("未命名");
});

for (const scheme of ["light", "dark"] as const) {
  test(`AC1/AC14 default theme follows system ${scheme} scheme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() =>
      document.documentElement.removeAttribute("data-theme"),
    );
    const tokens = await readTokens(page);
    expect(tokens).toEqual(
      PRD_PALETTE[scheme === "light" ? "papyros" : "melan"],
    );
  });
}
