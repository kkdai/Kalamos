import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, MOD, nextFrames } from "./helpers";

/** #81 A: document tabs — tab bar, switching, undo isolation, scroll restore, unsaved prompt. */

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const tabs = (page: Page) => page.getByTestId("tab");
const tabbar = (page: Page) => page.getByTestId("tabbar");

async function app<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const main = await import("/src/main.ts" as string);
      const ipc = await import("/src/ipc.ts" as string);
      const a = main.getActiveApp();
      return new Function(
        "app",
        "ipc",
        "arg",
        `return (async () => { ${fn} })();`,
      )(a, ipc, arg);
    },
    { fn, arg },
  );
}

async function focusEditor(page: Page): Promise<void> {
  await page.locator(".cm-content").click();
}

test("#81 one tab: no tab bar; Cmd+T shows it, Cmd+W hides it again", async ({
  page,
}) => {
  await expect(tabbar(page)).toBeHidden();
  await focusEditor(page);
  await page.keyboard.press(`${MOD}+t`);
  await expect(tabbar(page)).toBeVisible();
  await expect(tabs(page)).toHaveText(["未命名", "未命名 2"]);
  await expect(tabs(page).nth(1)).toHaveAttribute("data-active", "true");
  await expect(page).toHaveTitle("未命名 2");

  await page.getByTestId("tab-new").click();
  await expect(tabs(page)).toHaveCount(3);

  await page.keyboard.press(`${MOD}+w`);
  await page.keyboard.press(`${MOD}+w`);
  await expect(tabbar(page)).toBeHidden();
  expect(await app<number>(page, "return app.getTabs().length;")).toBe(1);
});

test("#81 Ctrl+Tab / Ctrl+Shift+Tab cycle; clicking a tab switches", async ({
  page,
}) => {
  await focusEditor(page);
  await page.keyboard.type("one");
  await page.keyboard.press(`${MOD}+t`);
  await page.keyboard.type("two");
  await page.keyboard.press(`${MOD}+t`);
  await page.keyboard.type("three");
  await page.keyboard.press("Control+Tab");
  expect(await getDoc(page)).toBe("one");
  await page.keyboard.press("Control+Shift+Tab");
  expect(await getDoc(page)).toBe("three");
  await tabs(page).nth(1).click();
  expect(await getDoc(page)).toBe("two");
  // Typing after a click goes to the editor (the tab bar does not take focus).
  await page.keyboard.type("!");
  expect(await getDoc(page)).toBe("two!");
});

test("#81 undo stays in its tab", async ({ page }) => {
  await focusEditor(page);
  await page.keyboard.type("AAA");
  await page.keyboard.press(`${MOD}+t`);
  await page.keyboard.type("BBB");
  await page.keyboard.press("Control+Tab");
  await page.waitForTimeout(600); // a new undo group
  await page.keyboard.type("+");
  await page.keyboard.press(`${MOD}+z`);
  expect(await getDoc(page)).toBe("AAA");
  await page.keyboard.press("Control+Tab");
  expect(await getDoc(page)).toBe("BBB");
});

test("#81 scroll position and cursor are restored per tab", async ({
  page,
}) => {
  const long = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 段文字`).join(
    "\n\n",
  );
  await app(page, "app.editor.setContent(arg, { dirty: false });", long);
  await nextFrames(page);
  await page.locator(".cm-scroller").evaluate((el) => {
    el.scrollTop = 2400;
  });
  await nextFrames(page, 3);
  const before = await page
    .locator(".cm-scroller")
    .evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(2000);

  await app(page, "app.newTab();");
  await nextFrames(page, 3);
  expect(
    await page.locator(".cm-scroller").evaluate((el) => el.scrollTop),
  ).toBe(0);

  await page.keyboard.press("Control+Tab");
  await nextFrames(page, 4);
  const after = await page
    .locator(".cm-scroller")
    .evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(4);
});

test("#81 closing an untitled tab with changes asks 儲存 / 不儲存 / 取消", async ({
  page,
}) => {
  await focusEditor(page);
  await page.keyboard.type("draft");
  await page.keyboard.press(`${MOD}+t`);
  await app(
    page,
    "ipc.setMockDialogHandlers({ saveChanges: () => 'cancel' });",
  );
  await tabs(page).nth(0).hover();
  await expect(tabs(page).nth(0)).toHaveAttribute("data-dirty", "true");
  await tabs(page).nth(0).getByTestId("tab-close").click();
  await expect(tabs(page)).toHaveCount(2);
  expect(
    await app<string[]>(page, "return ipc.getMockSaveChangesPrompts();"),
  ).toEqual(["「未命名」有未儲存的變更，要在關閉前儲存嗎？"]);
  await expect(tabs(page).nth(0)).toHaveAttribute("data-active", "true");

  await app(
    page,
    "ipc.setMockDialogHandlers({ saveChanges: () => 'save', save: () => '/demo/draft.md' });",
  );
  await page.keyboard.press(`${MOD}+w`);
  await expect(tabbar(page)).toBeHidden();
  expect(
    await app<string>(page, "return ipc.readMockFile('/demo/draft.md');"),
  ).toBe("draft");
});

test("#81 middle click closes a tab; many tabs scroll and keep the active one visible", async ({
  page,
}) => {
  await app(page, "for (let i = 0; i < 14; i++) app.newTab();");
  await expect(tabs(page)).toHaveCount(15);
  const width = await tabs(page)
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(119);
  const active = tabs(page).nth(14);
  await expect(active).toBeInViewport();
  await tabs(page).nth(13).click({ button: "middle" });
  await expect(tabs(page)).toHaveCount(14);
});

test("#81 tab bar starts after the sidebar; content stays centred", async ({
  page,
}) => {
  await app(
    page,
    "app.newTab(); if (!app.sidebar.isVisible()) await app.toggleSidebar();",
  );
  await page.waitForTimeout(400);
  const sidebarRight = await page
    .getByTestId("sidebar")
    .evaluate((el) => el.getBoundingClientRect().right);
  const trackLeft = await page
    .locator(".k-tabbar-track")
    .evaluate((el) => el.getBoundingClientRect().left);
  expect(trackLeft).toBeGreaterThan(sidebarRight);
  const g = await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>(".cm-scroller")!;
    const l = document
      .querySelector<HTMLElement>(".cm-content .cm-line")!
      .getBoundingClientRect();
    const r = s.getBoundingClientRect();
    return { left: l.left - r.left, right: r.left + s.clientWidth - l.right };
  });
  expect(Math.abs(g.left - g.right)).toBeLessThan(2);
  await page.screenshot({ path: "test-results/81-tabs-sidebar.png" });
});

const LOOKS = [
  { name: "papyros", theme: "papyros", scheme: "light" },
  { name: "melan", theme: "melan", scheme: "dark" },
  { name: "system-light", theme: null, scheme: "light" },
  { name: "system-dark", theme: null, scheme: "dark" },
] as const;

for (const look of LOOKS) {
  test(`#81 tab bar look — ${look.name}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: look.scheme });
    await page.evaluate((t) => {
      if (t) document.documentElement.setAttribute("data-theme", t);
      else document.documentElement.removeAttribute("data-theme");
    }, look.theme);
    await app(
      page,
      `ipc.seedMockFile('/demo/docs/README.md', '# Docs\\n\\n說明文件');
       ipc.seedMockFile('/demo/README.md', '# Kalamos\\n\\n多文件分頁。');
       await app.openDocument('/demo/docs/README.md');
       app.newTab();
       await app.openDocument('/demo/README.md');
       app.newTab();
       app.editor.view.dispatch({ changes: { from: 0, insert: '尚未儲存的草稿' } });
       app.activateTab(app.getTabs()[1].id);`,
    );
    await expect(tabs(page)).toHaveText([
      "README.md — docs",
      "README.md — demo",
      "未命名",
    ]);
    await page.mouse.move(600, 400);
    await nextFrames(page, 3);
    await page.screenshot({
      path: `test-results/81-tabs-${look.name}.png`,
      clip: { x: 0, y: 0, width: 1200, height: 220 },
    });
  });
}

// ---- #81 B: opening files, closing the window ----

test("#81 B sidebar: click uses this tab, a dirty tab gets a new one, Cmd+click always a new tab", async ({
  page,
}) => {
  await app(
    page,
    "await app.openFolder('/demo'); if (!app.sidebar.isVisible()) await app.toggleSidebar();",
  );
  await page.getByTestId("sidebar-tab-list").click();
  const item = (path: string) =>
    page.locator(`[data-testid="file-item"][data-path="${path}"]`);
  const paths = await page
    .getByTestId("file-item")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.path!));
  const [first, second, third] = paths;

  await item(first).click();
  // The blank untitled tab was reused: still one tab, no tab bar.
  await expect(tabbar(page)).toBeHidden();
  await item(second).click();
  await expect(tabbar(page)).toBeHidden();
  expect(await app<string>(page, "return app.getCurrentPath();")).toBe(second);

  await focusEditor(page);
  await page.keyboard.type("x");
  await item(first).click();
  await expect(tabs(page)).toHaveCount(2);

  await item(third).click({ modifiers: ["ControlOrMeta"] });
  await expect(tabs(page)).toHaveCount(3);
  // Clicking an open file switches to its tab.
  await item(second).click();
  await expect(tabs(page)).toHaveCount(3);
  await expect(tabs(page).nth(0)).toHaveAttribute("data-active", "true");
});

test("#81 B Cmd+O opens a new tab; an open file is switched to", async ({
  page,
}) => {
  await app(
    page,
    "ipc.seedMockFile('/demo/x.md', '# X'); ipc.seedMockFile('/demo/y.md', '# Y');" +
      "await app.openDocument('/demo/x.md'); await app.openDocument('/demo/y.md');",
  );
  await expect(tabs(page)).toHaveText(["x.md", "y.md"]);
  await app(page, "ipc.setMockDialogHandlers({ open: () => '/demo/x.md' });");
  await focusEditor(page);
  await page.keyboard.press(`${MOD}+o`);
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(0)).toHaveAttribute("data-active", "true");
});

test("#81 B closing the window lists every unsaved tab: 取消 keeps it, 不儲存 closes", async ({
  page,
}) => {
  await focusEditor(page);
  await page.keyboard.type("first draft");
  await page.keyboard.press(`${MOD}+t`);
  await page.keyboard.type("second draft");
  await page.keyboard.press(`${MOD}+t`);
  await app(
    page,
    "ipc.setMockDialogHandlers({ saveChanges: () => 'cancel' });",
  );
  expect(
    await app<boolean>(page, "return ipc.triggerMockCloseRequested();"),
  ).toBe(false);
  expect(
    await app<string[]>(page, "return ipc.getMockSaveChangesPrompts();"),
  ).toEqual([
    "以下 2 份文件有未儲存的變更：\n・未命名\n・未命名 2\n\n要在關閉前儲存嗎？",
  ]);
  await expect(tabs(page)).toHaveCount(3);
  await app(
    page,
    "ipc.setMockDialogHandlers({ saveChanges: () => 'discard' });",
  );
  expect(
    await app<boolean>(page, "return ipc.triggerMockCloseRequested();"),
  ).toBe(true);
});

test("#81 B ⌘Q with 全部儲存 saves each draft, then quits", async ({
  page,
}) => {
  await focusEditor(page);
  await page.keyboard.type("keep me");
  await app(
    page,
    "ipc.setMockDialogHandlers({ saveChanges: () => 'save', save: () => '/demo/kept.md' });",
  );
  await app(
    page,
    "await ipc.emitMockMenuAction('app.quit'); await new Promise((r) => setTimeout(r, 50));",
  );
  expect(
    await app<string>(page, "return ipc.readMockFile('/demo/kept.md');"),
  ).toBe("keep me");
  expect(await app<number>(page, "return ipc.getMockQuitCount();")).toBe(1);
});
