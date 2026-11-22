import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, MOD, withIpc } from "./helpers";

/** #73 B: Cmd+Shift+F — search the Markdown files of the open folder. */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const filler = Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}。`).join(
  "\n\n",
);

async function seedFolder(page: Page): Promise<void> {
  await withIpc(
    page,
    `ipc.seedMockDir('/kb');
     ipc.seedMockFile('/kb/alpha.md', arg.alpha);
     ipc.seedMockFile('/kb/notes/beta.md', arg.beta);
     ipc.seedMockFile('/kb/.trash/gamma.md', 'needle hidden');
     ipc.seedMockFile('/kb/readme.txt', 'needle txt');`,
    {
      alpha: `# Alpha\n\n第一個 needle 在這裡。\n\n${filler}\n\n最後的 **needle** 在底部。\n`,
      beta: "| 名稱 | 數量 |\n| --- | --- |\n| needle | 1 |\n",
    },
  );
}

async function openKb(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    await app.openFolder("/kb");
  });
}

const input = (page: Page) => page.getByTestId("folder-search-input");
const status = (page: Page) => page.getByTestId("folder-search-status");

test("#73 B Cmd+Shift+F without a folder asks to open one", async ({
  page,
}) => {
  await page.keyboard.press(`${MOD}+Shift+KeyF`);
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-visible",
    "true",
  );
  await expect(page.getByTestId("sidebar-tab-search")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(input(page)).toBeFocused();
  await expect(status(page)).toContainText("請先開啟資料夾");
});

test("#73 B type → grouped results → click opens the file at the hit", async ({
  page,
}) => {
  await seedFolder(page);
  await openKb(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Shift+KeyF`);
  await expect(input(page)).toBeFocused();
  await page.keyboard.type("needle");
  // Debounced; hidden folders and non-Markdown files are skipped.
  await expect(status(page)).toHaveText("3 筆結果，2 個檔案");
  const groups = page.getByTestId("folder-search-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).getByTestId("folder-search-file")).toContainText(
    "alpha.md",
  );
  await expect(groups.nth(1).getByTestId("folder-search-file")).toContainText(
    "beta.md",
  );
  await expect(groups.nth(1).getByTestId("folder-search-file")).toContainText(
    "notes",
  );
  await expect(groups.nth(0).locator("mark").first()).toHaveText("needle");

  // Collapse / expand.
  await groups.nth(0).getByTestId("folder-search-file").click();
  await expect(groups.nth(0)).toHaveAttribute("data-collapsed", "true");
  await expect(
    groups.nth(0).getByTestId("folder-search-hit").first(),
  ).toBeHidden();
  await groups.nth(0).getByTestId("folder-search-file").click();
  await expect(groups.nth(0)).toHaveAttribute("data-collapsed", "false");

  // The last hit of alpha.md is far below the fold.
  await groups.nth(0).getByTestId("folder-search-hit").nth(1).click();
  await expect
    .poll(async () => (await getDoc(page)).startsWith("# Alpha"))
    .toBe(true);
  const sel = await page.evaluate(async () => {
    const view = (await import("/src/main.ts" as string)).getActiveApp().editor
      .view;
    const s = view.state.selection.main;
    return {
      text: view.state.sliceDoc(s.from, s.to),
      line: view.state.doc.lineAt(s.from).text,
      focus: view.hasFocus,
    };
  });
  expect(sel).toEqual({
    text: "needle",
    line: "最後的 **needle** 在底部。",
    focus: true,
  });
  const visible = await page.evaluate(() => {
    const scroller = document
      .querySelector(".cm-scroller")!
      .getBoundingClientRect();
    const s = window.getSelection();
    const rect =
      s && s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
    return rect
      ? rect.top >= scroller.top && rect.bottom <= scroller.bottom
      : false;
  });
  expect(visible).toBe(true);

  // A hit in a table cell focuses that cell with the text selected.
  await groups.nth(1).getByTestId("folder-search-hit").click();
  await expect
    .poll(async () => (await getDoc(page)).includes("| needle |"))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        cell:
          (document.activeElement as HTMLElement | null)?.classList.contains(
            "k-table-cell-content",
          ) ?? false,
        text: window.getSelection()?.toString(),
      })),
    )
    .toEqual({ cell: true, text: "needle" });
});

test("#73 B options and invalid regex", async ({ page }) => {
  await withIpc(
    page,
    "ipc.seedMockDir('/re'); ipc.seedMockFile('/re/a.md', 'Cat cat concat foo-12');",
  );
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    await app.openFolder("/re");
  });
  await page.keyboard.press(`${MOD}+Shift+KeyF`);
  await page.keyboard.type("cat");
  await expect(status(page)).toHaveText("3 筆結果，1 個檔案");
  await page.getByTestId("folder-search-case").click();
  await expect(status(page)).toHaveText("2 筆結果，1 個檔案");
  await page.getByTestId("folder-search-word").click();
  await expect(status(page)).toHaveText("1 筆結果，1 個檔案");
  await page.getByTestId("folder-search-regex").click();
  await input(page).fill("foo-(\\d+");
  await expect(status(page)).toHaveText("正規表示式無效");
  await input(page).fill("foo-(\\d+)");
  await expect(status(page)).toHaveText("1 筆結果，1 個檔案");
  await expect(page.locator(".k-folder-search-snippet mark")).toHaveText(
    "foo-12",
  );
});

test("#73 B IME: no search while composing", async ({ page }) => {
  await withIpc(
    page,
    "ipc.seedMockDir('/ime'); ipc.seedMockFile('/ime/a.md', '中文搜尋');",
  );
  await page.evaluate(async () => {
    const app = (await import("/src/main.ts" as string)).getActiveApp();
    await app.openFolder("/ime");
  });
  await page.keyboard.press(`${MOD}+Shift+KeyF`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "搜",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await page.waitForTimeout(400);
  await expect(status(page)).toHaveText("");
  await expect(page.getByTestId("folder-search-group")).toHaveCount(0);
  await cdp.send("Input.insertText", { text: "搜尋" });
  await expect(status(page)).toHaveText("1 筆結果，1 個檔案");
});
